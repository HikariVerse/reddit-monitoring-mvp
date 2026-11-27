import type { ReportTemplateType } from "../../../packages/contracts/src/reports";

export interface ReportScopeSummary {
  id: string;
  sourceKind: "stories" | "archive" | "pg_content" | "project" | "monitor" | "ai_events";
  sourceLabel: string;
  query: string;
  range: { from: string | null; to: string | null; activeDays: number };
  dataVersion: string;
  matchedCount: number | null;
  matchedUnit: string;
  matchedStatus: "exact" | "candidate" | "truncated" | "unavailable";
  analyzedCount: number;
  analyzedUnit: string;
  samplingNote: string;
  engineLabel: string;
  projectId?: string | null;
  archiveRefId?: string | null;
  sourceIds?: string[];
  batchIds?: string[];
  monitorId?: string | null;
  studyId?: string | null;
}

export interface ReportEvidenceItem {
  id: string;
  scopeId: string;
  moduleId: string;
  groupLabel?: string;
  title: string;
  excerpt: string;
  sourceLabel: string;
  platform: string;
  community?: string | null;
  author?: string | null;
  publishedAt: string | null;
  url: string | null;
  documentId: string;
  threadId?: string | null;
  engagement?: Record<string, number>;
  reason: string;
}

export interface ReportMetricDatum {
  id: string;
  label: string;
  value: number | string | null;
  formatted: string;
  unit: string;
  denominator?: string;
  note?: string;
}

export interface ReportChartSpec {
  id: string;
  title: string;
  subtitle?: string;
  kind: "line" | "bar" | "horizontal_bar" | "stacked_bar" | "heatmap" | "pie" | "table";
  unit: string;
  denominator?: string;
  xLabels: string[];
  series: Array<{
    name: string;
    data: number[];
    color?: string;
  }>;
  heatmap?: {
    xLabels: string[];
    yLabels: string[];
    values: Array<[number, number, number]>;
  };
  table?: {
    columns: string[];
    rows: Array<Array<string | number>>;
  };
  evidenceIds?: string[];
}

export interface ReportFinding {
  title: string;
  text: string;
  kind: "observation" | "interpretation" | "hypothesis" | "recommendation";
  scopeIds: string[];
  metricIds: string[];
  evidenceIds: string[];
}

export interface ReportNarrative {
  sectionId: string;
  heading: string;
  summary: string;
  findings: ReportFinding[];
  topicLabels?: Array<{ groupId: string; label: string; evidenceIds: string[] }>;
  limitations: string[];
  verified: boolean;
  validationNotes?: string[];
}

export type ModuleAvailabilityState =
  | "ready"
  | "exploratory"
  | "insufficient_data"
  | "unsupported_source"
  | "missing_fields"
  | "unavailable_dependency"
  | "failed";

export interface ReportSectionData {
  id: string;
  moduleId: string;
  title: string;
  description: string;
  scopeId: string;
  state: ModuleAvailabilityState;
  stateMessage: string;
  engineSource: string;
  unit: string;
  denominatorLabel: string;
  sampleCount: number;
  metrics: ReportMetricDatum[];
  charts: ReportChartSpec[];
  evidenceIds: string[];
  method: string;
  warnings: string[];
  narrative?: ReportNarrative | null;
  pinned?: boolean;
}

export interface ReportModuleCatalogItem {
  id: string;
  title: string;
  description: string;
  engineSource: "stories" | "explore" | "project_l1" | "project_l2" | "project_l3" | "intel_monitor" | "system";
  metricIds: string[];
  applicableTemplates: ReportTemplateType[];
  supportedSources: Array<"stories" | "archive" | "pg_content" | "project" | "monitor" | "explore_study">;
  defaultForTemplates: ReportTemplateType[];
  pinned?: boolean;
}

export const REPORT_MODULE_CATALOG: readonly ReportModuleCatalogItem[] = [
  {
    id: "executive_summary",
    title: "核心研究摘要",
    description: "基于已校验统计数据与证据的综合结论与优先发现",
    engineSource: "system",
    metricIds: [],
    applicableTemplates: ["industry", "commerce", "social", "custom"],
    supportedSources: ["stories", "archive", "pg_content", "project", "monitor", "explore_study"],
    defaultForTemplates: ["industry", "commerce", "social", "custom"],
    pinned: true,
  },
  {
    id: "scope_overview",
    title: "研究范围与样本概况",
    description: "统计口径、时间覆盖、去重样本量、数据质量与分析引擎说明",
    engineSource: "system",
    metricIds: ["SL01", "SL03", "SL26", "L1-01"],
    applicableTemplates: ["industry", "commerce", "social", "custom"],
    supportedSources: ["stories", "archive", "pg_content", "project", "monitor", "explore_study"],
    defaultForTemplates: ["industry", "commerce", "social", "custom"],
    pinned: true,
  },
  {
    id: "industry_events",
    title: "重点行业事件与动态",
    description: "跨来源去重后的重要事件、独立报道来源数与代表原文",
    engineSource: "stories",
    metricIds: ["STORY-EVENTS", "AI-EVENTS"],
    applicableTemplates: ["industry", "custom"],
    supportedSources: ["stories", "pg_content"],
    defaultForTemplates: ["industry"],
  },
  {
    id: "industry_topics",
    title: "资讯主题与热词升温",
    description: "信息流高频词、前后窗口升温词与主题聚簇动态",
    engineSource: "stories",
    metricIds: ["STORY-KEYWORDS", "STORY-RISING", "STORY-TOPICS"],
    applicableTemplates: ["industry", "custom"],
    supportedSources: ["stories", "pg_content"],
    defaultForTemplates: ["industry"],
  },
  {
    id: "industry_trend",
    title: "资讯发布趋势与来源构成",
    description: "按时段分布的资讯活跃度与频道/来源等级结构",
    engineSource: "stories",
    metricIds: ["STORY-TREND", "STORY-COMP"],
    applicableTemplates: ["industry", "custom"],
    supportedSources: ["stories", "pg_content"],
    defaultForTemplates: ["industry"],
  },
  {
    id: "discussion_trend",
    title: "讨论规模与时间趋势",
    description: "按日/周讨论声量变化、独立作者规模与归档占比（适用时）",
    engineSource: "explore",
    metricIds: ["SL01", "SL02", "SL03", "L1-02"],
    applicableTemplates: ["commerce", "social", "custom"],
    supportedSources: ["archive", "pg_content", "project", "monitor", "explore_study"],
    defaultForTemplates: ["commerce", "social", "custom"],
  },
  {
    id: "community_audience",
    title: "受众社区与互动分布",
    description: "主要讨论社区、平台分布与按平台拆分的互动表现",
    engineSource: "explore",
    metricIds: ["SR01", "SR03", "SR17", "L1-05", "L1-07"],
    applicableTemplates: ["commerce", "social", "custom"],
    supportedSources: ["archive", "pg_content", "project", "monitor", "explore_study"],
    defaultForTemplates: ["social", "custom"],
  },
  {
    id: "lexical_features",
    title: "核心特征词与高频短语",
    description: "高区分度特征词、差异词与高频多词搭配",
    engineSource: "explore",
    metricIds: ["SR04", "SR05", "SR06", "L2-TFIDF"],
    applicableTemplates: ["commerce", "social", "custom"],
    supportedSources: ["archive", "pg_content", "project", "monitor", "explore_study"],
    defaultForTemplates: ["commerce", "social"],
  },
  {
    id: "topic_clusters",
    title: "核心关注话题与代表观点",
    description: "语义主题聚类、各话题讨论占比与中心代表原帖",
    engineSource: "explore",
    metricIds: ["SR08", "SR29", "L3-NMF"],
    applicableTemplates: ["commerce", "social", "custom"],
    supportedSources: ["archive", "pg_content", "project", "monitor", "explore_study"],
    defaultForTemplates: ["commerce", "social", "custom"],
  },
  {
    id: "temporal_rhythm",
    title: "话题时间分布与活跃节律",
    description: "星期×小时活跃热力与话题随时间演进节奏",
    engineSource: "explore",
    metricIds: ["SR24", "SR25"],
    applicableTemplates: ["social", "custom"],
    supportedSources: ["archive", "pg_content", "project", "explore_study"],
    defaultForTemplates: [],
  },
  {
    id: "anomaly_events",
    title: "声量异常波动与事件时间线",
    description: "滚动基线异常检测、突发事件周期与关键触发讨论",
    engineSource: "explore",
    metricIds: ["SL04", "SL15", "SL17", "SL30"],
    applicableTemplates: ["social", "custom"],
    supportedSources: ["archive", "pg_content", "project", "explore_study"],
    defaultForTemplates: ["social"],
  },
  {
    id: "sentiment_reputation",
    title: "消费者口碑与情感态度",
    description: "正负情感构成、观点表达率与争议焦点（未判单列）",
    engineSource: "explore",
    metricIds: ["SL07", "SL09", "L3-SENTIMENT"],
    applicableTemplates: ["commerce", "social", "custom"],
    supportedSources: ["archive", "pg_content", "project", "monitor", "explore_study"],
    defaultForTemplates: ["commerce", "social", "custom"],
  },
  {
    id: "active_demand",
    title: "主动需求与显式诉求",
    description: "求推荐、找平替、功能诉求与明确未满足需求信号",
    engineSource: "explore",
    metricIds: ["PR02", "PR03", "OD03", "OD04"],
    applicableTemplates: ["commerce", "custom"],
    supportedSources: ["archive", "pg_content", "project", "explore_study"],
    defaultForTemplates: ["commerce", "custom"],
  },
  {
    id: "pain_points",
    title: "未满足需求与产品痛点",
    description: "痛点语义聚类、使用场景困扰与高频抱怨主题",
    engineSource: "explore",
    metricIds: ["OD05", "OD06", "OD30"],
    applicableTemplates: ["commerce", "custom"],
    supportedSources: ["archive", "pg_content", "project", "explore_study"],
    defaultForTemplates: ["commerce", "custom"],
  },
  {
    id: "price_purchase",
    title: "价格关注与购买决策阶段",
    description: "价格敏感度、分币种价位提及与购买链路多标签分布",
    engineSource: "explore",
    metricIds: ["PR24", "MI24", "MI28"],
    applicableTemplates: ["commerce", "custom"],
    supportedSources: ["archive", "pg_content", "project", "explore_study"],
    defaultForTemplates: ["commerce"],
  },
  {
    id: "competitor_comparison",
    title: "多对象与竞品声量对比",
    description: "基于项目 L2 引擎的对象声量、独占讨论、Jaccard 重叠与差异词",
    engineSource: "project_l2",
    metricIds: ["L2-OBJ", "L2-JACCARD", "L2-LOGODDS"],
    applicableTemplates: ["commerce", "social", "custom"],
    supportedSources: ["project"],
    defaultForTemplates: [],
  },
  {
    id: "monitor_tracking",
    title: "持续监测窗口与外链意图",
    description: "监测期环比变化、外链引用域名、讨论意图与活跃账号",
    engineSource: "intel_monitor",
    metricIds: ["INTEL-KPI", "INTEL-INTENT", "INTEL-DOMAINS", "INTEL-AUTHORS"],
    applicableTemplates: ["social", "custom"],
    supportedSources: ["monitor", "project"],
    defaultForTemplates: [],
  },
  {
    id: "business_actions",
    title: "业务启示与后续行动建议",
    description: "基于真实发现提炼的产品、运营、营销与核查建议（明确标注待验证假设）",
    engineSource: "system",
    metricIds: [],
    applicableTemplates: ["industry", "commerce", "social", "custom"],
    supportedSources: ["stories", "archive", "pg_content", "project", "monitor", "explore_study"],
    defaultForTemplates: ["industry", "commerce", "social", "custom"],
  },
  {
    id: "sources_appendix",
    title: "数据来源、方法与证据索引",
    description: "研究范围快照、数据版本、引擎状态、算法口径与代表性原文清单",
    engineSource: "system",
    metricIds: [],
    applicableTemplates: ["industry", "commerce", "social", "custom"],
    supportedSources: ["stories", "archive", "pg_content", "project", "monitor", "explore_study"],
    defaultForTemplates: ["industry", "commerce", "social", "custom"],
    pinned: true,
  },
];

export function defaultSectionsForTemplate(template: ReportTemplateType): string[] {
  return REPORT_MODULE_CATALOG
    .filter((m) => m.defaultForTemplates.includes(template))
    .map((m) => m.id);
}
