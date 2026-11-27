"""L0/L1 文本基础处理：规范化、语言识别、分词、去重、轻量 NER。

设计原则：
* 零外部模型依赖 —— 全部基于 Unicode 统计 + 词典 + 正则，保证 CPU 上毫秒级；
* 多语言 —— 覆盖 Reddit 主要语言（en/zh/ja/ko/es/pt/fr/de/it/ru/ar/hi/th/...）；
* 可解释 —— 每个判定都返回置信度与依据，便于在仪表盘展示。
"""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from collections import Counter
from typing import Iterable

# --------------------------------------------------------------------------- #
# 正则
# --------------------------------------------------------------------------- #
RE_URL = re.compile(r"https?://\S+|www\.\S+", re.I)
RE_MD_LINK = re.compile(r"\[([^\]]*)\]\(([^)]*)\)")
RE_MD_IMG = re.compile(r"!\[[^\]]*\]\([^)]*\)")
RE_CODE = re.compile(r"```[\s\S]*?```|`[^`\n]{1,80}`")
RE_HTML = re.compile(r"<[^>]{1,40}>")
RE_QUOTE = re.compile(r"^\s*>.*$", re.M)
RE_EMOJI = re.compile(
    "[" "\U0001F300-\U0001FAFF" "\U00002600-\U000027BF" "\U0001F1E6-\U0001F1FF" "\U00002B00-\U00002BFF" "]"
)
RE_MENTION_SUB = re.compile(r"\br/([A-Za-z0-9_]{2,30})")
RE_MENTION_USER = re.compile(r"\b[uU]/([A-Za-z0-9_\-]{2,30})")
RE_HASHTAG = re.compile(r"(?<!\w)#([\w\u4e00-\u9fff]{2,30})")
RE_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]{2,}")
RE_DATE = re.compile(
    r"\b(?:19|20)\d{2}[-/](?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])\b"
    r"|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b"
)
RE_NUM_UNIT = re.compile(r"\b\d+(?:[.,]\d+)?\s?(?:%|usd|eur|gbp|kg|km|mb|gb|tb|ms|fps|mm|cm|m|k|w|h|min|s)\b", re.I)
RE_WORD = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿĀ-žА-яΑ-ωא-ת\u0600-\u06FF]{2,}")
RE_HAN = re.compile(r"[\u4e00-\u9fff]+")
RE_CAPS = re.compile(r"\b[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]+)*\b")
RE_TITLE_CASE = re.compile(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b")
RE_SENT = re.compile(r"[.!?。！？\n]+")
ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\ufeff\u2060"), None)

# --------------------------------------------------------------------------- #
# 停用词（用于词频统计与语言判定）
# --------------------------------------------------------------------------- #
STOPWORDS: dict[str, set[str]] = {
    "en": set(
        """i me my myself we our ours ourselves you your yours yourself yourselves he him his himself
        she her hers herself it its itself they them their theirs themselves what which who whom this
        that these those am is are was were be been being have has had having do does did doing a an
        the and but if or because as until while of at by for with about against between into through
        during before after above below to from up down in out on off over under again further then
        once here there when where why how all any both each few more most other some such no nor not
        only own same so than too very can will just should now s t ll m re ve y d o ain aren couldn
        didn doesn hadn hasn haven isn ma mightn mustn needn shan shouldn wasn weren won wouldn im ive
        id youre youve hes shes weve theyre thats whats theres dont doesnt didnt cant wont isnt arent
        wasnt werent havent hasnt wouldnt couldnt shouldnt aint
        get got gets getting go goes going gone wanna gonna gotta think thinks thought know knows knew
        like likes liked want wants wanted need needs needed feel feels felt see sees saw seen look
        looks looked say says said tell told take takes took taken make makes made thing things
        something anything nothing someone anyone everyone somebody anybody everybody people person
        time times day days week weeks month months year years way ways lot lots bit little really
        very much many also just even still back new first last right good bad better best worse
        actually basically probably maybe okay ok yeah yes nope lol edit update tl dr op ps imo tbh""".split()
    ),
    "es": set("de la que el en y a los se del las un por con no una su para es al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus ellas nosotras vosotros vosotras os mío mía míos mías tuyo tuya suyos suyas nuestro nuestra nuestros nuestras vuestro vuestra esos esas estoy estás está estamos estáis están".split()),
    "pt": set("de a o que e do da em um para com não uma os no se na por mais as dos como mas foi ao ele das tem à seu sua ou ser quando muito há nos já está eu também só pelo pela até isso ela entre era depois sem mesmo aos ter seus quem nas me esse eles estão você tinha foram essa num nem suas meu às minha têm numa pelos elas havia seja qual será nós tenho lhe deles essas esses pelas este fosse dele tu te vocês vos lhes meus minhas teu tua teus tuas nosso nossa nossos nossas dela delas esta estes estas aquele aquela".split()),
    "fr": set("de la le et les des en un une du que est pour qui dans a par plus pas au sur ne se ce il elle je tu nous vous ils elles son sa ses leur leurs avec comme mais ou où donc or ni car si très aussi été être avoir fait cette ces cet mon ma mes ton ta tes notre votre y d l c j qu n s m t".split()),
    "de": set("der die das und oder aber wenn dann als dass ich du er sie es wir ihr nicht kein keine ist sind war waren bin bist sein haben hat hatte haben wird werden wurde wurden mit von zu zum zur im in an auf für aus bei nach über unter durch gegen ohne um auch noch nur schon sehr mehr wie was wer wo warum weil diese dieser dieses dem den des ein eine einen einem einer eines".split()),
    "it": set("il lo la i gli le un uno una di del della dei delle che e è non per con su da in a al alla ai alle nel nella sono sei siamo siete erano ho hai ha abbiamo avete hanno questo questa questi queste quello quella ma però anche più molto come dove quando perché se o così io tu lui lei noi voi loro".split()),
    "nl": set("de het een en van ik te dat die in is hij ze niet zijn er was op aan met voor had maar om hem dan zou of wat mijn men dit zo door over ze zich bij ook als nog wil up uit der daar haar naar heb hoe heeft hebben deze u wordt wij".split()),
    "pl": set("i w nie na z do to że się jest o jak co ale za po tym tak od przez już są czy tylko go jego jej mu mi mnie ty my wy oni one ten ta te tego tej było być może który która które przy oraz lub gdy bo".split()),
    "tr": set("bir ve bu da de için ile çok daha gibi ama ne var yok ben sen o biz siz onlar değil mi ki en her şey sonra kadar olan olarak ise ancak veya".split()),
    "id": set("yang dan di ini itu dengan untuk tidak dari dalam akan pada juga saya kamu dia kami kita mereka ada karena bisa sudah belum atau tapi jika saat lebih sangat".split()),
    "vi": set("và của là có không được trong cho một những các người này đó với để khi thì rất như đã sẽ bạn tôi anh chị em nó họ cũng nhưng mà nếu vì sao".split()),
    "sv": set("och i att det som på är av för med till den har de inte om ett men var jag sig från vi så kan man när år under också efter eller nu sin där bara in blir upp".split()),
    "ro": set("și în de la cu pe că nu o un este sunt mai pentru care din se ce au fost sau dar cum dacă lui ei ele noi voi eu tu el ea acest această".split()),
    "cs": set("a v se na je že o s z do to jako ale pro po tak už také by byl byla být které který která při mezi nebo ještě jen což".split()),
    "ru": set("и в не на я что он с как это а по но они мы вы ты же бы для из у от за то так все она его мне было бы когда даже ну если уже или".split()),
    "uk": set("і в не на я що він з як це а по але вони ми ви ти ж би для із у від за то так всі вона його мені було коли навіть якщо вже або".split()),
    "ar": set("في من على أن إلى هذا هذه مع لا ما هو هي كان كانت عن ذلك لكن أو ثم قد كل بعض كما بين بعد قبل عند".split()),
}

# 英文补充停用词：缩写残片 + 高泛化功能词（提高主题/聚类可读性）
STOPWORDS["en"] |= set(
    """one two three would could should can may might must shall never ever well since around
    every each use used using find found help post posts life url us don didn doesn isn aren
    wasn weren couldn wouldn shouldn hasn haven hadn mustn needn ain ve re ll m t d s
    though although whether within without upon among across behind beyond toward towards
    quite rather enough almost already yet often sometimes always usually
    say says said go goes went gone gonna gotta wanna kind sort bunch""".split()
)


# 口语化泛化词：在社交媒体语料中高频但几乎不携带主题信息
GENERIC_CHAT = set(
    """looking long sure old trying different another let everything keep next please pretty thank thanks
    else give try come came put tell told ask asked mean means guess happens happened matter anyway anyways
    anymore guys guy dude man bro point reason start started stop run running talk talking said want need
    feel know think going gonna actually literally honestly probably maybe obviously seriously totally
    completely basically exactly especially usually today tomorrow yesterday morning night week month year
    day days time times hour hours minute minutes hour people person someone anyone everyone nobody every
    body something anything nothing way ways lot lots said saying see seen saw look looks looked make makes
    made take took taken get gets got give gives gave full part home end show done tried able away hard
    free making etc kinda sorta oh ah um uh ye yea yep nope nah hey hi hello
    good bad nice cool worse worst better best great awesome terrible""".split()
)
STOPWORDS["en"] |= GENERIC_CHAT

LANG_NAMES = {
    "en": "英语 English",
    "zh": "中文 Chinese",
    "ja": "日语 Japanese",
    "ko": "韩语 Korean",
    "es": "西语 Spanish",
    "pt": "葡语 Portuguese",
    "fr": "法语 French",
    "de": "德语 German",
    "it": "意语 Italian",
    "nl": "荷语 Dutch",
    "pl": "波兰语 Polish",
    "tr": "土语 Turkish",
    "id": "印尼语 Indonesian",
    "vi": "越南语 Vietnamese",
    "sv": "瑞典语 Swedish",
    "ro": "罗语 Romanian",
    "cs": "捷克语 Czech",
    "ru": "俄语 Russian",
    "uk": "乌语 Ukrainian",
    "ar": "阿语 Arabic",
    "hi": "印地语 Hindi",
    "th": "泰语 Thai",
    "he": "希伯来语 Hebrew",
    "el": "希腊语 Greek",
    "unknown": "未识别 Unknown",
}

SCRIPT_RANGES = {
    "latin": [(0x0041, 0x024F)],
    "han": [(0x4E00, 0x9FFF), (0x3400, 0x4DBF)],
    "kana": [(0x3040, 0x30FF)],
    "hangul": [(0xAC00, 0xD7AF), (0x1100, 0x11FF)],
    "cyrillic": [(0x0400, 0x04FF)],
    "arabic": [(0x0600, 0x06FF), (0x0750, 0x077F)],
    "hebrew": [(0x0590, 0x05FF)],
    "devanagari": [(0x0900, 0x097F)],
    "thai": [(0x0E00, 0x0E7F)],
    "greek": [(0x0370, 0x03FF)],
}


def script_of(ch: str) -> str | None:
    o = ord(ch)
    for name, ranges in SCRIPT_RANGES.items():
        for lo, hi in ranges:
            if lo <= o <= hi:
                return name
    return None


def script_profile(text: str) -> Counter:
    c = Counter()
    for ch in text:
        if ch.isalpha():
            s = script_of(ch)
            if s:
                c[s] += 1
    return c


def detect_language(text: str) -> tuple[str, float]:
    """返回 (语言代码, 置信度 0~1)。基于文字系统 + 停用词命中。"""
    if not text or not text.strip():
        return "unknown", 0.0
    prof = script_profile(text)
    total_alpha = sum(prof.values()) or 1
    # 1) 强脚本判定
    if prof["hangul"] / total_alpha > 0.15:
        return "ko", min(0.99, prof["hangul"] / total_alpha + 0.4)
    if prof["thai"] / total_alpha > 0.15:
        return "th", min(0.99, prof["thai"] / total_alpha + 0.4)
    if prof["hebrew"] / total_alpha > 0.15:
        return "he", min(0.99, prof["hebrew"] / total_alpha + 0.4)
    if prof["greek"] / total_alpha > 0.15:
        return "el", min(0.99, prof["greek"] / total_alpha + 0.4)
    if prof["devanagari"] / total_alpha > 0.15:
        return "hi", min(0.99, prof["devanagari"] / total_alpha + 0.4)
    if prof["arabic"] / total_alpha > 0.15:
        return "ar", min(0.99, prof["arabic"] / total_alpha + 0.4)
    if prof["kana"] / total_alpha > 0.05:
        return "ja", min(0.99, (prof["kana"] + prof["han"]) / total_alpha)
    if prof["han"] / total_alpha > 0.25:
        return "zh", min(0.99, prof["han"] / total_alpha + 0.3)
    if prof["cyrillic"] / total_alpha > 0.3:
        words = [w.lower() for w in RE_WORD.findall(text)]
        ru = sum(1 for w in words if w in STOPWORDS["ru"])
        uk = sum(1 for w in words if w in STOPWORDS["uk"])
        lang = "uk" if uk > ru else "ru"
        conf = 0.6 + 0.3 * (max(ru, uk) / max(1, len(words)) * 5)
        return lang, min(0.97, conf)
    # 2) 拉丁语系：停用词打分
    words = [w.lower() for w in RE_WORD.findall(text)]
    if not words:
        return "unknown", 0.1
    scores = {}
    for lang, sw in STOPWORDS.items():
        if lang in ("ru", "uk", "ar"):
            continue
        hit = sum(1 for w in words if w in sw)
        if hit:
            scores[lang] = hit / math.sqrt(len(words))
    if not scores:
        # 纯英文短文常见（"lol", "same"）
        return ("en", 0.35) if prof["latin"] / total_alpha > 0.8 else ("unknown", 0.1)
    best = max(scores, key=scores.get)
    ordered = sorted(scores.values(), reverse=True)
    margin = (ordered[0] - (ordered[1] if len(ordered) > 1 else 0)) / (ordered[0] + 1e-9)
    conf = 0.45 + 0.5 * margin
    if len(words) < 6:
        conf *= 0.7
    return best, round(min(0.98, conf), 3)


# --------------------------------------------------------------------------- #
# 清洗 / 规范化
# --------------------------------------------------------------------------- #
def normalize(text: str) -> str:
    if not text:
        return ""
    t = unicodedata.normalize("NFKC", text).translate(ZERO_WIDTH)
    t = RE_MD_IMG.sub(" ", t)
    t = RE_MD_LINK.sub(r"\1", t)
    t = RE_HTML.sub(" ", t)
    t = RE_QUOTE.sub(" ", t)
    t = RE_URL.sub(" <url> ", t)
    t = re.sub(r"[ \t\r\f\v]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def clean_stats(raw: str) -> dict:
    """计算清洗过程中的可观测指标（用于 L0 漏斗与质量画像）。"""
    if not raw:
        return {
            "chars_raw": 0, "chars": 0, "has_url": False, "has_emoji": False,
            "has_code": False, "url_count": 0, "emoji_count": 0, "markdown_marks": 0,
        }
    emojis = RE_EMOJI.findall(raw)
    return {
        "chars_raw": len(raw),
        "has_url": bool(RE_URL.search(raw)),
        "url_count": len(RE_URL.findall(raw)),
        "has_emoji": bool(emojis),
        "emoji_count": len(emojis),
        "has_code": bool(RE_CODE.search(raw)),
        "markdown_marks": raw.count("**") + raw.count("~~") + raw.count("##"),
    }


def tokenize(text: str, min_len: int = 2) -> list[str]:
    """混合语言分词：拉丁词 + CJK 二元组（无需 jieba，速度稳定）。"""
    toks: list[str] = []
    for w in RE_WORD.findall(text):
        lw = w.lower()
        if len(lw) >= min_len:
            toks.append(lw)
    for seg in RE_HAN.findall(text):
        if len(seg) == 1:
            toks.append(seg)
        else:
            # 二元组 + 完整词（<=4 字）
            for i in range(len(seg) - 1):
                toks.append(seg[i : i + 2])
            if 2 <= len(seg) <= 4:
                toks.append(seg)
    return toks


# 跨语种停用词并集：避免"si/da/ja/pra"这类其他语种虚词污染主题与聚类
ALL_STOP = set().union(*STOPWORDS.values()) | GENERIC_CHAT
# 短词白名单（领域缩写）
KEEP_SHORT = {"ai", "vr", "ar", "3d", "pc", "tv", "ui", "ux", "ml", "os", "js", "go", "uk", "us", "eu", "cs", "pm", "am"}


def content_tokens(tokens: Iterable[str], lang: str) -> list[str]:
    """去停用词（含跨语种并集）、去数字、去 2 字母以内的拉丁碎片。"""
    sw = ALL_STOP | STOPWORDS.get(lang, set())
    out = []
    for t in tokens:
        if t in sw or t == "url" or t.isdigit():
            continue
        if len(t) < 3 and t not in KEEP_SHORT and RE_WORD.fullmatch(t):
            continue
        out.append(t)
    return out


# --------------------------------------------------------------------------- #
# 去重
# --------------------------------------------------------------------------- #
def text_hash(norm_text: str) -> str:
    return hashlib.sha1(norm_text.encode("utf-8", "ignore")).hexdigest()[:16]


def simhash(tokens: list[str], bits: int = 64) -> int:
    if not tokens:
        return 0
    v = [0] * bits
    for tok in tokens:
        h = int.from_bytes(hashlib.blake2b(tok.encode("utf-8", "ignore"), digest_size=8).digest(), "big")
        for i in range(bits):
            v[i] += 1 if (h >> i) & 1 else -1
    out = 0
    for i in range(bits):
        if v[i] > 0:
            out |= 1 << i
    return out


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


# --------------------------------------------------------------------------- #
# 轻量 NER（规则 + 词典）
# --------------------------------------------------------------------------- #
ENTITY_DICT = {
    "MODEL": [
        "gpt", "gpt-4", "gpt-5", "chatgpt", "claude", "gemini", "llama", "mistral", "qwen",
        "deepseek", "phi-3", "sdxl", "stable diffusion", "midjourney", "whisper", "bert",
        "transformer", "rag", "lora", "quantization", "int8", "fp16", "cuda", "onnx",
    ],
    "PLATFORM": [
        "reddit", "youtube", "tiktok", "twitter", "x", "discord", "steam", "github", "huggingface",
        "openai", "anthropic", "google", "microsoft", "apple", "nvidia", "amd", "intel", "meta",
        "python", "javascript", "rust", "golang", "docker", "kubernetes", "linux", "windows",
    ],
    "GAME": [
        "minecraft", "fortnite", "valorant", "league of legends", "dota", "elden ring",
        "zelda", "pokemon", "skyrim", "witcher", "baldurs gate", "genshin", "osu", "roblox",
    ],
}
_ENTITY_LOOKUP = {k.lower(): v for v, items in ENTITY_DICT.items() for k in items}

# 全大写缩写的噪声词（功能词 / 网络俚语 / 罗马数字）
ACR_BLOCK = set(
    """lol omg imo imho tbh edit tldr psa op ama fyi btw dm ii iii iv vi vii viii ix xi nsfw
    nba nfl eli5 aita iirc yta nta wanr smh fwiw rt oc cmv""".split()
)

# 否定词（情感词典基线用）
NEGATORS = set("not no never nor none cannot cant dont doesnt didnt isnt arent wasnt werent hardly barely without".split())


def extract_entities(text: str) -> list[tuple[str, str]]:
    """返回 [(实体, 类型)]，规则优先、词典兜底。"""
    out: list[tuple[str, str]] = []
    if not text:
        return out
    for m in RE_MENTION_SUB.finditer(text):
        out.append(("r/" + m.group(1), "SUBREDDIT"))
    for m in RE_MENTION_USER.finditer(text):
        out.append(("u/" + m.group(1), "USER"))
    for m in RE_HASHTAG.finditer(text):
        out.append(("#" + m.group(1), "HASHTAG"))
    for m in RE_EMAIL.finditer(text):
        out.append((m.group(0), "EMAIL"))
    for m in RE_URL.finditer(text):
        dom = re.sub(r"^https?://(www\.)?", "", m.group(0)).split("/")[0][:40]
        out.append((dom, "URL"))
    for m in RE_DATE.finditer(text):
        out.append((m.group(0), "DATE"))
    for m in RE_NUM_UNIT.finditer(text):
        out.append((m.group(0), "QUANTITY"))
    lower = text.lower()
    for key, typ in _ENTITY_LOOKUP.items():
        if len(key) > 3 and key in lower:
            out.append((key.upper() if len(key) <= 6 else key.title(), typ))
    for m in RE_CAPS.finditer(text):
        tok = m.group(0)
        low = tok.lower()
        if 2 <= len(tok) <= 12 and low not in ACR_BLOCK and low not in STOPWORDS["en"]:
            out.append((tok, "ACRONYM"))
    for m in RE_TITLE_CASE.finditer(text):
        out.append((m.group(0), "PROPER_NOUN"))
    # 去重保序
    seen, uniq = set(), []
    for e, t in out:
        if (e, t) not in seen:
            seen.add((e, t))
            uniq.append((e, t))
    return uniq[:40]


# --------------------------------------------------------------------------- #
# 规则分类（L2）
# --------------------------------------------------------------------------- #
RULES: list[tuple[str, str, re.Pattern]] = [
    ("提问求助", "问题型", re.compile(r"\?|how do i|how to|anyone know|help me|what should|does anyone|求助|怎么办", re.I)),
    ("观点争论", "论辩型", re.compile(r"\bi think\b|\bimo\b|actually|wrong|disagree|unpopular opinion|我认 为|我觉得", re.I)),
    ("经验分享", "叙事型", re.compile(r"\bi (just|finally|recently)\b|my experience|story|update:|终于|分享", re.I)),
    ("数据引用", "证据型", re.compile(r"\d+(\.\d+)?%|\bsource\b|according to|study|report|统计|数据", re.I)),
    ("情绪宣泄", "情绪型", re.compile(r"!!+|wtf|hate|love this|so good|terrible|amazing|无语|太棒|垃圾", re.I)),
]


def senti_lexicon_score(text: str) -> tuple[int, int]:
    """词典情感计数，带 2 词窗口的否定翻转（not good -> 负向）。"""
    toks = tokenize(text)
    pos = neg = 0
    for i, t in enumerate(toks):
        if t in SENTI_LEX["pos"]:
            flip = any(x in NEGATORS for x in toks[max(0, i - 1):i])
            if flip:
                neg += 1
            else:
                pos += 1
        elif t in SENTI_LEX["neg"]:
            flip = any(x in NEGATORS for x in toks[max(0, i - 1):i])
            if flip:
                pos += 1
            else:
                neg += 1
    return pos, neg


def rule_classify(text: str) -> str:
    best, hits = "陈述描述", 0
    for name, _kind, rx in RULES:
        n = len(rx.findall(text or ""))
        if n > hits:
            best, hits = name, n
    return best


# --------------------------------------------------------------------------- #
# 情感词典（L4 校准基线）
# --------------------------------------------------------------------------- #
SENTI_LEX = {
    "pos": set(
        """good great awesome amazing excellent love loved like liked nice best better fun happy glad
        perfect beautiful helpful thanks thank brilliant fantastic wonderful solid enjoy enjoyed
        recommend impressive super cool win win win 好玩 喜欢 优秀 感谢 不错 厉害 赞 爱 开心 完美 强
        bom ótimo gostei adorei incrível excelente maravilhoso obrigado top demais
        bien bueno genial gracias excelente increíble me gusta
        gut super danke toll klasse
        bien merci génial parfait""".split()
    ),
    "neg": set(
        """bad worse worst terrible awful hate hated trash garbage shit sucks suck annoying broken bug
        bugs useless stupid disappointed disappointing sad angry wrong fail failed failure poor
        boring toxic scam waste 垃圾 差 烂 讨厌 失望 生气 恶心 无语 崩溃 难用 错误 失败 问题
        ruim péssimo odeio horrível lixo droga
        malo pésimo odio horrible basura
        schlecht hasse schlimm
        mauvais déteste nul""".split()
    ),
}
