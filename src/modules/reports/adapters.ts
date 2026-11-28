import type { Pool } from "pg";
import type { Actor } from "../../../packages/contracts/src/access";
import type { ExploreAnalyzeResponse, ExploreMetricResult, ExplorePanelResult } from "../../../packages/contracts/src/explore";
import type { ReportRunCreateInputType } from "../../../packages/contracts/src/reports";
import type { ArchiveRuntimeFacade } from "../archive-analysis/index";
import { contentVisibility } from "../collection/index";
import { computeStoryInsights, readStoryWindow } from "../content/index";
import { getMonitorOverview, listMonitorPosts, listResearchTasks, runL2ResearchComparison } from "../intelligence/index";
import { runL1ResearchOverview } from "../projects/index";
import type {
  ModuleAvailabilityState,
  ReportEvidenceItem,
  ReportScopeSummary,
  ReportSectionData,
} from "./types";

export interface AdaptedAnalysisBundle {
  scopes: ReportScopeSummary[];
  sectionsById: Map<string, ReportSectionData>;
  evidence: ReportEvidenceItem[];
  dataVersion: string;
  studyId?: string | null;
}

function asArray<T = Record<string, unknown>>(val: unknown): T[] {
  return Array.isArray(val) ? (val as T[]) : [];
}

function asNum(val: unknown): number {
  return typeof val === "number" && Number.isFinite(val) ? val : 0;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function mapMetricState(state: string | undefined): ModuleAvailabilityState {
  if (state === "ready" || state === "exploratory" || state === "insufficient_data" || state === "unsupported_source" || state === "missing_fields" || state === "unavailable_dependency" || state === "failed") {
    return state;
  }
  return "insufficient_data";
}

function friendlyStateMessage(state: ModuleAvailabilityState, fallbackReason: string): string {
  if (state === "ready") return "已完成真实数据统计与校验。";
  if (state === "exploratory") return "基于当前样本完成探索性统计，请结合代表原文解读。";
  if (state === "unavailable_dependency") return "当前分析模型尚未就绪，暂无法生成此模块，可先查看其他章节。";
  if (state === "unsupported_source") return "当前数据源不提供该维度所需字段，已诚实略过。";
  if (state === "missing_fields") return "样本缺少该分析所需的完整字段。";
  if (state === "failed") return "该模块计算未完成，可稍后重试。";
  return fallbackReason || "相关讨论样本较少，暂适合查看原文和基础统计。";
}

// ---------------- 1. Stories / StoryInsights Adapter (F01 Industry Briefing) ----------------

export async function adaptStoriesAnalysis(
  pool: Pool,
  actor: Actor,
  req: ReportRunCreateInputType,
): Promise<AdaptedAnalysisBundle> {
  const view = req.storyView ?? "latest";
  const win = await readStoryWindow(
    pool,
    actor,
    {
      channelScope: "info",
      view,
      ...(req.storyDate && view === "digest" ? { date: req.storyDate } : {}),
      ...(req.sourceGroup ? { sourceGroup: req.sourceGroup } : {}),
      ...(req.language ? { language: req.language === "zh" ? undefined : "en" } : {}),
    },
    Date.now(),
    contentVisibility,
  );
  const { insights } = computeStoryInsights(
    win,
    { view, sourceGroup: req.sourceGroup, lang: req.language ?? "zh" },
    Date.now(),
  );

  const list = view === "latest" ? win.latest : win.hottest;
  const topicFilter = (req.topic || "").trim().toLowerCase();
  const topicWords = topicFilter
    .replace(/(行业情报|简报|日报|周报|行业|资讯|动态|报告)/g, " ")
    .split(/[\s,，/]+/)
    .filter((w) => w.length >= 2);
  const matchedList =
    topicWords.length > 0
      ? list.filter((s) => {
          const hay = `${s.representative.title} ${s.excerpt ?? ""}`.toLowerCase();
          return topicWords.some((w) => hay.includes(w));
        })
      : list;
  const effectiveStories = matchedList.length >= 3 ? matchedList : list;

  // Query published AI release events in window (if any)
  const aiEventsRes = await pool
    .query<{
      id: string;
      title: string;
      vendor_slug: string;
      event_type: string;
      published_date: string | null;
      summary_zh: string | null;
      primary_url: string | null;
    }>(
      `SELECT id, title, vendor_slug, event_type, published_date::text, summary_zh, primary_url
       FROM ai_event
       WHERE status = 'published'
       ORDER BY published_date DESC NULLS LAST, updated_at DESC
       LIMIT 8`,
    )
    .catch(() => ({ rows: [] }));

  const scopeId = "S1";
  const scope: ReportScopeSummary = {
    id: scopeId,
    sourceKind: "stories",
    sourceLabel: req.sourceGroup ? `行业资讯流（频道：${req.sourceGroup}）` : "全站行业资讯流（多源去重事件）",
    query: req.topic || "全频道行业动态",
    range: {
      from: win.from,
      to: win.to,
      activeDays: Math.max(1, insights.activityTrend.buckets.filter((b) => b.count > 0).length),
    },
    dataVersion: `stories:${view}:${win.to.slice(0, 13)}`,
    matchedCount: win.totalRankedCount,
    matchedUnit: "去重事件",
    matchedStatus: "exact",
    analyzedCount: effectiveStories.length,
    analyzedUnit: "去重事件",
    samplingNote:
      view === "digest"
        ? "沿用上海时间 08:00 截止的 24 小时日报窗口，按去重事件聚合。"
        : `分析窗口覆盖 ${win.from.slice(0, 10)} 至 ${win.to.slice(0, 10)}，共 ${insights.quality.activeSourceCount} 个独立来源。`,
    engineLabel: "StoryFeed + StoryInsights 资讯分析引擎",
  };

  const evidence: ReportEvidenceItem[] = [];
  const addEv = (item: Omit<ReportEvidenceItem, "id">): string => {
    const id = `E-${String(evidence.length + 1).padStart(2, "0")}`;
    evidence.push({ id, ...item });
    return id;
  };

  const eventEvidenceIds: string[] = [];
  for (const st of effectiveStories.slice(0, 12)) {
    const eid = addEv({
      scopeId,
      moduleId: "industry_events",
      groupLabel: st.representative.sourceLabel,
      title: st.representative.title,
      excerpt: (st.excerpt ?? st.representative.title).slice(0, 420),
      sourceLabel: st.representative.sourceLabel,
      platform: st.representative.platform,
      author: st.representative.author,
      publishedAt: st.representative.publishedAt ?? st.updatedAt,
      url: st.representative.url,
      documentId: st.representative.id,
      reason: `多源事件代表报道（${st.sourceCount} 个独立来源印证，热度 ${st.heat48h.toFixed(1)}）`,
    });
    eventEvidenceIds.push(eid);
  }

  for (const aiEv of aiEventsRes.rows.slice(0, 4)) {
    const eid = addEv({
      scopeId,
      moduleId: "industry_events",
      groupLabel: `AI发布 · ${aiEv.vendor_slug}`,
      title: aiEv.title,
      excerpt: (aiEv.summary_zh || aiEv.title).slice(0, 320),
      sourceLabel: `已发布 AI 情报 (${aiEv.vendor_slug})`,
      platform: "web",
      publishedAt: aiEv.published_date,
      url: aiEv.primary_url,
      documentId: aiEv.id,
      reason: "平台已公开发布的 AI 官方事件台账",
    });
    eventEvidenceIds.push(eid);
  }

  const sectionsById = new Map<string, ReportSectionData>();

  sectionsById.set("scope_overview", {
    id: "scope_overview",
    moduleId: "scope_overview",
    title: "研究范围与本期概况",
    description: "窗口覆盖、独立来源数量与去重事件统计",
    scopeId,
    state: effectiveStories.length > 0 ? "ready" : "insufficient_data",
    stateMessage: effectiveStories.length > 0 ? `本期共汇总 ${effectiveStories.length} 个去重行业事件，覆盖 ${insights.quality.activeSourceCount} 个独立来源。` : "当前窗口内暂无已入库资讯事件。",
    engineSource: "StoryInsights",
    unit: "事件",
    denominatorLabel: "窗口内去重事件",
    sampleCount: effectiveStories.length,
    metrics: [
      { id: "M_EVENTS", label: "去重行业事件", value: effectiveStories.length, formatted: fmtInt(effectiveStories.length), unit: "件" },
      { id: "M_SOURCES", label: "参与独立来源", value: insights.quality.activeSourceCount, formatted: fmtInt(insights.quality.activeSourceCount), unit: "个" },
      { id: "M_TEXT_COV", label: "文本有效覆盖率", value: insights.quality.textCoveragePct, formatted: `${insights.quality.textCoveragePct.toFixed(1)}%`, unit: "" },
      { id: "M_AI_EVENTS", label: "关联已发布 AI 事件", value: aiEventsRes.rows.length, formatted: fmtInt(aiEventsRes.rows.length), unit: "项" },
    ],
    charts: [],
    evidenceIds: eventEvidenceIds.slice(0, 4),
    method: "按标准化标题与链接去重聚簇为事件，按独立来源等级（T1/T1.5/T2）与时间衰减排序。",
    warnings: effectiveStories.length < 5 ? ["当前窗口内资讯事件偏少，趋势与主题区分度有限。"] : [],
    pinned: true,
  });

  sectionsById.set("industry_events", {
    id: "industry_events",
    moduleId: "industry_events",
    title: "重点行业事件与动态",
    description: "按热度与多源印证排序的核心行业事件",
    scopeId,
    state: effectiveStories.length > 0 ? "ready" : "insufficient_data",
    stateMessage: effectiveStories.length > 0 ? `已筛选前 ${Math.min(12, effectiveStories.length)} 个高关注行业事件及关联官方动态。` : "当前窗口无重点事件。",
    engineSource: "StoryFeed",
    unit: "事件",
    denominatorLabel: "窗口内去重事件",
    sampleCount: effectiveStories.length,
    metrics: [
      { id: "M_TOP_HEAT", label: "最高事件热度", value: effectiveStories[0]?.heat48h ?? 0, formatted: (effectiveStories[0]?.heat48h ?? 0).toFixed(1), unit: "" },
      { id: "M_MULTI_SRC", label: "多源印证事件", value: effectiveStories.filter((s) => s.sourceCount >= 2).length, formatted: fmtInt(effectiveStories.filter((s) => s.sourceCount >= 2).length), unit: "件" },
    ],
    charts: [
      {
        id: "C_EVENTS_TABLE",
        title: "本期重点事件清单",
        kind: "table",
        unit: "事件",
        xLabels: [],
        series: [],
        table: {
          columns: ["事件标题", "代表来源", "等级", "印证来源数", "发布时间 (UTC)"],
          rows: effectiveStories.slice(0, 12).map((st) => [
            st.representative.title.slice(0, 72),
            st.representative.sourceLabel,
            st.representative.tier,
            st.sourceCount,
            (st.representative.publishedAt ?? st.updatedAt).slice(0, 16).replace("T", " "),
          ]),
        },
        evidenceIds: eventEvidenceIds.slice(0, 8),
      },
    ],
    evidenceIds: eventEvidenceIds,
    method: "优先保留 T1/T1.5 独立来源印证事件；AI 事件仅纳入已审核发布台账。",
    warnings: [],
  });

  const hotItems = insights.hotKeywords.items;
  const risingItems = insights.risingTerms.items;
  const topicItems = insights.topics.items;
  sectionsById.set("industry_topics", {
    id: "industry_topics",
    moduleId: "industry_topics",
    title: "资讯主题与热词升温",
    description: "本期高频关键词、前后窗口升温词与主题聚簇",
    scopeId,
    state: hotItems.length >= 2 ? "ready" : "insufficient_data",
    stateMessage: hotItems.length >= 2 ? `识别出 ${hotItems.length} 个高频热词、${risingItems.length} 个升温词与 ${topicItems.length} 个主题簇。` : "有效文本词频不足以形成稳定主题分布。",
    engineSource: "StoryInsights (NMF + DF)",
    unit: "事件数",
    denominatorLabel: "含有效文本去重事件",
    sampleCount: effectiveStories.length,
    metrics: [
      { id: "M_HOT_TOP", label: "首要热词", value: hotItems[0]?.displayTerm ?? "—", formatted: hotItems[0]?.displayTerm ?? "—", unit: hotItems[0] ? `(${hotItems[0].eventCount}件)` : "" },
      { id: "M_RISING_CNT", label: "明显升温词", value: risingItems.length, formatted: fmtInt(risingItems.length), unit: "个" },
      { id: "M_TOPICS_CNT", label: "识别主题数", value: topicItems.length, formatted: fmtInt(topicItems.length), unit: "个" },
    ],
    charts: [
      ...(hotItems.length
        ? [
            {
              id: "C_HOT_KW",
              title: "本期资讯高频关键词（去重事件提及数）",
              kind: "horizontal_bar" as const,
              unit: "件",
              denominator: `有效事件 N=${effectiveStories.length}`,
              xLabels: hotItems.map((h) => h.displayTerm),
              series: [{ name: "提及事件数", data: hotItems.map((h) => h.eventCount), color: "#0f766e" }],
              evidenceIds: eventEvidenceIds.slice(0, 6),
            },
          ]
        : []),
      ...(topicItems.length
        ? [
            {
              id: "C_TOPICS_TBL",
              title: "主题聚簇概览",
              kind: "table" as const,
              unit: "事件",
              xLabels: [],
              series: [],
              table: {
                columns: ["主题标签", "事件数", "占比", "代表事件"],
                rows: topicItems.map((tp) => [
                  tp.label,
                  tp.docCount,
                  `${tp.sharePct.toFixed(1)}%`,
                  (tp.sampleTitles[0] ?? tp.keywords.join(", ")).slice(0, 60),
                ]),
              },
            },
          ]
        : []),
    ],
    evidenceIds: eventEvidenceIds.slice(0, 8),
    method: "热词按去重事件文档频率统计并做词干归并；升温词对比前后等长窗口提及率差（百分点）。",
    warnings: risingItems.length === 0 ? ["前后窗口基线样本有限，暂未检测到显著升温词。"] : [],
  });

  const trendBuckets = insights.activityTrend.buckets;
  const compSources = insights.composition.bySource;
  sectionsById.set("industry_trend", {
    id: "industry_trend",
    moduleId: "industry_trend",
    title: "资讯发布趋势与来源构成",
    description: "分时段事件发布节奏与独立来源分布",
    scopeId,
    state: trendBuckets.some((b) => b.count > 0) ? "ready" : "insufficient_data",
    stateMessage: insights.activityTrend.summaryText,
    engineSource: "StoryInsights",
    unit: "事件",
    denominatorLabel: "窗口内去重事件",
    sampleCount: effectiveStories.length,
    metrics: [
      { id: "M_BUCKETS", label: "活跃时段数", value: trendBuckets.filter((b) => b.count > 0).length, formatted: fmtInt(trendBuckets.filter((b) => b.count > 0).length), unit: "段" },
      { id: "M_TOP_SRC", label: "最活跃来源", value: compSources[0]?.label ?? "—", formatted: compSources[0]?.label ?? "—", unit: compSources[0] ? `(${compSources[0].count}件)` : "" },
    ],
    charts: [
      ...(trendBuckets.length
        ? [
            {
              id: "C_NEWS_TREND",
              title: `资讯事件发布趋势（粒度：${insights.activityTrend.bucketGranularity}）`,
              kind: "line" as const,
              unit: "事件",
              xLabels: trendBuckets.map((b) => b.bucket),
              series: [{ name: "去重事件数", data: trendBuckets.map((b) => b.count), color: "#0f766e" }],
            },
          ]
        : []),
      ...(compSources.length
        ? [
            {
              id: "C_SRC_COMP",
              title: "主要资讯来源分布",
              kind: "horizontal_bar" as const,
              unit: "事件",
              xLabels: compSources.map((s) => s.label),
              series: [{ name: "事件数", data: compSources.map((s) => s.count), color: "#2563eb" }],
            },
          ]
        : []),
    ],
    evidenceIds: eventEvidenceIds.slice(0, 4),
    method: "按事件发布或首次观测时间落入对应 UTC 时间桶统计。",
    warnings: [],
  });

  return {
    scopes: [scope],
    sectionsById,
    evidence,
    dataVersion: scope.dataVersion,
  };
}

// ---------------- 2. Explore P01–P12 Adapter (F02/F06/F07 Commerce & Social) ----------------

function findMetric(panel: ExplorePanelResult | undefined, id: string): ExploreMetricResult | undefined {
  return panel?.metrics.find((m) => m.metric_id === id);
}

export async function adaptExploreAnalysis(
  explore: ExploreAnalyzeResponse,
  actor: Actor,
  archiveRuntime: ArchiveRuntimeFacade | undefined,
  extraScopeMeta?: {
    projectId?: string | null;
    archiveRefId?: string | null;
    sourceIds?: string[];
    batchIds?: string[];
  },
): Promise<AdaptedAnalysisBundle> {
  const scopeId = "S1";
  const sp = explore.sourceProfile;
  const panelById = new Map<string, ExplorePanelResult>(explore.panels.map((p) => [p.panel_id, p]));

  const scope: ReportScopeSummary = {
    id: scopeId,
    sourceKind: sp.sourceMode === "archive" ? "archive" : sp.sourceMode === "project_content" ? "project" : "pg_content",
    sourceLabel: sp.sourceLabel,
    query: explore.query || "全范围",
    range: sp.timeRange,
    dataVersion: explore.dataVersion,
    matchedCount: sp.rawDocuments,
    matchedUnit: sp.sourceMode === "archive" ? "讨论串" : "记录",
    matchedStatus: sp.isSampled ? "truncated" : "exact",
    analyzedCount: sp.analyzedDocuments,
    analyzedUnit: "有效去重样本",
    samplingNote: sp.isSampled
      ? `匹配总量超出单次明细上限（${sp.sampleCap.toLocaleString()}），已按日分层抽样 ${sp.analyzedDocuments.toLocaleString()} 条有效样本。`
      : `全量分析 ${sp.analyzedDocuments.toLocaleString()} 条去重有效样本。`,
    engineLabel: sp.engineLabel,
    projectId: extraScopeMeta?.projectId ?? null,
    archiveRefId: extraScopeMeta?.archiveRefId ?? null,
    sourceIds: extraScopeMeta?.sourceIds,
    batchIds: extraScopeMeta?.batchIds,
    studyId: explore.studyId,
  };

  // Harvest durable representative evidence from Explore panels while study cache is live!
  const evidence: ReportEvidenceItem[] = [];
  const seenDocIds = new Set<string>();
  const evidenceByModule = new Map<string, string[]>();

  const pullEvidenceRef = async (moduleId: string, refId: string | undefined, reason: string, groupLabel?: string, maxTake = 4) => {
    if (!refId || !archiveRuntime) return;
    try {
      const res = await archiveRuntime.resolveEvidence(actor, {
        studyId: explore.studyId,
        evidenceId: refId,
        offset: 0,
        limit: maxTake + 2,
      });
      const modList = evidenceByModule.get(moduleId) ?? [];
      let taken = 0;
      for (const item of res.items) {
        if (taken >= maxTake) break;
        const key = `${item.document_id}:${moduleId}`;
        if (seenDocIds.has(key)) continue;
        seenDocIds.add(key);
        const id = `E-${String(evidence.length + 1).padStart(2, "0")}`;
        evidence.push({
          id,
          scopeId,
          moduleId,
          groupLabel: groupLabel ?? item.group,
          title: item.title ?? "",
          excerpt: (item.focus || item.text || "").slice(0, 460),
          sourceLabel: sp.sourceMode === "archive" ? "Reddit 历史讨论归档" : item.source_type || sp.sourceLabel,
          platform: item.source_type === "reddit_archive" ? "reddit" : item.source_type || "unknown",
          community: item.group ?? null,
          author: item.author_key ?? null,
          publishedAt: typeof item.created_utc === "number" ? new Date(item.created_utc * 1000).toISOString() : null,
          url: item.url || null,
          documentId: item.document_id,
          threadId: item.thread_id ?? null,
          engagement: item.engagement_channels,
          reason,
        });
        modList.push(id);
        taken++;
      }
      evidenceByModule.set(moduleId, modList);
    } catch {
      // Evidence resolution is best-effort per ref; keep going
    }
  };

  // Extract evidence_ref IDs across key panels in parallel (bounded)
  const p01 = panelById.get("P01");
  const p02 = panelById.get("P02");
  const p03 = panelById.get("P03");
  const p04 = panelById.get("P04");
  const p05 = panelById.get("P05");
  const p06 = panelById.get("P06");
  const p07 = panelById.get("P07");
  const p08 = panelById.get("P08");
  const p09 = panelById.get("P09");
  const p10 = panelById.get("P10");
  const p11 = panelById.get("P11");
  const p12 = panelById.get("P12");
  const p13 = panelById.get("P13");
  const p14 = panelById.get("P14");

  const refJobs: Array<() => Promise<void>> = [];
  const queueRef = (moduleId: string, obj: unknown, reason: string, groupLabel?: string, maxTake = 3) => {
    const refId = (obj as { evidence_ref?: { id?: string } } | undefined)?.evidence_ref?.id;
    if (refId) refJobs.push(() => pullEvidenceRef(moduleId, refId, reason, groupLabel, maxTake));
  };

  const sentLabelZh: Record<string, string> = {
    positive: "正向评价",
    negative: "负向评价",
    neutral: "中性/客观",
    non_opinion: "客观信息型",
    mixed: "正负混合",
    unclassified: "未判情感",
    unknown: "待判定",
  };
  const formatTopicLabel = (tr: Record<string, unknown>, idx: number): string => {
    if (typeof tr.label === "string" && tr.label.trim() && !/^[a-f0-9]{16,}:topic:/i.test(tr.label.trim())) {
      return tr.label.trim().slice(0, 32);
    }
    const rawTerms = Array.isArray(tr.top_terms)
      ? tr.top_terms
      : Array.isArray(tr.keywords)
        ? tr.keywords
        : Array.isArray(tr.terms)
          ? tr.terms
          : [];
    const termStr = rawTerms
      .map((item) => (typeof item === "string" ? item : typeof (item as { term?: unknown })?.term === "string" ? String((item as { term: string }).term) : ""))
      .filter(Boolean)
      .slice(0, 3)
      .join(" / ");
    return termStr ? `话题 ${idx + 1}：${termStr}`.slice(0, 32) : `讨论话题 ${idx + 1}`;
  };

  const sortTopicsDesc = (rows: Record<string, unknown>[]) =>
    [...rows].sort((a, b) => {
      const diff = asNum(b.documents ?? b.size ?? b.count) - asNum(a.documents ?? a.size ?? a.count);
      if (diff !== 0) return diff;
      return String(a.topic_id ?? a.topic_label ?? "").localeCompare(String(b.topic_id ?? b.topic_label ?? ""));
    });

  // P05 topics (sorted descending by document volume so top topics always lead evidence & KPI)
  const sortedP05Topics = sortTopicsDesc(asArray(findMetric(p05, "SR08")?.data.topics));
  for (const [idx, row] of sortedP05Topics.slice(0, 4).entries()) {
    const label = formatTopicLabel(row, idx);
    queueRef("topic_clusters", row, `主题代表讨论（${label}）`, label, 2);
  }
  // P07 anomalies
  for (const row of asArray(findMetric(p07, "SL15")?.data.events).slice(0, 2)) {
    queueRef("anomaly_events", row, `异常波动窗口代表讨论`, String(row.date ?? row.start_day ?? ""), 2);
  }
  // P09 sentiment
  for (const row of asArray(findMetric(p09, "SL07")?.data.labels ?? findMetric(p09, "SL07")?.data.distribution).slice(0, 3)) {
    const rawKey = String(row.label ?? "");
    const label = sentLabelZh[rawKey] ?? rawKey;
    queueRef("sentiment_reputation", row, `情感态度代表讨论（${label}）`, label, 2);
  }
  // P10 active demand
  for (const row of asArray(findMetric(p10, "OD03")?.data.states ?? findMetric(p10, "OD04")?.data.states).slice(0, 3)) {
    queueRef("active_demand", row, `主动需求诉求代表原文（${String(row.state ?? row.label ?? "")}）`, String(row.state ?? ""), 2);
  }
  // P11 pain points
  for (const row of asArray(findMetric(p11, "OD06")?.data.clusters ?? findMetric(p11, "OD05")?.data.clusters).slice(0, 3)) {
    queueRef("pain_points", row, `产品痛点/未满足需求代表原文（${String(row.label ?? "")}）`, String(row.label ?? ""), 2);
  }
  // P12 price / stages
  queueRef("price_purchase", findMetric(p12, "PR24")?.data, "价格关注代表原文", "价格讨论", 3);
  for (const row of asArray(findMetric(p12, "MI28")?.data.stages).slice(0, 2)) {
    queueRef("price_purchase", row, `购买决策阶段代表原文（${String(row.stage ?? "")}）`, String(row.stage ?? ""), 2);
  }
  // P03 top group fallback evidence
  for (const row of asArray(findMetric(p03, "SR01")?.data.groups).slice(0, 2)) {
    queueRef("community_audience", row, `高频社区代表讨论（${String(row.group ?? "")}）`, String(row.group ?? ""), 2);
  }
  // P13 brand competition evidence (MI05/MI14)
  for (const row of asArray(findMetric(p13, "MI05")?.data.brands).slice(0, 3)) {
    queueRef("brand_competition", row, `品牌讨论代表原文（${String(row.brand ?? "")}）`, String(row.brand ?? ""), 2);
  }
  for (const row of asArray(findMetric(p13, "MI14")?.data.pairs).slice(0, 3)) {
    const pairLbl = `${String(row.brand_a ?? "")} vs ${String(row.brand_b ?? "")}`;
    queueRef("brand_competition", row, `直接竞品对比代表原文（${pairLbl}）`, pairLbl, 2);
  }
  // P14 attribute sentiment / matrix / scenarios / workarounds evidence (PR07/MI19/PR13/OD16)
  for (const row of asArray(findMetric(p14, "PR07")?.data.attributes).slice(0, 3)) {
    queueRef("brand_attribute_matrix", row, `属性负面口碑代表原文（${String(row.attribute ?? "")}）`, String(row.attribute ?? ""), 2);
  }
  for (const row of asArray(findMetric(p14, "MI19")?.data.cells).slice(0, 3)) {
    const cellLbl = `${String(row.brand ?? "")} × ${String(row.attribute ?? "")}`;
    queueRef("brand_attribute_matrix", row, `品牌属性反馈代表原文（${cellLbl}）`, cellLbl, 2);
  }
  for (const row of asArray(findMetric(p14, "PR13")?.data.scenarios).slice(0, 3)) {
    queueRef("scenario_workaround", row, `使用场景需求代表原文（${String(row.scenario ?? "")}）`, String(row.scenario ?? ""), 2);
  }
  for (const row of asArray(findMetric(p14, "OD16")?.data.categories).slice(0, 2)) {
    queueRef("scenario_workaround", row, `用户变通方案代表原文（${String(row.category ?? "")}）`, String(row.category ?? ""), 2);
  }

  // Run evidence pulls in small batches of 4
  for (let i = 0; i < refJobs.length; i += 4) {
    await Promise.all(refJobs.slice(i, i + 4).map((fn) => fn()));
  }

  const sectionsById = new Map<string, ReportSectionData>();

  // Scope Overview (P01 + P02)
  const sl03 = findMetric(p01, "SL03");
  const sl26 = findMetric(p02, "SL26");
  const distinctAuthors = asNum(sl03?.data.distinct_authors ?? sl03?.data.authors);
  const distinctThreads = asNum(sl03?.data.distinct_threads ?? sl03?.data.threads);
  const dupRatio = asNum(sl26?.data.duplicate_rate ?? sl26?.data.template_rate);

  sectionsById.set("scope_overview", {
    id: "scope_overview",
    moduleId: "scope_overview",
    title: "研究范围与样本概况",
    description: "样本规模、去重质量、时间覆盖与引擎口径",
    scopeId,
    state: sp.analyzedDocuments > 0 ? "ready" : "insufficient_data",
    stateMessage: sp.analyzedDocuments > 0
      ? `本次有效分析去重样本 ${fmtInt(sp.analyzedDocuments)} 条（匹配总量 ${fmtInt(sp.rawDocuments)}），覆盖 ${sp.timeRange.activeDays} 个活跃日。`
      : "当前检索条件下有效样本为 0，请调整检索词或扩大范围。",
    engineSource: sp.engineLabel,
    unit: "条",
    denominatorLabel: "有效去重样本",
    sampleCount: sp.analyzedDocuments,
    metrics: [
      { id: "M_RAW", label: "匹配总量", value: sp.rawDocuments, formatted: fmtInt(sp.rawDocuments), unit: scope.matchedUnit },
      { id: "M_ANALYZED", label: "有效去重样本", value: sp.analyzedDocuments, formatted: fmtInt(sp.analyzedDocuments), unit: "条" },
      ...(distinctThreads > 0 ? [{ id: "M_THREADS", label: "独立讨论串", value: distinctThreads, formatted: fmtInt(distinctThreads), unit: "串" }] : []),
      ...(distinctAuthors > 0 ? [{ id: "M_AUTHORS", label: "参与独立作者", value: distinctAuthors, formatted: fmtInt(distinctAuthors), unit: "人" }] : []),
      { id: "M_DUP", label: "重复/模板占比", value: dupRatio, formatted: fmtPct(dupRatio), unit: "" },
    ],
    charts: [],
    evidenceIds: evidence.slice(0, 4).map((e) => e.id),
    method: `${sp.engineLabel}；${scope.samplingNote}`,
    warnings: sp.impactNotes.slice(0, 2),
    pinned: true,
  });

  // P01 Discussion Trend
  const sl01 = findMetric(p01, "SL01");
  const sl02 = findMetric(p01, "SL02");
  const dayPoints = asArray(sl01?.data.days ?? sl01?.data.series);
  const p01State = mapMetricState(sl01?.state);
  sectionsById.set("discussion_trend", {
    id: "discussion_trend",
    moduleId: "discussion_trend",
    title: "讨论规模与时间趋势",
    description: "按日讨论声量走势与全库声量占比（适用时）",
    scopeId,
    state: p01State,
    stateMessage: friendlyStateMessage(p01State, sl01?.reason ?? ""),
    engineSource: "Explore P01 (SL01/SL02/SL03)",
    unit: "条",
    denominatorLabel: "有效去重样本",
    sampleCount: sl01?.selected_documents ?? sp.analyzedDocuments,
    metrics: [
      { id: "M_P01_DAYS", label: "活跃天数", value: dayPoints.length, formatted: fmtInt(dayPoints.length), unit: "天" },
      { id: "M_P01_PEAK", label: "单日峰值", value: Math.max(0, ...dayPoints.map((d) => asNum(d.count ?? d.documents))), formatted: fmtInt(Math.max(0, ...dayPoints.map((d) => asNum(d.count ?? d.documents)))), unit: "条" },
      ...(sl02 && sl02.state === "ready" && typeof sl02.data.overall_share === "number"
        ? [{ id: "M_SL02_SHARE", label: "全归档声量占比", value: sl02.data.overall_share, formatted: `${(asNum(sl02.data.overall_share) * 10000).toFixed(2)}‱`, unit: "（万分比）" }]
        : []),
    ],
    charts: dayPoints.length
      ? [
          {
            id: "C_P01_TREND",
            title: "每日讨论声量趋势",
            kind: "line",
            unit: "条",
            xLabels: dayPoints.map((d) => String(d.day ?? d.date ?? "")),
            series: [{ name: "讨论量", data: dayPoints.map((d) => asNum(d.count ?? d.documents)), color: "#0f766e" }],
          },
        ]
      : [],
    evidenceIds: evidence.slice(0, 4).map((e) => e.id),
    method: "按发布日期（UTC）聚合去重样本；空缺日未填零。",
    warnings: [],
  });

  // P03 Community & Audience
  const sr01 = findMetric(p03, "SR01");
  const groups = asArray(sr01?.data.groups).slice(0, 12);
  const p03State = mapMetricState(sr01?.state);
  sectionsById.set("community_audience", {
    id: "community_audience",
    moduleId: "community_audience",
    title: "受众社区与互动分布",
    description: "主要讨论社区声量排名与分组覆盖",
    scopeId,
    state: p03State,
    stateMessage: friendlyStateMessage(p03State, sr01?.reason ?? ""),
    engineSource: "Explore P03 (SR01/SR03/SR17)",
    unit: "条",
    denominatorLabel: "有效去重样本",
    sampleCount: sr01?.selected_documents ?? sp.analyzedDocuments,
    metrics: [
      { id: "M_GROUPS", label: "覆盖社区/分组", value: groups.length, formatted: fmtInt(groups.length), unit: "个" },
      ...(groups[0] ? [{ id: "M_TOP_GROUP", label: "首要社区", value: String(groups[0].group ?? ""), formatted: String(groups[0].group ?? ""), unit: `(${fmtInt(asNum(groups[0].documents ?? groups[0].count))}条)` }] : []),
    ],
    charts: groups.length
      ? [
          {
            id: "C_P03_GROUPS",
            title: "高频讨论社区分布",
            kind: "horizontal_bar",
            unit: "条",
            xLabels: groups.map((g) => String(g.group ?? g.name ?? "")),
            series: [{ name: "样本数", data: groups.map((g) => asNum(g.documents ?? g.count)), color: "#0f766e" }],
            evidenceIds: evidenceByModule.get("community_audience") ?? [],
          },
        ]
      : [],
    evidenceIds: evidenceByModule.get("community_audience") ?? [],
    method: "按社区/来源分组统计去重文档量；跨平台互动分列不混合相加。",
    warnings: [],
  });

  // P04 Lexical Features
  const sr04 = findMetric(p04, "SR04");
  const sr06 = findMetric(p04, "SR06");
  const terms = asArray(sr04?.data.terms ?? sr04?.data.top_terms).slice(0, 12);
  const phrases = asArray(sr06?.data.phrases ?? sr06?.data.ngrams).slice(0, 10);
  const p04State = mapMetricState(sr04?.state);
  sectionsById.set("lexical_features", {
    id: "lexical_features",
    moduleId: "lexical_features",
    title: "核心特征词与高频短语",
    description: "高区分度词汇与高频多词搭配",
    scopeId,
    state: p04State,
    stateMessage: friendlyStateMessage(p04State, sr04?.reason ?? ""),
    engineSource: "Explore P04 (SR04/SR05/SR06)",
    unit: "频次/得分",
    denominatorLabel: "有效去重样本",
    sampleCount: sr04?.selected_documents ?? sp.analyzedDocuments,
    metrics: [
      { id: "M_TERMS", label: "显著特征词", value: terms.length, formatted: fmtInt(terms.length), unit: "个" },
      { id: "M_PHRASES", label: "高频短语", value: phrases.length, formatted: fmtInt(phrases.length), unit: "个" },
    ],
    charts: [
      ...(terms.length
        ? [
            {
              id: "C_P04_TERMS",
              title: "核心特征词排名",
              kind: "horizontal_bar" as const,
              unit: "提及/权重",
              xLabels: terms.map((t) => String(t.term ?? t.word ?? "")),
              series: [{ name: "词频/权重", data: terms.map((t) => asNum(t.count ?? t.score ?? t.documents)), color: "#2563eb" }],
            },
          ]
        : []),
      ...(phrases.length
        ? [
            {
              id: "C_P04_PHRASES",
              title: "高频多词搭配",
              kind: "table" as const,
              unit: "次",
              xLabels: [],
              series: [],
              table: {
                columns: ["高频短语", "出现次数"],
                rows: phrases.map((ph) => [String(ph.phrase ?? ph.ngram ?? ""), fmtInt(asNum(ph.count ?? ph.documents))]),
              },
            },
          ]
        : []),
    ],
    evidenceIds: evidence.slice(0, 4).map((e) => e.id),
    method: "Log-Odds + Dirichlet 先验特征词与 n-gram 短语共现抽取。",
    warnings: [],
  });

  // P05 Topics (sorted descending by volume; preserve low-support clusters in an explicit tail bucket when corpus >= 40)
  const sr08 = findMetric(p05, "SR08");
  const rawTopicRows = sortTopicsDesc(asArray(sr08?.data.topics));
  const minMainCluster = sp.analyzedDocuments >= 60 ? Math.max(3, Math.min(5, Math.floor(sp.analyzedDocuments * 0.006))) : 1;
  const mainTopics = rawTopicRows.filter((tr) => asNum(tr.documents ?? tr.size ?? tr.count) >= minMainCluster);
  const tailTopics = rawTopicRows.filter((tr) => asNum(tr.documents ?? tr.size ?? tr.count) < minMainCluster);
  const tailDocs = tailTopics.reduce((sum, tr) => sum + asNum(tr.documents ?? tr.size ?? tr.count), 0);
  const topicRows = (mainTopics.length > 0 ? mainTopics : rawTopicRows).slice(0, 10);
  const chartLabels = topicRows.map((tr, idx) => formatTopicLabel(tr, idx));
  const chartCounts = topicRows.map((tr) => asNum(tr.documents ?? tr.size ?? tr.count));
  if (mainTopics.length > 0 && tailDocs > 0) {
    chartLabels.push(`其他零散讨论（${tailTopics.length} 个小簇）`);
    chartCounts.push(tailDocs);
  }
  const topTopicCount = topicRows[0] ? asNum(topicRows[0].documents ?? topicRows[0].size ?? topicRows[0].count) : 0;
  const p05State = mapMetricState(sr08?.state);
  sectionsById.set("topic_clusters", {
    id: "topic_clusters",
    moduleId: "topic_clusters",
    title: "核心关注话题与代表观点",
    description: "基于语义聚类的核心讨论话题构成（按文档数降序排列）",
    scopeId,
    state: p05State,
    stateMessage: friendlyStateMessage(p05State, sr08?.reason ?? ""),
    engineSource: "Explore P05 (SR08/SR29)",
    unit: "条",
    denominatorLabel: "有效去重样本",
    sampleCount: sr08?.selected_documents ?? sp.analyzedDocuments,
    metrics: [
      { id: "M_TOPIC_CNT", label: "核心主题簇", value: topicRows.length, formatted: fmtInt(topicRows.length), unit: "个" },
      ...(topicRows[0] ? [{ id: "M_TOP_TOPIC", label: "最大话题规模", value: topTopicCount, formatted: fmtInt(topTopicCount), unit: "条" }] : []),
    ],
    charts: topicRows.length
      ? [
          {
            id: "C_P05_TOPICS",
            title: "核心话题分布",
            kind: "horizontal_bar",
            unit: "条",
            xLabels: chartLabels,
            series: [{ name: "样本数", data: chartCounts, color: "#0f766e" }],
            evidenceIds: evidenceByModule.get("topic_clusters") ?? [],
          },
        ]
      : [],
    evidenceIds: evidenceByModule.get("topic_clusters") ?? [],
    method: sp.potionModelReady ? "语义向量聚类 + c-TF-IDF 主题词抽取（按文档量降序）。" : "基于词项分布的话题聚类（未加载语义向量模型）。",
    warnings: [
      ...(!sp.potionModelReady ? ["语义向量模型未就绪，已降级为词频主题分析。"] : []),
      ...(mainTopics.length > 0 && tailDocs > 0 ? [`已将 ${tailTopics.length} 个低支持微簇（共 ${tailDocs} 条）归入「其他零散讨论」，保留完整分母与成员证据。`] : []),
    ],
  });

  // P06 Temporal Rhythm
  const sr25 = findMetric(p06, "SR25");
  const cells = asArray(sr25?.data.cells ?? sr25?.data.matrix);
  const p06State = mapMetricState(sr25?.state);
  sectionsById.set("temporal_rhythm", {
    id: "temporal_rhythm",
    moduleId: "temporal_rhythm",
    title: "话题时间分布与活跃节律",
    description: "星期×小时活跃时段分布（UTC）",
    scopeId,
    state: p06State,
    stateMessage: friendlyStateMessage(p06State, sr25?.reason ?? ""),
    engineSource: "Explore P06 (SR24/SR25)",
    unit: "条",
    denominatorLabel: "含发布时间样本",
    sampleCount: sr25?.selected_documents ?? sp.analyzedDocuments,
    metrics: [{ id: "M_RHYTHM_CELLS", label: "活跃时段格", value: cells.length, formatted: fmtInt(cells.length), unit: "格" }],
    charts: [],
    evidenceIds: [],
    method: "按发布时间 UTC 星期（0–6）× 小时（0–23）聚合统计。",
    warnings: [],
  });

  // P07 & P08 Anomaly Events
  const sl04 = findMetric(p07, "SL04");
  const sl15 = findMetric(p07, "SL15");
  const sl30 = findMetric(p08, "SL30");
  const anomalyEvents = asArray(sl15?.data.events ?? sl30?.data.events ?? sl04?.data.anomalies).slice(0, 8);
  const p07State = mapMetricState(sl15?.state ?? sl04?.state);
  sectionsById.set("anomaly_events", {
    id: "anomaly_events",
    moduleId: "anomaly_events",
    title: "声量异常波动与事件时间线",
    description: "基于滚动基线的突发异常窗口与代表讨论",
    scopeId,
    state: p07State,
    stateMessage: friendlyStateMessage(p07State, sl15?.reason ?? sl04?.reason ?? ""),
    engineSource: "Explore P07/P08 (SL04/SL15/SL17/SL30)",
    unit: "次",
    denominatorLabel: "活跃时间窗口",
    sampleCount: sl04?.selected_documents ?? sp.analyzedDocuments,
    metrics: [{ id: "M_ANOMALIES", label: "检测异常事件", value: anomalyEvents.length, formatted: fmtInt(anomalyEvents.length), unit: "个" }],
    charts: anomalyEvents.length
      ? [
          {
            id: "C_P07_EVENTS",
            title: "异常波动事件清单",
            kind: "table",
            unit: "条",
            xLabels: [],
            series: [],
            table: {
              columns: ["日期/时段", "声量", "异常强度 (Z)", "摘要/关键词"],
              rows: anomalyEvents.map((ev) => [
                String(ev.date ?? ev.start_day ?? ev.window ?? "—"),
                fmtInt(asNum(ev.documents ?? ev.count)),
                typeof ev.z_score === "number" ? ev.z_score.toFixed(2) : "—",
                String(ev.summary ?? ev.label ?? (Array.isArray(ev.keywords) ? ev.keywords.join(", ") : "—")).slice(0, 64),
              ]),
            },
            evidenceIds: evidenceByModule.get("anomaly_events") ?? [],
          },
        ]
      : [],
    evidenceIds: evidenceByModule.get("anomaly_events") ?? [],
    method: "过去窗口滚动 z-score / MAD 异常检测与簇归并。",
    warnings: anomalyEvents.length === 0 ? ["当前时间窗内未检测到显著超出基线的声量突发异常。"] : [],
  });

  // P09 Sentiment (SL07 + SL09 + SL08 Net Sentiment Index)
  const sl07 = findMetric(p09, "SL07");
  const sl09 = findMetric(p09, "SL09");
  const sl08 = findMetric(p09, "SL08");
  const sentDist = asArray(sl07?.data.labels ?? sl07?.data.distribution);
  const negRate = asNum(sl09?.data.negative_rate ?? sl09?.data.rate);
  const netSent = typeof sl08?.data.net_sentiment === "number" ? sl08.data.net_sentiment : null;
  const sentRuntime = (sl07?.data.runtime as { device?: string; model?: string; weightFile?: string } | undefined) ?? undefined;
  const p09State = mapMetricState(sl07?.state);
  // Reuse sentLabelZh declared above for P09 sentiment labels
  sectionsById.set("sentiment_reputation", {
    id: "sentiment_reputation",
    moduleId: "sentiment_reputation",
    title: "消费者口碑与情感态度",
    description: "正负情感构成、净情感指数（SL08）、负面率与代表观点（未判情感单列）",
    scopeId,
    state: p09State,
    stateMessage: friendlyStateMessage(p09State, sl07?.reason ?? ""),
    engineSource: "Explore P09 (SL07/SL08/SL09)",
    unit: "条",
    denominatorLabel: "有效去重样本",
    sampleCount: sl07?.selected_documents ?? sp.analyzedDocuments,
    metrics: [
      { id: "M_NEG_RATE", label: "负面评价占比", value: negRate, formatted: fmtPct(negRate), unit: "", denominator: "明确正负评价" },
      ...(netSent !== null
        ? [{ id: "M_NET_SENTIMENT", label: "净情感指数 (SL08)", value: netSent, formatted: netSent >= 0 ? `+${netSent.toFixed(2)}` : netSent.toFixed(2), unit: "", denominator: "明确正负评价 [-1,+1]" }]
        : []),
      ...sentDist.slice(0, 4).map((row) => ({
        id: `M_SENT_${String(row.label ?? "x").toUpperCase()}`,
        label: sentLabelZh[String(row.label ?? "")] ?? String(row.label ?? ""),
        value: asNum(row.documents ?? row.count),
        formatted: fmtInt(asNum(row.documents ?? row.count)),
        unit: "条",
      })),
    ],
    charts: sentDist.length
      ? [
          {
            id: "C_P09_SENT",
            title: "样本情感分布（未判情感单列）",
            kind: "horizontal_bar",
            unit: "条",
            xLabels: sentDist.map((row) => sentLabelZh[String(row.label ?? "")] ?? String(row.label ?? "")),
            series: [{ name: "样本数", data: sentDist.map((row) => asNum(row.documents ?? row.count)), color: "#0f766e" }],
            evidenceIds: evidenceByModule.get("sentiment_reputation") ?? [],
          },
        ]
      : [],
    evidenceIds: evidenceByModule.get("sentiment_reputation") ?? [],
    method: sentRuntime?.model
      ? `多语上下文情感模型（${sentRuntime.device === "gpu" ? "GPU FP16 加速" : "CPU INT8"}），结合转折分句含混识别与客观信息门控；净情感指数 (正-负)/(正+负)。`
      : "情感极性分类，明确将无法判定情感的客观陈述单列为“未判情感”，不混入中性。",
    warnings: [],
  });

  // P10 Active Demand
  const pr02 = findMetric(p10, "PR02");
  const od03 = findMetric(p10, "OD03");
  const od04 = findMetric(p10, "OD04");
  const demandStates = asArray(od03?.data.states ?? od04?.data.states ?? pr02?.data.states);
  const activeDemandCount = asNum(pr02?.data.documents ?? pr02?.data.count ?? demandStates.reduce((s, r) => s + asNum(r.documents ?? r.count), 0));
  const p10State = mapMetricState(od03?.state ?? pr02?.state);
  const demandZh: Record<string, string> = {
    recommendation_request: "求推荐",
    alternative_search: "找替代/平替",
    feature_request: "功能诉求",
    unmet_need: "未满足需求",
    solution_search: "求解决方案",
    explicit_need: "明确需求",
    bundled_need: "组合需求",
  };
  sectionsById.set("active_demand", {
    id: "active_demand",
    moduleId: "active_demand",
    title: "主动需求与显式诉求",
    description: "求推荐、找平替、功能请求与未满足需求分布（多标签可重叠）",
    scopeId,
    state: p10State,
    stateMessage: friendlyStateMessage(p10State, od03?.reason ?? ""),
    engineSource: "Explore P10 (PR02/OD03/OD04)",
    unit: "条",
    denominatorLabel: `有效去重样本 N=${sp.analyzedDocuments}`,
    sampleCount: pr02?.selected_documents ?? sp.analyzedDocuments,
    metrics: [
      { id: "M_DEMAND_DOCS", label: "主动需求文档", value: activeDemandCount, formatted: fmtInt(activeDemandCount), unit: "条" },
      { id: "M_DEMAND_RATE", label: "主动需求密度", value: sp.analyzedDocuments > 0 ? activeDemandCount / sp.analyzedDocuments : 0, formatted: fmtPct(sp.analyzedDocuments > 0 ? activeDemandCount / sp.analyzedDocuments : 0), unit: "" },
    ],
    charts: demandStates.length
      ? [
          {
            id: "C_P10_DEMAND",
            title: "显式诉求类型分布（单条讨论可同时命中多项）",
            kind: "horizontal_bar",
            unit: "条",
            xLabels: demandStates.map((s) => demandZh[String(s.state ?? s.label ?? "")] ?? String(s.state ?? s.label ?? "")),
            series: [{ name: "命中文档数", data: demandStates.map((s) => asNum(s.documents ?? s.count)), color: "#2563eb" }],
            evidenceIds: evidenceByModule.get("active_demand") ?? [],
          },
        ]
      : [],
    evidenceIds: evidenceByModule.get("active_demand") ?? [],
    method: "多标签需求意图规则与语义识别；单条内容可归属多个诉求维度，不直接相加。",
    warnings: [],
  });

  // P11 Pain Points
  const od06 = findMetric(p11, "OD06");
  const od05 = findMetric(p11, "OD05");
  const painClusters = asArray(od06?.data.clusters ?? od05?.data.clusters).slice(0, 10);
  const p11State = mapMetricState(od06?.state ?? od05?.state);
  const painZh: Record<string, string> = {
    reliability_bug: "故障与稳定性问题",
    performance_latency: "性能与体验延迟",
    cost_pricing: "价格与付费顾虑",
    usability_ux: "易用性与佩戴/操作体验",
  };
  sectionsById.set("pain_points", {
    id: "pain_points",
    moduleId: "pain_points",
    title: "未满足需求与产品痛点",
    description: "高频痛点聚类与代表性抱怨语境",
    scopeId,
    state: p11State,
    stateMessage: friendlyStateMessage(p11State, od06?.reason ?? ""),
    engineSource: "Explore P11 (OD05/OD06/OD30)",
    unit: "条",
    denominatorLabel: "有效去重样本",
    sampleCount: od06?.selected_documents ?? sp.analyzedDocuments,
    metrics: [
      { id: "M_PAIN_CLUSTERS", label: "识别痛点簇", value: painClusters.length, formatted: fmtInt(painClusters.length), unit: "类" },
      ...(painClusters[0] ? [{ id: "M_TOP_PAIN", label: "首要痛点规模", value: asNum(painClusters[0].documents ?? painClusters[0].size ?? painClusters[0].count), formatted: fmtInt(asNum(painClusters[0].documents ?? painClusters[0].size ?? painClusters[0].count)), unit: "条" }] : []),
    ],
    charts: painClusters.length
      ? [
          {
            id: "C_P11_PAIN",
            title: "核心产品痛点分布",
            kind: "horizontal_bar",
            unit: "条",
            xLabels: painClusters.map((c) => painZh[String(c.label ?? "")] ?? String(c.label ?? c.name ?? "").slice(0, 32)),
            series: [{ name: "提及样本数", data: painClusters.map((c) => asNum(c.documents ?? c.size ?? c.count)), color: "#d97706" }],
            evidenceIds: evidenceByModule.get("pain_points") ?? [],
          },
        ]
      : [],
    evidenceIds: evidenceByModule.get("pain_points") ?? [],
    method: "基于痛点片段抽取与语义密度聚类（无语义模型时回退规则痛点分类）。",
    warnings: [],
  });

  // P12 Price & Purchase Stages
  const pr24 = findMetric(p12, "PR24");
  const mi24 = findMetric(p12, "MI24");
  const mi28 = findMetric(p12, "MI28");
  const priceDocs = asNum(pr24?.data.documents);
  const priceRate = asNum(pr24?.data.rate);
  const stages = asArray(mi28?.data.stages);
  const cohorts = asArray(mi24?.data.cohorts).slice(0, 8);
  const p12State = mapMetricState(mi28?.state ?? pr24?.state);
  const stageZh: Record<string, string> = {
    need: "需求萌生",
    research: "调研评估",
    compare: "竞品对比",
    budget: "预算考量",
    intent: "购买意向",
    purchased: "已购买/订阅",
    use: "使用体验",
    returned: "退货/取消",
  };
  sectionsById.set("price_purchase", {
    id: "price_purchase",
    moduleId: "price_purchase",
    title: "价格关注与购买决策阶段",
    description: "价格提及比例、币种价位带与消费者购买阶段文本信号",
    scopeId,
    state: p12State,
    stateMessage: friendlyStateMessage(p12State, pr24?.reason ?? ""),
    engineSource: "Explore P12 (PR24/MI24/MI28)",
    unit: "条",
    denominatorLabel: `有效去重样本 N=${sp.analyzedDocuments}`,
    sampleCount: pr24?.selected_documents ?? sp.analyzedDocuments,
    metrics: [
      { id: "M_PRICE_DOCS", label: "价格关注文本", value: priceDocs, formatted: fmtInt(priceDocs), unit: "条" },
      { id: "M_PRICE_RATE", label: "价格敏感度占比", value: priceRate, formatted: fmtPct(priceRate), unit: "" },
      { id: "M_PRICE_COHORTS", label: "识别价位组", value: cohorts.length, formatted: fmtInt(cohorts.length), unit: "组" },
    ],
    charts: [
      ...(stages.length
        ? [
            {
              id: "C_P12_STAGES",
              title: "购买决策阶段信号分布（文本信号，非真实成交）",
              kind: "horizontal_bar" as const,
              unit: "条",
              xLabels: stages.map((st) => stageZh[String(st.stage ?? "")] ?? String(st.stage ?? "")),
              series: [{ name: "样本数", data: stages.map((st) => asNum(st.documents ?? st.count)), color: "#7c3aed" }],
              evidenceIds: evidenceByModule.get("price_purchase") ?? [],
            },
          ]
        : []),
      ...(cohorts.length
        ? [
            {
              id: "C_P12_PRICES",
              title: "分币种价位提及概况",
              kind: "table" as const,
              unit: "次",
              xLabels: [],
              series: [],
              table: {
                columns: ["币种/周期", "提及次数", "中位价", "区间 (P25–P75)"],
                rows: cohorts.map((c) => [
                  `${String(c.currency ?? "USD")}${c.period ? ` / ${String(c.period)}` : ""}`,
                  fmtInt(asNum(c.count ?? c.mentions)),
                  typeof c.median === "number" ? c.median.toFixed(1) : "—",
                  typeof c.p25 === "number" && typeof c.p75 === "number" ? `${c.p25.toFixed(0)}–${c.p75.toFixed(0)}` : "—",
                ]),
              },
            },
          ]
        : []),
    ],
    evidenceIds: evidenceByModule.get("price_purchase") ?? [],
    method: "分币种与计费周期抽取金额提及；购买阶段基于文本多标签表达，不代表实际交易转化率。",
    warnings: ["文本中的价格与购买意向信号不等同于实际电商销量或成交价格。"],
  });

  // P13 Brand Competition & Direct Comparison (MI05, MI06, MI07, MI14, MI13)
  const mi05 = findMetric(p13, "MI05");
  const mi06 = findMetric(p13, "MI06");
  const mi07 = findMetric(p13, "MI07");
  const mi14 = findMetric(p13, "MI14");
  const mi13 = findMetric(p13, "MI13");
  const brandRows = asArray(mi06?.data.brands ?? mi05?.data.brands).slice(0, 10);
  const compPairs = asArray(mi14?.data.pairs).slice(0, 10);
  const coEdges = asArray(mi13?.data.edges).slice(0, 8);
  const brandCovRate = asNum(mi07?.data.coverage_rate);
  const brandUnmatchedRate = asNum(mi07?.data.unmatched_rate);
  const p13State = mapMetricState(mi05?.state ?? mi07?.state);
  const relZh: Record<string, string> = { switch: "切换/替换", alternative: "平替/优劣对比", compare: "直接对比" };
  sectionsById.set("brand_competition", {
    id: "brand_competition",
    moduleId: "brand_competition",
    title: "品牌格局与竞品比较",
    description: "样本品牌声量份额（MI05/MI06）、品牌提及覆盖率（MI07）与同句直接竞品对比（MI14）",
    scopeId,
    state: p13State,
    stateMessage: friendlyStateMessage(p13State, mi05?.reason ?? ""),
    engineSource: "Explore P13 (MI05/MI06/MI07/MI14/MI13)",
    unit: "篇",
    denominatorLabel: `有效去重样本 N=${sp.analyzedDocuments}`,
    sampleCount: mi05?.selected_documents ?? sp.analyzedDocuments,
    metrics: [
      { id: "M_BRAND_COUNT", label: "识别品牌数", value: asNum(mi07?.data.distinct_brands) || brandRows.length, formatted: fmtInt(asNum(mi07?.data.distinct_brands) || brandRows.length), unit: "个" },
      { id: "M_BRAND_COV", label: "品牌提及覆盖率", value: brandCovRate, formatted: fmtPct(brandCovRate), unit: "", denominator: "有效去重样本" },
      ...(brandRows[0]
        ? [{ id: "M_TOP_BRAND_SOV", label: `声量份额 Top1 (${String(brandRows[0].brand)})`, value: asNum(brandRows[0].sov_share), formatted: fmtPct(asNum(brandRows[0].sov_share)), unit: "", denominator: "已识别品牌提及总量" }]
        : []),
      { id: "M_DIRECT_COMP_EDGES", label: "直接竞品对比对", value: compPairs.length, formatted: fmtInt(compPairs.length), unit: "组" },
    ],
    charts: [
      ...(brandRows.length
        ? [
            {
              id: "C_P13_BRAND_SOV",
              title: "样本品牌声量排行（MI05/MI06）",
              subtitle: `品牌提及覆盖率 ${fmtPct(brandCovRate)} · 未匹配品牌 ${fmtPct(brandUnmatchedRate)}`,
              kind: "horizontal_bar" as const,
              unit: "篇",
              xLabels: brandRows.map((b) => `${String(b.brand)} (${fmtPct(asNum(b.sov_share))})`),
              series: [{ name: "提及篇数", data: brandRows.map((b) => asNum(b.documents)), color: "#0f766e" }],
              evidenceIds: evidenceByModule.get("brand_competition") ?? [],
            },
          ]
        : []),
      ...(compPairs.length
        ? [
            {
              id: "C_P13_DIRECT_COMP",
              title: "同句直接竞品对比与切换关系（MI14，已与普通共提分层）",
              kind: "table" as const,
              unit: "篇",
              xLabels: [],
              series: [],
              table: {
                columns: ["竞品关系", "比较类型", "命中篇数"],
                rows: compPairs.map((p) => [
                  p.direction === "directed" ? `${String(p.brand_a)} → ${String(p.brand_b)}` : `${String(p.brand_a)} vs ${String(p.brand_b)}`,
                  relZh[String(p.relation_type ?? "")] ?? String(p.relation_type ?? ""),
                  fmtInt(asNum(p.documents)),
                ]),
              },
              evidenceIds: evidenceByModule.get("brand_competition") ?? [],
            },
          ]
        : []),
      ...(!compPairs.length && coEdges.length
        ? [
            {
              id: "C_P13_COOCCUR",
              title: "文档级品牌共提关联（MI13，非直接比较）",
              kind: "table" as const,
              unit: "篇",
              xLabels: [],
              series: [],
              table: {
                columns: ["共提品牌对", "共提篇数", "Lift", "NPMI"],
                rows: coEdges.map((e) => [
                  `${String(e.brand_a)} × ${String(e.brand_b)}`,
                  fmtInt(asNum(e.co_documents)),
                  typeof e.lift === "number" ? e.lift.toFixed(2) : "—",
                  typeof e.npmi === "number" ? e.npmi.toFixed(2) : "—",
                ]),
              },
            },
          ]
        : []),
    ],
    evidenceIds: evidenceByModule.get("brand_competition") ?? [],
    method: "基于规范品牌别名词表与语境消歧守卫统计样本品牌份额（严格加总 100%）；MI14 仅抽取同句显式比较/切换关系，与 MI13 文档共提网络严格分层。",
    warnings: [
      "样本品牌声量份额仅反映当前检索语料中的讨论分布，不等同于真实市场销量份额；未识别品牌的讨论不可直接推断为未决定购买。",
    ],
  });

  // P14 Brand × Attribute Sentiment Matrix & Attribute Negative Rate (MI19, PR07, SL08)
  const pr07 = findMetric(p14, "PR07");
  const mi19 = findMetric(p14, "MI19");
  const attrRows = asArray(pr07?.data.attributes).slice(0, 10);
  const ratedAttrs = attrRows.filter((a) => typeof a.negative_rate === "number");
  const hmBrands = asArray<string>(mi19?.data.brands).slice(0, 7);
  const hmAttrs = asArray<string>(mi19?.data.attributes).slice(0, 7);
  const hmCells = asArray(mi19?.data.cells);
  const hmValues: Array<[number, number, number]> = [];
  for (const c of hmCells) {
    const xi = hmAttrs.indexOf(String(c.attribute ?? ""));
    const yi = hmBrands.indexOf(String(c.brand ?? ""));
    if (xi >= 0 && yi >= 0 && typeof c.net_sentiment === "number") {
      hmValues.push([xi, yi, Number(c.net_sentiment.toFixed(2))]);
    }
  }
  const p14AttrState = mapMetricState(mi19?.state ?? pr07?.state);
  sectionsById.set("brand_attribute_matrix", {
    id: "brand_attribute_matrix",
    moduleId: "brand_attribute_matrix",
    title: "品牌属性口碑与净情感",
    description: "基于分句目标归属的品牌×属性净情感热力矩阵（MI19）与品类属性负面率（PR07）",
    scopeId,
    state: p14AttrState,
    stateMessage: friendlyStateMessage(p14AttrState, mi19?.reason ?? pr07?.reason ?? ""),
    engineSource: "Explore P14 (MI19/PR07/SL08)",
    unit: "净情感",
    denominatorLabel: "属性/品牌明确正负评价分母",
    sampleCount: pr07?.selected_documents ?? sp.analyzedDocuments,
    metrics: [
      ...(netSent !== null
        ? [{ id: "M_OVERALL_NSI", label: "样本净情感指数 (SL08)", value: netSent, formatted: netSent >= 0 ? `+${netSent.toFixed(2)}` : netSent.toFixed(2), unit: "", denominator: "明确正负评价" }]
        : []),
      ...(ratedAttrs[0]
        ? [{ id: "M_TOP_NEG_ATTR", label: `最高负面率属性 (${String(ratedAttrs[0].attribute)})`, value: asNum(ratedAttrs[0].negative_rate), formatted: fmtPct(asNum(ratedAttrs[0].negative_rate)), unit: "", denominator: `n=${asNum(ratedAttrs[0].opinion_denominator)}` }]
        : []),
      { id: "M_MATRIX_CELLS", label: "有效品牌×属性格", value: hmValues.length, formatted: fmtInt(hmValues.length), unit: "格" },
    ],
    charts: [
      ...(hmValues.length >= 2
        ? [
            {
              id: "C_P14_BRAND_ATTR_HEATMAP",
              title: "品牌 × 属性净情感热力矩阵（MI19，范围 -1 至 +1）",
              subtitle: "按分句目标归属聚合，绿色偏正向、红色偏负向",
              kind: "heatmap" as const,
              unit: "NSI",
              xLabels: hmAttrs,
              series: [],
              heatmap: {
                xLabels: hmAttrs,
                yLabels: hmBrands,
                values: hmValues,
              },
              evidenceIds: evidenceByModule.get("brand_attribute_matrix") ?? [],
            },
          ]
        : []),
      ...(ratedAttrs.length
        ? [
            {
              id: "C_P14_ATTR_NEG_RATE",
              title: "品类属性负面率排行（PR07，%）",
              subtitle: "负面评价 / (正面评价 + 负面评价)，已过滤无明确极性句段",
              kind: "horizontal_bar" as const,
              unit: "%",
              xLabels: ratedAttrs.slice(0, 8).map((a) => `${String(a.attribute)} (n=${asNum(a.opinion_denominator)})`),
              series: [{ name: "属性负面率 (%)", data: ratedAttrs.slice(0, 8).map((a) => Number((asNum(a.negative_rate) * 100).toFixed(1))), color: "#dc2626" }],
              evidenceIds: evidenceByModule.get("brand_attribute_matrix") ?? [],
            },
          ]
        : []),
    ],
    evidenceIds: evidenceByModule.get("brand_attribute_matrix") ?? [],
    method: "按转折与标点拆句，在同分句内绑定品牌与属性极性（避免同帖夸 A 贬 B 串味）；净情感指数 = (正-负)/(正+负)。",
    warnings: hmCells.some((c) => c.low_support)
      ? ["部分品牌×属性单元格明确正负评价少于 3 条（低支持量），解读时请结合代表原文。"]
      : [],
  });

  // P14 Usage Scenarios & User Workarounds (PR13, OD16)
  const pr13 = findMetric(p14, "PR13");
  const od16 = findMetric(p14, "OD16");
  const scenRows = asArray(pr13?.data.scenarios).slice(0, 10);
  const workCases = asArray(od16?.data.cases).slice(0, 8);
  const workDocs = asNum(od16?.data.documents);
  const p14ScenState = mapMetricState(pr13?.state ?? od16?.state);
  sectionsById.set("scenario_workaround", {
    id: "scenario_workaround",
    moduleId: "scenario_workaround",
    title: "使用场景需求与用户变通方案",
    description: "区分全部场景提及与场景内主动需求（PR13），并提取用户自制/替代变通方案（OD16）",
    scopeId,
    state: p14ScenState,
    stateMessage: friendlyStateMessage(p14ScenState, pr13?.reason ?? ""),
    engineSource: "Explore P14 (PR13/OD16)",
    unit: "篇",
    denominatorLabel: `有效去重样本 N=${sp.analyzedDocuments}`,
    sampleCount: pr13?.selected_documents ?? sp.analyzedDocuments,
    metrics: [
      { id: "M_SCEN_COVERED", label: "命中场景文档", value: asNum(pr13?.data.covered_documents), formatted: fmtInt(asNum(pr13?.data.covered_documents)), unit: "篇" },
      ...(scenRows[0]
        ? [{ id: "M_TOP_SCENARIO", label: `核心场景 (${String(scenRows[0].scenario)})`, value: asNum(scenRows[0].documents), formatted: fmtInt(asNum(scenRows[0].documents)), unit: "篇" }]
        : []),
      { id: "M_WORKAROUND_DOCS", label: "用户变通方案", value: workDocs, formatted: fmtInt(workDocs), unit: "篇", denominator: `占样本 ${fmtPct(asNum(od16?.data.rate))}` },
    ],
    charts: [
      ...(scenRows.length
        ? [
            {
              id: "C_P14_SCENARIOS",
              title: "高频使用场景与主动需求分布（PR13，多标签可重叠）",
              kind: "horizontal_bar" as const,
              unit: "篇",
              xLabels: scenRows.slice(0, 8).map((s) => `${String(s.scenario)} (需求 ${asNum(s.demand_documents)})`),
              series: [{ name: "场景提及篇数", data: scenRows.slice(0, 8).map((s) => asNum(s.documents)), color: "#2563eb" }],
              evidenceIds: evidenceByModule.get("scenario_workaround") ?? [],
            },
          ]
        : []),
      ...(workCases.length
        ? [
            {
              id: "C_P14_WORKAROUNDS",
              title: "典型用户变通与自制替代方案（OD16，可验证产品机会线索）",
              kind: "table" as const,
              unit: "条",
              xLabels: [],
              series: [],
              table: {
                columns: ["变通类别", "解决状态", "用户做法摘录"],
                rows: workCases.map((w) => [
                  String(w.category ?? ""),
                  w.resolution_status === "resolved" ? "已验证有效" : "绕行使用中",
                  String(w.excerpt ?? "").slice(0, 120),
                ]),
              },
              evidenceIds: evidenceByModule.get("scenario_workaround") ?? [],
            },
          ]
        : []),
    ],
    evidenceIds: evidenceByModule.get("scenario_workaround") ?? [],
    method: "多标签场景识别区分「普通提及」与「场景内明确需求/痛点」；变通方案基于 DIY、第三方配件与绕行规则抽取，产品改进建议均以「可验证线索」呈现。",
    warnings: ["多标签场景不可直接相加；变通方案属于定性机会线索，建议结合后续用户访谈或小规模测试验证。"],
  });

  return {
    scopes: [scope],
    sectionsById,
    evidence,
    dataVersion: explore.dataVersion,
    studyId: explore.studyId,
  };
}

// ---------------- 3. Project L1/L2/L3 Adapter ----------------

export async function adaptProjectL1L2L3Analysis(
  pool: Pool,
  actor: Actor,
  projectId: string,
  lang: "zh" | "en",
): Promise<AdaptedAnalysisBundle> {
  const [l1, l2, l3Res] = await Promise.all([
    runL1ResearchOverview(pool, actor, projectId, { lang }),
    runL2ResearchComparison(pool, actor, projectId, { lang }).catch(() => null),
    listResearchTasks(pool, actor, projectId).catch(() => ({ dataVersion: "", tasks: [] })),
  ]);
  const l3Tasks = l3Res.tasks;

  const scopeId = "S_PROJ";
  const scale = l1.analyses.scale.data;
  const scope: ReportScopeSummary = {
    id: scopeId,
    sourceKind: "project",
    sourceLabel: `研究项目：${l1.projectName}`,
    query: l1.scope.selectedTargetKeys.join(", ") || "项目有效研究范围",
    range: {
      from: l1.scope.from,
      to: l1.scope.to,
      activeDays: l1.analyses.trend.data.points.length,
    },
    dataVersion: l1.dataVersion,
    matchedCount: scale.deduplicatedContentCount,
    matchedUnit: "去重内容",
    matchedStatus: "exact",
    analyzedCount: scale.deduplicatedContentCount,
    analyzedUnit: "去重内容",
    samplingNote: `主帖 ${scale.postsCount} 条 + 已采评论 ${scale.commentsCount} 条 + 文章 ${scale.articlesCount} 条（平台报告评论 ${scale.reportedPlatformCommentsSum} 条单列）。`,
    engineLabel: "项目 L1/L2/L3 分析引擎",
    projectId,
  };

  const evidence: ReportEvidenceItem[] = [];
  for (const item of l1.analyses.topContent.data.items.slice(0, 10)) {
    evidence.push({
      id: `E-${String(evidence.length + 1).padStart(2, "0")}`,
      scopeId,
      moduleId: "scope_overview",
      groupLabel: item.communityName ?? item.platform,
      title: item.title ?? "",
      excerpt: (item.cleanExcerpt ?? item.title ?? "").slice(0, 420),
      sourceLabel: item.platform.toUpperCase(),
      platform: item.platform,
      community: item.communityName,
      author: item.authorHandle,
      publishedAt: item.publishedAt,
      url: item.url,
      documentId: item.id,
      reason: "项目内高互动代表内容",
    });
  }

  const sectionsById = new Map<string, ReportSectionData>();

  const objRows = l1.analyses.keywords.data.rows;
  if (objRows.length > 0) {
    sectionsById.set("competitor_comparison", {
      id: "competitor_comparison",
      moduleId: "competitor_comparison",
      title: "多对象与竞品声量对比",
      description: "基于项目 L1/L2 引擎的对象声量、独占讨论与重叠分析",
      scopeId,
      state: objRows.length >= 2 ? "ready" : "exploratory",
      stateMessage: objRows.length >= 2 ? `已对比 ${objRows.length} 个研究对象的声量与独占比例。` : "当前项目仅包含单一对象，展示基础声量分布。",
      engineSource: l2 ? "Project L2 Comparison" : "Project L1 Objects",
      unit: "条",
      denominatorLabel: "项目去重样本",
      sampleCount: scale.deduplicatedContentCount,
      metrics: objRows.slice(0, 4).map((r, i) => ({
        id: `M_L2_OBJ_${i + 1}`,
        label: r.label,
        value: r.contentCount,
        formatted: fmtInt(r.contentCount),
        unit: `条（独占 ${fmtInt(r.exclusiveCount)}）`,
      })),
      charts: [
        {
          id: "C_L2_OBJECTS",
          title: "研究对象声量对比",
          kind: "horizontal_bar",
          unit: "条",
          xLabels: objRows.map((r) => r.label),
          series: [
            { name: "总声量", data: objRows.map((r) => r.contentCount), color: "#0f766e" },
            { name: "独占讨论", data: objRows.map((r) => r.exclusiveCount), color: "#2563eb" },
          ],
        },
      ],
      evidenceIds: evidence.slice(0, 4).map((e) => e.id),
      method: "基于项目 L1/L2 采集目标/批次分组去重对比，含独占讨论与差异分析。",
      warnings: [],
    });
  }

  // Also include completed L3 sentiment/topic summary if available
  const latestSent = l3Tasks.find((t) => t.taskType === "sentiment" && t.status === "succeeded" && t.summary);
  if (latestSent?.summary && "distribution" in latestSent.summary) {
    const dist = asArray<{ label: string; count: number; sharePct: number }>(
      (latestSent.summary as { distribution?: unknown }).distribution,
    );
    sectionsById.set("sentiment_reputation", {
      id: "sentiment_reputation",
      moduleId: "sentiment_reputation",
      title: "消费者口碑与情感态度（项目 L3）",
      description: "基于项目 L3 情感分析任务的极性分布",
      scopeId,
      state: "ready",
      stateMessage: `复用项目 L3 情感分析结果（有效样本 ${latestSent.sampleCount} 条）。`,
      engineSource: "Project L3 Sentiment",
      unit: "条",
      denominatorLabel: `L3 任务样本 N=${latestSent.sampleCount}`,
      sampleCount: latestSent.sampleCount,
      metrics: dist.map((d) => ({
        id: `M_L3_SENT_${d.label.toUpperCase()}`,
        label: d.label,
        value: d.count,
        formatted: fmtInt(d.count),
        unit: `条 (${d.sharePct.toFixed(1)}%)`,
      })),
      charts: [
        {
          id: "C_L3_SENT",
          title: "项目 L3 情感分布",
          kind: "horizontal_bar",
          unit: "条",
          xLabels: dist.map((d) => d.label),
          series: [{ name: "样本数", data: dist.map((d) => d.count), color: "#0f766e" }],
        },
      ],
      evidenceIds: evidence.slice(0, 4).map((e) => e.id),
      method: `项目 L3 情感任务（算法 ${latestSent.algorithmVersion}，未判情感单列）。`,
      warnings: [],
    });
  }

  return {
    scopes: [scope],
    sectionsById,
    evidence,
    dataVersion: l1.dataVersion,
  };
}

// ---------------- 4. Intel Monitor Adapter (F04 Continuous Tracking) ----------------

export async function adaptMonitorAnalysis(
  pool: Pool,
  actor: Actor,
  monitorId: string,
  days = 14,
): Promise<AdaptedAnalysisBundle> {
  const [ov, postsRes] = await Promise.all([
    getMonitorOverview(pool, actor, monitorId, { days }),
    listMonitorPosts(pool, actor, monitorId, { days, limit: 12 }),
  ]);

  const scopeId = "S_MON";
  const scope: ReportScopeSummary = {
    id: scopeId,
    sourceKind: "monitor",
    sourceLabel: `持续监测器：${ov.monitor.name}`,
    query: ov.monitor.name,
    range: { from: ov.window.from, to: ov.window.to, activeDays: ov.timeline.length },
    dataVersion: `monitor:${monitorId}:${ov.window.to.slice(0, 13)}`,
    matchedCount: ov.coverage.sampleSize,
    matchedUnit: "监测样本",
    matchedStatus: "exact",
    analyzedCount: ov.coverage.sampleSize,
    analyzedUnit: "监测样本",
    samplingNote: `覆盖 ${ov.coverage.activeSources}/${ov.coverage.totalSources} 个活跃来源，窗口 ${days} 天。`,
    engineLabel: "Intel 监测与 Rollup 分析引擎",
    monitorId,
    projectId: ov.monitor.projectId,
  };

  const evidence: ReportEvidenceItem[] = postsRes.items.slice(0, 8).map((p, idx) => ({
    id: `E-${String(idx + 1).padStart(2, "0")}`,
    scopeId,
    moduleId: "monitor_tracking",
    groupLabel: p.communityName ?? p.platform,
    title: p.title ?? "",
    excerpt: (p.cleanExcerpt ?? p.title ?? "").slice(0, 420),
    sourceLabel: `${p.platform.toUpperCase()} 监测样本`,
    platform: p.platform,
    community: p.communityName,
    author: p.authorHandle,
    publishedAt: p.publishedAt,
    url: p.url,
    documentId: p.id,
    reason: "监测窗口高热代表帖",
  }));

  const sectionsById = new Map<string, ReportSectionData>();
  sectionsById.set("monitor_tracking", {
    id: "monitor_tracking",
    moduleId: "monitor_tracking",
    title: "持续监测窗口与外链意图",
    description: "监测窗口规模、环比趋势、意图分布与高频外链域名",
    scopeId,
    state: ov.coverage.sampleSize > 0 ? "ready" : "insufficient_data",
    stateMessage: ov.coverage.sampleSize > 0
      ? `监测窗口内累计 ${fmtInt(ov.kpis.posts.current)} 篇主帖与 ${fmtInt(ov.kpis.comments.current)} 条评论。`
      : "当前监测窗口暂无已入库样本，请核查监测器调度与来源状态。",
    engineSource: "Intel Rollup & Analytics",
    unit: "条",
    denominatorLabel: `${days} 天监测窗口`,
    sampleCount: ov.coverage.sampleSize,
    metrics: [
      { id: "M_MON_POSTS", label: "窗口主帖数", value: ov.kpis.posts.current, formatted: fmtInt(ov.kpis.posts.current), unit: "篇" },
      { id: "M_MON_COMMENTS", label: "窗口评论数", value: ov.kpis.comments.current, formatted: fmtInt(ov.kpis.comments.current), unit: "条" },
      { id: "M_MON_ENG", label: "总互动量", value: ov.kpis.totalEngagement.current, formatted: fmtInt(ov.kpis.totalEngagement.current), unit: "" },
      { id: "M_MON_DEPTH", label: "平均讨论深度", value: ov.kpis.discussionDepth, formatted: ov.kpis.discussionDepth.toFixed(2), unit: "评/帖" },
    ],
    charts: [
      ...(ov.timeline.length
        ? [
            {
              id: "C_MON_TREND",
              title: "监测窗口讨论趋势",
              kind: "line" as const,
              unit: "篇",
              xLabels: ov.timeline.map((t) => t.bucketAt.slice(5, 16).replace("T", " ")),
              series: [{ name: "主帖数", data: ov.timeline.map((t) => t.postCount), color: "#0f766e" }],
            },
          ]
        : []),
      ...(ov.geoCitedDomains.length
        ? [
            {
              id: "C_MON_DOMAINS",
              title: "高频引用外链域名",
              kind: "horizontal_bar" as const,
              unit: "次",
              xLabels: ov.geoCitedDomains.slice(0, 10).map((d) => d.domain),
              series: [{ name: "引用次数", data: ov.geoCitedDomains.slice(0, 10).map((d) => d.count), color: "#2563eb" }],
            },
          ]
        : []),
    ],
    evidenceIds: evidence.map((e) => e.id),
    method: "基于监测器关联来源与 Rollup 聚合，作者统计仅反映样本内活跃账号。",
    warnings: [],
  });

  return {
    scopes: [scope],
    sectionsById,
    evidence,
    dataVersion: scope.dataVersion,
  };
}
