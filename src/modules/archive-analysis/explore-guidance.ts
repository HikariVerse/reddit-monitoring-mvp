import type {
  ExploreGuidedStep,
  ExploreMetricResult,
  ExplorePanelId,
  ExplorePanelResult,
  ExploreScenarioId,
  ExploreSourceMode,
  ExploreSourceProfile,
} from "../../../packages/contracts/src/explore";

export const PANEL_SCENARIO_MAP: Record<ExplorePanelId, ExploreScenarioId> = {
  P01: "pulse",
  P02: "pulse",
  P07: "pulse",
  P08: "pulse",
  P03: "audience",
  P04: "audience",
  P05: "topics",
  P06: "topics",
  P09: "voice",
  P10: "voice",
  P11: "voice",
  P12: "voice",
  P13: "commercial",
  P14: "commercial",
};

export const EXPLORE_SCENARIOS: Array<{
  id: ExploreScenarioId;
  title: string;
  description: string;
  panels: ExplorePanelId[];
}> = [
  {
    id: "pulse",
    title: "市场热度与讨论全局",
    description: "评估声量趋势、全库声量占比、讨论活跃度、声量异常波动与语料质量。",
    panels: ["P01", "P07", "P08", "P02"],
  },
  {
    id: "audience",
    title: "受众社区与语言特征",
    description: "拆解不同社区/渠道的声量分布、独立互动分位数、特征词与高频多词搭配。",
    panels: ["P03", "P04"],
  },
  {
    id: "topics",
    title: "主题聚类与时空节律",
    description: "通过语义向量聚类发现核心子话题、代表性原帖与日历/星期小时发布节律。",
    panels: ["P05", "P06"],
  },
  {
    id: "voice",
    title: "口碑、用户需求与商业机会",
    description: "识别观点情感与正负口碑、主动需求与功能请求、痛点簇、价格带与购买阶段。",
    panels: ["P09", "P10", "P11", "P12"],
  },
  {
    id: "commercial",
    title: "商业竞品、属性口碑与场景",
    description: "拆解品牌声量份额、直接竞品比较与共提网络、品牌×属性情感矩阵、使用场景需求及用户变通方案。",
    panels: ["P13", "P14"],
  },
];

export const SOURCE_MODE_LABELS: Record<ExploreSourceMode, string> = {
  archive: "全量离线 Reddit 归档（R4 DuckDB）",
  live_content: "站内全部已入库数据（信息流 + Reddit + X）",
  info_stream: "站内资讯信息流（RSS / Web）",
  reddit_api: "站内 Reddit API 采集数据",
  x_api: "站内 X (Twitter) API 采集数据",
  project_content: "指定研究项目已采集样本",
};

export function buildSourceImpactNotes(
  sourceMode: ExploreSourceMode,
  engine: ExploreSourceProfile["engine"],
  opts: {
    potionModelReady: boolean;
    isSampled: boolean;
    sampleCap: number;
    analyzedDocuments: number;
    platformCount: number;
  },
): string[] {
  const notes: string[] = [];
  if (sourceMode === "archive") {
    notes.push(
      "数据来源于本地 R4 历史归档（DuckDB + FTS5 引擎直查），覆盖所选归档月份的完整历史讨论，适合长周期趋势、社区对比与深度语义挖掘。",
    );
    notes.push(
      "Reddit 归档的互动字段包含帖子 score 与原帖报告评论数（reported_comments），评论数口径可能包含未归档或已删除评论。",
    );
  } else if (sourceMode === "info_stream") {
    notes.push(
      "数据来源于系统已入库的资讯信息流（Web/RSS），侧重媒体与官方资讯口径；原生评论线程与社媒互动字段通常缺失，相关互动/线程指标会按规则降级或折叠。",
    );
    notes.push("全库归档声量比（SL02）仅对具备完整归档分母账本的 R4 归档有效，信息流数据源将诚实标记为不适用。");
  } else if (sourceMode === "reddit_api" || sourceMode === "x_api" || sourceMode === "live_content") {
    notes.push(
      "数据来源于系统 PostgreSQL 中当前账号有权访问的已入库实时/增量采集内容，反映已配置来源的观测结果，而非对应平台全网普查。",
    );
    notes.push(
      "各平台互动通道（Reddit score/comments、X likes/reposts/replies）按平台量纲独立统计，不进行跨平台直接相加。",
    );
  } else if (sourceMode === "project_content") {
    notes.push(
      "数据严格限定在所选研究项目的已采集批次与范围内，结果可直接与「研究」工作台口径互相印证。",
    );
  }

  if (opts.isSampled) {
    notes.push(
      sourceMode === "archive"
        ? `当前全库命中总量超过单次探索明细样本上限（${opts.sampleCap.toLocaleString()} 条），全库日声量比（SL02）基于真实全量命中计数计算，其余明细面板基于按日分层等比抽样的 ${opts.analyzedDocuments.toLocaleString()} 条有效去重样本计算；建议通过时间区间或更精确关键词收窄范围以获得全量明细精度。`
        : `当前匹配总量超过单次探索计算上限（${opts.sampleCap.toLocaleString()} 条），本次基于按时间最新的 ${opts.analyzedDocuments.toLocaleString()} 条有效去重样本计算；建议通过时间区间或更精确关键词收窄范围以获得全量精度。`,
    );
  }

  if (engine === "pg_builtin_fast") {
    notes.push(
      "当前由主线内置快速分析引擎计算（外置 Python Potion 分析服务未连接）。词汇、趋势、异常、情感、需求与价格分析已就绪；需 Potion 语义向量的主题聚类（P05/P06）与语义痛点聚类（P11）将在连接外置分析 Worker 后自动解锁。",
    );
  } else if (!opts.potionModelReady) {
    notes.push(
      "外置 Python 分析服务已连接，但尚未检测到本地 Potion INT8 模型权重，语义聚类相关面板（P05/P06/P11）将显示恢复条件。",
    );
  }

  if (opts.platformCount > 1) {
    notes.push(
      `本次分析跨 ${opts.platformCount} 个数据源平台；对比词频与情感时请注意媒体资讯与社媒讨论的文体差异，可在上方按单一来源拆分验证。`,
    );
  }
  return notes;
}

function findMetric(panels: readonly ExplorePanelResult[], metricId: string): ExploreMetricResult | undefined {
  for (const panel of panels) {
    const found = panel.metrics.find((m) => m.metric_id === metricId);
    if (found) return found;
  }
  return undefined;
}

function asArray<T = Record<string, unknown>>(val: unknown): T[] {
  return Array.isArray(val) ? (val as T[]) : [];
}

function asNumber(val: unknown): number | null {
  return typeof val === "number" && Number.isFinite(val) ? val : null;
}

export function buildDynamicGuidance(
  query: string,
  sourceProfile: ExploreSourceProfile,
  panels: readonly ExplorePanelResult[],
  archiveAvailable: boolean,
): ExploreGuidedStep[] {
  const steps: ExploreGuidedStep[] = [];
  const trimmedQuery = query.trim();

  // 1. Anomaly spike guidance (SL04 / SL15)
  const sl04 = findMetric(panels, "SL04");
  const anomalies = asArray<{ date?: string; documents?: number; z?: number; evidence_ref?: { id?: string } }>(
    sl04?.data?.anomalies,
  );
  if (anomalies.length > 0) {
    const top = [...anomalies].sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0))[0];
    steps.push({
      id: "guide-anomaly",
      priority: "high",
      category: "anomaly",
      title: `发现 ${anomalies.length} 个声量异常峰值（最高 ${top?.date ?? "近期"}）`,
      description: `当日讨论量达到 ${top?.documents ?? "—"} 条（Z=${(top?.z ?? 0).toFixed(1)}），建议下钻查看异常区间主题与触发事件原帖。`,
      actionLabel: "下钻异常事件",
      targetScenario: "pulse",
      targetPanelId: "P07",
      evidenceRefId: top?.evidence_ref?.id,
    });
  }

  // 2. Pain / Negative sentiment guidance (SL09 / OD06)
  const sl09 = findMetric(panels, "SL09");
  const negRate = asNumber(sl09?.data?.negative_rate);
  const negCount = asNumber(sl09?.data?.negative);
  if (negRate !== null && negCount !== null && negCount >= 3 && negRate >= 0.3) {
    steps.push({
      id: "guide-negative-voice",
      priority: "high",
      category: "pain",
      title: `负面口碑占比达 ${Math.round(negRate * 100)}%（${negCount} 条观点）`,
      description: "讨论中存在较明显的吐槽或不满信号，建议立即切换到「口碑、需求与商业机会」排查高频痛点与未满足诉求。",
      actionLabel: "查看口碑与痛点",
      targetScenario: "voice",
      targetPanelId: "P09",
    });
  }

  // 3. Active demand & feature requests (PR02 / OD03 / OD04)
  const pr02 = findMetric(panels, "PR02");
  const od03 = findMetric(panels, "OD03");
  const demandHits = asNumber(pr02?.data?.documents) ?? asNumber(pr02?.data?.hits) ?? 0;
  const featureHits = asNumber(od03?.data?.documents) ?? asNumber(od03?.data?.hits) ?? 0;
  if (demandHits >= 2) {
    steps.push({
      id: "guide-demand",
      priority: "high",
      category: "demand",
      title: `识别到 ${demandHits} 条主动需求信号${featureHits > 0 ? `（含 ${featureHits} 条显式功能请求）` : ""}`,
      description: "用户正在主动寻求方案、替代品或提出功能诉求，适合直接提炼产品机会与竞品切入点。",
      actionLabel: "查看需求与诉求",
      targetScenario: "voice",
      targetPanelId: "P10",
    });
  }

  // 4. Price & purchase intent (PR24 / MI28)
  const pr24 = findMetric(panels, "PR24");
  const priceDocs = asNumber(pr24?.data?.documents) ?? 0;
  const priceRate = asNumber(pr24?.data?.rate);
  if (priceDocs >= 2) {
    const pct = priceRate !== null ? `（占比 ${(priceRate * 100).toFixed(1)}%）` : "";
    steps.push({
      id: "guide-price",
      priority: "medium",
      category: "price",
      title: `检测到 ${priceDocs} 条价格与消费讨论${pct}`,
      description: "用户提到了预算、订阅定价或性价比评估，建议查看分币种价格分布与购买决策阶段漏斗。",
      actionLabel: "拆解价格与转化",
      targetScenario: "voice",
      targetPanelId: "P12",
    });
  }

  // 5. Lexical drill-down suggestion (SR04 top distinctive term -> refine query!)
  const sr04 = findMetric(panels, "SR04");
  const terms = asArray<{ term?: string; documents?: number; df?: number }>(sr04?.data?.terms);
  const queryLower = trimmedQuery.toLowerCase();
  const topFreshTerm = terms.find(
    (item) =>
      typeof item.term === "string" &&
      item.term.length >= 2 &&
      !queryLower.includes(item.term.toLowerCase()),
  );
  if (topFreshTerm?.term) {
    const refined = trimmedQuery ? `${trimmedQuery} ${topFreshTerm.term}` : topFreshTerm.term;
    steps.push({
      id: "guide-lexical-refine",
      priority: "medium",
      category: "lexical",
      title: `高频特征词「${topFreshTerm.term}」显著共现`,
      description: `该词在当前语料中频繁出现，可将其与当前主题组合为「${refined}」进行二次聚焦探索，挖掘更细分讨论。`,
      actionLabel: `聚焦「${topFreshTerm.term}」`,
      suggestedQuery: refined,
      targetScenario: "audience",
      targetPanelId: "P04",
    });
  }

  // 6. Topic structure guidance (SR08)
  const sr08 = findMetric(panels, "SR08");
  const topics = asArray<{ name?: string; documents?: number }>(sr08?.data?.topics);
  if (topics.length >= 2) {
    steps.push({
      id: "guide-topics",
      priority: "medium",
      category: "topic",
      title: `语义聚类自动拆分出 ${topics.length} 个核心子话题`,
      description: `头部话题「${topics[0]?.name ?? "Topic 0"}」包含 ${topics[0]?.documents ?? 0} 条讨论，点击浏览各主题代表内容与活跃时段热力图。`,
      actionLabel: "查看主题分布",
      targetScenario: "topics",
      targetPanelId: "P05",
    });
  }

  // 7. Cross-source comparison / upgrade guidance
  if (sourceProfile.sourceMode !== "archive" && archiveAvailable) {
    steps.push({
      id: "guide-switch-archive",
      priority: "info",
      category: "source",
      title: "切换全量离线归档验证长周期基线",
      description: "当前基于站内已入库实时样本；切换到 R4 DuckDB 全量归档可解锁历史多月趋势与全库归档声量比（SL02）。",
      actionLabel: "切至全量归档",
      suggestedSourceMode: "archive",
    });
  } else if (sourceProfile.sourceMode === "archive") {
    steps.push({
      id: "guide-switch-live",
      priority: "info",
      category: "source",
      title: "对照站内最新实时资讯与社媒动态",
      description: "离线归档反映历史切片；可一键切换至站内最新信息流 / Reddit / X 实时数据，对比近期口碑与话题演进。",
      actionLabel: "对照实时数据源",
      suggestedSourceMode: "live_content",
    });
  }

  return steps.slice(0, 5);
}
