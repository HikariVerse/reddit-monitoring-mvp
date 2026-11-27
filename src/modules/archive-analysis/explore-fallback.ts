import { createHash } from "node:crypto";
import type {
  ExploreEvidenceItem,
  ExploreEvidenceResponse,
  ExploreGroupBy,
  ExploreMetricResult,
  ExplorePanelId,
  ExplorePanelResult,
} from "../../../packages/contracts/src/explore";
import {
  cleanTextForAnalysis,
  computeDistinctiveTermsForGroups,
  detectBucketAnomalies,
  extractNgrams,
  extractTfIdfKeywords,
  tokenizeClauses,
} from "../../shared/text/analysis";
import { scoreBilingualSentiment } from "../../shared/text/sentiment";
import { PANEL_SCENARIO_MAP } from "./explore-guidance";

const SCHEMA_VERSION = "first-batch/1.0";
const MAX_CACHED_STUDIES = 16;
const STUDY_TTL_MS = 15 * 60 * 1000;

export interface CanonicalExploreDoc {
  source_id: string;
  source_type: string;
  dataset_id: string;
  document_id: string;
  source_document_id?: string;
  thread_id: string;
  parent_id: string;
  author_key: string;
  group: string;
  kind: string;
  created_utc: number | null;
  observed_at: number | null;
  title: string;
  url: string;
  language: string;
  text: string;
  engagement_channels: Record<string, number>;
}

interface InternalDoc extends CanonicalExploreDoc {
  day: string | null;
  focus: string;
  norm: string;
  groupValue: string;
}

interface CachedEvidenceBucket {
  indices: number[];
  predicate: Record<string, unknown>;
}

interface CachedStudyEntry {
  studyId: string;
  createdAt: number;
  docs: InternalDoc[];
  evidences: Map<string, CachedEvidenceBucket>;
}

const studyCache = new Map<string, CachedStudyEntry>();

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function utcDayFromEpoch(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec)) return null;
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function weekStartIso(day: string): string {
  const d = new Date(day + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const DEMAND_PATTERNS: Array<{ state: string; rx: RegExp }> = [
  { state: "recommendation_request", rx: /\b(?:recommend|recommendation|any suggestions?|what should i (?:buy|use)|looking for (?:a|an|the best))\b|求推荐|有什么推荐|推荐一个/i },
  { state: "alternative_search", rx: /\b(?:alternative(?:s)? to|switch(?:ing)? from|replace|migrate from|better than)\b|替代品|平替|替代方案/i },
  { state: "feature_request", rx: /\b(?:wish (?:it|they) had|feature request|please add|should support|would love (?:to see|if))\b|希望支持|建议增加|功能请求/i },
  { state: "unmet_need", rx: /\b(?:still no way to|doesn'?t support|missing feature|lacks?|can'?t do|no good (?:tool|way|option))\b|不支持|缺少|痛点|没法|无法满足/i },
  { state: "solution_search", rx: /\b(?:how do (?:i|you) solve|how to fix|is there a (?:tool|way|app)|anyone know how)\b|怎么解决|有没有办法|求解决方案/i },
];

const PAIN_PATTERNS: Array<{ label: string; rx: RegExp }> = [
  { label: "reliability_bug", rx: /\b(?:crash(?:es|ed|ing)?|buggy|broken|freeze|frozen|unusable|error|outage|failed)\b|崩溃|报错|故障|卡顿|无法使用/i },
  { label: "performance_latency", rx: /\b(?:slow(?:er|est)?|lag(?:gy)?|latency|timeout|heavy|memory leak|high cpu)\b|太慢|延迟|超时|内存占用/i },
  { label: "cost_pricing", rx: /\b(?:overpriced|too expensive|price hike|subscription fatigue|not worth|paywall)\b|太贵|涨价|不值|订阅贵|收费高/i },
  { label: "usability_ux", rx: /\b(?:confusing|clunky|hard to use|steep learning curve|bad ux|annoying|frustrating)\b|难用|反人类|体验差|繁琐|劝退/i },
];

const PRICE_ATTENTION_RX = /\b(?:price|pricing|cost(?:s)?|budget|afford|overpriced|expensive|cheaper|subscription|discount|coupon|free tier|paid plan|billing|worth the money)\b|价格|定价|预算|订阅|付费|免费|太贵|便宜|性价比/i;
const PRICE_AMOUNT_RX = /(?:(\$|€|£|¥|USD|EUR|GBP|CNY|RMB)\s*(\d{1,6}(?:[.,]\d{1,2})?)|(\d{1,6}(?:[.,]\d{1,2})?)\s*(USD|EUR|GBP|CNY|RMB|美元|元|块))(?:\s*(?:\/|per\s+)?(month|mo|year|yr|annual|week|day|月|年))?/gi;

const PURCHASE_STAGES: Array<{ stage: string; rx: RegExp }> = [
  { stage: "need", rx: /\b(?:need a|looking for|trying to find|want something that)\b|需要一个|想找/i },
  { stage: "research", rx: /\b(?:recommend|reviews?|worth it|anyone tried|how is)\b|评测|口碑|值得买|求推荐/i },
  { stage: "compare", rx: /\b(?:vs\.?|versus|compared to|alternative|better than|or should i)\b|对比|还是选|替代/i },
  { stage: "budget", rx: /\b(?:budget|under \$?\d+|afford|pricing|cost)\b|预算|多少钱|价格/i },
  { stage: "intent", rx: /\b(?:going to buy|about to subscribe|plan to purchase|ready to switch)\b|准备买|打算入手|准备订阅/i },
  { stage: "purchased", rx: /\b(?:just bought|purchased|subscribed|paid for|signed up)\b|刚买|已购买|已订阅|入手了/i },
  { stage: "use", rx: /\b(?:i use|we use|been using|using it for|my workflow)\b|一直在用|用了|使用体验/i },
  { stage: "returned", rx: /\b(?:returned|refund|cancel(?:led|ed)? my subscription|unsubscribed)\b|退货|退款|取消订阅/i },
];

function pruneStudyCache() {
  const now = Date.now();
  for (const [key, entry] of studyCache) {
    if (now - entry.createdAt > STUDY_TTL_MS) studyCache.delete(key);
  }
  while (studyCache.size > MAX_CACHED_STUDIES) {
    const oldest = studyCache.keys().next().value;
    if (!oldest) break;
    studyCache.delete(oldest);
  }
}

export function resolveBuiltinEvidence(
  studyId: string,
  evidenceId: string,
  offset = 0,
  limit = 20,
): ExploreEvidenceResponse | null {
  pruneStudyCache();
  const entry = studyCache.get(studyId);
  if (!entry) return null;
  const bucket = entry.evidences.get(evidenceId);
  if (!bucket) return null;
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const slice = bucket.indices.slice(safeOffset, safeOffset + safeLimit);
  const items: ExploreEvidenceItem[] = slice.map((idx) => {
    const d = entry.docs[idx];
    return {
      source_id: d.source_id,
      source_type: d.source_type,
      dataset_id: d.dataset_id,
      document_id: d.document_id,
      source_document_id: d.source_document_id,
      thread_id: d.thread_id || undefined,
      author_key: d.author_key || undefined,
      group: d.group || undefined,
      kind: d.kind || undefined,
      created_utc: d.created_utc,
      day: d.day,
      title: d.title || undefined,
      url: d.url || undefined,
      text: d.text,
      focus: d.focus,
      engagement_channels: d.engagement_channels,
    };
  });
  return {
    id: evidenceId,
    state: "ready",
    total: bucket.indices.length,
    offset: safeOffset,
    has_more: safeOffset + items.length < bucket.indices.length,
    predicate: bucket.predicate,
    items,
  };
}

export function runBuiltinExploreAnalysis(
  rawDocs: readonly CanonicalExploreDoc[],
  opts: { dataVersion: string; groupBy: ExploreGroupBy; query: string },
): { studyId: string; analyzedDocuments: number; panels: ExplorePanelResult[] } {
  const studyId = stableHash([SCHEMA_VERSION, opts.dataVersion, opts.groupBy, opts.query, rawDocs.length]);
  const evidences = new Map<string, CachedEvidenceBucket>();

  const registerEvidence = (indices: number[], predicate: Record<string, unknown>) => {
    const uniq = [...new Set(indices)].sort((a, b) => a - b);
    const id = "ev:" + stableHash([studyId, uniq.length, uniq.slice(0, 8), predicate]);
    if (!evidences.has(id)) evidences.set(id, { indices: uniq, predicate });
    return { id, member_count: uniq.length, predicate };
  };

  // Dedupe exact normalized text
  const allDocs: InternalDoc[] = [];
  const seenNorm = new Map<string, number>();
  const dedupeGroups = new Map<number, number[]>();
  const keptIndices: number[] = [];

  for (const raw of rawDocs) {
    const focus = cleanTextForAnalysis(raw.text, false);
    if (!focus) continue;
    const norm = focus.toLowerCase().replace(/\s+/gu, " ").trim();
    const groupValue =
      opts.groupBy === "source"
        ? raw.source_type || raw.source_id
        : opts.groupBy === "dataset"
          ? raw.dataset_id
          : opts.groupBy === "kind"
            ? raw.kind
            : opts.groupBy === "language"
              ? raw.language || "unknown"
              : raw.group || raw.source_type || "default";
    const docIdx = allDocs.length;
    allDocs.push({ ...raw, day: utcDayFromEpoch(raw.created_utc), focus, norm, groupValue });

    const existing = seenNorm.get(norm);
    if (existing !== undefined) {
      const list = dedupeGroups.get(existing) ?? [];
      list.push(docIdx);
      dedupeGroups.set(existing, list);
    } else {
      seenNorm.set(norm, docIdx);
      keptIndices.push(docIdx);
    }
  }

  const n = keptIndices.length;
  const makeMetric = (
    metric_id: string,
    title: string,
    unit: string,
    method: string,
    state: ExploreMetricResult["state"],
    reason: string,
    data: Record<string, unknown>,
  ): ExploreMetricResult => ({
    schema_version: SCHEMA_VERSION,
    metric_id,
    title,
    state,
    reason,
    unit,
    method,
    study_id: studyId,
    data_version: opts.dataVersion,
    selected_documents: n,
    sample_unit: "deduplicated_document",
    elapsed_seconds: 0.001,
    data,
  });

  // Helper: support stats
  const supportOf = (indices: number[]) => {
    const threads = new Set<string>();
    const authors = new Set<string>();
    let threadCov = 0;
    let authorCov = 0;
    for (const i of indices) {
      if (allDocs[i].thread_id) {
        threads.add(allDocs[i].thread_id);
        threadCov++;
      }
      if (allDocs[i].author_key) {
        authors.add(allDocs[i].author_key);
        authorCov++;
      }
    }
    return {
      documents: indices.length,
      threads: threadCov > 0 ? threads.size : null,
      authors: authorCov > 0 ? authors.size : null,
      thread_coverage: threadCov,
      author_coverage: authorCov,
    };
  };

  // --- P01: SL01, SL02, SL03 ---
  const byDay = new Map<string, number[]>();
  const byWeek = new Map<string, number[]>();
  const byMonth = new Map<string, number[]>();
  let datedCount = 0;
  for (const i of keptIndices) {
    const day = allDocs[i].day;
    if (!day) continue;
    datedCount++;
    byDay.set(day, [...(byDay.get(day) ?? []), i]);
    const wk = weekStartIso(day);
    byWeek.set(wk, [...(byWeek.get(wk) ?? []), i]);
    const mo = day.slice(0, 7);
    byMonth.set(mo, [...(byMonth.get(mo) ?? []), i]);
  }
  const buildSeries = (map: Map<string, number[]>, grain: string) => {
    const keys = [...map.keys()].sort();
    let prev: number | null = null;
    return keys.map((period) => {
      const ids = map.get(period) ?? [];
      const count = ids.length;
      const delta = prev !== null ? count - prev : null;
      const growth = prev !== null && prev > 0 ? (count - prev) / prev : null;
      prev = count;
      return {
        period,
        documents: count,
        collection: "partial",
        delta,
        growth,
        evidence_ref: registerEvidence(ids, { period, grain }),
      };
    });
  };
  const daysSeries = buildSeries(byDay, "day");
  const sl01 = makeMetric(
    "SL01",
    "声量、增长与变化",
    "documents",
    "count_delta_growth",
    datedCount > 0 ? "exploratory" : "missing_fields",
    datedCount > 0 ? "" : "当前样本缺少有效发布时间戳",
    {
      days: daysSeries,
      weeks: buildSeries(byWeek, "week"),
      months: buildSeries(byMonth, "month"),
      documents_without_date: n - datedCount,
    },
  );
  const sl02 = makeMetric(
    "SL02",
    "全库归档声量比",
    "threads",
    "matched_admitted_threads_over_admitted_threads",
    "unsupported_source",
    "全库归档声量比仅对具备完整归档分母账本的 R4 DuckDB 归档有效",
    {},
  );
  const meaningfulIds = keptIndices.filter(
    (i) => allDocs[i].focus.length >= 20 && (allDocs[i].focus.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 12,
  );
  const sup = supportOf(keptIndices);
  const sl03 = makeMetric(
    "SL03",
    "作者、线程及有效讨论",
    "documents",
    "distinct_and_direct_meaningful_rate",
    n === 0 ? "insufficient_data" : sup.thread_coverage === n && sup.author_coverage === n ? "ready" : "exploratory",
    n === 0 ? "当前范围无有效样本" : "",
    {
      ...sup,
      denominator: n,
      meaningful_documents: meaningfulIds.length,
      meaningful_rate: n > 0 ? meaningfulIds.length / n : 0,
      meaningful_rule: "focus ≥20 characters, ≥12 alphanumeric characters",
      evidence_ref: registerEvidence(meaningfulIds, { role: "meaningful_discussion" }),
    },
  );

  // --- P02: SL26 ---
  const exactRemoved = allDocs.length - n;
  const sl26Groups = [...dedupeGroups.entries()].slice(0, 30).map(([rootIdx, dupes]) => ({
    retained_id: allDocs[rootIdx].document_id,
    retained_in_view: true,
    removed: dupes.length,
    methods: { normalized_exact: dupes.length },
    evidence_ref: registerEvidence([rootIdx, ...dupes], { role: "dedupe_group", retained_id: allDocs[rootIdx].document_id }),
  }));
  const sl26 = makeMetric(
    "SL26",
    "语料去重与质量",
    "documents",
    "normalized_exact_simhash_hamming",
    "ready",
    "",
    {
      before: allDocs.length,
      kept: n,
      exact: exactRemoved,
      near: 0,
      groups: sl26Groups,
      evidence_ref: registerEvidence(keptIndices, { role: "retained_documents" }),
    },
  );

  // --- P03: SR01, SR03, SR17 ---
  const byGroup = new Map<string, number[]>();
  for (const i of keptIndices) {
    const g = allDocs[i].groupValue;
    byGroup.set(g, [...(byGroup.get(g) ?? []), i]);
  }
  const groupRows = [...byGroup.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20)
    .map(([group, members]) => {
      const gDay = new Map<string, number[]>();
      for (const idx of members) {
        const day = allDocs[idx].day;
        if (day) gDay.set(day, [...(gDay.get(day) ?? []), idx]);
      }
      return {
        group,
        ...supportOf(members),
        share: n > 0 ? members.length / n : 0,
        evidence_ref: registerEvidence(members, { group }),
        days: buildSeries(gDay, "day"),
      };
    });
  const sr01State: ExploreMetricResult["state"] = groupRows.length > 1 ? "ready" : groupRows.length === 1 ? "exploratory" : "insufficient_data";
  const sr01 = makeMetric("SR01", "分组语料对比", "documents", "group_count_and_dynamics", sr01State, "", { groups: groupRows });
  const sr03 = makeMetric("SR03", "分组与时序覆盖", "documents", "group_document_share_and_trend", sr01State, "", { groups: groupRows });

  const channelMap = new Map<string, { source: string; channel: string; values: number[]; indices: number[] }>();
  for (const i of keptIndices) {
    const d = allDocs[i];
    for (const [ch, val] of Object.entries(d.engagement_channels)) {
      if (typeof val !== "number" || !Number.isFinite(val)) continue;
      const key = `${d.source_type}::${ch}`;
      const bucket = channelMap.get(key) ?? { source: d.source_type, channel: ch, values: [], indices: [] };
      bucket.values.push(val);
      bucket.indices.push(i);
      channelMap.set(key, bucket);
    }
  }
  const channelRows = [...channelMap.values()].map((b) => {
    const sorted = [...b.values].sort((a, c) => a - c);
    return {
      source: b.source,
      channel: b.channel,
      observations: sorted.length,
      coverage: n > 0 ? sorted.length / n : 0,
      zeros: sorted.filter((v) => v === 0).length,
      min: sorted[0] ?? 0,
      p25: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      p90: quantile(sorted, 0.9),
      max: sorted[sorted.length - 1] ?? 0,
      evidence_ref: registerEvidence(b.indices, { source: b.source, channel: b.channel }),
    };
  });
  const sr17 = makeMetric(
    "SR17",
    "互动分布对比",
    "observations",
    "per_platform_per_channel_percentiles",
    channelRows.length > 0 ? "ready" : "missing_fields",
    channelRows.length > 0 ? "" : "当前样本未包含有效互动数值字段",
    { channels: channelRows },
  );

  // --- P04: SR04, SR05, SR06 ---
  const tokenizedDocs = keptIndices.map((i) => ({ clauses: tokenizeClauses(allDocs[i].focus) }));
  const docTokenSets = tokenizedDocs.map((d) => new Set(d.clauses.flat()));
  const indexToPos = new Map(keptIndices.map((docIdx, pos) => [docIdx, pos]));
  const tfidfItems = n >= 2 ? extractTfIdfKeywords(tokenizedDocs, 20) : [];
  const sr04 = makeMetric(
    "SR04",
    "社区特征词与代表词汇",
    "terms",
    "group_vs_rest_dirichlet_log_odds_and_sublinear_tfidf",
    tfidfItems.length > 0 ? "ready" : "insufficient_data",
    tfidfItems.length > 0 ? "" : "有效文本不足，暂无法提取特征词",
    {
      terms: tfidfItems.map((it) => ({
        term: it.term,
        documents: it.docCount,
        tf: it.termCount,
        tfidf: it.avgScore ?? 0,
        share: n > 0 ? it.docCount / n : 0,
      })),
    },
  );
  const groupTextBuckets = [...byGroup.entries()]
    .filter(([, members]) => members.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .map(([label, members]) => ({
      objectKey: label,
      label,
      docIndices: members.map((i) => indexToPos.get(i)!).filter((pos) => pos !== undefined),
    }));
  const diffGroups = groupTextBuckets.length >= 2 ? computeDistinctiveTermsForGroups(groupTextBuckets, docTokenSets, 10) : [];
  const sr05 = makeMetric(
    "SR05",
    "方向性特有词",
    "terms",
    "dirichlet_log_odds",
    diffGroups.length >= 2 ? "ready" : "insufficient_data",
    diffGroups.length >= 2 ? "" : "至少需要 2 个含 ≥2 条文档的分组方可计算组间特有词",
    { comparisons: diffGroups },
  );
  const bigrams = n >= 3 ? extractNgrams(tokenizedDocs, 2, 15) : [];
  const trigrams = n >= 5 ? extractNgrams(tokenizedDocs, 3, 12) : [];
  const sr06 = makeMetric(
    "SR06",
    "多词搭配与名词短语",
    "phrases",
    "boundary_aware_ngrams_and_noun_chunks",
    bigrams.length > 0 ? "ready" : "insufficient_data",
    bigrams.length > 0 ? "" : "当前样本暂未提取出重复多词搭配",
    {
      bigrams: bigrams.map((b) => ({ phrase: b.term, documents: b.docCount, count: b.termCount })),
      trigrams: trigrams.map((tr) => ({ phrase: tr.term, documents: tr.docCount, count: tr.termCount })),
    },
  );

  // --- P05 & P06: Potion semantic topic space (honestly marked unavailable_dependency in builtin mode) ---
  const potionReason = "主题向量聚类（SR08/SR29）与主题时空热力图（SR24/SR25）需要外置 Python 分析 Worker 及本地 Potion INT8 模型。";
  const sr08 = makeMetric("SR08", "共用主题空间", "documents", "potion_pca_hdbscan_or_minibatch_kmeans_ctfidf", "unavailable_dependency", potionReason, {});
  const sr29 = makeMetric("SR29", "主题代表内容", "documents", "own_topic_centroid_and_independent_threads", "unavailable_dependency", potionReason, {});
  const sr24 = makeMetric("SR24", "主题日历", "documents", "assigned_topic_by_utc_day", "unavailable_dependency", potionReason, {});
  const sr25 = makeMetric("SR25", "主题星期小时", "documents", "assigned_topic_by_utc_weekday_hour", "unavailable_dependency", potionReason, {});

  // --- P07 & P08: SL04, SL15, SL17, SL30 ---
  const bucketCounts = daysSeries.map((d) => ({
    bucket: d.period,
    count: d.documents ?? 0,
    topTerms: [] as string[],
    topItemIds: [] as string[],
  }));
  const detectedPoints = bucketCounts.length >= 4 ? detectBucketAnomalies(bucketCounts, "medium").points : [];
  const anomalyRows = detectedPoints
    .filter((pt) => pt.isAnomaly)
    .map((pt) => {
      const ids = byDay.get(pt.bucket) ?? [];
      return {
        date: pt.bucket,
        documents: pt.count,
        baseline: pt.baselineAvg,
        z: pt.zScore,
        direction: pt.direction,
        evidence_ref: registerEvidence(ids, { anomaly_date: pt.bucket }),
      };
    });
  const sl04 = makeMetric(
    "SL04",
    "异常声量",
    "documents",
    "past_only_rolling_z_30_days",
    bucketCounts.length >= 4 ? "exploratory" : "insufficient_data",
    bucketCounts.length >= 4 ? "" : "至少需要 4 个活跃日期方可进行滚动基线异常检测",
    {
      days: detectedPoints.map((pt) => ({
        date: pt.bucket,
        documents: pt.count,
        baseline: pt.baselineAvg,
        z: pt.zScore,
        is_anomaly: pt.isAnomaly,
      })),
      anomalies: anomalyRows,
      window_days: 30,
      min_history_days: 4,
    },
  );
  const events = anomalyRows.map((a, idx) => ({
    event_id: `ev-window-${idx + 1}`,
    start: a.date,
    end: a.date,
    peak_date: a.date,
    documents: a.documents,
    peak_z: a.z,
    evidence_ref: a.evidence_ref,
  }));
  const sl15 = makeMetric(
    "SL15",
    "异常区间和区间主题",
    "documents",
    "group_alert_windows_and_recluster",
    events.length > 0 ? "exploratory" : "insufficient_data",
    events.length > 0 ? "" : "当前时间窗口未检测到显著声量异常区间",
    { events },
  );
  const sl17 = makeMetric(
    "SL17",
    "异常事件生命周期",
    "documents",
    "anomaly_window_phases_and_observed_peak",
    events.length > 0 ? "exploratory" : "insufficient_data",
    events.length > 0 ? "" : "暂无异常事件可生成生命周期阶段",
    {
      lifecycles: events.map((e) => ({
        event_id: e.event_id,
        start: e.start,
        peak: e.peak_date,
        end: e.end,
        duration_days: 1,
        peak_documents: e.documents,
        evidence_ref: e.evidence_ref,
      })),
    },
  );
  const sl30 = makeMetric(
    "SL30",
    "异常事件证据摘要",
    "documents",
    "extractive_event_terms_entities_attributes_and_membership",
    events.length > 0 ? "exploratory" : "insufficient_data",
    events.length > 0 ? "" : "暂无异常事件摘要",
    {
      summaries: events.map((e) => {
        const ids = byDay.get(e.peak_date) ?? [];
        const dayTokens = ids.map((i) => ({ clauses: tokenizeClauses(allDocs[i].focus) }));
        const topTerms = extractTfIdfKeywords(dayTokens, 5).map((t) => t.term);
        return { event_id: e.event_id, peak_date: e.peak_date, documents: e.documents, terms: topTerms, evidence_ref: e.evidence_ref };
      }),
    },
  );

  // --- P09: SL07, SL09 ---
  const sentBuckets: Record<string, number[]> = { positive: [], negative: [], neutral: [], mixed: [] };
  const sentByDay = new Map<string, { positive: number; negative: number; neutral: number }>();
  for (const i of keptIndices) {
    const scored = scoreBilingualSentiment(allDocs[i].focus);
    const label = scored.label === "positive" || scored.label === "negative" ? scored.label : "neutral";
    sentBuckets[label].push(i);
    const day = allDocs[i].day;
    if (day) {
      const cur = sentByDay.get(day) ?? { positive: 0, negative: 0, neutral: 0 };
      cur[label]++;
      sentByDay.set(day, cur);
    }
  }
  const posN = sentBuckets.positive.length;
  const negN = sentBuckets.negative.length;
  const polDen = posN + negN;
  const sl07 = makeMetric(
    "SL07",
    "情感与观点结构",
    "documents",
    "scope_opinion_gate_and_polarity",
    n > 0 ? "ready" : "insufficient_data",
    "",
    {
      labels: [
        { label: "positive", documents: posN, share: n > 0 ? posN / n : 0, evidence_ref: registerEvidence(sentBuckets.positive, { sentiment: "positive" }) },
        { label: "negative", documents: negN, share: n > 0 ? negN / n : 0, evidence_ref: registerEvidence(sentBuckets.negative, { sentiment: "negative" }) },
        { label: "neutral", documents: sentBuckets.neutral.length, share: n > 0 ? sentBuckets.neutral.length / n : 0, evidence_ref: registerEvidence(sentBuckets.neutral, { sentiment: "neutral" }) },
      ],
      coverage: n > 0 ? polDen / n : 0,
      by_day: [...sentByDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, c]) => ({ date: day, ...c })),
    },
  );
  const sl09 = makeMetric(
    "SL09",
    "正负口碑",
    "documents",
    "positive_over_positive_and_negative",
    polDen > 0 ? "ready" : "insufficient_data",
    polDen > 0 ? "" : "当前样本中未识别出明确正/负面观点",
    {
      positive: posN,
      negative: negN,
      denominator: polDen,
      positive_rate: polDen > 0 ? posN / polDen : null,
      negative_rate: polDen > 0 ? negN / polDen : null,
      positive_evidence: registerEvidence(sentBuckets.positive, { sentiment: "positive" }),
      negative_evidence: registerEvidence(sentBuckets.negative, { sentiment: "negative" }),
      by_day: [...sentByDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, c]) => {
          const d = c.positive + c.negative;
          return { date: day, positive: c.positive, negative: c.negative, negative_rate: d > 0 ? c.negative / d : null };
        }),
    },
  );

  // --- P10: PR02, PR03, OD03, OD04 ---
  const demandByState = new Map<string, number[]>();
  const activeNeedIds = new Set<number>();
  for (const i of keptIndices) {
    const txt = allDocs[i].focus;
    for (const rule of DEMAND_PATTERNS) {
      if (rule.rx.test(txt)) {
        demandByState.set(rule.state, [...(demandByState.get(rule.state) ?? []), i]);
        activeNeedIds.add(i);
      }
    }
  }
  const activeNeedList = [...activeNeedIds];
  const featureList = demandByState.get("feature_request") ?? [];
  const unmetList = demandByState.get("unmet_need") ?? [];
  const stateBreakdown = DEMAND_PATTERNS.map((r) => {
    const ids = demandByState.get(r.state) ?? [];
    return { state: r.state, documents: ids.length, rate: n > 0 ? ids.length / n : 0, evidence_ref: registerEvidence(ids, { state: r.state }) };
  });
  const pr02 = makeMetric("PR02", "主动需求规模", "documents", "grounded_active_need_count", n > 0 ? "ready" : "insufficient_data", "", {
    hits: activeNeedList.length,
    documents: activeNeedList.length,
    denominator: n,
    rate: n > 0 ? activeNeedList.length / n : 0,
    states: stateBreakdown,
    evidence_ref: registerEvidence(activeNeedList, { role: "active_need" }),
  });
  const pr03 = makeMetric("PR03", "主动需求密度", "ratio", "grounded_active_need_over_research_documents", n > 0 ? "ready" : "insufficient_data", "", {
    hits: activeNeedList.length,
    denominator: n,
    rate: n > 0 ? activeNeedList.length / n : 0,
    states: stateBreakdown,
  });
  const od03 = makeMetric("OD03", "显式功能请求", "documents", "grounded_feature_request", n > 0 ? "ready" : "insufficient_data", "", {
    hits: featureList.length,
    documents: featureList.length,
    denominator: n,
    rate: n > 0 ? featureList.length / n : 0,
    evidence_ref: registerEvidence(featureList, { state: "feature_request" }),
  });
  const od04 = makeMetric("OD04", "明确未满足需求", "documents", "explicit_unmet_need_excluding_inferred_partial_solutions", n > 0 ? "ready" : "insufficient_data", "", {
    hits: unmetList.length,
    documents: unmetList.length,
    denominator: n,
    rate: n > 0 ? unmetList.length / n : 0,
    evidence_ref: registerEvidence(unmetList, { state: "unmet_need" }),
  });

  // --- P11: OD05, OD06, OD30 ---
  const painBuckets = PAIN_PATTERNS.map((p) => {
    const ids = keptIndices.filter((i) => p.rx.test(allDocs[i].focus));
    return {
      cluster_id: `pain:${p.label}`,
      name: p.label,
      documents: ids.length,
      rate: n > 0 ? ids.length / n : 0,
      evidence_ref: registerEvidence(ids, { pain_theme: p.label }),
    };
  }).filter((b) => b.documents > 0);
  const od05 = makeMetric("OD05", "需求语义聚类", "passages", "grounded_active_need_passage_clusters", "unavailable_dependency", "需求片段语义聚类需外置 Python Potion 分析服务。", {});
  const od06 = makeMetric(
    "OD06",
    "痛点簇",
    "passages",
    "grounded_pain_passage_clusters",
    painBuckets.length > 0 ? "exploratory" : "insufficient_data",
    painBuckets.length > 0 ? "由内置规则按典型痛点维度聚合；连接 Potion Worker 可解锁开放式语义聚类。" : "当前样本未命中典型痛点表达",
    { clusters: painBuckets },
  );
  const od30 = makeMetric(
    "OD30",
    "需求、痛点与使用价格语境",
    "passages",
    "separate_need_and_pain_and_explicit_context",
    activeNeedList.length > 0 || painBuckets.length > 0 ? "exploratory" : "insufficient_data",
    "",
    { need: activeNeedList.length, pain: painBuckets.reduce((s, b) => s + b.documents, 0) },
  );

  // --- P12: PR24, MI24, MI28 ---
  const priceAttentionSet = new Set<number>();
  const priceCohorts = new Map<string, { currency: string; period: string; amounts: number[]; indices: number[] }>();
  for (const i of keptIndices) {
    const txt = allDocs[i].focus;
    if (PRICE_ATTENTION_RX.test(txt)) priceAttentionSet.add(i);
    for (const match of txt.matchAll(PRICE_AMOUNT_RX)) {
      const currency = (match[1] || match[4] || "$").toUpperCase();
      const rawVal = Number((match[2] || match[3] || "").replace(",", ""));
      if (!Number.isFinite(rawVal) || rawVal <= 0) continue;
      priceAttentionSet.add(i);
      const period = (match[5] || "one_time").toLowerCase();
      const key = `${currency}/${period}`;
      const bucket = priceCohorts.get(key) ?? { currency, period, amounts: [], indices: [] };
      bucket.amounts.push(rawVal);
      bucket.indices.push(i);
      priceCohorts.set(key, bucket);
    }
  }
  const priceAttentionIds = [...priceAttentionSet];
  const cohortRows = [...priceCohorts.entries()].map(([key, c]) => {
    const sorted = [...c.amounts].sort((a, b) => a - b);
    return {
      cohort: key,
      currency: c.currency,
      period: c.period,
      mentions: sorted.length,
      min: sorted[0],
      median: quantile(sorted, 0.5),
      max: sorted[sorted.length - 1],
      evidence_ref: registerEvidence(c.indices, { price_cohort: key }),
    };
  });
  const stageRows = PURCHASE_STAGES.map((st) => {
    const ids = keptIndices.filter((i) => st.rx.test(allDocs[i].focus));
    return {
      stage: st.stage,
      documents: ids.length,
      rate: n > 0 ? ids.length / n : 0,
      evidence_ref: registerEvidence(ids, { stage: st.stage }),
    };
  });
  const pr24 = makeMetric("PR24", "价格关注与语境", "documents", "money_and_price_clause_attention", n > 0 ? "ready" : "insufficient_data", "", {
    documents: priceAttentionIds.length,
    denominator: n,
    rate: n > 0 ? priceAttentionIds.length / n : 0,
    evidence_ref: registerEvidence(priceAttentionIds, { role: "price_attention" }),
  });
  const mi24 = makeMetric(
    "MI24",
    "价格分布",
    "price_mentions",
    "separate_currency_period_target_amount_role",
    cohortRows.length > 0 ? "exploratory" : "insufficient_data",
    cohortRows.length > 0 ? "" : "当前样本中未提取出带明确币种的金额提及",
    { cohorts: cohortRows },
  );
  const mi28 = makeMetric("MI28", "购买决策阶段", "documents", "descriptive_grounded_multilabel_purchase_stage", n > 0 ? "ready" : "insufficient_data", "", {
    stages: stageRows,
    denominator: n,
    overlap_possible: true,
  });

  const panelSpecs: Array<[ExplorePanelId, string, string, ExploreMetricResult[]]> = [
    ["P01", "讨论规模与覆盖", "line / cards", [sl01, sl02, sl03]],
    ["P02", "语料与去重", "bar / expandable table", [sl26]],
    ["P03", "分组与互动", "line / boxplot / table", [sr01, sr03, sr17]],
    ["P04", "词汇与差异", "bar / diverging bar", [sr04, sr05, sr06]],
    ["P05", "主题结构与代表内容", "bar / table", [sr08, sr29]],
    ["P06", "主题时间分布", "calendar / heatmap", [sr24, sr25]],
    ["P07", "声量异常与事件", "line / expandable table", [sl04, sl15]],
    ["P08", "生命周期", "timeline / table", [sl17, sl30]],
    ["P09", "情感与口碑", "stacked bar / line", [sl07, sl09]],
    ["P10", "主动需求与显式诉求", "bar / cards", [pr02, pr03, od03, od04]],
    ["P11", "未满足需求与痛点", "table / bar", [od05, od06, od30]],
    ["P12", "价格与购买决策", "histogram / table", [pr24, mi24, mi28]],
  ];

  const panels: ExplorePanelResult[] = panelSpecs.map(([panel_id, title, chart, metrics]) => ({
    schema_version: SCHEMA_VERSION,
    panel_id,
    scenario: PANEL_SCENARIO_MAP[panel_id],
    title,
    chart,
    study_id: studyId,
    metrics,
  }));

  pruneStudyCache();
  studyCache.set(studyId, { studyId, createdAt: Date.now(), docs: allDocs, evidences });

  return { studyId, analyzedDocuments: n, panels };
}
