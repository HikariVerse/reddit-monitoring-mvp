export interface ParsedResearchQuery {
  originalTopic: string;
  coreTerms: string[];
  aliases: string[];
  expandedTerms: string[];
  intentTerms: string[];
  pgTerms: string[];
  englishQuery: string;
  englishExactQuery: string | null;
  hasChinese: boolean;
  ambiguityWarnings: string[];
  suggestedSubreddits: string[];
  translationSource: "passthrough" | "dictionary" | "user_override" | "fallback";
}

interface BilingualEntry {
  patterns: RegExp[];
  english: string;
  exactPhrase?: string;
  aliases: string[];
  expanded: string[];
  subreddits?: string[];
  ambiguity?: string;
}

const BILINGUAL_DICT: readonly BilingualEntry[] = [
  {
    patterns: [/开放式耳机|挂耳式耳机|骨传导耳机|气传导耳机|open[\s-]*ear/i],
    english: '("open ear" OR "open-ear" OR shokz) AND (headphones OR earbuds OR audio OR running)',
    exactPhrase: '"open ear headphones" OR "open-ear earbuds" OR shokz',
    aliases: ["open ear", "open-ear", "Shokz", "open earbuds"],
    expanded: ["bone conduction", "clip-on earbuds", "running headphones"],
    subreddits: ["headphones", "headphoneadvice", "earbuds", "running"],
  },
  {
    patterns: [/便携式电源|便携电源|户外电源|储能电源|portable\s+power\s+station/i],
    english: '"portable power station" OR (ecoflow OR jackery OR bluetti)',
    exactPhrase: '"portable power station"',
    aliases: ["portable power station", "EcoFlow", "Jackery", "Bluetti"],
    expanded: ["solar generator", "camping battery", "backup power"],
    subreddits: ["solardiy", "campinggear", "urbancarliving", "preppers"],
  },
  {
    patterns: [/编程代理|ai\s*编程|代码助手|coding\s+agent/i],
    english: '"coding agent" OR "claude code" OR (codex AND coding)',
    exactPhrase: '"coding agent"',
    aliases: ["coding agent", "Claude Code", "Codex", "Cursor"],
    expanded: ["AI coding", "agentic coding", "dev agent"],
    subreddits: ["claudecode", "codex", "claudeai", "cursor", "localllama"],
  },
  {
    patterns: [/\bcodex\b/i],
    english: 'codex AND (openai OR coding OR cli OR agent OR claude)',
    exactPhrase: '"openai codex" OR "codex cli"',
    aliases: ["Codex", "OpenAI Codex", "Codex CLI"],
    expanded: ["Claude Code", "coding agent"],
    subreddits: ["codex", "openai", "claudeai", "claudecode"],
    ambiguity: "“Codex”在英文社区可能同时命中战锤规则书（Warhammer Codex）或硬件型号（MSI Codex），建议结合产品/社区语境过滤。",
  },
  {
    patterns: [/\bgemini\b/i],
    english: 'gemini AND (google OR ai OR model OR cli OR api OR llm)',
    exactPhrase: '"google gemini" OR "gemini cli"',
    aliases: ["Gemini", "Google Gemini", "Gemini CLI"],
    expanded: ["Gemini Pro", "Gemini Flash"],
    subreddits: ["geminiai", "google_antigravity", "localllama", "singularity"],
    ambiguity: "“Gemini”在英文社区可能同时命中星座（双子座）或加密货币交易所，已优先结合 AI 产品语境消歧。",
  },
  {
    patterns: [/\bgrok\b/i],
    english: "Grok",
    exactPhrase: null as unknown as string,
    aliases: ["Grok", "xAI Grok"],
    expanded: ["Grok 3", "Grok 4", "xAI"],
    subreddits: ["grok", "xai", "localllama", "openai"],
  },
  {
    patterns: [/\bclaude\b/i],
    english: "Claude",
    aliases: ["Claude", "Claude Code", "Anthropic Claude"],
    expanded: ["Claude Sonnet", "Claude Opus", "MCP"],
    subreddits: ["claudeai", "claudecode", "anthropic", "localllama"],
  },
  {
    patterns: [/\bchatgpt\b/i],
    english: "ChatGPT",
    aliases: ["ChatGPT", "OpenAI ChatGPT"],
    expanded: ["GPT-4o", "GPT-5", "OpenAI"],
    subreddits: ["chatgpt", "openai", "artificial"],
  },
  {
    patterns: [/扫地机器人|洗地机|robot\s+vacuum/i],
    english: '"robot vacuum" OR roborock OR dreame OR roomba',
    exactPhrase: '"robot vacuum"',
    aliases: ["robot vacuum", "Roborock", "Dreame", "Roomba"],
    expanded: ["robot mop", "self-emptying vacuum"],
    subreddits: ["robotvacuums", "smarthome", "buyitforlife"],
  },
  {
    patterns: [/咖啡机|意式咖啡|espresso\s+machine/i],
    english: '"espresso machine" OR breville OR delonghi',
    exactPhrase: '"espresso machine"',
    aliases: ["espresso machine", "Breville", "DeLonghi"],
    expanded: ["coffee maker", "grinder"],
    subreddits: ["espresso", "coffee"],
  },
  {
    patterns: [/电动牙刷|冲牙器|electric\s+toothbrush/i],
    english: '"electric toothbrush" OR sonicare OR "oral-b"',
    exactPhrase: '"electric toothbrush"',
    aliases: ["electric toothbrush", "Sonicare", "Oral-B"],
    expanded: ["water flosser"],
    subreddits: ["dentalhygiene", "buyitforlife"],
  },
  {
    patterns: [/人体工学椅|办公椅|ergonomic\s+chair/i],
    english: '"ergonomic chair" OR "herman miller" OR steelcase',
    exactPhrase: '"ergonomic chair"',
    aliases: ["ergonomic chair", "Herman Miller", "Steelcase"],
    expanded: ["office chair", "lumbar support"],
    subreddits: ["officechairs", "battlestations", "ergonomics"],
  },
  {
    patterns: [/投影仪|家用投影|projector/i],
    english: 'projector AND (home OR portable OR 4k OR xgimi OR benq)',
    exactPhrase: '"portable projector" OR "home projector"',
    aliases: ["projector", "XGIMI", "BenQ"],
    expanded: ["4k projector", "mini projector"],
    subreddits: ["projectors", "hometheater"],
  },
  {
    patterns: [/宠物喂食器|智能猫砂盆|自动猫砂盆|litter\s*robot|pet\s+feeder/i],
    english: '"litter robot" OR "automatic litter box" OR "pet feeder"',
    exactPhrase: '"automatic litter box" OR "litter robot"',
    aliases: ["Litter Robot", "automatic litter box", "pet feeder"],
    expanded: ["smart cat litter", "pet camera"],
    subreddits: ["cats", "litterrobot"],
  },
];

const INTENT_NOISE_RX =
  /(消费者需求|市场研究|产品痛点|用户痛点|口碑|竞品分析|购买决策|价格分析|舆情分析|趋势分析|行业简报|日报|周报|分析|研究|洞察|报告|需求|痛点|体验|评价|建议|对比)/g;

const AMBIGUOUS_SINGLE_WORDS: Record<string, string> = {
  gemini: "“Gemini”容易与星座或交易所混淆，建议搭配 AI / Google / 模型词或限定社区。",
  codex: "“Codex”容易与战锤规则书或 MSI 主机型号混淆，建议搭配 OpenAI / CLI / coding。",
  delta: "“Delta”可能同时命中航空公司、水龙头或数学术语，建议补充品类限定词。",
  apple: "“Apple”可能命中水果与科技品牌，建议补充具体产品型号（如 AirPods / MacBook）。",
  amazon: "“Amazon”可能命中电商平台、AWS 或雨林，建议补充具体品类或服务名。",
};

export function sanitizeArchiveQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Strip pure CJK characters when building an R4 Latin-indexed FTS expression
  const stripped = trimmed.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/g, " ").replace(/\s+/g, " ").trim();
  return stripped.slice(0, 240);
}

export function parseResearchQuery(input: {
  topic: string;
  question?: string;
  aliases?: string[];
  englishQuery?: string;
}): ParsedResearchQuery {
  const originalTopic = (input.topic || input.question || "").trim();
  const combined = `${originalTopic} ${input.question ?? ""}`.trim();
  const hasChinese = /[\u4e00-\u9fff]/.test(combined);
  const intentMatches = [...new Set(combined.match(INTENT_NOISE_RX) ?? [])];
  const cleanedSubject = originalTopic.replace(INTENT_NOISE_RX, " ").replace(/[，。！？、；：（）()【】]/g, " ").replace(/\s+/g, " ").trim() || originalTopic;

  const matchedEntry = BILINGUAL_DICT.find((entry) => entry.patterns.some((rx) => rx.test(combined)));
  const userAliases = (input.aliases ?? []).map((a) => a.trim()).filter(Boolean);

  const ambiguityWarnings: string[] = [];
  if (matchedEntry?.ambiguity) ambiguityWarnings.push(matchedEntry.ambiguity);
  for (const [word, warn] of Object.entries(AMBIGUOUS_SINGLE_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(combined) && !ambiguityWarnings.includes(warn)) {
      ambiguityWarnings.push(warn);
    }
  }

  let englishQuery = "";
  let englishExactQuery: string | null = null;
  let translationSource: ParsedResearchQuery["translationSource"] = "passthrough";

  if (input.englishQuery && input.englishQuery.trim()) {
    englishQuery = sanitizeArchiveQuery(input.englishQuery);
    translationSource = "user_override";
  } else if (matchedEntry) {
    englishQuery = matchedEntry.english;
    englishExactQuery = matchedEntry.exactPhrase ?? null;
    translationSource = hasChinese ? "dictionary" : "passthrough";
  } else {
    const latin = sanitizeArchiveQuery(cleanedSubject);
    if (latin && /[a-z0-9]{2,}/i.test(latin)) {
      const words = latin.split(/\s+/).filter((w) => w.length >= 2);
      englishQuery = words.length > 1 && !/\b(?:AND|OR|NOT)\b/i.test(latin) && !latin.includes('"')
        ? words.join(" ")
        : latin;
      if (words.length >= 2 && !latin.includes('"') && !/\b(?:AND|OR|NOT)\b/i.test(latin)) {
        englishExactQuery = `"${words.join(" ")}"`;
      }
      translationSource = "passthrough";
    } else if (userAliases.length > 0) {
      const latinAliases = userAliases.map(sanitizeArchiveQuery).filter((a) => /[a-z0-9]{2,}/i.test(a));
      englishQuery = latinAliases.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" OR ");
      translationSource = "user_override";
    } else {
      englishQuery = "";
      translationSource = "fallback";
    }
  }

  const coreTerms = [
    ...new Set([
      ...(cleanedSubject ? [cleanedSubject] : []),
      ...(matchedEntry ? matchedEntry.aliases.slice(0, 2) : []),
    ]),
  ].filter((t) => t.length >= 2);

  const aliases = [...new Set([...userAliases, ...(matchedEntry?.aliases ?? [])])];
  const expandedTerms = [...new Set(matchedEntry?.expanded ?? [])];
  const pgTerms = [
    ...new Set([
      ...coreTerms,
      ...aliases,
      ...(englishQuery
        ? englishQuery
            .replace(/\b(?:AND|OR|NOT)\b/gi, " ")
            .replace(/[()"']/g, " ")
            .split(/\s+/)
            .filter((t) => t.length >= 2)
        : []),
    ]),
  ].slice(0, 6);

  return {
    originalTopic,
    coreTerms,
    aliases,
    expandedTerms,
    intentTerms: intentMatches,
    pgTerms,
    englishQuery,
    englishExactQuery,
    hasChinese,
    ambiguityWarnings,
    suggestedSubreddits: matchedEntry?.subreddits ?? [],
    translationSource,
  };
}
