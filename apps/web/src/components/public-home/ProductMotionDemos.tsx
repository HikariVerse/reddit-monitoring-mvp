import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Download,
  FileText,
  Layers,
  Sparkles,
  X,
} from 'lucide-react';
import { useI18n } from '../../i18n/translations';

interface ExploreDemoScenario {
  key: string;
  labelZh: string;
  labelEn: string;
  query: string;
  sourceZh: string;
  sourceEn: string;
  matched: string;
  analyzed: string;
  panelsReady: string;
  trendPath: string;
  peakLabelZh: string;
  peakLabelEn: string;
  bars: Array<{ labelZh: string; labelEn: string; pct: number; count: string }>;
  topics: string[];
  evidenceId: string;
  evidenceCommunity: string;
  evidenceQuoteZh: string;
  evidenceQuoteEn: string;
}

const EXPLORE_SCENARIOS: ExploreDemoScenario[] = [
  {
    key: 'open-ear',
    labelZh: '开放式耳机',
    labelEn: 'Open-Ear Audio',
    query: '"open ear" OR shokz OR openfit',
    sourceZh: 'R4 离线归档 · DuckDB + Potion',
    sourceEn: 'R4 Archive · DuckDB + Potion',
    matched: '780',
    analyzed: '721',
    panelsReady: 'P01–P12',
    trendPath: 'M 10 66 L 44 58 L 78 62 L 112 42 L 148 48 L 184 26 L 224 34',
    peakLabelZh: '长时舒适 · 负面仅 8.5%',
    peakLabelEn: 'All-day comfort · 8.5% neg',
    bars: [
      { labelZh: 'Shokz 品牌心智与型号对比', labelEn: 'Shokz brand & model comparison', pct: 88, count: '214' },
      { labelZh: '运动稳固性与环境感知', labelEn: 'Sport stability & awareness', pct: 68, count: '162' },
      { labelZh: '通勤嘈杂环境隔音预期', labelEn: 'Commute ambient noise', pct: 46, count: '98' },
    ],
    topics: ['Shokz 品牌心智', '骨传导技术', 'OpenFit 对比', '100–200 美元带'],
    evidenceId: 'E-01',
    evidenceCommunity: 'r/running',
    evidenceQuoteZh: '“长跑 15 公里耳朵完全无压迫感，能清楚听到后方自行车铃声，比入耳式安全太多。”',
    evidenceQuoteEn: '"Zero ear fatigue after 15km runs and I can still hear bikes approaching behind me."',
  },
  {
    key: 'power-station',
    labelZh: '便携式储能',
    labelEn: 'Power Stations',
    query: '"power station" OR ecoflow OR jackery',
    sourceZh: 'R4 离线归档 · 92 天窗口',
    sourceEn: 'R4 Archive · 92d Window',
    matched: '2,721',
    analyzed: '2,375',
    panelsReady: 'P01–P12',
    trendPath: 'M 10 62 L 44 50 L 78 46 L 112 52 L 148 30 L 184 36 L 224 22',
    peakLabelZh: '常态化刚需 · 42.7% 未定品牌',
    peakLabelEn: 'Steady demand · 42.7% undecided',
    bars: [
      { labelZh: 'EcoFlow 电池扩容与光伏配比', labelEn: 'EcoFlow expansion & solar', pct: 92, count: '691' },
      { labelZh: '逆变器带载兼容与过热保护', labelEn: 'Inverter load & thermal safety', pct: 64, count: '412' },
      { labelZh: 'App 固件连接与整套成本', labelEn: 'App firmware & total kit cost', pct: 48, count: '305' },
    ],
    topics: ['EcoFlow 扩容', 'Jackery 太阳能', 'Bluetti 方案', '过热安全'],
    evidenceId: 'E-04',
    evidenceCommunity: 'r/SolarDIY',
    evidenceQuoteZh: '“房车露营选 2kWh 主机一定要看太阳能板接口电压上限，整套算下来比单机贵 35%。”',
    evidenceQuoteEn: '"Always check solar input voltage ceilings before picking a 2kWh unit for RV camping."',
  },
  {
    key: 'ai-models',
    labelZh: 'AI 大模型舆情',
    labelEn: 'AI Model Buzz',
    query: 'ChatGPT OR Claude OR Gemini',
    sourceZh: '实时社媒 X + 信息聚焦',
    sourceEn: 'Live X + Signal Focus',
    matched: '155',
    analyzed: '132',
    panelsReady: 'P01–P09',
    trendPath: 'M 10 70 L 44 68 L 78 60 L 112 56 L 148 20 L 184 38 L 224 32',
    peakLabelZh: '单日爆点占 54.5%',
    peakLabelEn: '54.5% single-day spike',
    bars: [
      { labelZh: 'Claude 代码与代理工作流', labelEn: 'Claude Code & agent workflows', pct: 86, count: '58' },
      { labelZh: '三模型编程与推理横向实测', labelEn: '3-model coding benchmarks', pct: 62, count: '41' },
      { labelZh: '订阅额度与 API 迁移节奏', labelEn: 'Subscription limits & API', pct: 44, count: '29' },
    ],
    topics: ['Claude 代码场景', '三模型横向对比', 'API 迁移', '订阅性价比'],
    evidenceId: 'E-02',
    evidenceCommunity: 'X · Live',
    evidenceQuoteZh: '“多文件重构还是更倾向 Claude Code，长上下文稳定性决定了日常开发效率。”',
    evidenceQuoteEn: '"For multi-file refactoring, long-context stability in Claude Code saves hours every week."',
  },
];

export function ExploreLiveDemoWidget({
  onExploreTopic,
}: {
  onExploreTopic: (query: string) => void;
}) {
  const { lang, t } = useI18n();
  const [idx, setIdx] = useState(0);
  const [stage, setStage] = useState(2);
  const [paused, setPaused] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  const active = EXPLORE_SCENARIOS[idx];

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => {
      setIdx((prev) => (prev + 1) % EXPLORE_SCENARIOS.length);
      setShowEvidence(false);
    }, 5200);
    return () => window.clearInterval(timer);
  }, [paused]);

  useEffect(() => {
    const t0 = window.setTimeout(() => setStage(0), 0);
    const t1 = window.setTimeout(() => setStage(1), 380);
    const t2 = window.setTimeout(() => setStage(2), 820);
    return () => {
      window.clearTimeout(t0);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [idx]);

  const stages = [
    t('1. Resource Discovery', '① 资源发现'),
    t('2. Semantic Clustering', '② Potion 语义聚类'),
    t('3. P01–P12 Panels', '③ P01–P12 指标面板'),
  ];

  return (
    <div
      className="hp-promo-widget hp-demo-explore"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="hp-widget-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="hp-live-dot" aria-hidden="true" />
          <h3>{t('One-Click Exploration', '一键智能洞察探索')}</h3>
        </div>
        <div className="hp-widget-tabs" role="tablist" aria-label={t('Demo research topics', '演示研究主题')}>
          {EXPLORE_SCENARIOS.map((sc, i) => (
            <button
              key={sc.key}
              type="button"
              role="tab"
              aria-selected={idx === i}
              className={`hp-widget-tab ${idx === i ? 'active' : ''}`}
              onClick={() => {
                setIdx(i);
                setShowEvidence(false);
              }}
            >
              {lang === 'zh' ? sc.labelZh : sc.labelEn}
            </button>
          ))}
        </div>
      </div>

      {/* Animated Pipeline Progress Strip */}
      <div className="hp-demo-pipeline" aria-label={t('Exploration stages', '智能探索阶段')}>
        {stages.map((lbl, i) => (
          <div key={lbl} className={`hp-pipe-step ${stage >= i ? 'is-done' : ''} ${stage === i ? 'is-active' : ''}`}>
            <span className="hp-pipe-dot" />
            <span>{lbl}</span>
          </div>
        ))}
        <span className="hp-demo-source-pill">{lang === 'zh' ? active.sourceZh : active.sourceEn}</span>
      </div>

      {/* Animated Trend + Ranked Pain Bars */}
      <div className="hp-demo-explore-grid">
        <div className="hp-demo-panel">
          <div className="hp-demo-panel-head">
            <span>{t('Volume Trend (P01)', '讨论声量趋势 · P01')}</span>
            <strong style={{ color: 'var(--teal)' }}>
              {active.analyzed} / {active.matched}
            </strong>
          </div>
          <svg viewBox="0 0 236 84" className="hp-demo-svg" aria-hidden="true">
            <line x1="8" y1="18" x2="228" y2="18" stroke="#eef1ef" />
            <line x1="8" y1="44" x2="228" y2="44" stroke="#eef1ef" />
            <line x1="8" y1="70" x2="228" y2="70" stroke="#eef1ef" />
            <path
              key={active.key}
              d={active.trendPath}
              fill="none"
              stroke="var(--purple)"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="hp-svg-draw"
            />
            <circle cx="184" cy={active.key === 'open-ear' ? 26 : active.key === 'power-station' ? 36 : 38} r="4" fill="var(--teal)" className="hp-svg-pulse-dot" />
          </svg>
          <div className="hp-demo-panel-foot">
            <span>{lang === 'zh' ? active.peakLabelZh : active.peakLabelEn}</span>
            <span className="hp-demo-badge">{active.panelsReady}</span>
          </div>
        </div>

        <div className="hp-demo-panel">
          <div className="hp-demo-panel-head">
            <span>{t('Top Topics & Pain Clusters (P05/P11)', '高频话题与痛点聚类 · P05/P11')}</span>
          </div>
          <div className="hp-demo-bars">
            {active.bars.map((bar) => (
              <div key={bar.labelZh} className="hp-demo-bar-row">
                <div className="hp-demo-bar-meta">
                  <span>{lang === 'zh' ? bar.labelZh : bar.labelEn}</span>
                  <b>{bar.count}</b>
                </div>
                <div className="hp-demo-bar-track">
                  <div
                    className="hp-demo-bar-fill"
                    style={{ width: stage >= 1 ? `${bar.pct}%` : '14%' }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Topic Pills + Interactive Evidence Drawer Peek */}
      <div className="hp-demo-foot-row">
        <div className="hp-demo-topic-pills">
          {active.topics.map((tp) => (
            <span key={tp} className="hp-demo-topic-chip">
              {tp}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            className={`hp-demo-ev-btn ${showEvidence ? 'active' : ''}`}
            onClick={() => setShowEvidence((v) => !v)}
          >
            {active.evidenceId} {t('Evidence', '原声证据')}
          </button>
          <button
            type="button"
            className="hp-demo-go-btn"
            onClick={() => onExploreTopic(active.query)}
          >
            <Sparkles size={12} />
            <span>{t('Run in Explore', '一键探索')}</span>
          </button>
        </div>
      </div>

      {showEvidence && (
        <div className="hp-demo-ev-popover" role="region" aria-label={t('Sample traceable evidence', '可溯源原声示例')}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--teal)' }}>
              {active.evidenceId} · {active.evidenceCommunity} · {t('Illustrative excerpt', '真实结构示意')}
            </span>
            <button type="button" className="hp-demo-close" onClick={() => setShowEvidence(false)} aria-label="Close">
              <X size={12} />
            </button>
          </div>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--ink)' }}>
            {lang === 'zh' ? active.evidenceQuoteZh : active.evidenceQuoteEn}
          </p>
        </div>
      )}
    </div>
  );
}

interface ReportDemoTemplate {
  id: 'industry' | 'commerce' | 'social' | 'custom';
  labelZh: string;
  labelEn: string;
  accent: string;
  tint: string;
  titleZh: string;
  titleEn: string;
  sampleKpi: string;
  chaptersKpi: string;
  evidenceKpi: string;
  summaryZh: string;
  summaryEn: string;
  actionZh: string;
  actionEn: string;
  htmlSize: string;
  evTitleZh: string;
  evQuoteZh: string;
}

const REPORT_TEMPLATES: ReportDemoTemplate[] = [
  {
    id: 'commerce',
    labelZh: '电商市场研究',
    labelEn: 'E-Commerce',
    accent: '#287f75',
    tint: '#e6f3ef',
    titleZh: '开放式耳机全球用户痛点与口碑研究',
    titleEn: 'Global Open-Ear Audio Pain Points & Sentiment',
    sampleKpi: '721 条',
    chaptersKpi: '11 章',
    evidenceKpi: '27 条',
    summaryZh: '核心动因聚焦长时舒适与环境感知，负面仅 8.5%；机会在于运动稳固卖点与 $100–200 中高端对比测评转化。',
    summaryEn: 'Comfort and situational awareness drive demand (8.5% neg); opportunity lies in $100–200 comparison reviews.',
    actionZh: '【高优先级】详情页首屏改为长时舒适 + 环境感知，强化通勤隔音预期管理',
    actionEn: '[High Priority] Lead PDP with all-day comfort + ambient awareness messaging.',
    htmlSize: '185 KB',
    evTitleZh: 'E-01 · r/running · Shokz 佩戴对比',
    evQuoteZh: '“相比入耳式耳机，开放式佩戴在半马训练中零胀痛，但地铁通勤时需接受轻微环境底噪。”',
  },
  {
    id: 'industry',
    labelZh: '行业情报简报',
    labelEn: 'Industry Brief',
    accent: '#3c70a8',
    tint: '#eaf1fa',
    titleZh: '全球 AI 与科技产业动态深度简报',
    titleEn: 'Global AI & Tech Industry Briefing',
    sampleKpi: '45 事件',
    chaptersKpi: '7 章',
    evidenceKpi: '12 条',
    summaryZh: '多源去重聚合 5 个独立信源，提炼模型能力演进、端侧安全链路风险与工程生态动向，支持日/周自动周期产出。',
    summaryEn: 'Deduplicated across 5 sources covering model launches, security risks, and weekly scheduled digests.',
    actionZh: '【高优先级】AI 能力对外传播配套可复现评测案例与安全链路核查清单',
    actionEn: '[High Priority] Pair capability releases with reproducible benchmark evidence.',
    htmlSize: '99 KB',
    evTitleZh: 'E-05 · Hacker News · 一手研发动态',
    evQuoteZh: '“社区讨论重心正从参数跑分转向真实复杂任务的端到端可验证能力。”',
  },
  {
    id: 'social',
    labelZh: '社媒舆情洞察',
    labelEn: 'Social Listening',
    accent: '#7463a5',
    tint: '#f0edf8',
    titleZh: '主流大模型社媒舆情与竞品讨论分析',
    titleEn: 'LLM Social Sentiment & Competitor Listening',
    sampleKpi: '132 条',
    chaptersKpi: '10 章',
    evidenceKpi: '6 条',
    summaryZh: '单日声量脉冲占 54.5%，聚焦编程助手体验、API 迁移倒计时与订阅权益争议，自动识别异常峰值与阵营分化。',
    summaryEn: '54.5% single-day spike driven by coding workflows, API deprecations, and pricing debates.',
    actionZh: '【高优先级】以编程辅助作为跨模型监测主线，前置发布版本迁移倒计时清单',
    actionEn: '[High Priority] Track coding workflows as primary cross-model benchmark.',
    htmlSize: '105 KB',
    evTitleZh: 'E-02 · X 平台 · 实时补采样本',
    evQuoteZh: '“版本弃用前两周如果能给出清晰迁移对照表，开发者社区的负面情绪会下降一大半。”',
  },
  {
    id: 'custom',
    labelZh: '自定义研究报告',
    labelEn: 'Custom Report',
    accent: '#a5773e',
    tint: '#f8f0e4',
    titleZh: '便携式户外储能电源全维度定制研究',
    titleEn: 'Portable Power Station Custom Deep-Dive',
    sampleKpi: '2,375 条',
    chaptersKpi: '13 章',
    evidenceKpi: '17 条',
    summaryZh: '自由编排 13 个分析模块，覆盖 EcoFlow / Jackery / Bluetti 品牌声量、热安全痛点与 42.7% 未定品牌选品流量。',
    summaryEn: '13 custom modules covering EcoFlow, Jackery & Bluetti share of voice, safety, and undecided buyers.',
    actionZh: '【高优先级】将端口带载兼容性设为售前红线，用整套系统成本替代单机比价',
    actionEn: '[High Priority] Make port load compatibility a pre-sales guardrail and bundle kit pricing.',
    htmlSize: '184 KB',
    evTitleZh: 'E-04 · r/SolarDIY · 品牌扩容对比',
    evQuoteZh: '“近一半发帖者在预算区间内尚未锁定品牌，清晰的太阳板兼容表直接决定下单转化。”',
  },
];

export function ReportExportLiveDemo({
  onLaunchReports,
}: {
  onLaunchReports: (template: ReportDemoTemplate['id']) => void;
}) {
  const { lang, t } = useI18n();
  const [tplIdx, setTplIdx] = useState(0);
  const [stepIdx, setStepIdx] = useState(3);
  const [previewTheme, setPreviewTheme] = useState<'light' | 'sepia' | 'dark'>('light');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [exportPulse, setExportPulse] = useState(false);
  const [paused, setPaused] = useState(false);

  const tpl = REPORT_TEMPLATES[tplIdx];

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => {
      setTplIdx((prev) => (prev + 1) % REPORT_TEMPLATES.length);
      setDrawerOpen(false);
    }, 5600);
    return () => window.clearInterval(timer);
  }, [paused]);

  useEffect(() => {
    const t0 = window.setTimeout(() => setStepIdx(0), 0);
    const t1 = window.setTimeout(() => setStepIdx(1), 420);
    const t2 = window.setTimeout(() => setStepIdx(2), 900);
    const t3 = window.setTimeout(() => setStepIdx(3), 1380);
    return () => {
      window.clearTimeout(t0);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [tplIdx]);

  const handleSimulatedExport = () => {
    setExportPulse(true);
    window.setTimeout(() => setExportPulse(false), 1800);
  };

  const flowSteps = [
    t('Discover', '① 发现资料'),
    t('Analyze', '② 真实分析'),
    t('AI Synthesis', '③ AI 核验撰写'),
    t('Export HTML', '④ 离线交互 HTML'),
  ];

  return (
    <div
      className="hp-enterprise-app hp-report-demo"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Left dark rail matching original enterprise mock */}
      <div className="hp-ent-rail" aria-hidden="true">
        <div className="hp-ent-rail-dot" style={{ background: tpl.accent }} />
        <Layers size={16} />
        <FileText size={16} />
        <Download size={16} />
      </div>

      <div className="hp-ent-body hp-report-demo-body">
        {/* Top Template Selector + Mini Theme Toggle */}
        <div className="hp-rd-topbar">
          <div className="hp-rd-tpl-tabs" role="tablist" aria-label={t('Report templates', '报告场景模板')}>
            {REPORT_TEMPLATES.map((item, i) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tplIdx === i}
                className={`hp-rd-tpl-btn ${tplIdx === i ? 'active' : ''}`}
                style={tplIdx === i ? { borderColor: item.accent, background: item.tint, color: item.accent } : undefined}
                onClick={() => {
                  setTplIdx(i);
                  setDrawerOpen(false);
                }}
              >
                {lang === 'zh' ? item.labelZh : item.labelEn}
              </button>
            ))}
          </div>

          <div className="hp-rd-theme-pills" aria-label={t('Offline HTML theme preview', '离线报告阅读主题演示')}>
            {(['light', 'sepia', 'dark'] as const).map((th) => (
              <button
                key={th}
                type="button"
                className={`hp-rd-th-btn ${previewTheme === th ? 'active' : ''}`}
                onClick={() => setPreviewTheme(th)}
              >
                {th === 'light' ? t('Light', '浅色') : th === 'sepia' ? t('Sepia', '纸感') : t('Dark', '深色')}
              </button>
            ))}
          </div>
        </div>

        {/* Animated 4-Stage Report Generation Pipeline */}
        <div className="hp-rd-stepper">
          {flowSteps.map((st, i) => (
            <div key={st} className={`hp-rd-step ${stepIdx >= i ? 'done' : ''} ${stepIdx === i ? 'current' : ''}`}>
              <CheckCircle2 size={11} />
              <span>{st}</span>
            </div>
          ))}
        </div>

        {/* Live Offline Interactive HTML Paper Preview */}
        <div className={`hp-rd-paper hp-rd-paper--${previewTheme}`} style={{ borderTopColor: tpl.accent }}>
          <div className="hp-rd-paper-head">
            <div style={{ minWidth: 0 }}>
              <div className="hp-rd-eyebrow" style={{ color: tpl.accent }}>
                {lang === 'zh' ? tpl.labelZh : tpl.labelEn} · {t('LLM Verified · Offline HTML', 'AI 归纳已校验 · 单文件离线交互')}
              </div>
              <h4 className="hp-rd-title">{lang === 'zh' ? tpl.titleZh : tpl.titleEn}</h4>
            </div>
            <button
              type="button"
              className={`hp-rd-export-btn ${exportPulse ? 'pulsed' : ''}`}
              style={{ background: tpl.accent }}
              onClick={handleSimulatedExport}
            >
              <Download size={12} />
              <span>
                {exportPulse
                  ? t(`Ready · ${tpl.htmlSize}`, `已就绪 · ${tpl.htmlSize}`)
                  : t('Export HTML', '一键导出 HTML')}
              </span>
            </button>
          </div>

          {/* KPI Ribbon */}
          <div className="hp-rd-kpis">
            <div className="hp-rd-kpi">
              <span>{t('Analyzed', '有效样本')}</span>
              <strong>{tpl.sampleKpi}</strong>
            </div>
            <div className="hp-rd-kpi">
              <span>{t('Sections', '研究章节')}</span>
              <strong>{tpl.chaptersKpi}</strong>
            </div>
            <div className="hp-rd-kpi">
              <span>{t('Evidence', '原文证据')}</span>
              <strong>{tpl.evidenceKpi}</strong>
            </div>
          </div>

          {/* BLUF Executive Summary Callout */}
          <div className="hp-rd-callout" style={{ borderLeftColor: tpl.accent }}>
            <p>{lang === 'zh' ? tpl.summaryZh : tpl.summaryEn}</p>
          </div>

          {/* Action Recommendation + Interactive Evidence Drawer Toggle */}
          <div className="hp-rd-bottom">
            <div className="hp-rd-action-pill">
              {lang === 'zh' ? tpl.actionZh : tpl.actionEn}
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                className="hp-rd-ev-trigger"
                onClick={() => setDrawerOpen((v) => !v)}
              >
                {t('Evidence Drawer', '证据抽屉')}
              </button>
              <button
                type="button"
                className="hp-rd-try-btn"
                onClick={() => onLaunchReports(tpl.id)}
              >
                {t('Try Template →', '体验模板 →')}
              </button>
            </div>
          </div>

          {/* Animated Slide-Over Mini Evidence Drawer */}
          {drawerOpen && (
            <div className="hp-rd-drawer" role="region" aria-label={t('Evidence drawer preview', '原文证据抽屉预览')}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <strong style={{ fontSize: 11.5, color: tpl.accent }}>{tpl.evTitleZh}</strong>
                <button type="button" className="hp-demo-close" onClick={() => setDrawerOpen(false)} aria-label="Close">
                  <X size={12} />
                </button>
              </div>
              <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5 }}>{tpl.evQuoteZh}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
