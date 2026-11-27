import type {
  ExploreMetricResult,
  ExplorePanelId,
  ExplorePanelResult,
  ExploreScenarioId,
} from '../../../../../packages/contracts/src/explore';
import type { PanelPolicyRule, TranslateFn } from '../research/panelRegistry';

export interface ExploreScenarioMeta {
  id: ExploreScenarioId;
  titleEn: string;
  titleZh: string;
  descEn: string;
  descZh: string;
  panels: readonly ExplorePanelId[];
}

export const EXPLORE_SCENARIO_LIST: readonly ExploreScenarioMeta[] = [
  {
    id: 'pulse',
    titleEn: 'Market Pulse & Scale',
    titleZh: '市场热度与讨论全局',
    descEn: 'Track volume dynamics, archive share, anomaly spikes, event lifecycles, and corpus quality.',
    descZh: '一眼掌握声量走势、全库声量比、讨论活跃度、声量异常爆发事件与语料去重质量。',
    panels: ['P01', 'P07', 'P08', 'P02'],
  },
  {
    id: 'audience',
    titleEn: 'Audience & Language',
    titleZh: '受众社区与语言特征',
    descEn: 'Compare communities, per-platform engagement percentiles, distinctive terms, and phrases.',
    descZh: '对比不同社区/来源的讨论份额、各平台独立互动分位数、特征词与高频多词搭配。',
    panels: ['P03', 'P04'],
  },
  {
    id: 'topics',
    titleEn: 'Topics & Rhythm',
    titleZh: '主题聚类与时空节律',
    descEn: 'Discover semantic topic clusters, representative threads, and UTC posting heatmaps.',
    descZh: '通过语义向量聚类拆分核心子话题、定位高代表性原帖与日历/星期小时发布节律。',
    panels: ['P05', 'P06'],
  },
  {
    id: 'voice',
    titleEn: 'Voice, Demand & Pricing',
    titleZh: '口碑、用户需求与商业机会',
    descEn: 'Analyze opinion polarity, active needs, feature requests, pain points, prices, and buying stages.',
    descZh: '深入拆解观点情感与正负口碑、主动需求与功能请求、痛点簇、价格关注带与购买阶段。',
    panels: ['P09', 'P10', 'P11', 'P12'],
  },
];

export interface ExplorePanelMeta {
  id: ExplorePanelId;
  scenario: ExploreScenarioId;
  titleEn: string;
  titleZh: string;
  subtitleEn: string;
  subtitleZh: string;
  priority: number;
  defaultSpan: 'full' | 'half';
  fieldGlossary: readonly { field: string; meaning: string }[];
}

export const EXPLORE_PANEL_META: Record<ExplorePanelId, ExplorePanelMeta> = {
  P01: {
    id: 'P01',
    scenario: 'pulse',
    titleEn: 'Discussion Volume & Coverage',
    titleZh: '讨论规模与覆盖（P01）',
    subtitleEn: 'Daily/weekly volume trajectory, archive share (SL02), and meaningful discussion density (SL03).',
    subtitleZh: '按日/周追踪讨论声量与增速（SL01）、全库归档声量比（SL02）及作者/线程/有效讨论占比（SL03）。',
    priority: 100,
    defaultSpan: 'full',
    fieldGlossary: [
      { field: 'documents', meaning: '去重后的有效匹配文档数' },
      { field: 'threads / authors', meaning: '去重独立讨论线程数与独立作者数（仅统计带标识的记录）' },
      { field: 'meaningful_rate', meaning: '有效讨论率（正文 ≥20 字符且 ≥12 字母/数字字符的占比）' },
      { field: 'per_million (SL02)', meaning: '每百万条全库归档线程中的命中数（仅 R4 归档全量账本支持）' },
    ],
  },
  P02: {
    id: 'P02',
    scenario: 'pulse',
    titleEn: 'Corpus Deduplication & Quality',
    titleZh: '语料去重与质量（P02）',
    subtitleEn: 'Normalized exact and SimHash near-duplicate removal breakdown (SL26).',
    subtitleZh: '统计规范化精确去重与 SimHash 近似去重前后变化（SL26），确保高频转发不扭曲结论。',
    priority: 72,
    defaultSpan: 'half',
    fieldGlossary: [
      { field: 'before / kept', meaning: '去重前原始候选文档数与去重后保留分析数' },
      { field: 'exact / near', meaning: '精确重复移除数与 SimHash 近似重复移除数' },
    ],
  },
  P03: {
    id: 'P03',
    scenario: 'audience',
    titleEn: 'Group Share & Platform Engagement',
    titleZh: '分组覆盖与独立互动分布（P03）',
    subtitleEn: 'Community/group share dynamics (SR01/SR03) and per-platform engagement percentiles (SR17).',
    subtitleZh: '对比各社区/来源的文档份额（SR01/SR03），并按平台原量纲独立计算互动中位数与分位数（SR17）。',
    priority: 95,
    defaultSpan: 'full',
    fieldGlossary: [
      { field: 'share', meaning: '该分组文档占当前总去重样本的比例' },
      { field: 'p25 / median / p75 / p90', meaning: '同平台同互动通道（如 score、likes）的分位数分布，不跨平台混加' },
      { field: 'zeros / coverage', meaning: '真实零互动数量与该字段非空覆盖率' },
    ],
  },
  P04: {
    id: 'P04',
    scenario: 'audience',
    titleEn: 'Distinctive Terms & Collocations',
    titleZh: '特征词汇、差异词与多词搭配（P04）',
    subtitleEn: 'Sublinear TF-IDF / Log-Odds distinctive terms (SR04/SR05) and recurring phrases (SR06).',
    subtitleZh: '提取最具区分度的核心特征词（SR04）、组间方向性特有词（SR05）以及高频二/三元短语搭配（SR06）。',
    priority: 90,
    defaultSpan: 'full',
    fieldGlossary: [
      { field: 'documents (df)', meaning: '包含该词条/短语的独立文档数' },
      { field: 'tfidf / log_odds', meaning: '词条在当前语料或特定分组中的显著性权重' },
    ],
  },
  P05: {
    id: 'P05',
    scenario: 'topics',
    titleEn: 'Semantic Topic Space & Representatives',
    titleZh: '共用主题空间与代表内容（P05）',
    subtitleEn: 'Potion vector clustering with c-TF-IDF topic labels (SR08) and centroid-nearest threads (SR29).',
    subtitleZh: '基于 Potion 语义向量构建共用主题空间（SR08），并为每个主题选出最贴近质心的独立代表原帖（SR29）。',
    priority: 95,
    defaultSpan: 'full',
    fieldGlossary: [
      { field: 'documents / share', meaning: '归属该语义主题的文档量与占比' },
      { field: 'noise', meaning: '未归入显著聚类的离散讨论占比' },
      { field: 'similarity', meaning: '代表帖子与该主题语义质心的余弦相似度' },
    ],
  },
  P06: {
    id: 'P06',
    scenario: 'topics',
    titleEn: 'Topic Temporal Rhythm',
    titleZh: '主题时间分布与星期×小时热力（P06）',
    subtitleEn: 'Topic calendar by UTC day (SR24) and UTC weekday × hour posting rhythm (SR25).',
    subtitleZh: '观察各语义主题的 UTC 日历活跃度（SR24）与星期×小时发帖节律热力图（SR25）。',
    priority: 85,
    defaultSpan: 'full',
    fieldGlossary: [
      { field: 'weekday × hour (UTC)', meaning: '按 UTC 星期（周一至周日）与小时（0–23）聚合的主题发帖频次' },
    ],
  },
  P07: {
    id: 'P07',
    scenario: 'pulse',
    titleEn: 'Volume Anomalies & Alert Events',
    titleZh: '声量异常检测与突发事件（P07）',
    subtitleEn: 'Past-only rolling Z-score anomaly detection (SL04) and alert window clustering (SL15).',
    subtitleZh: '使用无未来泄漏的历史滚动基线 Z-score 识别异常峰值（SL04），归并连续突发事件窗口（SL15）。',
    priority: 90,
    defaultSpan: 'full',
    fieldGlossary: [
      { field: 'baseline', meaning: '仅基于此前历史窗口计算的滚动均值基线' },
      { field: 'z (Z-score)', meaning: '当日声量偏离历史基线的标准差倍数，显著高于阈值即标为异常' },
    ],
  },
  P08: {
    id: 'P08',
    scenario: 'pulse',
    titleEn: 'Event Lifecycle & Evidence Summary',
    titleZh: '异常事件生命周期与摘要（P08）',
    subtitleEn: 'Observed anomaly phases, peak dates (SL17), and extractive event summaries (SL30).',
    subtitleZh: '展示突发事件的起止时间、观测峰值与持续天数（SL17），并抽取事件核心词与证据摘要（SL30）。',
    priority: 78,
    defaultSpan: 'half',
    fieldGlossary: [
      { field: 'start / peak / end', meaning: '异常事件窗口的起始日、峰值日与结束日（UTC）' },
      { field: 'terms', meaning: '该异常事件期间显著富集的核心关键词' },
    ],
  },
  P09: {
    id: 'P09',
    scenario: 'voice',
    titleEn: 'Sentiment Structure & Reputation',
    titleZh: '情感观点结构与正负口碑（P09）',
    subtitleEn: 'Opinion polarity breakdown (SL07) and positive/negative reputation ratio (SL09).',
    subtitleZh: '区分明确观点与中性陈述（SL07），追踪正负口碑比率及每日负面波动趋势（SL09）。',
    priority: 98,
    defaultSpan: 'full',
    fieldGlossary: [
      { field: 'positive_rate / negative_rate', meaning: '正面或负面观点在「正面 + 负面」明确观点总量中的占比' },
      { field: 'coverage', meaning: '含明确情感极性的文档占全部有效样本的比例' },
    ],
  },
  P10: {
    id: 'P10',
    scenario: 'voice',
    titleEn: 'Active Demand & Explicit Requests',
    titleZh: '主动需求规模与显式诉求（P10）',
    subtitleEn: 'Active demand volume & density (PR02/PR03), feature requests (OD03), and unmet needs (OD04).',
    subtitleZh: '量化求推荐、找替代品、显式功能请求（OD03）与明确未满足需求（OD04）的规模与密度。',
    priority: 94,
    defaultSpan: 'full',
    fieldGlossary: [
      { field: 'hits / denominator', meaning: '命中主动需求规则的独立文档数与当前总样本分母' },
      { field: 'rate', meaning: '需求密度（命中文档数 / 当前有效样本总数）' },
    ],
  },
  P11: {
    id: 'P11',
    scenario: 'voice',
    titleEn: 'Need & Pain Point Clusters',
    titleZh: '未满足需求与痛点聚类（P11）',
    subtitleEn: 'Grounded active-need clusters (OD05), pain clusters (OD06), and usage/price contexts (OD30).',
    subtitleZh: '独立呈现需求语义簇（OD05）、高频痛点主题簇（OD06）及关联的使用与价格语境（OD30）。',
    priority: 88,
    defaultSpan: 'half',
    fieldGlossary: [
      { field: 'clusters', meaning: '按语义或规则聚合的独立痛点/需求簇及其支撑文档数' },
    ],
  },
  P12: {
    id: 'P12',
    scenario: 'voice',
    titleEn: 'Price Attention & Purchase Stages',
    titleZh: '价格关注带与购买决策阶段（P12）',
    subtitleEn: 'Price clause attention (PR24), currency/period price cohorts (MI24), and buying funnel (MI28).',
    subtitleZh: '统计价格敏感讨论占比（PR24）、按币种与计费周期拆分价格分布（MI24）与多标签购买决策阶段（MI28）。',
    priority: 86,
    defaultSpan: 'full',
    fieldGlossary: [
      { field: 'cohort (MI24)', meaning: '按币种与计费周期（如 USD/month）独立分列的金额区间，不跨币种混算' },
      { field: 'stages (MI28)', meaning: '需求、调研、对比、预算、购买意向、已购、使用与退货等多标签阶段（可重叠）' },
    ],
  },
};

function hasUsableMetric(metrics: readonly ExploreMetricResult[]): boolean {
  return metrics.some((m) => m.state === 'ready' || m.state === 'exploratory');
}

function summarizeReason(metrics: readonly ExploreMetricResult[], t: TranslateFn): {
  state: 'full' | 'collapsed' | 'unavailable';
  reason?: string;
  recoveryHint?: string;
} {
  if (hasUsableMetric(metrics)) {
    // Auto-collapse low-signal panels so users stay focused on high-value insights
    const first = metrics[0];
    if (first?.metric_id === 'SL26') {
      const exact = Number(first.data?.exact ?? 0);
      const near = Number(first.data?.near ?? 0);
      if (exact === 0 && near === 0) {
        return {
          state: 'collapsed',
          reason: t('Zero duplicate documents found; corpus is already clean.', '当前语料无重复文档（精确/近似去重均为 0），已自动折叠以突出高价值洞察。'),
          recoveryHint: t('Expand manually anytime to inspect corpus counts.', '可随时在底部「其他分析」中手动展开查看。'),
        };
      }
    }
    if (first?.metric_id === 'SL04') {
      const anomalies = Array.isArray(first.data?.anomalies) ? first.data.anomalies : [];
      const days = Array.isArray(first.data?.days) ? first.data.days : [];
      if (anomalies.length === 0 && days.length < 4) {
        return {
          state: 'collapsed',
          reason: t('Time span is short and no significant volume spikes were detected.', '当前时间跨度较短且未检测到显著声量异常峰值，已自动折叠。'),
          recoveryHint: t('Broaden the date window or switch to full archive to detect spikes.', '扩大时间窗口或切换全量归档后将自动展开异常检测。'),
        };
      }
    }
    if (first?.metric_id === 'SL17') {
      const lifecycles = Array.isArray(first.data?.lifecycles) ? first.data.lifecycles : [];
      if (lifecycles.length === 0) {
        return {
          state: 'collapsed',
          reason: t('No anomaly events detected for lifecycle breakdown.', '当前未命中异常事件窗口，生命周期面板已自动折叠。'),
          recoveryHint: t('Appears automatically when SL04/SL15 detects at least 1 anomaly event.', '当检测到至少 1 个异常事件窗口时自动展开。'),
        };
      }
    }
    return { state: 'full' };
  }

  const depMissing = metrics.find((m) => m.state === 'unavailable_dependency');
  if (depMissing) {
    return {
      state: 'unavailable',
      reason: depMissing.reason || t('Requires external Potion analytics worker.', '该面板依赖外置 Python Potion 语义分析引擎。'),
      recoveryHint: t('Start the R4 / Explore Python service with Potion INT8 weights to unlock.', '启动外置 R4/Explore Python 服务并挂载本地 Potion INT8 模型后自动解锁。'),
    };
  }
  const unsupported = metrics.find((m) => m.state === 'unsupported_source');
  if (unsupported) {
    return {
      state: 'unavailable',
      reason: unsupported.reason || t('Not supported for the selected data source.', '当前数据源不支持该口径。'),
      recoveryHint: t('Switch to the full R4 Reddit archive data source.', '切换至全量离线 Reddit 归档数据源后可用。'),
    };
  }
  const primary = metrics[0];
  return {
    state: 'collapsed',
    reason: primary?.reason || t('Insufficient matching documents for this panel.', '当前筛选范围内有效样本不足，已自动折叠。'),
    recoveryHint: t('Try broader keywords, a longer time range, or another data source.', '尝试放宽关键词、扩大时间窗口或切换数据源。'),
  };
}

export function buildExplorePanelRules(
  scenario: ExploreScenarioId,
): readonly PanelPolicyRule<Record<ExplorePanelId, ExplorePanelResult | undefined>>[] {
  const scenarioMeta = EXPLORE_SCENARIO_LIST.find((s) => s.id === scenario);
  const panelIds = scenarioMeta?.panels ?? [];
  return panelIds.map((pid) => {
    const meta = EXPLORE_PANEL_META[pid];
    return {
      id: `explore.${pid}`,
      layer: 'l1' as const,
      section: scenario,
      titleEn: meta.titleEn,
      titleZh: meta.titleZh,
      priority: meta.priority,
      defaultSpan: meta.defaultSpan,
      compactCapable: false,
      dependencies: [pid],
      evaluate: (panelMap, t) => {
        const panel = panelMap[pid];
        if (!panel) {
          return {
            autoState: 'unavailable',
            autoReason: t('Panel data was not returned.', '未返回该面板数据。'),
          };
        }
        const evaluated = summarizeReason(panel.metrics, t);
        return {
          autoState: evaluated.state,
          autoReason: evaluated.reason,
          recoveryHint: evaluated.recoveryHint,
          preferredSpan: meta.defaultSpan,
        };
      },
    };
  });
}
