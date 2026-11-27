"""内置通用词典与规则库（免人工标注的起点资产）。

设计原则：
* 品牌/属性/场景/痛点均为**通用种子**，运行时会被"自动领域词典"扩展与校正；
* 所有匹配模式大小写不敏感，长词优先，避免 "apple" 命中 "pineapple"；
* 意图规则返回多标签，并记录命中片段与规则 id，供实验室对比与证据回溯。
"""

from __future__ import annotations

import re

# --------------------------------------------------------------------------- #
# 1. 品牌种子（跨品类，自动扩展的基础）
# --------------------------------------------------------------------------- #
BRANDS: dict[str, list[str]] = {
    "audio": [
        "sony", "bose", "sennheiser", "apple", "airpods", "samsung", "galaxy buds", "jbl", "anker",
        "soundcore", "beats", "audio-technica", "audiotechnica", "beyerdynamic", "shure", "moondrop",
        "kz", "google pixel buds", "nothing ear", "oneplus", "jabra", "akg", "focal", "hifiman",
        "audeze", "campfire audio", "final audio", "linsoul", "truthear", "simgot", "edifier",
        "steelseries", "hyperx", "razer", "logitech", "creative", "fiio", "hiby", "topping",
        "schiit", "drop", "massdrop", "philips", "panasonic", "skullcandy", "jaybird", "plantronics",
        "poly", "yealink", "sonos", "harman kardon", "denon", "marantz", "yamaha", "klipsch",
    ],
    "keyboard": [
        "keychron", "logitech", "razer", "corsair", "ducky", "leopold", "hhkb", "topre", "akko",
        "glorious", "gmmk", "varmilo", "anne pro", "wooting", "drop", "nuhpy", "nuphy", "kbd Fans",
        "kbdfans", "epomaker", "royal kludge", "r k", "redragon", "hyperx", "steelseries", "asus",
        "roccat", "kinesis", "zsa", "moonlander", "ergodox", "mode", "qwertykeys", "lofree",
        "azio", "das keyboard", "unicomp", "cherry", "gateron", "kailh", "akko", "montage",
    ],
    "ai": [
        "openai", "chatgpt", "gpt-4", "gpt-5", "gpt", "anthropic", "claude", "google gemini",
        "gemini", "copilot", "github copilot", "cursor", "windsurf", "codeium", "perplexity",
        "midjourney", "stable diffusion", "dall-e", "llama", "meta llama", "mistral", "qwen",
        "deepseek", "kimi", "grok", "poe", "character.ai", "replika", "notion ai", "jasper",
        "runway", "elevenlabs", "suno", "udio", "ollama", "lm studio", "open webui", "textgen",
        "vllm", "llama.cpp", "huggingface", "hugging face", "replicate", "together ai", "groq",
        "openrouter", "claude code", "codex", "devin", "replit", "tabnine", "continue", "aider",
    ],
    "sleep": [
        "casper", "purple", "tempur-pedic", "tempurpedic", "saatva", "sleep number", "brooklyn bedding",
        "helix", "eight sleep", "hatch", "manta", "loop earplugs", "bose sleepbuds", "sleepbuds",
        "yogasleep", "hush", "muse", "oura", "whoop", "dreamcloud", "nectar", "leesa", "tuft",
        "amerisleep", "avocado", "sealy", "serta", "simba", "emma", "linenspa", "zippee",
    ],
    "home": [
        "ninja", "cosori", "instant pot", "instantpot", "philips", "breville", "cuisinart",
        "kitchenaid", "dyson", "shark", "irobot", "roomba", "roborock", "eufy", "lefant",
        "dreame", "ecovacs", "vitamix", "blendtec", "nutribullet", "tefal", "delonghi",
        "nespresso", "keurig", "smeg", "moccamaster", "fellow", "zwilling", "all-clad",
        "lodge", "le creuset", "stanley", "yeti", "hydro flask", "owala", "simplehuman",
    ],
    "tech": [
        "apple", "microsoft", "google", "amazon", "meta", "nvidia", "amd", "intel", "qualcomm",
        "lenovo", "dell", "hp", "asus", "acer", "msi", "gigabyte", "framework", "valve", "steam deck",
        "nintendo", "sony playstation", "xbox", "oculus", "meta quest", "garmin", "fitbit",
        "gopro", "dji", "insta360", "raspberry pi", "arduino", "synology", "qnap", "ubiquiti",
        "tp-link", "netgear", "asus rog", "razer blade", "thinkpad", "macbook", "surface",
    ],
}

ALL_BRANDS: list[str] = sorted({b for v in BRANDS.values() for b in v}, key=len, reverse=True)
BRAND_DOMAIN: dict[str, str] = {b: d for d, lst in BRANDS.items() for b in lst}

# 同形词品牌：本身是常用英文词，在本类语料中误报率极高（Apple=水果、Drop=动词、Surface=表面…）
# 默认不计入品牌声量；如确需分析，可在 ScopeSpec 中显式开启（见文档"已知限制"）。
GENERIC_WORD_BRANDS = {
    "apple", "drop", "surface", "mode", "continue", "creative", "fellow", "avocado",
    "topping", "monitor", "prime", "aura", "arc", "flow", "frame", "halo", "echo", "beam",
}

# --------------------------------------------------------------------------- #
# 2. 品类 / 子品类种子
# --------------------------------------------------------------------------- #
CATEGORIES: dict[str, list[str]] = {
    "headphones": ["headphones", "headphone", "over-ear", "on-ear", "open-back", "closed-back", "cans"],
    "earbuds": ["earbuds", "earbud", "iems", "iem", "in-ear", "tws", "true wireless"],
    "keyboard": ["keyboard", "keyboards", "mechanical keyboard", "keeb", "keebs"],
    "ai_tool": ["ai assistant", "ai tool", "llm", "chatbot", "coding agent", "ai subscription", "copilot"],
    "sleep": ["mattress", "mattresses", "sleep tracker", "white noise", "earplugs", "pillow", "sleep aid"],
    "kitchen": ["air fryer", "blender", "coffee machine", "espresso machine", "pressure cooker", "kettle"],
    "cleaning": ["robot vacuum", "vacuum", "mop", "air purifier"],
    "wearable": ["smartwatch", "fitness tracker", "smart ring", "fitness ring"],
}
CATEGORY_TERMS: dict[str, str] = {t: c for c, lst in CATEGORIES.items() for t in lst}

# --------------------------------------------------------------------------- #
# 3. 属性（canonical -> 同义表达）
# --------------------------------------------------------------------------- #
ATTRIBUTES: dict[str, list[str]] = {
    "音质": ["sound quality", "audio quality", "sound", "tonality", "timbre", "soundstage", "imaging"],
    "低频": ["bass", "low end", "sub bass", "subbass", "low-end"],
    "中频": ["mids", "midrange", "vocals", "mid range"],
    "高频": ["treble", "highs", "high end", "sibilance", "bright"],
    "降噪": ["anc", "noise cancelling", "noise canceling", "noise cancellation", "noise isolation", "isolation"],
    "通透模式": ["transparency mode", "ambient mode", "passthrough"],
    "舒适度": ["comfort", "comfortable", "uncomfortable", "clamp", "headband", "earpads", "ear tips", "fit"],
    "续航": ["battery life", "battery", "playtime", "runtime", "charge", "charging"],
    "延迟": ["latency", "lag", "delay", "audio delay"],
    "麦克风": ["mic", "microphone", "call quality", "mic quality"],
    "做工": ["build quality", "build", "materials", "creak", "hinge", "durability", "durable"],
    "价格": ["price", "pricing", "cost", "expensive", "cheap", "value", "worth", "affordable", "budget"],
    "软件": ["app", "software", "firmware", "driver", "update", "eq"],
    "连接": ["bluetooth", "pairing", "connection", "connectivity", "dropout", "multipoint", "codec", "ldac", "aptx"],
    "重量": ["weight", "heavy", "lightweight", "grams"],
    "续航充电": ["usb-c", "wireless charging", "charging case", "case"],
    "售后": ["warranty", "customer service", "support", "rma", "return"],
    "手感": ["typing feel", "typing experience", "switch feel", "actuation", "tactile", "linear", "clicky", "sound"],
    "布局": ["layout", "60%", "65%", "75%", "tkl", "full size", "ansi", "iso", "knob"],
    "可定制": ["hotswap", "hot-swappable", "customizable", "qmk", "via", "remap", "modding"],
    "准确性": ["accuracy", "accurate", "hallucination", "hallucinate", "wrong", "correct"],
    "速度": ["speed", "fast", "slow", "latency", "response time", "token"],
    "上下文": ["context window", "context length", "tokens", "memory"],
    "隐私": ["privacy", "data", "local", "offline", "self-hosted", "telemetry"],
    "订阅成本": ["subscription", "monthly", "per month", "credits", "pricing tier", "free tier", "rate limit"],
    "功能": ["feature", "features", "capability", "integration", "plugin", "workflow"],
    "温度控制": ["temperature", "even cooking", "hot spot", "preheat"],
    "清洁": ["clean", "cleaning", "dishwasher", "washable", "nonstick"],
    "噪音": ["noise", "loud", "quiet", "volume"],
    "尺寸": ["size", "footprint", "compact", "large", "storage"],
    "支撑": ["support", "firmness", "sink", "sag", "pressure relief"],
    "透气": ["cooling", "temperature", "hot sleeper", "breathable"],
}
# 先到先得：同一 surface 只归属第一个属性（"sound" 应归"音质"，而非"手感"）
ATTR_TERMS: dict[str, str] = {}
for canon, syns in ATTRIBUTES.items():
    for s in syns:
        ATTR_TERMS.setdefault(s, canon)
for c in ATTRIBUTES:
    ATTR_TERMS.setdefault(c, c)
ATTR_KEYS = sorted(ATTR_TERMS.keys(), key=len, reverse=True)

# --------------------------------------------------------------------------- #
# 4. 使用场景
# --------------------------------------------------------------------------- #
SCENARIOS: dict[str, list[str]] = {
    "通勤": ["commute", "commuting", "subway", "train", "bus", "walking to work"],
    "办公": ["office", "work", "workplace", "cubicle", "open office", "meetings", "calls"],
    "游戏": ["gaming", "game", "fps", "competitive", "console", "pc gaming"],
    "运动": ["gym", "workout", "running", "run", "cycling", "hiking", "exercise", "sweat"],
    "旅行": ["travel", "flight", "plane", "airplane", "airport", "hotel", "trip"],
    "居家": ["home", "apartment", "living room", "bedroom", "kitchen", "house"],
    "学习": ["study", "studying", "school", "college", "university", "library", "lecture"],
    "睡眠": ["sleep", "sleeping", "bed", "night", "insomnia", "nap"],
    "编程": ["coding", "programming", "development", "dev", "debugging", "ide"],
    "写作": ["writing", "drafting", "blog", "docs", "essay"],
    "亲子": ["kids", "children", "baby", "family", "toddler"],
    "开车": ["car", "driving", "road trip", "commute by car"],
    "户外": ["outdoor", "camping", "beach", "park", "trail"],
    "咖啡馆": ["cafe", "coffee shop", "coworking", "remote work"],
}
SCENARIO_TERMS: dict[str, str] = {}
for canon, syns in SCENARIOS.items():
    for s in syns:
        SCENARIO_TERMS[s] = canon
SCENARIO_TERMS.update({c: c for c in SCENARIOS})
SCENARIO_KEYS = sorted(SCENARIO_TERMS.keys(), key=len, reverse=True)

# --------------------------------------------------------------------------- #
# 5. 痛点模式（正则 -> 痛点类型）
# --------------------------------------------------------------------------- #
PAIN_PATTERNS: list[tuple[str, str]] = [
    ("故障损坏", r"\b(broke|broken|died|dead|stopped working|won'?t turn on|failed|defective|malfunction\w*)\b"),
    ("质量差", r"\b(cheap(ly)? made|flimsy|creak\w*|fell apart|poor quality|build quality is (bad|poor))\b"),
    ("不舒适", r"\b(hurt\w*|painful|uncomfortable|too tight|clamp\w*|ear fatigue|sore)\b"),
    ("续航差", r"\b(battery (life )?(is )?(bad|poor|terrible|short)|dies (fast|quickly)|drain\w*)\b"),
    ("连接问题", r"\b(disconnect\w*|dropout\w*|pairing (issue|problem|fail\w*)|won'?t pair|laggy)\b"),
    ("价格贵", r"\b(overpriced|too expensive|not worth|rip ?off|pricey|costs? too much)\b"),
    ("软件问题", r"\b(app (is )?(buggy|broken|terrible)|firmware (issue|bug)|update broke|driver (issue|problem))\b"),
    ("售后差", r"\b(customer service (is )?(bad|terrible|awful)|no support|warranty (denied|void)|rma)\b"),
    ("尺寸不合", r"\b(too (big|small|large|tight|loose)|doesn'?t fit|fit issue)\b"),
    ("功能缺失", r"\b(wish it had|no \w+ (mode|option|support)|missing \w+|lacks? \w+)\b"),
    ("效果不符", r"\b(didn'?t work|doesn'?t work|no difference|not effective|useless|gimmick)\b"),
    ("退货后悔", r"\b(returned (it|them)|sent it back|refund|regret (buying|purchasing))\b"),
    ("噪音大", r"\b(too loud|noisy|whine|humming)\b"),
    ("发热", r"\b(overheat\w*|too hot|gets hot|heat issue)\b"),
    ("兼容性", r"\b(not compatible|compatibility (issue|problem)|doesn'?t work with)\b"),
]
PAIN_RES = [(t, re.compile(p, re.I)) for t, p in PAIN_PATTERNS]

# --------------------------------------------------------------------------- #
# 6. 多标签意图（29 类，二级 → 一级）
# --------------------------------------------------------------------------- #
INTENT_RULES: dict[str, dict] = {
    # 需求
    "求推荐": {"group": "需求", "patterns": [
        r"\b(recommend\w*|suggestions?|what should i (buy|get)|which one should|any (good )?recommendations?)\b",
        r"\b(looking for|in the market for|shopping for|need (a|some) (new )?\w+)\b",
        r"\b(help me (choose|pick)|advice on (buying|choosing))\b",
    ]},
    "寻找解决方案": {"group": "需求", "patterns": [
        r"\b(how (do|can) i (fix|solve|stop)|is there (a|any) way to|solution for|workaround)\b",
        r"\b(anyone (else )?(found|know) (a|any) (fix|way))\b",
    ]},
    "寻找替代品": {"group": "需求", "patterns": [
        r"\b(alternatives? to|instead of|something (similar|like)|replace(ment)? for|equivalent (to|of))\b",
        r"\b(what else (is|are) (there|out there))\b",
    ]},
    "组合需求": {"group": "需求", "patterns": [
        r"\b(and also|but also|with (both|all)|needs? to (also|both)|combination of)\b",
        r"\b\w+ (and|plus|\+) \w+ (that|which) (also|both)\b",
    ]},
    "功能请求": {"group": "需求", "patterns": [
        r"\b(wish (it|they|there) (had|was|were)|should (add|have|include)|feature request|please add)\b",
        r"\b(why (is )?there no|needs? a \w+ (mode|option|feature))\b",
    ]},
    # 考虑
    "产品比较": {"group": "考虑", "patterns": [r"\b(\w+) (vs\.?|versus|or) (\w+)\b", r"\bcompar\w* (between|of)\b", r"\bwhich is better\b"]},
    "品牌比较": {"group": "考虑", "patterns": [r"\b(brand|make) (comparison|x vs y)\b", r"\b(switched|choosing) between\b"]},
    "价格比较": {"group": "考虑", "patterns": [r"\b(cheaper than|worth the (extra|difference)|price difference)\b", r"\b(deal|discount|sale|coupon)\b"]},
    "购买计划": {"group": "考虑", "patterns": [r"\b(planning to (buy|get)|going to (buy|get)|thinking about (buying|getting)|about to (buy|order))\b"]},
    "预算询问": {"group": "考虑", "patterns": [r"\b(budget|how much (should|do) i (spend|pay)|price range|under \$?\d+)\b"]},
    # 购买
    "已购买": {"group": "购买", "patterns": [r"\b(i (just )?(bought|ordered|picked up|got) (a|an|the|my)|pulled the trigger|finally (got|bought))\b"]},
    "下单订购": {"group": "购买", "patterns": [r"\b(ordered|pre-?ordered|checkout|shipped|arriving)\b"]},
    # 使用
    "产品体验": {"group": "使用", "patterns": [r"\b(after (a|one|two|\d+) (week|month|day)s? of use|been using (it|them)|my experience)\b"]},
    "满意称赞": {"group": "使用", "patterns": [r"\b(love (it|them|this)|amazing|excellent|fantastic|blown away|worth every penny|highly recommend)\b"]},
    "推荐他人": {"group": "使用", "patterns": [r"\b(i (would|'d) recommend|go (for|with) (it|them)|you should (get|buy))\b"]},
    "抱怨投诉": {"group": "使用", "patterns": [r"\b(disappoint\w*|frustrat\w*|angry|annoy\w*|sucks|worst|terrible|awful)\b"]},
    "产品故障": {"group": "使用", "patterns": [r"\b(broke|broken|stopped working|defective|died after|rma|warranty claim)\b"]},
    "退货退款": {"group": "使用", "patterns": [r"\b(returned|refund|sent (it|them) back|money back)\b"]},
    "弃用": {"group": "使用", "patterns": [r"\b(stopped using|gave up on|sold (it|them)|collecting dust|switched away)\b"]},
    # 迁移
    "切换产品": {"group": "迁移", "patterns": [r"\b(switched (from|to)|moved (from|to)|upgraded (from|to)|replaced (my )?\w+ with)\b"]},
    "切换品牌": {"group": "迁移", "patterns": [r"\b(went (back )?to (brand|company)|brand (switch|loyalty)|never buying \w+ again)\b"]},
    # 创新
    "变通方案": {"group": "创新", "patterns": [r"\b(workaround|hack|jury[- ]rig\w*|i just use|as a (stand|substitute)|make ?shift)\b"]},
    "DIY 解决方案": {"group": "创新", "patterns": [r"\b(diy|built my own|3d print\w*|homemade|custom (build|mod))\b"]},
    "新使用场景": {"group": "创新", "patterns": [r"\b(started using (it|them) for|also works for|use (it|them) as a)\b"]},
    # 资讯
    "产品发布": {"group": "资讯", "patterns": [r"\b(announc\w*|launch\w*|released?|unveil\w*|new (model|version|generation))\b"]},
    "新闻事件": {"group": "资讯", "patterns": [r"\b(news|report\w*|article|says|according to)\b"]},
    "传闻猜测": {"group": "资讯", "patterns": [r"\b(rumou?r\w*|leak\w*|allegedly|supposedly|might be|speculat\w*)\b"]},
    # 其他
    "一般讨论": {"group": "其他", "patterns": []},
}
INTENT_GROUP = {k: v["group"] for k, v in INTENT_RULES.items()}
INTENT_KEYS = list(INTENT_RULES.keys())
_INTENT_RES = {k: [re.compile(p, re.I) for p in v["patterns"]] for k, v in INTENT_RULES.items()}

# --------------------------------------------------------------------------- #
# 7. 迁移 / 比较 / 替代 / 变通 关系模板
# --------------------------------------------------------------------------- #
REL_PATTERNS: dict[str, list[str]] = {
    "SWITCH": [
        r"(?:switched|moving|moved|upgraded|changed)\s+from\s+(?:my\s+|the\s+)?([A-Za-z0-9][\w\s\-\.\+]{1,30}?)\s+to\s+(?:the\s+)?([A-Za-z0-9][\w\s\-\.\+]{1,30}?)(?:[.,;!?]|\s+(?:and|because|since|as)\b)",
        r"(?:replaced|returned)\s+(?:my\s+|the\s+)?([A-Za-z0-9][\w\s\-\.\+]{1,30}?)\s+with\s+(?:a\s+|an\s+|the\s+)?([A-Za-z0-9][\w\s\-\.\+]{1,30}?)(?:[.,;!?]|\s+(?:and|because)\b)",
        r"([A-Za-z0-9][\w\s\-\.\+]{1,30}?)\s+instead of\s+(?:the\s+)?([A-Za-z0-9][\w\s\-\.\+]{1,30}?)(?:[.,;!?]|\s+(?:and|because)\b)",
    ],
    "COMPARE": [
        r"([A-Za-z0-9][\w\s\-\.\+]{1,28}?)\s+(?:vs\.?|versus)\s+([A-Za-z0-9][\w\s\-\.\+]{1,28}?)(?:[.,;!?]|\s+(?:for|on|when|and)\b)",
    ],
    "ALTERNATIVE": [
        r"alternatives?\s+to\s+(?:the\s+)?([A-Za-z0-9][\w\s\-\.\+]{1,30})",
        r"instead of\s+(?:the\s+)?([A-Za-z0-9][\w\s\-\.\+]{1,30})",
    ],
    "WORKAROUND": [
        r"(?:use|using)\s+(?:my\s+|a\s+|an\s+|the\s+)?([A-Za-z0-9][\w\s\-\.\+]{1,30}?)\s+(?:as a|as an|to)\s+([A-Za-z0-9][\w\s\-\.\+]{1,30})",
        r"(?:workaround|hack)\s*(?:is|:)\s*([^.\n]{5,80})",
    ],
}
REL_RES = {k: [re.compile(p, re.I) for p in v] for k, v in REL_PATTERNS.items()}

# --------------------------------------------------------------------------- #
# 8. 价格表达
# --------------------------------------------------------------------------- #
RE_PRICE = re.compile(
    r"(?:(?P<cur1>[$€£¥])\s?(?P<v1>\d{1,6}(?:[.,]\d{1,3})?))"
    r"|(?:(?P<v2>\d{1,6}(?:[.,]\d{1,3})?)\s?(?P<cur2>usd|eur|gbp|dollars?|bucks|euros?|pounds?|元|块|rmb|cny))",
    re.I,
)
PRICE_CONTEXT = {
    "预算": [r"\bbudget\b", r"\bwilling to (pay|spend)\b", r"\bup to\b", r"\bmax(imum)?\b", r"\bunder\b", r"\bno more than\b"],
    "实付": [r"\bbought .* for\b", r"\bpaid\b", r"\bgot (it|them) for\b", r"\bpicked up for\b"],
    "标价": [r"\bmsrp\b", r"\bretail(s)? for\b", r"\blist price\b", r"\brrp\b"],
    "折扣": [r"\bon sale\b", r"\bdiscount\w*\b", r"\bdeal\b", r"\bcoupon\b", r"\b\d+% off\b", r"\bprice drop\b"],
    "上限": [r"\bmax\b", r"\bceiling\b", r"\bcap\b", r"\bno more than\b"],
    "可接受": [r"\bfair price\b", r"\breasonable\b", r"\bworth\b", r"\bacceptable\b"],
    "抱怨": [r"\boverpriced\b", r"\btoo expensive\b", r"\bpricey\b", r"\brip ?off\b"],
    "订阅": [r"\bper month\b", r"/mo\b", r"\bmonthly\b", r"\bsubscription\b", r"\byearly\b", r"\bannual\b"],
}
PRICE_CTX_RES = {k: [re.compile(p, re.I) for p in v] for k, v in PRICE_CONTEXT.items()}
CURRENCY_NORM = {"$": "USD", "usd": "USD", "dollar": "USD", "dollars": "USD", "buck": "USD", "bucks": "USD",
                 "€": "EUR", "eur": "EUR", "euro": "EUR", "euros": "EUR",
                 "£": "GBP", "gbp": "GBP", "pound": "GBP", "pounds": "GBP",
                 "¥": "CNY", "元": "CNY", "块": "CNY", "rmb": "CNY", "cny": "CNY"}

# --------------------------------------------------------------------------- #
# 9. 情绪与评价词典（文档/实体/属性三级共用）
# --------------------------------------------------------------------------- #
POS_WORDS = set("""good great amazing awesome excellent love loved like liked nice best better worth perfect
beautiful helpful thanks brilliant fantastic wonderful solid enjoy enjoyed recommend impressive super cool
flawless comfortable comfy clean fast accurate reliable sturdy premium happy glad satisfied pleased
完美 很好 不错 喜欢 优秀 感谢 很棒 舒服 满意 推荐 性价比 清晰 稳定 快""".split())
NEG_WORDS = set("""bad worse worst terrible awful hate hated trash garbage shit sucks suck annoying broken bug bugs
useless stupid disappointed disappointing sad angry wrong fail failed failure poor boring toxic scam waste
overpriced expensive flimsy uncomfortable unusable defective regret refund returned
垃圾 差 烂 讨厌 失望 生气 恶心 无语 崩溃 难用 错误 失败 问题 贵 退货 后悔""".split())
NEGATORS = set("""not no never nor none cannot cant can't dont don't doesnt doesn't didnt didn't isnt isn't
arent aren't wasnt wasn't werent weren't hardly barely without lack lacks lacking""".split())
INTENSIFIERS = {"very": 1.4, "really": 1.35, "extremely": 1.6, "super": 1.45, "so": 1.3, "too": 1.35,
                "quite": 1.2, "absolutely": 1.6, "totally": 1.4, "incredibly": 1.55, "slightly": 0.7,
                "a bit": 0.75, "kinda": 0.8, "pretty": 1.15}
CONTRAST = re.compile(r"\b(but|however|although|though|except|whereas|yet)\b", re.I)

# --------------------------------------------------------------------------- #
# 10. 自述特征（年龄/性别/职业，匿名聚合）
# --------------------------------------------------------------------------- #
SELF_REPORT = {
    "age": re.compile(r"\b(?:i'?m|i am|as a|im)\s+(\d{2})\s?[mf]\b|\b(\d{2})\s?[mf]\b", re.I),
    "occupation": re.compile(
        r"\b(?:i'?m|i am|as a|work as a|working as a)\s+(?:a|an)?\s?(engineer|developer|nurse|teacher|student|designer|"
        r"doctor|lawyer|manager|technician|artist|writer|researcher|consultant|accountant|electrician|chef|driver)\b", re.I),
    "region": re.compile(r"\b(?:in|from)\s+(the\s+)?(us|usa|uk|canada|australia|germany|india|brazil|france|japan|"
                         r"korea|china|netherlands|sweden|poland|spain|italy|mexico|pakistan|philippines)\b", re.I),
}

# --------------------------------------------------------------------------- #
# 11. 通用停用词（用于特征词/短语）
# --------------------------------------------------------------------------- #
FUNCTION_WORDS = set("""the a an and or but if then than that this these those i you he she it we they me him her us them
my your his its our their is are was were be been being am do does did have has had will would can could should
may might must not no nor so as at by for from in into of on onto out over to up with about after before again
just very too also more most some any all other such only own same than then there here what which who whom when
where why how because while during through between both each few many much get got go going like want need know
think really actually basically probably maybe still even much lot bit thing things way something someone anyone
everyone people time times day days week month year years good bad better best worse worst
first last next new old big small little long short high low right left
""".split()) | POS_WORDS | NEG_WORDS

# 闲聊词：自动词典候选里最常见的噪声来源
CHAT_WORDS = set("""yeah yes yep nope nah no ok okay oh ah um uh hey hi hello thanks thank thx lol lmao rofl
haha hmm hm well really actually basically literally honestly probably maybe obviously seriously
guys guy dude bro man op edit update tldr imo imho btw fyi afaik iirc tbh smh nta yta aita
anyone someone everyone somebody nobody something anything nothing thing things stuff
one ones other others another same different such very much many more most less least
first second third last next new old good bad better best worse worst big small little long short
feel feels feeling look looks looking get got gets make makes made take took go goes going
want wants wanted need needs needed know knows think thinks thought say says said see saw seen
people person time times day days week weeks month months year years way ways lot lots bit
u ur r im ive id youre dont doesnt didnt cant wont isnt arent wasnt thats theres
shut actually guess suppose mean means mean feel feels
however therefore though although instead always never without since getting trying
everything anything anyone pretty away back still around maybe sounds listen watching
asking wondering thinking saying talking looking something nothing else also even
buy bought buying use used using work working works done does doing
""".split())

# 名词短语线索：属性候选需要"像名词"
DETERMINERS = set("the my your his her its our their this that these those a an some any no every".split())

# --------------------------------------------------------------------------- #
# 12. 自动领域词候选的过滤词（避免把泛词/品牌当"属性"）
# --------------------------------------------------------------------------- #
def is_content_term(t: str) -> bool:
    """单 token 是否有内容（用于 n-gram 组件过滤）。"""
    t = t.lower().strip()
    if len(t) < 3 or t.isdigit():
        return False
    if t in FUNCTION_WORDS or t in CHAT_WORDS:
        return False
    return True


def is_valid_phrase(g: str, max_n: int = 3) -> bool:
    """短语级过滤：每个组件都要有内容，且不能以虚词开头/结尾。"""
    parts = g.split()
    if not parts or len(parts) > max_n:
        return False
    if not all(is_content_term(p) for p in parts):
        return False
    return True
