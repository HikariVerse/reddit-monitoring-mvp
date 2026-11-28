"""Phase 2 Commercial Intelligence Core (S2-02, S2-03, S2-04, S2-06).

Single source of truth for:
- S2-04: Bilingual Brand/Alias normalization, disambiguation, dynamic candidate discovery,
         universal + category-rich attributes & scenarios, clause-level target-attribute binding.
- S2-02 (First Batch 5): PR01, PR07, MI03, MI05, MI07
- S2-03 (Second Batch 6): MI06, MI14, MI19, PR13, OD16, SL08
- S2-06 (High-ROI Bonus): MI13 (brand co-occurrence with Lift/NPMI, strictly separate from MI14)

Runs identically with GPU OFF (CPU INT8) or GPU ON (RTX 4060 FP16) by reusing Phase 1
`_signals(study)` V2 multilingual sentiment + clause-level contrast refinement.
"""

from __future__ import annotations

from collections import Counter, defaultdict
import math
import re
from typing import Any

from research import lexicon, semantics

from . import corpus, semantic
from .study import groups_for


# ---------------------------------------------------------------------------
# 1. S2-04 Commercial Knowledge Base: Brands, Aliases, Disambiguation
# ---------------------------------------------------------------------------

BRAND_CATALOG: dict[str, dict[str, Any]] = {
    # Open-ear & Audio
    "Shokz": {"domain": "audio", "aliases": ["shokz", "aftershokz", "openrun", "openfit", "openswim", "opencomm", "openmove", "韶音"]},
    "Soundcore": {"domain": "audio", "aliases": ["soundcore", "aerofit", "sport x20", "liberty 4", "声阔"]},
    "Bose": {"domain": "audio", "aliases": ["bose", "ultra open", "qc ultra", "quietcomfort", "qc45"]},
    "Sony": {"domain": "audio", "aliases": ["sony", "linkbuds", "wh-1000xm5", "wh-1000xm4", "wf-1000xm5", "xm5", "xm4", "索尼"]},
    "Apple": {"domain": "audio", "aliases": ["airpods", "airpods pro", "airpods max", "macbook", "iphone", "apple watch"]},
    "Samsung": {"domain": "audio", "aliases": ["samsung", "galaxy buds", "三星"]},
    "Huawei": {"domain": "audio", "aliases": ["huawei", "freeclip", "free clip", "freebuds", "华为"]},
    "Oladance": {"domain": "audio", "aliases": ["oladance", "ows pro"]},
    "Cleer": {"domain": "audio", "aliases": ["cleer", "cleer arc"]},
    "JBL": {"domain": "audio", "aliases": ["jbl", "soundgear"]},
    "Nothing": {"domain": "audio", "aliases": ["nothing ear", "cmf buds"]},
    "Sennheiser": {"domain": "audio", "aliases": ["sennheiser", "momentum 4", "森海塞尔"]},
    "OnePlus": {"domain": "audio", "aliases": ["oneplus", "one plus", "nord buds"]},
    "Beats": {"domain": "audio", "aliases": ["beats fit", "powerbeats", "beats studio"]},
    "Jabra": {"domain": "audio", "aliases": ["jabra", "elite 8", "elite 10"]},
    "Anker": {"domain": "power", "aliases": ["anker solix", "anker", "solix", "c1000", "f2000", "f3800", "ps400"]},
    "Edifier": {"domain": "audio", "aliases": ["edifier", "漫步者"]},
    "Xiaomi": {"domain": "audio", "aliases": ["xiaomi", "redmi buds", "小米"]},
    "Moondrop": {"domain": "audio", "aliases": ["moondrop", "水月雨"]},
    "Audio-Technica": {"domain": "audio", "aliases": ["audio-technica", "audiotechnica", "铁三角"]},
    "Beyerdynamic": {"domain": "audio", "aliases": ["beyerdynamic", "拜亚"]},
    "Shure": {"domain": "audio", "aliases": ["shure"]},
    "Baseus": {"domain": "audio", "aliases": ["baseus", "倍思"]},
    "Tozo": {"domain": "audio", "aliases": ["tozo"]},
    "EarFun": {"domain": "audio", "aliases": ["earfun"]},
    # Portable Power & Solar
    "EcoFlow": {"domain": "power", "aliases": ["ecoflow", "delta 2", "delta pro", "delta 3", "river 2", "river 3", "正浩"]},
    "Bluetti": {"domain": "power", "aliases": ["bluetti", "ac70", "ac180", "ac200", "elite 200", "铂陆帝"]},
    "Jackery": {"domain": "power", "aliases": ["jackery", "explorer 1000", "explorer 2000", "explorer 300", "电小二"]},
    "Pecron": {"domain": "power", "aliases": ["pecron"]},
    "Zendure": {"domain": "power", "aliases": ["zendure", "征拓"]},
    "Goal Zero": {"domain": "power", "aliases": ["goal zero", "yeti 1000", "yeti 1500"]},
    "DJI Power": {"domain": "power", "aliases": ["dji power"]},
    "Oukitel": {"domain": "power", "aliases": ["oukitel"]},
    "Fossibot": {"domain": "power", "aliases": ["fossibot"]},
    "Renogy": {"domain": "power", "aliases": ["renogy"]},
    "Victron": {"domain": "power", "aliases": ["victron"]},
    # AI Coding & LLMs
    "Claude": {"domain": "ai", "aliases": ["claude", "claude code", "anthropic"]},
    "ChatGPT / OpenAI": {"domain": "ai", "aliases": ["chatgpt", "openai", "gpt-4", "gpt-5", "gpt4", "gpt5", "codex"]},
    "Gemini": {"domain": "ai", "aliases": ["gemini", "google gemini"]},
    "Cursor": {"domain": "ai", "aliases": ["cursor"], "context_required": "ai"},
    "Windsurf": {"domain": "ai", "aliases": ["windsurf", "codeium"]},
    "GitHub Copilot": {"domain": "ai", "aliases": ["github copilot", "copilot"]},
    "DeepSeek": {"domain": "ai", "aliases": ["deepseek"]},
    "Perplexity": {"domain": "ai", "aliases": ["perplexity"]},
    "Grok": {"domain": "ai", "aliases": ["grok"]},
    "Qwen": {"domain": "ai", "aliases": ["qwen", "通义千问"]},
    "Kimi": {"domain": "ai", "aliases": ["kimi"]},
    "Aider": {"domain": "ai", "aliases": ["aider"]},
    "Cline": {"domain": "ai", "aliases": ["cline", "roo code"]},
    "Devin": {"domain": "ai", "aliases": ["devin"]},
    "Replit": {"domain": "ai", "aliases": ["replit"]},
    "Ollama": {"domain": "ai", "aliases": ["ollama"]},
    "Mistral": {"domain": "ai", "aliases": ["mistral"]},
    "Llama": {"domain": "ai", "aliases": ["meta llama", "llama 3", "llama 4"]},
    # Robot Vacuums & Smart Home
    "Roborock": {"domain": "home", "aliases": ["roborock", "石头", "q revo", "qrevo", "s8 maxv", "s7 maxv", "saros"]},
    "Dreame": {"domain": "home", "aliases": ["dreame", "追觅", "l20 ultra", "l40 ultra", "x40 ultra"]},
    "Ecovacs": {"domain": "home", "aliases": ["ecovacs", "科沃斯", "deebot"]},
    "Roomba / iRobot": {"domain": "home", "aliases": ["roomba", "irobot"]},
    "Eufy": {"domain": "home", "aliases": ["eufy"]},
    "Narwal": {"domain": "home", "aliases": ["narwal", "云鲸"]},
    "Shark": {"domain": "home", "aliases": ["shark"], "context_required": "home"},
    "Dyson": {"domain": "home", "aliases": ["dyson", "戴森"]},
    "Mova": {"domain": "home", "aliases": ["mova"]},
    "SwitchBot": {"domain": "home", "aliases": ["switchbot"]},
    # Keyboards & Peripherals
    "Keychron": {"domain": "keyboard", "aliases": ["keychron"]},
    "Logitech": {"domain": "keyboard", "aliases": ["logitech", "罗技", "mx keys", "mx master"]},
    "Razer": {"domain": "keyboard", "aliases": ["razer", "雷蛇"]},
    "NuPhy": {"domain": "keyboard", "aliases": ["nuphy"]},
    "Wooting": {"domain": "keyboard", "aliases": ["wooting"]},
    "HHKB": {"domain": "keyboard", "aliases": ["hhkb", "topre"]},
    "Akko": {"domain": "keyboard", "aliases": ["akko"]},
    "Epomaker": {"domain": "keyboard", "aliases": ["epomaker"]},
    "Royal Kludge": {"domain": "keyboard", "aliases": ["royal kludge", "rk61", "rk84"]},
    "Ducky": {"domain": "keyboard", "aliases": ["ducky"]},
    "Corsair": {"domain": "keyboard", "aliases": ["corsair", "海盗船"]},
    "SteelSeries": {"domain": "keyboard", "aliases": ["steelseries", "赛睿"]},
    "Lofree": {"domain": "keyboard", "aliases": ["lofree", "洛斐"]},
    "Leopold": {"domain": "keyboard", "aliases": ["leopold"]},
    "Qwertykeys": {"domain": "keyboard", "aliases": ["qwertykeys", "neo65", "qk65"]},
    # Wearables / Misc
    "Garmin": {"domain": "wearable", "aliases": ["garmin", "佳明"]},
    "Coros": {"domain": "wearable", "aliases": ["coros"]},
    "Meta": {"domain": "tech", "aliases": ["meta quest", "meta wayfarer", "ray-ban meta"]},
}

_CONTEXT_GUARDS = {
    "ai": re.compile(r"\b(?:ai|llm|agent|claude|gpt|openai|anthropic|windsurf|copilot|codebase|prompt|coding|ide|vscode|repo|token|mcp|composer|refactor|subscription|pro plan)\b|编程|代码|模型", re.I),
    "home": re.compile(r"\b(?:vacuum|mop|suction|carpet|floor|robot|cleaner|dust|lidar|dock|hair|pet)\b|扫地|拖地|吸尘", re.I),
}


def _compile_alias_pattern(alias: str) -> re.Pattern[str]:
    has_cjk = any("\u4e00" <= ch <= "\u9fff" for ch in alias)
    escaped = re.escape(alias).replace(r"\ ", r"[\s\-]+")
    if has_cjk:
        return re.compile(escaped, re.I)
    return re.compile(rf"(?<![a-z0-9]){escaped}(?:'s)?(?![a-z0-9])", re.I)


_COMPILED_BRANDS: list[tuple[str, str | None, list[tuple[str, re.Pattern[str]]]]] = [
    (
        brand,
        cfg.get("context_required"),
        [(al, _compile_alias_pattern(al)) for al in sorted(cfg["aliases"], key=len, reverse=True)],
    )
    for brand, cfg in BRAND_CATALOG.items()
]


# 18 Universal + Category-Rich Business Attributes (EN + ZH)
ATTRIBUTE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("价格与性价比", re.compile(r"\b(?:price|pricing|cost|expensive|overpriced|cheap(?:er)?|budget|value for money|worth (?:it|the money)|afford\w*|subscription|deal|discount)\b|价格|性价比|太贵|便宜|预算|划算|订阅", re.I)),
    ("佩戴与舒适度", re.compile(r"\b(?:comfort\w*|uncomfortable|fit|fits|fitting|clamp\w*|ear\s?(?:pain|hurt\w*|fatigue|tips?|cups?)|headband|hurts? my ears?|glasses|lightweight|heavy|weight|sweat\w*)\b|佩戴|舒适|夹头|压耳|闷热|耳朵疼|轻巧|难受", re.I)),
    ("音质表现", re.compile(r"\b(?:sound quality|audio quality|bass|treble|mids|midrange|vocals|tonality|soundstage|loudness|volume|distortion|tinny|muddy|crisp audio)\b|音质|低音|高音|通透|失真", re.I)),
    ("降噪与通透", re.compile(r"\b(?:anc|noise cancel\w*|transparency mode|ambient mode|passthrough|isolation|cabin pressure|ear pressure)\b|降噪|通透模式|耳压|隔音", re.I)),
    ("漏音与隔音", re.compile(r"\b(?:sound leakage|leakage|audio leak|leaking sound|people nearby hear)\b|漏音", re.I)),
    ("续航与电池", re.compile(r"\b(?:battery|battery life|runtime|playtime|lifepo4|watt[- ]?hour|capacity|power drain|dies? fast|standby|lasted \d+)\b|续航|电池|掉电|电量", re.I)),
    ("充电与补能", re.compile(r"\b(?:charg\w*|solar panel|solar input|fast charg\w*|usb-?c|pass[- ]?through|inverter|ac output|12v|anderson)\b|充电|太阳能|快充|逆变", re.I)),
    ("连接与蓝牙", re.compile(r"\b(?:bluetooth|multipoint|pairing|connect\w*|disconnect\w*(?!\s+switch)|dropout\w*|ldac|aptx|wireless|2\.4ghz|dongle|signal)\b|蓝牙|断连|配对|三模|无线|连接", re.I)),
    ("防水与耐用", re.compile(r"\b(?:sweatproof|waterproof|water resistant|ipx\d|ip\d\d|rain|weatherproof|durab\w*|rugged)\b|防水|防汗|耐用", re.I)),
    ("做工与质量", re.compile(r"\b(?:build quality|flimsy|sturdy|aluminum|plastic|hinge|creak\w*|snapped|cracked|fragile|material\w*|solid build|quality control|qc)\b|做工|材质|铝坨坨|开裂|脆弱|质量|品控", re.I)),
    ("软件与App", re.compile(r"\b(?:app|software|firmware|driver|companion app|eq|equalizer|update|via|qmk|keymap|ui|ux|buggy|crash\w*)\b|软件|固件|驱动|闪退|崩溃|App", re.I)),
    ("麦克风与通话", re.compile(r"\b(?:mic|microphone|call quality|voice call|meetings?|wind noise|sound underwater)\b|麦克风|通话|收音|开会", re.I)),
    ("售后与保修", re.compile(r"\b(?:warranty|customer (?:service|support)|support|rma|refund|return\w*|replacement|service)\b|售后|客服|保修|退货|退款|换新", re.I)),
    ("噪音与静音", re.compile(r"\b(?:noise|noisy|loud|quiet|silent|fan noise|static|hiss|crackle|whine|rattle\w*|thock\w*|acoustics)\b|噪音|底噪|安静|静音|钢丝音|嗡嗡", re.I)),
    ("清洁与避障", re.compile(r"\b(?:suction|mop\w*|obstacle avoidance|mapping|lidar|tangle\w*|pet hair|carpet|hardwood|auto[- ]?empty|base station|dock|water tank|leak\w*)\b|吸力|拖地|避障|建图|基站|毛发|漏水|集尘", re.I)),
    ("手感与输入", re.compile(r"\b(?:typing feel|switches?|tactile|linear|clicky|keycaps?|stabilizer\w*|gasket|chatter|double[- ]?typing|actuation|layout|75%|65%|hotswap)\b|手感|轴体|大键|连击|键帽|配列|热插拔", re.I)),
    ("智能与准确性", re.compile(r"\b(?:accuracy|hallucinat\w*|context window|reasoning|coding|refactor\w*|agentic|multi[- ]?file|bugs?|prompt\w*|intelligence|smart)\b|准确率|幻觉|上下文|推理|编程|智能", re.I)),
    ("速度与延迟", re.compile(r"\b(?:latency|lag\w*|delay|response time|speed|fast|slow|token\w* per second|wake up slow)\b|延迟|卡顿|速度|响应", re.I)),
]


# 12 Universal + Category-Rich Usage Scenarios (EN + ZH)
SCENARIO_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("运动健身", re.compile(r"\b(?:running|marathon|cycling|biking|gym|workout|exercise|sweat\w*|hiking|trail|jogging|fitness|swim\w*|(?:morning|long|daily)\s+runs?|go\s+for\s+a\s+run)\b|跑步|骑行|运动|健身|出汗|马拉松", re.I)),
    ("通勤出行", re.compile(r"\b(?:commut\w*|subway|train|bus|metro|walking to work|public transit)\b|通勤|地铁|公交|高铁", re.I)),
    ("办公与会议", re.compile(r"\b(?:office|workplace|open office|workday|meetings?|zoom|teams|calls?|desk|work from home|wfh|productivity)\b|办公|开会|会议|工位|写代码", re.I)),
    ("旅行与差旅", re.compile(r"\b(?:travel\w*|flight|airplane|plane|airport|hotel|trip|business trip|road trip)\b|旅行|出差|飞机|航班", re.I)),
    ("露营与户外", re.compile(r"\b(?:camping|camp|outdoor\w*|tent|off[- ]?grid|tailgat\w*|overland\w*|boondock\w*)\b|露营|户外|野营", re.I)),
    ("停电与应急备电", re.compile(r"\b(?:power outage\w*|blackout\w*|backup power|emergency|cpap|fridge|freezer|home backup|storm|hurricane|ups)\b|停电|断电|备电|应急|冰箱", re.I)),
    ("房车与车旅", re.compile(r"\b(?:vanlife|van life|rv\b|camper|car camping|car battery|12v|truck|vehicle)\b|房车|车旅|车载", re.I)),
    ("编程与开发", re.compile(r"\b(?:coding|programming|software engineering|swe\b|debugging|codebase|frontend|backend|terminal|repo|pipeline|dev\b)\b|编程|开发|代码|工程|调试", re.I)),
    ("居家与养宠", re.compile(r"\b(?:home|apartment|kitchen|living room|hardwood|carpet|rug|pet hair|dog|cat|golden retriever|kids|family)\b|居家|家里|木地板|地毯|养猫|宠物|猫砂", re.I)),
    ("睡眠与助眠", re.compile(r"\b(?:sleep\w*|bed|night|at night|insomnia|side sleeper)\b|睡眠|睡觉|半夜|晚上", re.I)),
    ("游戏娱乐", re.compile(r"\b(?:gaming|game\w*|fps|console|esports|music|podcast\w*|audiobook\w*)\b|游戏|听歌|播客", re.I)),
    ("学习与阅读", re.compile(r"\b(?:study\w*|library|student|college|university|reading|focus)\b|学习|图书馆|学生", re.I)),
]


# Direct comparison / switching templates (MI14 — strictly distinct from bare co-occurrence MI13!)
_DIRECT_COMPARE_PATTERNS: list[tuple[str, str, re.Pattern[str]]] = [
    ("switch", "directed", re.compile(r"\b(?:switched|switching|moved|moving|migrated|upgraded|went)\s+from\b.{0,45}\bto\b", re.I)),
    ("switch", "directed", re.compile(r"\b(?:replaced|replacing|returned|ditching|ditched|dropped|leaving|left)\b.{0,45}\b(?:with|for)\b", re.I)),
    ("alternative", "directed", re.compile(r"\b(?:alternative\w*\s+to|cheaper\s+than|better\s+than|worse\s+than|instead\s+of|over\s+the)\b|平替|替代|不如|比.{1,12}好", re.I)),
    ("compare", "undirected", re.compile(r"\b(?:vs\.?|versus|compared\s+to|compare\s+between|choose\s+between|between\b.{1,50}\band\b|or\s+should\s+i\s+(?:get|buy))\b|对比|怎么选|之间选|还是选", re.I)),
]

# Dynamic candidate brand discovery pattern (emerging / unknown brands)
_CANDIDATE_CTX_RE = re.compile(
    r"(?:\b(?:vs\.?|versus|alternative\s+to|switched\s+from|replaced|better\s+than|cheaper\s+than|recommend\s+(?:the\s+)?|bought\s+(?:a|an|the)\s+))\s*([A-Z][A-Za-z0-9\-]{2,16})\b"
)
_CANDIDATE_STOP = {
    "the", "this", "that", "these", "those", "with", "from", "into", "over", "under", "about", "after",
    "before", "when", "where", "what", "which", "would", "could", "should", "have", "been", "just",
    "open", "ear", "ears", "power", "station", "code", "coding", "agent", "battery", "solar", "panel",
    "panels", "sound", "audio", "noise", "pro", "max", "ultra", "plus", "mini", "lite", "new", "old",
    "good", "best", "better", "budget", "cheap", "free", "home", "work", "black", "friday", "amazon",
    "reddit", "youtube", "windows", "linux", "android", "monday", "tuesday", "wednesday", "thursday",
    "friday", "saturday", "sunday", "january", "february", "march", "april", "june", "july", "august",
    "september", "october", "november", "december", "anyone", "someone", "everyone", "something",
    "anything", "nothing", "people", "canada", "china", "japan", "europe", "usb", "anc", "bluetooth",
}

# Workaround extraction patterns (OD16 — genuine user workarounds / DIY / accessory fixes)
_WORKAROUND_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("DIY/自制改造", re.compile(r"\b(?:diy|built my own|3d print\w*|solder\w*|custom (?:cable|mount|rig|adapter|build|mod)|modded|jury[- ]?rig\w*|make ?shift)\b|自制|魔改|自己做|3D打印", re.I)),
    ("第三方配件替代", re.compile(r"\b(?:third[- ]?party|aftermarket|adapter|anderson output|external (?:mic|battery|charger|dac|antenna)|silicone tip|foam tips?|replacement pads?)\b|第三方配件|转接头|替换耳套|副厂", re.I)),
    ("工作流/设置变通", re.compile(r"\b(?:workaround|stopgap|temporary fix|as a workaround|my workaround|hack (?:is|was|to)|i ended up using|fixed it by|solved it by|bypass\w*|use .{1,25} instead of)\b|变通方案|临时方案|折中方案|绕过|解决办法", re.I)),
]
_WORKAROUND_PROBLEM_RE = re.compile(
    r"\b(?:because|since|so that|to avoid|to fix|to stop|prevent\w*|issue|problem|failed|broken|hurts?|drain|limit\w*|too expensive|doesn't|can't|won't|missing)\b|因为|为了解决|避免|报错|太贵|不行|不支持",
    re.I,
)
_WORKAROUND_OUTCOME_RE = re.compile(
    r"\b(?:worked|works? (?:great|well|fine|now|perfectly)|solved|fixed|much better|saved|quiet now|no more|lasts?|comfortable now)\b|有效|解决了|好用多了|省了|没再出现",
    re.I,
)

# Clause splitter for accurate Brand × Attribute target binding (MI19)
_CLAUSE_SPLIT_RE = re.compile(
    r"(?:[;!?。！？\n]+|\s*,\s*(?=(?:but|however|though|although|while|whereas|yet|and)\b)|\s+\b(?:but|however|though|although|while|whereas|yet)\b\s*|[,，]\s*(?:但是|但|不过|然而|可是|而))",
    re.I,
)
_CLAUSE_POS_RE = re.compile(
    r"\b(?:love\w*|great|amazing|awesome|excellent|fantastic|flawless|best|better|solid|super|impressed|comfortable|comfy|clean|fast|accurate|reliable|sturdy|worth|quiet|crisp|smooth|seamless\w*|unmatched|heavenly|natural|clear|good)\b|满意|很棒|不错|舒服|惊艳|流畅|稳定|超值|划算|干净|聪明|清晰|扎实|好用|一流|很强|省心",
    re.I,
)
_CLAUSE_NEG_RE = re.compile(
    r"\b(?:hate\w*|terrible|awful|horrible|atrocious|worst|bad|poor|trash|garbage|sucks?|annoying|frustrat\w*|disappoint\w*|unusable|broken|breaks?|broke|failed|fails?|died|dead|flimsy|overpriced|expensive|pricey|hurts?|painful|uncomfortable|tight|clamp\w*|leak\w*|rattle\w*|chatter|static|hiss|crackle|buzz\w*|crash\w*|buggy|disconnect\w*(?!\s+switch)|drops?|laggy|slow\w*|tangled|stuck|smell\w* awful|refused|terribly|hot|sweat\w*|headache|drain\w*)\b|差|烂|垃圾|糟糕|失望|崩溃|难受|头晕|夹头|压耳|闷热|漏水|漏音|报错|卡住|断连|连击|钢丝音|底噪|太贵|偏贵|拉垮|开裂|脆弱|烦人|噪音.*大|太吵",
    re.I,
)
_CLAUSE_NEGATE_POS_RE = re.compile(
    r"\b(?:not|never|hardly|barely|isn't|aren't|wasn't|doesn't|don't|didn't)\s+(?:very\s+|really\s+|fully\s+|that\s+)?(?:good|great|comfortable|worth|reliable|fast|quiet|accurate|clean|clear|impressed)\b|不够|不太|并不|一点也不",
    re.I,
)


def _clause_sentiment(clause: str, doc_sent_label: str) -> str:
    """Determine polarity of a single clause for target-attribute attribution (MI19 / PR07)."""
    neg_hits = len(_CLAUSE_NEG_RE.findall(clause))
    negated_pos = len(_CLAUSE_NEGATE_POS_RE.findall(clause))
    pos_hits = max(0, len(_CLAUSE_POS_RE.findall(clause)) - negated_pos)
    eff_neg = neg_hits + negated_pos

    if pos_hits > 0 and eff_neg > 0:
        return "mixed"
    if eff_neg > 0:
        return "negative"
    if pos_hits > 0:
        return "positive"
    # Fall back to document-level V2 ONNX sentiment ONLY when doc polarity is unambiguous
    if doc_sent_label in ("正面", "positive"):
        return "positive"
    if doc_sent_label in ("负面", "negative"):
        return "negative"
    if doc_sent_label in ("含混", "mixed"):
        return "mixed"
    return "neutral"


def _extract_brands_in_text(text: str, seed_set: set[str]) -> list[tuple[str, int, int, str]]:
    """Return list of (canonical_brand, start, end, matched_alias) with disambiguation guard."""
    hits: list[tuple[str, int, int, str]] = []
    seen_spans: list[tuple[int, int]] = []
    for brand, ctx_req, compiled_aliases in _COMPILED_BRANDS:
        if ctx_req:
            guard = _CONTEXT_GUARDS.get(ctx_req)
            has_seed_hint = (ctx_req == "ai" and bool(seed_set & {"cursor", "claude", "coding", "agent", "windsurf", "ide", "llm"})) or (
                ctx_req == "home" and bool(seed_set & {"vacuum", "roborock", "dreame", "roomba", "shark", "mop"})
            )
            if guard and not guard.search(text) and not has_seed_hint:
                continue
        for alias, rx in compiled_aliases:
            for m in rx.finditer(text):
                st, en = m.start(), m.end()
                if any(not (en <= s or st >= e) for s, e in seen_spans):
                    continue
                seen_spans.append((st, en))
                hits.append((brand, st, en, alias))
    hits.sort(key=lambda x: x[1])
    return hits


def _extract_attributes_in_text(text: str) -> list[tuple[str, int, int]]:
    out: list[tuple[str, int, int]] = []
    for attr, rx in ATTRIBUTE_PATTERNS:
        m = rx.search(text)
        if m:
            out.append((attr, m.start(), m.end()))
    return out


def _extract_scenarios_in_text(text: str) -> list[str]:
    return [name for name, rx in SCENARIO_PATTERNS if rx.search(text)]


def _commercial_signals(study) -> dict[str, Any]:
    """Single shared cached pass computing brands, candidates, attributes, scenarios, comparisons & workarounds."""
    def build():
        sig = semantic._signals(study)
        seed_set = {s.lower().strip('"\'() ') for s in (getattr(study.config, "seeds", ()) or ())}

        doc_brands: dict[int, list[str]] = {}
        doc_brand_aliases: dict[int, dict[str, set[str]]] = {}
        doc_attrs: dict[int, list[str]] = {}
        doc_scenarios: dict[int, list[str]] = {}
        candidate_docs: dict[str, set[int]] = defaultdict(set)
        direct_comparisons: list[dict[str, Any]] = []
        brand_attr_obs: list[dict[str, Any]] = []
        attr_obs: list[dict[str, Any]] = []
        workarounds: list[dict[str, Any]] = []

        known_brand_lowers = {b.lower() for b in BRAND_CATALOG} | {
            al.lower() for cfg in BRAND_CATALOG.values() for al in cfg["aliases"]
        }

        for i in study.core:
            text = study.rows[i]["focus"]
            if not text:
                continue
            doc_sent = sig[i]["sent"].get("label", "未知")
            brand_hits = _extract_brands_in_text(text, seed_set)
            unique_brands = list(dict.fromkeys(b for b, _, _, _ in brand_hits))
            if unique_brands:
                doc_brands[i] = unique_brands
                amap: dict[str, set[str]] = defaultdict(set)
                for b, _, _, al in brand_hits:
                    amap[b].add(al)
                doc_brand_aliases[i] = amap

            # Dynamic unknown brand candidates
            for m in _CANDIDATE_CTX_RE.finditer(text):
                cand = m.group(1).strip("-")
                low = cand.lower()
                if len(cand) >= 3 and low not in _CANDIDATE_STOP and low not in known_brand_lowers:
                    candidate_docs[cand].add(i)

            attrs = _extract_attributes_in_text(text)
            if attrs:
                doc_attrs[i] = [a for a, _, _ in attrs]

            scens = _extract_scenarios_in_text(text)
            if scens:
                doc_scenarios[i] = scens

            # Sentence-level direct comparisons (MI14), attribute polarity (PR07), brand×attribute (MI19), workarounds (OD16)
            for s_start, _, sentence in semantics.sentences(text):
                sent_trim = sentence.strip()
                if len(sent_trim) < 12:
                    continue

                # 1. Direct brand comparison (MI14)
                s_brands = _extract_brands_in_text(sent_trim, seed_set)
                s_unique_brands = list(dict.fromkeys(b for b, _, _, _ in s_brands))
                if len(s_unique_brands) >= 2:
                    for rel_type, direction, rx in _DIRECT_COMPARE_PATTERNS:
                        if rx.search(sent_trim):
                            ba, bb = s_unique_brands[0], s_unique_brands[1]
                            if direction == "undirected":
                                ba, bb = sorted((ba, bb))
                            direct_comparisons.append({
                                "doc_idx": i,
                                "brand_a": ba,
                                "brand_b": bb,
                                "relation_type": rel_type,
                                "direction": direction,
                                "sentence": sent_trim[:260],
                            })
                            break

                # 2. Clause-level Attribute Sentiment (PR07) & Brand × Attribute Binding (MI19)
                clauses = [c.strip() for c in _CLAUSE_SPLIT_RE.split(sent_trim) if c and len(c.strip()) >= 6]
                if not clauses:
                    clauses = [sent_trim]

                for clause in clauses:
                    c_attrs = _extract_attributes_in_text(clause)
                    if not c_attrs:
                        continue
                    pol = _clause_sentiment(clause, doc_sent)
                    c_brands = list(dict.fromkeys(b for b, _, _, _ in _extract_brands_in_text(clause, seed_set)))
                    # Bind target: prefer brand in SAME clause; if clause has none and sentence has exactly 1 brand, inherit sentence brand
                    bound_brands = c_brands if c_brands else (s_unique_brands if len(s_unique_brands) == 1 else [])
                    for attr, _, _ in c_attrs:
                        attr_obs.append({
                            "doc_idx": i,
                            "attribute": attr,
                            "polarity": pol,
                            "sentence": clause[:220],
                        })
                        for b in bound_brands:
                            brand_attr_obs.append({
                                "doc_idx": i,
                                "brand": b,
                                "attribute": attr,
                                "polarity": pol,
                                "sentence": clause[:220],
                            })

                # 3. User Workaround & DIY Detection (OD16)
                for w_cat, wrx in _WORKAROUND_PATTERNS:
                    if wrx.search(sent_trim):
                        # Distinguish genuine workaround from casual mention: require problem/outcome or explicit workaround cue
                        has_explicit = bool(re.search(r"\b(?:workaround|stopgap|jury[- ]?rig|diy|built my own|3d print|fixed it by|solved it by|third[- ]?party|aftermarket)\b|变通|自制|魔改|临时方案|第三方配件", sent_trim, re.I))
                        has_prob = bool(_WORKAROUND_PROBLEM_RE.search(sent_trim))
                        has_out = bool(_WORKAROUND_OUTCOME_RE.search(sent_trim))
                        if has_explicit or (has_prob and has_out):
                            workarounds.append({
                                "doc_idx": i,
                                "category": w_cat,
                                "sentence": sent_trim[:280],
                                "has_problem_cue": has_prob,
                                "has_outcome_cue": has_out,
                                "resolution_status": "resolved" if has_out else "workaround_active",
                            })
                            break

        return {
            "doc_brands": doc_brands,
            "doc_brand_aliases": doc_brand_aliases,
            "doc_attrs": doc_attrs,
            "doc_scenarios": doc_scenarios,
            "candidate_docs": {k: sorted(v) for k, v in candidate_docs.items() if len(v) >= 2},
            "direct_comparisons": direct_comparisons,
            "brand_attr_obs": brand_attr_obs,
            "attr_obs": attr_obs,
            "workarounds": workarounds,
        }

    return study._artifact("commercial_signals_v2", build)


def _sample_examples(study, items: list[tuple[int, str]], limit: int = 3) -> list[dict[str, Any]]:
    seen_docs: set[int] = set()
    out: list[dict[str, Any]] = []
    for idx, excerpt in items:
        if idx in seen_docs:
            continue
        seen_docs.add(idx)
        row = study.rows[idx]
        out.append({
            "document_id": row["document_id"],
            "group": row["group"],
            "day": row["day"],
            "excerpt": excerpt[:240],
        })
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------------------
# 2. Metric Calculators for Recipes (PR01, MI03, MI05, MI06, MI07, MI13, MI14,
#    PR07, MI19, SL08, PR13, OD16)
# ---------------------------------------------------------------------------

def commercial(study, mid, ids, filters):
    id_set = set(ids)
    n = len(ids)

    # --- PR01: Category discussion scale (posts/comments/threads split + sampled flag) ---
    if mid == "PR01":
        posts = sum(1 for i in ids if study.rows[i].get("kind") == "post")
        comments = sum(1 for i in ids if study.rows[i].get("kind") == "comment")
        threads = len({study.rows[i]["thread_id"] for i in ids if study.rows[i].get("thread_id")})
        authors = len({study.rows[i]["author_key"] for i in ids if study.rows[i].get("author_key")})
        by_day = [{"date": d, "documents": len(g)} for d, g in sorted(groups_for(study.rows, ids, "day").items())]
        is_archive = bool(getattr(study, "archive_meta", None))
        return "ready" if n > 0 else "insufficient_data", "", {
            "documents": n,
            "posts": posts,
            "comments": comments,
            "threads": threads,
            "authors": authors,
            "source_scope": "archive_ledger" if is_archive else "sample_corpus",
            "days": by_day,
            "evidence_ref": study.evidence(ids, role="category_scale"),
        }

    # --- MI03: Per-million archive attention (strictly from verified Population Ledger) ---
    if mid == "MI03":
        state, reason, data = corpus.archive(study, "SL02", ids, filters)
        if state in ("unsupported_source", "missing_fields", "insufficient_data"):
            return state, reason or "MI03 requires verifiable archive Population Ledger", data
        return state, reason, {
            **data,
            "metric_alias": "SL02",
            "threads_per_million": data.get("per_million"),
            "formula": "matched_admitted_threads / archive_admitted_threads * 1_000_000",
        }

    # --- SL08: Net Sentiment Index (strictly locked to SL09 explicit-opinion denominator) ---
    if mid == "SL08":
        sig = semantic._signals(study)
        cs = _commercial_signals(study)
        pos = sum(1 for i in ids if sig[i]["sent"]["label"] == "正面")
        neg = sum(1 for i in ids if sig[i]["sent"]["label"] == "负面")
        denom = pos + neg
        nsi = round((pos - neg) / denom, 4) if denom > 0 else None

        by_brand = []
        brand_docs = defaultdict(list)
        for i in ids:
            for b in cs["doc_brands"].get(i, ()):
                brand_docs[b].append(i)
        for b, b_ids in sorted(brand_docs.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:12]:
            bp = sum(1 for i in b_ids if sig[i]["sent"]["label"] == "正面")
            bn = sum(1 for i in b_ids if sig[i]["sent"]["label"] == "负面")
            bd = bp + bn
            by_brand.append({
                "brand": b,
                "documents": len(b_ids),
                "positive": bp,
                "negative": bn,
                "denominator": bd,
                "net_sentiment": round((bp - bn) / bd, 4) if bd > 0 else None,
                "low_support": bd < 5,
                "evidence_ref": study.evidence(b_ids, brand=b, role="brand_nsi"),
            })

        by_day = []
        for day, d_ids in sorted(groups_for(study.rows, ids, "day").items()):
            dp = sum(1 for i in d_ids if sig[i]["sent"]["label"] == "正面")
            dn = sum(1 for i in d_ids if sig[i]["sent"]["label"] == "负面")
            dd = dp + dn
            if dd > 0:
                by_day.append({"date": day, "positive": dp, "negative": dn, "denominator": dd, "net_sentiment": round((dp - dn) / dd, 4)})

        state = "ready" if denom >= 10 else ("exploratory" if denom > 0 else "insufficient_data")
        return state, ("" if denom > 0 else "No explicit positive or negative sentiment opinions"), {
            "net_sentiment": nsi,
            "positive": pos,
            "negative": neg,
            "denominator": denom,
            "coverage_rate": round(denom / max(1, n), 4),
            "formula": "(positive - negative) / (positive + negative)",
            "by_brand": by_brand,
            "by_day": by_day,
            "evidence_ref": study.evidence((i for i in ids if sig[i]["sent"]["label"] in ("正面", "负面")), role="sl08_opinion_pool"),
        }

    cs = _commercial_signals(study)
    sig = semantic._signals(study)

    # --- MI05 / MI06 / MI07: Brand Voice, Share of Voice, Coverage ---
    if mid in ("MI05", "MI06", "MI07"):
        brand_to_docs: dict[str, list[int]] = defaultdict(list)
        brand_aliases: dict[str, set[str]] = defaultdict(set)
        covered_docs: set[int] = set()
        for i in ids:
            bs = cs["doc_brands"].get(i)
            if not bs:
                continue
            covered_docs.add(i)
            for b in bs:
                brand_to_docs[b].append(i)
                brand_aliases[b].update(cs["doc_brand_aliases"].get(i, {}).get(b, ()))

        total_mentions = sum(len(v) for v in brand_to_docs.values())
        unmatched = n - len(covered_docs)
        ranked = sorted(brand_to_docs.items(), key=lambda kv: (-len(kv[1]), kv[0]))

        if mid == "MI07":
            cov_rate = round(len(covered_docs) / max(1, n), 4)
            return ("ready" if covered_docs else "insufficient_data"), ("" if covered_docs else "No recognized brand mentions in corpus"), {
                "covered_documents": len(covered_docs),
                "unmatched_documents": unmatched,
                "denominator": n,
                "coverage_rate": cov_rate,
                "unmatched_rate": round(unmatched / max(1, n), 4),
                "distinct_brands": len(ranked),
                "interpretation_note": "未识别品牌的讨论包含品类通用探讨或未收录长尾品牌，不可直接推断为消费者未决定购买。",
                "evidence_ref": study.evidence(sorted(covered_docs), role="brand_covered"),
                "unmatched_evidence_ref": study.evidence([i for i in ids if i not in covered_docs], role="brand_unmatched"),
            }

        brand_rows = []
        for b, b_ids in ranked[:20]:
            b_posts = sum(1 for i in b_ids if study.rows[i].get("kind") == "post")
            b_comments = sum(1 for i in b_ids if study.rows[i].get("kind") == "comment")
            sov = round(len(b_ids) / total_mentions, 4) if total_mentions > 0 else 0.0
            cov = round(len(b_ids) / max(1, n), 4)
            brand_rows.append({
                "brand": b,
                "documents": len(b_ids),
                "posts": b_posts,
                "comments": b_comments,
                "sov_share": sov,
                "coverage_rate": cov,
                "aliases_matched": sorted(brand_aliases[b])[:8],
                "evidence_ref": study.evidence(b_ids, brand=b, role="brand_voice"),
                "examples": _sample_examples(study, [(i, study.rows[i]["focus"][:220]) for i in b_ids[:6]], limit=2),
            })

        candidates = [
            {"candidate": cand, "documents": len([i for i in d_ids if i in id_set]), "source": "corpus_candidate",
             "evidence_ref": study.evidence([i for i in d_ids if i in id_set], candidate=cand)}
            for cand, d_ids in cs["candidate_docs"].items()
        ]
        candidates = sorted([c for c in candidates if c["documents"] >= 2], key=lambda x: (-x["documents"], x["candidate"]))[:10]

        if not brand_rows:
            return "insufficient_data", "No recognized brands found in current sample", {
                "brands": [], "discovered_candidates": candidates, "total_brand_mentions": 0, "denominator": n,
            }

        if mid == "MI05":
            return "ready", "", {
                "brands": brand_rows,
                "discovered_candidates": candidates,
                "total_brand_mentions": total_mentions,
                "covered_documents": len(covered_docs),
                "denominator": n,
                "method_note": "单篇同时提及多个品牌时分别计入对应品牌（同文多品牌去重计数）。",
            }

        # MI06: Share of Voice (strictly additive sum = 1.0 over all recognized brand mentions)
        exact_sum_sov = round(sum(len(v) / total_mentions for _, v in ranked), 4) if total_mentions > 0 else 0.0
        return "ready", "", {
            "brands": brand_rows,
            "total_brand_mentions": total_mentions,
            "sum_sov_share": exact_sum_sov,
            "covered_documents": len(covered_docs),
            "unbranded_documents": unmatched,
            "unbranded_rate": round(unmatched / max(1, n), 4),
            "denominator": n,
            "formula": "brand_documents / sum(all_brand_documents) [sums to 1.0]; coverage_rate = brand_documents / analyzed_documents [multi-label]",
        }

    # --- MI14: Direct Competitor Comparisons & Switching (strictly separate from co-occurrence) ---
    if mid == "MI14":
        pair_groups: dict[tuple[str, str, str, str], list[tuple[int, str]]] = defaultdict(list)
        comp_docs: set[int] = set()
        for item in cs["direct_comparisons"]:
            if item["doc_idx"] not in id_set:
                continue
            comp_docs.add(item["doc_idx"])
            key = (item["brand_a"], item["brand_b"], item["relation_type"], item["direction"])
            pair_groups[key].append((item["doc_idx"], item["sentence"]))

        pairs = []
        for (ba, bb, rel, direction), items in sorted(pair_groups.items(), key=lambda kv: (-len({x[0] for x in kv[1]}), kv[0])):
            d_ids = sorted({x[0] for x in items})
            pairs.append({
                "brand_a": ba,
                "brand_b": bb,
                "relation_type": rel,
                "direction": direction,
                "documents": len(d_ids),
                "mentions": len(items),
                "evidence_ref": study.evidence(d_ids, brand_a=ba, brand_b=bb, relation=rel),
                "examples": _sample_examples(study, items, limit=2),
            })
        state = "ready" if len(pairs) >= 2 else ("exploratory" if pairs else "insufficient_data")
        return state, ("" if pairs else "No explicit same-sentence brand comparisons detected"), {
            "pairs": pairs[:20],
            "total_comparison_documents": len(comp_docs),
            "total_edges": len(pairs),
            "denominator": n,
            "layer": "direct_comparison_only",
        }

    # --- MI13: Brand Co-occurrence Network (Lift & NPMI, strictly separated from MI14) ---
    if mid == "MI13":
        brand_doc_sets: dict[str, set[int]] = defaultdict(set)
        co_docs: dict[tuple[str, str], list[int]] = defaultdict(list)
        for i in ids:
            bs = sorted(set(cs["doc_brands"].get(i, ())))
            for b in bs:
                brand_doc_sets[b].add(i)
            for idx_a in range(len(bs)):
                for idx_b in range(idx_a + 1, len(bs)):
                    co_docs[(bs[idx_a], bs[idx_b])].append(i)

        edges = []
        for (ba, bb), d_ids in sorted(co_docs.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            c_ab = len(d_ids)
            if c_ab < 2:
                continue
            p_a = len(brand_doc_sets[ba]) / max(1, n)
            p_b = len(brand_doc_sets[bb]) / max(1, n)
            p_ab = c_ab / max(1, n)
            lift = round(p_ab / max(1e-9, p_a * p_b), 3)
            npmi = round(math.log(max(1e-9, p_ab / max(1e-9, p_a * p_b))) / max(1e-9, -math.log(max(1e-9, p_ab))), 3) if p_ab < 1.0 else 1.0
            edges.append({
                "brand_a": ba,
                "brand_b": bb,
                "co_documents": c_ab,
                "lift": lift,
                "npmi": npmi,
                "evidence_ref": study.evidence(d_ids, brand_a=ba, brand_b=bb, role="co_occurrence"),
            })
        state = "ready" if len(edges) >= 2 else ("exploratory" if edges else "insufficient_data")
        return state, ("" if edges else "Fewer than 2 co-occurring brand pairs"), {
            "edges": edges[:20],
            "total_edges": len(edges),
            "denominator": n,
            "layer": "document_cooccurrence_only",
        }

    # --- PR07: True Attribute-Level Negative Rate ---
    if mid == "PR07":
        by_attr: dict[str, dict[str, Any]] = defaultdict(lambda: {"pos": set(), "neg": set(), "mix": set(), "neu": set(), "all": set(), "neg_ex": [], "pos_ex": []})
        for obs in cs["attr_obs"]:
            if obs["doc_idx"] not in id_set:
                continue
            bucket = by_attr[obs["attribute"]]
            idx = obs["doc_idx"]
            bucket["all"].add(idx)
            pol = obs["polarity"]
            if pol == "positive":
                bucket["pos"].add(idx)
                bucket["pos_ex"].append((idx, obs["sentence"]))
            elif pol == "negative":
                bucket["neg"].add(idx)
                bucket["neg_ex"].append((idx, obs["sentence"]))
            elif pol == "mixed":
                bucket["mix"].add(idx)
                bucket["neg_ex"].append((idx, obs["sentence"]))
            else:
                bucket["neu"].add(idx)

        rows = []
        for attr, b in by_attr.items():
            # Strictly separate positive-only vs negative-only vs mixed for clean opinion denominator
            both = b["pos"] & b["neg"]
            pos_c = len(b["pos"] - both)
            neg_c = len(b["neg"] - both)
            mix_c = len(b["mix"] | both)
            neu_c = len(b["all"] - (b["pos"] | b["neg"] | b["mix"]))
            denom = pos_c + neg_c
            neg_rate = round(neg_c / denom, 4) if denom > 0 else None
            nsi = round((pos_c - neg_c) / denom, 4) if denom > 0 else None
            rows.append({
                "attribute": attr,
                "documents": len(b["all"]),
                "coverage_rate": round(len(b["all"]) / max(1, n), 4),
                "positive": pos_c,
                "negative": neg_c,
                "mixed": mix_c,
                "neutral": neu_c,
                "opinion_denominator": denom,
                "negative_rate": neg_rate,
                "net_sentiment": nsi,
                "low_support": denom < 5,
                "evidence_ref": study.evidence(sorted(b["all"]), attribute=attr, role="pr07_attr"),
                "negative_evidence_ref": study.evidence(sorted(b["neg"]), attribute=attr, role="pr07_attr_neg"),
                "examples": _sample_examples(study, b["neg_ex"] or b["pos_ex"], limit=2),
            })
        rows.sort(key=lambda r: (-(r["negative_rate"] if r["negative_rate"] is not None and not r["low_support"] else -1.0), -r["documents"], r["attribute"]))
        state = "ready" if any(not r["low_support"] for r in rows) else ("exploratory" if rows else "insufficient_data")
        return state, ("" if rows else "No grounded attribute evaluations detected"), {
            "attributes": rows[:16],
            "denominator": n,
            "formula": "negative_docs / (positive_docs + negative_docs) per attribute; None when denominator=0",
        }

    # --- MI19: Brand × Attribute Sentiment Matrix ---
    if mid == "MI19":
        cell_map: dict[tuple[str, str], dict[str, Any]] = defaultdict(lambda: {"pos": set(), "neg": set(), "mix": set(), "neu": set(), "all": set(), "ex": []})
        brand_totals = Counter()
        attr_totals = Counter()
        for obs in cs["brand_attr_obs"]:
            if obs["doc_idx"] not in id_set:
                continue
            key = (obs["brand"], obs["attribute"])
            c = cell_map[key]
            idx = obs["doc_idx"]
            c["all"].add(idx)
            brand_totals[obs["brand"]] += 1
            attr_totals[obs["attribute"]] += 1
            pol = obs["polarity"]
            if pol == "positive":
                c["pos"].add(idx)
            elif pol == "negative":
                c["neg"].add(idx)
            elif pol == "mixed":
                c["mix"].add(idx)
            else:
                c["neu"].add(idx)
            c["ex"].append((idx, obs["sentence"]))

        top_brands = [b for b, _ in brand_totals.most_common(8)]
        top_attrs = [a for a, _ in attr_totals.most_common(8)]
        cells = []
        for b in top_brands:
            for a in top_attrs:
                c = cell_map.get((b, a))
                if not c or not c["all"]:
                    continue
                both = c["pos"] & c["neg"]
                pos_c = len(c["pos"] - both)
                neg_c = len(c["neg"] - both)
                mix_c = len(c["mix"] | both)
                neu_c = len(c["all"] - (c["pos"] | c["neg"] | c["mix"]))
                denom = pos_c + neg_c
                nsi = round((pos_c - neg_c) / denom, 4) if denom > 0 else None
                neg_rate = round(neg_c / denom, 4) if denom > 0 else None
                cells.append({
                    "brand": b,
                    "attribute": a,
                    "documents": len(c["all"]),
                    "positive": pos_c,
                    "negative": neg_c,
                    "mixed": mix_c,
                    "neutral": neu_c,
                    "opinion_denominator": denom,
                    "net_sentiment": nsi,
                    "negative_rate": neg_rate,
                    "low_support": denom < 3,
                    "evidence_ref": study.evidence(sorted(c["all"]), brand=b, attribute=a, role="mi19_cell"),
                    "examples": _sample_examples(study, c["ex"], limit=2),
                })

        state = "ready" if len(cells) >= 4 else ("exploratory" if cells else "insufficient_data")
        return state, ("" if cells else "Insufficient co-aligned brand and attribute evaluations"), {
            "brands": top_brands,
            "attributes": top_attrs,
            "cells": cells,
            "denominator": n,
            "attribution_method": "clause_level_target_attribute_binding",
        }

    # --- PR13: Usage Scenario Demand Distribution ---
    if mid == "PR13":
        active_doc_ids = {i for i in ids if any(d["state"] in semantic.ACTIVE for d in sig[i]["demand_states"])}
        pain_doc_ids = {i for i in ids if any(p.get("resolution_status") != "resolved" for p in sig[i]["pain_spans"])}
        scen_all: dict[str, list[int]] = defaultdict(list)
        for i in ids:
            for sc in cs["doc_scenarios"].get(i, ()):
                scen_all[sc].append(i)

        rows = []
        for sc, d_ids in sorted(scen_all.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            d_set = set(d_ids)
            dem_ids = sorted(d_set & active_doc_ids)
            pn_ids = sorted(d_set & pain_doc_ids)
            rows.append({
                "scenario": sc,
                "documents": len(d_ids),
                "share_of_corpus": round(len(d_ids) / max(1, n), 4),
                "demand_documents": len(dem_ids),
                "demand_rate": round(len(dem_ids) / max(1, len(d_ids)), 4),
                "pain_documents": len(pn_ids),
                "pain_rate": round(len(pn_ids) / max(1, len(d_ids)), 4),
                "evidence_ref": study.evidence(d_ids, scenario=sc, role="pr13_scenario"),
                "demand_evidence_ref": study.evidence(dem_ids, scenario=sc, role="pr13_scenario_demand"),
                "examples": _sample_examples(study, [(i, study.rows[i]["focus"][:220]) for i in (dem_ids or d_ids)[:6]], limit=2),
            })
        state = "ready" if rows else "insufficient_data"
        return state, ("" if rows else "No explicit usage scenarios detected in current corpus"), {
            "scenarios": rows,
            "covered_documents": len({i for v in scen_all.values() for i in v}),
            "denominator": n,
            "overlap_possible": True,
            "method_note": "区分全部场景提及（documents）与该场景下的明确主动需求（demand_documents）及痛点（pain_documents）；多标签可重叠。",
        }

    # --- OD16: User Workarounds & DIY Solutions ---
    if mid == "OD16":
        by_cat: dict[str, list[dict[str, Any]]] = defaultdict(list)
        all_w_docs: set[int] = set()
        cases = []
        for w in cs["workarounds"]:
            if w["doc_idx"] not in id_set:
                continue
            by_cat[w["category"]].append(w)
            all_w_docs.add(w["doc_idx"])
            row = study.rows[w["doc_idx"]]
            cases.append({
                "category": w["category"],
                "document_id": row["document_id"],
                "group": row["group"],
                "day": row["day"],
                "excerpt": w["sentence"],
                "has_problem_cue": w["has_problem_cue"],
                "has_outcome_cue": w["has_outcome_cue"],
                "resolution_status": w["resolution_status"],
            })

        cat_rows = []
        for cat, items in sorted(by_cat.items(), key=lambda kv: (-len({x["doc_idx"] for x in kv[1]}), kv[0])):
            d_ids = sorted({x["doc_idx"] for x in items})
            cat_rows.append({
                "category": cat,
                "documents": len(d_ids),
                "mentions": len(items),
                "resolved_count": sum(1 for x in items if x["has_outcome_cue"]),
                "evidence_ref": study.evidence(d_ids, workaround_category=cat, role="od16_workaround"),
                "examples": _sample_examples(study, [(x["doc_idx"], x["sentence"]) for x in items], limit=2),
            })
        state = "ready" if len(all_w_docs) >= 3 else ("exploratory" if all_w_docs else "insufficient_data")
        return state, ("" if all_w_docs else "No explicit user workarounds or DIY adaptations detected"), {
            "documents": len(all_w_docs),
            "rate": round(len(all_w_docs) / max(1, n), 4),
            "denominator": n,
            "categories": cat_rows,
            "cases": cases[:12],
            "evidence_ref": study.evidence(sorted(all_w_docs), role="od16_all_workarounds"),
        }

    return "unsupported_source", f"Unknown commercial metric {mid}", {}
