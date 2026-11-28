import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BarChart3,
  BookMarked,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Compass,
  Database,
  FileSearch,
  Flame,
  Lightbulb,
  MessageSquareQuote,
  Newspaper,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Tag,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  reportsApi,
  useCreateReportRunMutation,
  useCreateReportScheduleMutation,
  useReportDraftsQuery,
  useReportModulesQuery,
  useUpsertReportDraftMutation,
  type ReportTemplateType,
  type ResourceDiscoveryResponse,
} from '../../api/reports';
import { formatApiError, useProjectsQuery } from '../../api/hooks';
import { SOURCE_GROUPS } from '../../lib/sourceLabels';

const TEMPLATE_OPTIONS: Array<{ id: ReportTemplateType; label: string; desc: string }> = [
  { id: 'industry', label: '行业情报简报', desc: '基于资讯流与官方动态生成日/周/专题简报' },
  { id: 'commerce', label: '电商市场研究', desc: '聚焦消费者需求、产品痛点、口碑与价格带' },
  { id: 'social', label: '社媒舆情洞察', desc: '聚焦讨论趋势、社区分布、异常事件与态度' },
  { id: 'custom', label: '自定义研究报告', desc: '自由勾选并排序所有可用分析模块' },
];

const SOURCE_MODE_OPTIONS: Array<{ id: 'stories' | 'archive' | 'pg_content' | 'project' | 'monitor' | 'explore_study'; label: string }> = [
  { id: 'archive', label: '历史消费者与社媒讨论（Reddit 归档）' },
  { id: 'pg_content', label: '平台已收集站内讨论' },
  { id: 'stories', label: '平台行业资讯流（去重事件）' },
  { id: 'project', label: '已有研究项目样本' },
  { id: 'explore_study', label: '复用已有探索分析结果' },
  { id: 'monitor', label: '持续监测器窗口数据' },
];

const TEMPLATE_VISUAL_META: Record<
  ReportTemplateType,
  { accent: string; tint: string; badge: string }
> = {
  industry: { accent: '#3c70a8', tint: '#eaf1fa', badge: '行业情报简报' },
  commerce: { accent: '#287f75', tint: '#e6f3ef', badge: '电商市场研究' },
  social: { accent: '#7463a5', tint: '#f0edf8', badge: '社媒舆情洞察' },
  custom: { accent: '#a5773e', tint: '#f8f0e4', badge: '自定义研究报告' },
};

const WIZARD_STEPS = [
  {
    n: 1 as const,
    code: '01',
    title: '定义研究需求',
    desc: '选定业务报告类型，输入核心研究对象、时间范围与关注重点。',
    accent: '#3c70a8',
    tint: '#eaf1fa',
  },
  {
    n: 2 as const,
    code: '02',
    title: '自动发现资料与方案',
    desc: '只读检索平台资讯、社区归档与项目资料，确认主数据源或按需补采。',
    accent: '#287f75',
    tint: '#e6f3ef',
  },
  {
    n: 3 as const,
    code: '03',
    title: '确认目录并开始研究',
    desc: '核对报告章节结构，一键自动分析、AI 核验撰写并支持离线 HTML 导出。',
    accent: '#7463a5',
    tint: '#f0edf8',
  },
];

function WizardStepIllustration({ stepNum, accent }: { stepNum: 1 | 2 | 3; accent: string }) {
  if (stepNum === 1) {
    return (
      <svg viewBox="0 0 48 48" className="rw-step-svg" aria-hidden="true">
        <rect x="6" y="7" width="28" height="34" rx="5" fill="#ffffff" stroke={accent} strokeWidth="1.6" />
        <rect x="12" y="13" width="16" height="3.2" rx="1.5" fill={accent} />
        <rect x="12" y="20" width="14" height="2.4" rx="1.2" fill="#cbd5e1" />
        <rect x="12" y="26" width="10" height="2.4" rx="1.2" fill="#cbd5e1" />
        <circle cx="34" cy="32" r="9" fill={accent} />
        <circle cx="34" cy="32" r="4" fill="none" stroke="#ffffff" strokeWidth="1.7" />
        <circle cx="34" cy="32" r="1.4" fill="#ffffff" />
      </svg>
    );
  }
  if (stepNum === 2) {
    return (
      <svg viewBox="0 0 48 48" className="rw-step-svg" aria-hidden="true">
        <circle cx="24" cy="24" r="17" fill="#ffffff" stroke={accent} strokeWidth="1.5" strokeDasharray="3 2.5" />
        <circle cx="24" cy="24" r="9" fill={accent} opacity="0.16" />
        <path d="M12 16 L24 24 L37 15 M24 24 L34 35" fill="none" stroke={accent} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="12" cy="16" r="3.6" fill={accent} />
        <circle cx="37" cy="15" r="3.6" fill={accent} opacity="0.75" />
        <circle cx="34" cy="35" r="3.6" fill={accent} opacity="0.85" />
        <circle cx="24" cy="24" r="4.5" fill={accent} />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 48 48" className="rw-step-svg" aria-hidden="true">
      <rect x="7" y="6" width="28" height="36" rx="5" fill="#ffffff" stroke={accent} strokeWidth="1.6" />
      <rect x="7" y="6" width="28" height="5" rx="2.5" fill={accent} />
      <rect x="12" y="16" width="18" height="3" rx="1.5" fill={accent} opacity="0.85" />
      <rect x="12" y="23" width="14" height="3" rx="1.5" fill={accent} opacity="0.55" />
      <rect x="12" y="30" width="16" height="3" rx="1.5" fill={accent} opacity="0.35" />
      <circle cx="35" cy="33" r="8.5" fill={accent} />
      <path d="M31.5 33.2 L33.8 35.5 L38.6 30.5" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface OutlineSectionMeta {
  icon: typeof Sparkles;
  roleLabel: string;
  roleTone: 'exec' | 'data' | 'action' | 'proof';
  shortHint: string;
}

function getOutlineSectionMeta(sectionId: string, fallbackDesc?: string): OutlineSectionMeta {
  switch (sectionId) {
    case 'executive_summary':
      return { icon: Sparkles, roleLabel: '核心总览', roleTone: 'exec', shortHint: '一页速览研究结论与关键业务判断' };
    case 'scope_overview':
      return { icon: Compass, roleLabel: '必含口径', roleTone: 'proof', shortHint: '时间窗口、有效样本量与统计基准说明' };
    case 'industry_events':
      return { icon: Newspaper, roleLabel: '事件聚合', roleTone: 'data', shortHint: '跨来源去重后的重点动态与报道脉络' };
    case 'industry_topics':
      return { icon: Flame, roleLabel: '热词升温', roleTone: 'data', shortHint: '高频主题聚簇与前后窗口升温词追踪' };
    case 'industry_trend':
    case 'discussion_trend':
      return { icon: TrendingUp, roleLabel: '趋势图表', roleTone: 'data', shortHint: '按时段呈现活跃度走势与来源结构' };
    case 'community_audience':
      return { icon: Users, roleLabel: '受众分布', roleTone: 'data', shortHint: '核心社区阵地、平台占比与互动热度' };
    case 'lexical_features':
    case 'topic_clusters':
      return { icon: BarChart3, roleLabel: '语义聚类', roleTone: 'data', shortHint: '高区分度特征词与中文命名核心话题' };
    case 'sentiment_reputation':
      return { icon: MessageSquareQuote, roleLabel: '口碑态度', roleTone: 'data', shortHint: '正负情感结构、争议焦点与未判单列' };
    case 'active_demand':
    case 'pain_points':
      return { icon: AlertTriangle, roleLabel: '需求痛点', roleTone: 'data', shortHint: '真实求推荐诉求、场景困扰与高频抱怨' };
    case 'price_purchase':
      return { icon: Tag, roleLabel: '价格决策', roleTone: 'data', shortHint: '价位区间关注度与购买链路阶段分布' };
    case 'business_actions':
      return { icon: Lightbulb, roleLabel: '行动建议', roleTone: 'action', shortHint: '分级可执行建议与后续核查验证清单' };
    case 'sources_appendix':
      return { icon: BookMarked, roleLabel: '原文溯源', roleTone: 'proof', shortHint: '数据范围快照与可点击核验的原文证据' };
    default:
      return {
        icon: BarChart3,
        roleLabel: '专题分析',
        roleTone: 'data',
        shortHint: fallbackDesc ? fallbackDesc.slice(0, 26) : '基于已授权样本的专项统计与解读',
      };
  }
}

export function ReportWizardView({
  search,
  onNavigate,
}: {
  search: string;
  onNavigate: (path: string) => void;
}) {
  const sp = useMemo(() => new URLSearchParams(search), [search]);
  const initialTemplate = (['industry', 'commerce', 'social', 'custom'].includes(sp.get('template') || '')
    ? sp.get('template')
    : 'commerce') as ReportTemplateType;
  const fromContext = sp.get('from') || '';
  const urlProjectId = sp.get('projectId') || '';
  const urlStudyId = sp.get('studyId') || '';
  const urlMonitorId = sp.get('monitorId') || '';
  const urlDraftId = sp.get('draftId') || '';
  const urlSourceGroup = sp.get('sourceGroup') || '';
  const urlStoryView = (['latest', 'hot', 'digest'].includes(sp.get('storyView') || '')
    ? sp.get('storyView')
    : 'latest') as 'latest' | 'hot' | 'digest';
  const urlStoryDate = sp.get('storyDate') || '';
  const urlTopic = sp.get('topic') || '';

  const modulesQuery = useReportModulesQuery(true);
  const draftsQuery = useReportDraftsQuery(Boolean(urlDraftId));
  const projectsQuery = useProjectsQuery(true);
  const upsertDraftMut = useUpsertReportDraftMutation();
  const createRunMut = useCreateReportRunMutation();
  const createScheduleMut = useCreateReportScheduleMutation();

  const modules = useMemo(() => modulesQuery.data?.modules ?? [], [modulesQuery.data?.modules]);
  const projects = useMemo(() => projectsQuery.data?.projects ?? [], [projectsQuery.data?.projects]);

  const [step, setStep] = useState<1 | 2 | 3>(urlStudyId ? 3 : 1);
  const [draftId, setDraftId] = useState<string | undefined>(urlDraftId || undefined);
  const [template, setTemplate] = useState<ReportTemplateType>(initialTemplate);
  const [topic, setTopic] = useState(urlTopic);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'comprehensive' | 'recent' | 'continuous'>('comprehensive');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [focus, setFocus] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Advanced & Context settings
  const [platform, setPlatform] = useState<'' | 'reddit' | 'x' | 'bluesky' | 'web'>('');
  const [subredditsText, setSubredditsText] = useState('');
  const [sampleLimit, setSampleLimit] = useState(2000);
  const [profile, setProfile] = useState<'fast' | 'balanced'>('fast');
  const [includeComments, setIncludeComments] = useState(false);
  const [projectId, setProjectId] = useState(urlProjectId);
  const [sourceGroup, setSourceGroup] = useState(urlSourceGroup);
  const [storyView, setStoryView] = useState<'latest' | 'hot' | 'digest'>(urlStoryView);
  const [storyDate] = useState(urlStoryDate);
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  const [detailLevel, setDetailLevel] = useState<'full' | 'compact'>('full');

  // Step 2: Real discovery state
  const [englishQuery, setEnglishQuery] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [verifyingPhrase, setVerifyingPhrase] = useState(false);
  const [discovery, setDiscovery] = useState<ResourceDiscoveryResponse | null>(null);
  const [discoveryErr, setDiscoveryErr] = useState<string | null>(null);
  const discoverAbortRef = useRef<AbortController | null>(null);

  const [primarySource, setPrimarySource] = useState<
    'stories' | 'archive' | 'pg_content' | 'project' | 'monitor' | 'explore_study'
  >(
    urlStudyId
      ? 'explore_study'
      : urlMonitorId
        ? 'monitor'
        : urlProjectId
          ? 'project'
          : initialTemplate === 'industry'
            ? 'stories'
            : 'archive',
  );
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>([]);

  // Optional Extra Collection (Step 2)
  const [extraCollect, setExtraCollect] = useState(false);
  const [collectPlatform, setCollectPlatform] = useState<'x' | 'reddit' | 'bluesky'>('x');
  const [collectTargetType, setCollectTargetType] = useState<'keyword' | 'community' | 'account'>('keyword');
  const [collectTargetValue, setCollectTargetValue] = useState('');
  const [collectLimit, setCollectLimit] = useState(100);
  const [collectLookbackDays, setCollectLookbackDays] = useState(7);
  const [confirmPaidOrTracking, setConfirmPaidOrTracking] = useState(false);

  // Optional Periodic Report Schedule (when mode === 'continuous')
  const [scheduleCadence, setScheduleCadence] = useState<'daily' | 'weekly'>('daily');

  // Step 3: Ordered sections
  const [selectedSections, setSelectedSections] = useState<string[]>([]);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const draftHydratedRef = useRef(false);
  const projectHydratedRef = useRef(false);

  // Hydrate default sections whenever template or modules load
  useEffect(() => {
    if (!modules.length) return;
    const timer = window.setTimeout(() => {
      setSelectedSections((prev) => {
        if (prev.length > 0 && urlDraftId) return prev;
        return modules.filter((m) => m.defaultForTemplates.includes(template)).map((m) => m.id);
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [modules, template, urlDraftId]);

  // Restore draft if draftId present
  useEffect(() => {
    if (draftHydratedRef.current || !urlDraftId || !draftsQuery.data?.drafts.length) return;
    const found = draftsQuery.data.drafts.find((d) => d.id === urlDraftId);
    if (!found) return;
    draftHydratedRef.current = true;
    const timer = window.setTimeout(() => {
      setDraftId(found.id);
      setTemplate(found.template);
      setTitle(found.title);
      const inp = found.input ?? {};
      if (typeof inp.topic === 'string') setTopic(inp.topic);
      if (typeof inp.focus === 'string') setFocus(inp.focus);
      if (typeof inp.englishQuery === 'string') setEnglishQuery(inp.englishQuery);
      if (found.projectId) setProjectId(found.projectId);
      if (found.discovery) setDiscovery(found.discovery);
      if (found.sections?.length) setSelectedSections(found.sections);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [urlDraftId, draftsQuery.data]);

  // Sync project name into topic if opened from a project
  useEffect(() => {
    if (projectHydratedRef.current || !urlProjectId || topic || !projects.length) return;
    const proj = projects.find((p) => p.id === urlProjectId);
    if (proj) {
      projectHydratedRef.current = true;
      const timer = window.setTimeout(() => {
        setTopic(proj.name);
        setTitle(`${proj.name} · 研究报告`);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [urlProjectId, topic, projects]);

  const effectiveTitle = useMemo(() => {
    if (title.trim()) return title.trim();
    const base = topic.trim() || (template === 'industry' ? '行业情报简报' : '专题研究报告');
    const suffix = template === 'industry' ? (storyView === 'digest' ? '日报' : '简报') : '研究报告';
    return base.includes('报告') || base.includes('简报') ? base : `${base}${suffix}`;
  }, [title, topic, template, storyView]);

  const runDiscovery = async (opts?: { overrideEnglish?: string; verifyPhrase?: boolean }) => {
    discoverAbortRef.current?.abort();
    const ac = new AbortController();
    discoverAbortRef.current = ac;
    setDiscoveryErr(null);
    if (opts?.verifyPhrase) setVerifyingPhrase(true);
    else setDiscovering(true);

    const subs = subredditsText
      .split(/[,，\s]+/)
      .map((s) => s.trim().replace(/^r\//i, ''))
      .filter(Boolean);

    try {
      const res = await reportsApi.discoverResources(
        {
          topic: topic.trim() || (template === 'industry' ? '行业情报' : ''),
          question: focus.trim() || undefined,
          template,
          mode,
          englishQuery: (opts?.overrideEnglish ?? englishQuery).trim() || undefined,
          from: fromDate ? new Date(`${fromDate}T00:00:00Z`).toISOString() : null,
          to: toDate ? new Date(`${toDate}T23:59:59Z`).toISOString() : null,
          platforms: platform ? [platform] : undefined,
          subreddits: subs.length ? subs : undefined,
          sourceGroup: sourceGroup || undefined,
          projectId: projectId || undefined,
          verifyArchivePhrase: Boolean(opts?.verifyPhrase),
          includeSamples: true,
        },
        ac.signal,
      );
      setDiscovery(res);
      if (!opts?.overrideEnglish && res.parsedQuery.englishQuery) {
        setEnglishQuery(res.parsedQuery.englishQuery);
      }
      if (!urlStudyId && !urlMonitorId) {
        setPrimarySource(res.recommendation.primarySource);
      }
      setSelectedBatchIds(res.recommendation.recommendedBatchIds);
      if (!collectTargetValue && (res.parsedQuery.englishQuery || topic.trim())) {
        setCollectTargetValue(res.parsedQuery.coreTerms[0] || topic.trim());
      }
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') {
        setDiscoveryErr(formatApiError(err));
      }
    } finally {
      setDiscovering(false);
      setVerifyingPhrase(false);
    }
  };

  const handleGoStep2 = async () => {
    if (template !== 'industry' && !topic.trim() && !projectId && !urlStudyId) {
      setSubmitErr('请先填写研究对象或专题关键词。');
      return;
    }
    setSubmitErr(null);
    setStep(2);
    await runDiscovery();
  };

  const handleSaveDraft = async () => {
    setNotice(null);
    try {
      const res = await upsertDraftMut.mutateAsync({
        id: draftId,
        template,
        title: effectiveTitle,
        input: { topic, focus, mode, fromDate, toDate, englishQuery, platform, subredditsText, sourceGroup, storyView, sampleLimit, profile },
        discovery: discovery ? (discovery as unknown as Record<string, unknown>) : null,
        plan: { primarySource, selectedBatchIds, extraCollect, collectPlatform, collectTargetValue, collectLimit },
        sections: selectedSections,
        projectId: projectId || null,
      });
      setDraftId(res.draft.id);
      setNotice('草稿已保存，可随时从报告工作台恢复。');
    } catch (err) {
      setSubmitErr(formatApiError(err));
    }
  };

  const toggleModule = (id: string) => {
    const mod = modules.find((m) => m.id === id);
    if (mod?.pinned) return;
    setSelectedSections((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const moveModule = (id: string, dir: -1 | 1) => {
    setSelectedSections((prev) => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 1 || target >= prev.length - 1) return prev;
      const copy = [...prev];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return copy;
    });
  };

  const handleSubmitRun = async () => {
    setSubmitErr(null);
    if ((extraCollect || mode === 'continuous') && !confirmPaidOrTracking) {
      setSubmitErr('请先勾选确认补充采集或持续跟踪方案。');
      return;
    }
    const subs = subredditsText
      .split(/[,，\s]+/)
      .map((s) => s.trim().replace(/^r\//i, ''))
      .filter(Boolean);

    try {
      const res = await createRunMut.mutateAsync({
        draftId,
        idempotencyKey,
        template,
        title: effectiveTitle,
        topic: topic.trim() || effectiveTitle,
        question: focus.trim() || undefined,
        focus: focus.trim() || undefined,
        language,
        detailLevel,
        mode,
        projectId: projectId || null,
        reuseStudyId: urlStudyId || undefined,
        primarySource,
        englishQuery: englishQuery.trim() || undefined,
        subreddits: subs.length ? subs : undefined,
        from: fromDate ? new Date(`${fromDate}T00:00:00Z`).toISOString() : null,
        to: toDate ? new Date(`${toDate}T23:59:59Z`).toISOString() : null,
        platforms: platform ? [platform] : undefined,
        sourceGroup: sourceGroup || undefined,
        storyView: template === 'industry' ? storyView : undefined,
        storyDate: template === 'industry' && storyView === 'digest' && storyDate ? storyDate : null,
        batchIds: selectedBatchIds.length ? selectedBatchIds : undefined,
        monitorId: urlMonitorId || null,
        sampleLimit,
        profile,
        includeComments,
        sections: selectedSections.length ? selectedSections : undefined,
        ...(extraCollect && collectTargetValue.trim()
          ? {
              collectionAction: {
                enabled: true,
                confirmed: true,
                platform: collectPlatform,
                targetType: collectTargetType,
                targetValue: collectTargetValue.trim(),
                limit: collectLimit,
                lookbackDays: collectLookbackDays,
                includeComments,
              },
            }
          : {}),
      });

      // If user chose continuous mode and confirmed, also create a real periodic report schedule
      if (mode === 'continuous' && confirmPaidOrTracking) {
        await createScheduleMut
          .mutateAsync({
            name: `${effectiveTitle}（定期自动）`,
            template,
            projectId: res.run.projectId ?? (projectId || null),
            monitorId: urlMonitorId || null,
            cadence: scheduleCadence,
            windowHours: scheduleCadence === 'weekly' ? 168 : 24,
            enabled: true,
            config: {
              topic: topic.trim() || effectiveTitle,
              focus: focus.trim(),
              primarySource,
              sourceGroup: sourceGroup || undefined,
              englishQuery: englishQuery.trim() || undefined,
              sections: selectedSections,
            },
          })
          .catch(() => {});
      }

      onNavigate(`/reports/runs/${encodeURIComponent(res.run.id)}`);
    } catch (err) {
      setSubmitErr(formatApiError(err));
    }
  };

  const moduleMap = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);

  return (
    <div className="ds-page" style={{ display: 'grid', gap: 16 }}>
      {/* Wizard Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>
            <button type="button" className="ds-btn ds-btn--quiet" style={{ padding: 0, fontSize: 12 }} onClick={() => onNavigate('/reports')}>
              ← 返回报告工作台
            </button>
            {fromContext && <span style={{ marginLeft: 10 }} className="tag">已继承上下文：{fromContext}</span>}
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, margin: 0 }}>
            创建研究报告
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="ds-btn ds-btn--ghost" disabled={upsertDraftMut.isPending} onClick={() => void handleSaveDraft()}>
            <Save size={13} />
            <span>保存草稿</span>
          </button>
          <button type="button" className="ds-btn ds-btn--quiet" onClick={() => onNavigate('/reports')}>
            取消
          </button>
        </div>
      </div>

      {/* Horizontal 3-Step Visual Guide */}
      <section className="ds-card rw-stepper-card" aria-label="创建研究报告步骤">
        <div className="rw-stepper-head">
          <div className="rw-stepper-head-left">
            <span className="rw-stepper-eyebrow">三步完成研究报告</span>
            <span className="rw-stepper-progress">当前进度：第 {step} / 3 步</span>
          </div>
          {modulesQuery.data?.llm && (
            <span
              className={`rw-llm-pill ${modulesQuery.data.llm.configured ? 'is-ready' : 'is-fallback'}`}
              title={modulesQuery.data.llm.configured ? `模型：${modulesQuery.data.llm.model}` : '未配置模型密钥时自动交付纯数据统计报告'}
            >
              <span className="rw-llm-dot" aria-hidden="true" />
              <span>
                {modulesQuery.data.llm.configured
                  ? 'AI 结论归纳引擎已就绪'
                  : '纯数据统计模式（未配置 AI 引擎）'}
              </span>
            </span>
          )}
        </div>

        <div className="rw-steps-row">
          {WIZARD_STEPS.map((item, idx) => {
            const isActive = step === item.n;
            const isDone = step > item.n;
            const canClick = item.n < step || (item.n === 2 && Boolean(discovery)) || item.n === 1;
            return (
              <div key={item.n} className="rw-step-slot">
                <button
                  type="button"
                  className={`rw-step-card ${isActive ? 'is-active' : ''} ${isDone ? 'is-done' : ''}`}
                  style={{ '--step-accent': item.accent, '--step-tint': item.tint } as CSSProperties}
                  disabled={!canClick && !isActive}
                  aria-current={isActive ? 'step' : undefined}
                  onClick={() => {
                    if (canClick) setStep(item.n);
                  }}
                >
                  <div className="rw-step-illus" style={{ background: item.tint }}>
                    <WizardStepIllustration stepNum={item.n} accent={item.accent} />
                  </div>
                  <div className="rw-step-copy">
                    <div className="rw-step-top">
                      <span className="rw-step-num" style={{ color: item.accent }}>
                        {item.code}
                      </span>
                      <strong className="rw-step-title">{item.title}</strong>
                      <span className={`rw-step-state ${isActive ? 'is-active' : isDone ? 'is-done' : ''}`}>
                        {isDone ? '已完成' : isActive ? '进行中' : '待进行'}
                      </span>
                    </div>
                    <p className="rw-step-desc">{item.desc}</p>
                  </div>
                </button>
                {idx < WIZARD_STEPS.length - 1 && (
                  <div className={`rw-step-arrow ${step > item.n ? 'is-passed' : ''}`} aria-hidden="true">
                    <ChevronRight size={16} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {notice && <div className="wb-alert wb-alert--success">{notice}</div>}
      {submitErr && <div className="wb-alert wb-alert--error">{submitErr}</div>}

      {/* Main 2-column Wizard Layout: Form + Visual Sticky Outline */}
      <div className="rw-main-grid">
        {/* Left column: Step Content */}
        <div className="ds-card" style={{ padding: 20, display: 'grid', gap: 16 }}>
          {step === 1 && (
            <>
              <div>
                <label style={{ display: 'block', fontSize: 12.5, fontWeight: 700, marginBottom: 8 }}>选择报告类型</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                  {TEMPLATE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className="ds-card"
                      style={{
                        textAlign: 'left',
                        padding: '10px 12px',
                        cursor: 'pointer',
                        borderColor: template === opt.id ? 'var(--wb-purple)' : undefined,
                        background: template === opt.id ? 'var(--wb-tint)' : undefined,
                      }}
                      onClick={() => {
                        setTemplate(opt.id);
                        setDiscovery(null);
                        if (opt.id === 'industry') setPrimarySource('stories');
                      }}
                    >
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{opt.label}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="wb-grid-2">
                <div className="wb-field">
                  <label>{template === 'industry' ? '关注主题或领域（可选）' : '研究对象 / 品类 / 品牌 *'}</label>
                  <input
                    className="wb-input"
                    value={topic}
                    onChange={(e) => {
                      setTopic(e.target.value);
                      setDiscovery(null);
                    }}
                    placeholder={template === 'industry' ? '例如：AI 大模型、科技硬件（留空汇总全频道）' : '例如：开放式耳机、便携式电源、Grok、Claude'}
                  />
                </div>
                <div className="wb-field">
                  <label>报告名称（留空自动命名）</label>
                  <input
                    className="wb-input"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={effectiveTitle}
                  />
                </div>
              </div>

              {template === 'industry' ? (
                <div className="wb-grid-2">
                  <div className="wb-field">
                    <label>简报周期口径</label>
                    <select className="wb-select" value={storyView} onChange={(e) => setStoryView(e.target.value as 'latest' | 'hot' | 'digest')}>
                      <option value="latest">近 7 天行业动态（周报/专题）</option>
                      <option value="hot">近 48 小时热点事件</option>
                      <option value="digest">08:00 每日简报（24 小时窗口）</option>
                    </select>
                  </div>
                  <div className="wb-field">
                    <label>资讯频道筛选</label>
                    <select className="wb-select" value={sourceGroup} onChange={(e) => setSourceGroup(e.target.value)}>
                      <option value="">全部资讯频道</option>
                      {Object.entries(SOURCE_GROUPS).map(([key, meta]) => (
                        <option key={key} value={key}>{meta.zh}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    <label style={{ display: 'block', fontSize: 12.5, fontWeight: 700, marginBottom: 8 }}>研究方式</label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                      {[
                        { id: 'comprehensive' as const, label: '综合研究', sub: '优先利用完整历史与站内资料' },
                        { id: 'recent' as const, label: '近期动态', sub: '侧重近期社媒讨论与热点变化' },
                        { id: 'continuous' as const, label: '持续跟踪', sub: '复用已有持续供给并设置周期报告' },
                      ].map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="ds-card"
                          style={{
                            textAlign: 'left',
                            padding: '9px 11px',
                            cursor: 'pointer',
                            borderColor: mode === m.id ? 'var(--wb-purple)' : undefined,
                            background: mode === m.id ? 'var(--wb-tint)' : undefined,
                          }}
                          onClick={() => {
                            setMode(m.id);
                            setDiscovery(null);
                          }}
                        >
                          <div style={{ fontWeight: 700, fontSize: 12.5 }}>{m.label}</div>
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{m.sub}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="wb-grid-2">
                    <div className="wb-field">
                      <label>研究起始日期（UTC，可选）</label>
                      <input type="date" className="wb-input" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setDiscovery(null); }} />
                    </div>
                    <div className="wb-field">
                      <label>研究截止日期（UTC，可选）</label>
                      <input type="date" className="wb-input" value={toDate} onChange={(e) => { setToDate(e.target.value); setDiscovery(null); }} />
                    </div>
                  </div>
                </>
              )}

              <div className="wb-field">
                <label>业务研究重点（可选，将指导报告归纳方向）</label>
                <textarea
                  className="wb-input"
                  rows={3}
                  style={{ height: 'auto', padding: '8px 10px' }}
                  value={focus}
                  onChange={(e) => setFocus(e.target.value)}
                  placeholder="例如：重点关注佩戴舒适度、漏音抱怨、户外跑步场景及 $100–$200 价格带竞品对比…"
                />
              </div>

              <div>
                <button
                  type="button"
                  className="ds-btn ds-btn--quiet"
                  style={{ padding: '4px 0', fontSize: 12.5 }}
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  <span>高级研究设置（平台、社区、样本上限、关联已有项目）</span>
                </button>
                {showAdvanced && (
                  <div style={{ display: 'grid', gap: 10, marginTop: 10, padding: 12, background: '#f8fafc', borderRadius: 8, border: '1px solid var(--line)' }}>
                    <div className="wb-grid-2">
                      <div className="wb-field">
                        <label>指定平台（留空自动推荐）</label>
                        <select className="wb-select" value={platform} onChange={(e) => setPlatform(e.target.value as '' | 'reddit' | 'x' | 'bluesky' | 'web')}>
                          <option value="">自动推荐</option>
                          <option value="reddit">Reddit</option>
                          <option value="x">X (Twitter)</option>
                          <option value="bluesky">Bluesky</option>
                          <option value="web">资讯网页</option>
                        </select>
                      </div>
                      <div className="wb-field">
                        <label>限定社区（可选，逗号分隔）</label>
                        <input className="wb-input" value={subredditsText} onChange={(e) => setSubredditsText(e.target.value)} placeholder="例如：headphones, headphoneadvice" />
                      </div>
                    </div>
                    <div className="wb-grid-2">
                      <div className="wb-field">
                        <label>分析样本上限</label>
                        <select className="wb-select" value={sampleLimit} onChange={(e) => setSampleLimit(Number(e.target.value))}>
                          <option value={500}>500 条（极速）</option>
                          <option value={2000}>2,000 条（默认平衡）</option>
                          <option value={5000}>5,000 条（深度）</option>
                          <option value={10000}>10,000 条（全量上限）</option>
                        </select>
                      </div>
                      <div className="wb-field">
                        <label>关联已有研究项目（可选）</label>
                        <select className="wb-select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                          <option value="">确认后自动创建私有项目</option>
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.is_shared ? '共享' : '私有'})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5 }}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <input type="checkbox" checked={includeComments} onChange={(e) => setIncludeComments(e.target.checked)} />
                        <span>纳入可用评论文本</span>
                      </label>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span>分析模式：</span>
                        <select className="wb-select" style={{ height: 26, fontSize: 12 }} value={profile} onChange={(e) => setProfile(e.target.value as 'fast' | 'balanced')}>
                          <option value="fast">快速分析</option>
                          <option value="balanced">均衡深度分析</option>
                        </select>
                      </label>
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 6 }}>
                <button type="button" className="ds-btn" onClick={() => void handleGoStep2()}>
                  <FileSearch size={14} />
                  <span>自动发现可用资料</span>
                  <ArrowRight size={14} />
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>已发现的授权研究资料</h2>
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 0' }}>
                    此阶段为只读检索，尚未创建项目或触发任何外部采集费用。
                  </p>
                </div>
                <button type="button" className="ds-btn ds-btn--ghost" disabled={discovering} onClick={() => void runDiscovery()}>
                  <RefreshCw size={13} />
                  <span>{discovering ? '正在检索…' : '重新匹配'}</span>
                </button>
              </div>

              {/* Editable English query for archive/cross-lingual discovery */}
              {template !== 'industry' && (
                <div style={{ padding: 12, background: '#f8fafc', borderRadius: 8, border: '1px solid var(--line)', display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div className="wb-field" style={{ flex: 1, minWidth: 220, margin: 0 }}>
                      <label>英文检索表达式（用于历史讨论归档，可直接编辑）</label>
                      <input
                        className="wb-input"
                        value={englishQuery}
                        onChange={(e) => setEnglishQuery(e.target.value)}
                        placeholder='例如：("open ear" OR shokz) AND headphones'
                      />
                    </div>
                    <button
                      type="button"
                      className="ds-btn ds-btn--ghost"
                      disabled={discovering}
                      onClick={() => void runDiscovery({ overrideEnglish: englishQuery })}
                    >
                      按编辑词重新匹配
                    </button>
                    {discovery?.archiveChannel.needsExactVerify && (
                      <button
                        type="button"
                        className="ds-btn ds-btn--ghost"
                        disabled={verifyingPhrase}
                        onClick={() => void runDiscovery({ overrideEnglish: englishQuery, verifyPhrase: true })}
                      >
                        {verifyingPhrase ? '正在复核短语…' : '精确短语复核'}
                      </button>
                    )}
                  </div>
                  {discovery?.parsedQuery.ambiguityWarnings.map((w, i) => (
                    <div key={i} style={{ fontSize: 12, color: '#92400e', display: 'flex', gap: 6, alignItems: 'center' }}>
                      <AlertTriangle size={13} />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              {discovering && (
                <div style={{ padding: 26, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                  正在并行查询站内已存资料、历史讨论归档与行业资讯流…
                </div>
              )}

              {discoveryErr && <div className="wb-alert wb-alert--error">{discoveryErr}</div>}

              {discovery && !discovering && (
                <div style={{ display: 'grid', gap: 12 }}>
                  {/* Recommendation Banner */}
                  <div
                    style={{
                      padding: '12px 14px',
                      borderRadius: 8,
                      border: '1px solid var(--wb-purple)',
                      background: 'var(--wb-tint)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13.5, color: 'var(--wb-purple-deep)' }}>
                        推荐方案：{discovery.recommendation.readinessLabel}
                      </strong>
                      <span className="tag">发现耗时 {discovery.elapsedMs} ms</span>
                    </div>
                    <p style={{ fontSize: 12.5, margin: '6px 0 0', color: 'var(--ink)' }}>{discovery.recommendation.rationale}</p>
                    {discovery.recommendation.gaps.length > 0 && (
                      <ul style={{ margin: '6px 0 0 18px', padding: 0, fontSize: 12, color: '#92400e' }}>
                        {discovery.recommendation.gaps.map((g, i) => <li key={i}>{g}</li>)}
                      </ul>
                    )}
                  </div>

                  {/* Three Source Cards */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                    {/* Card 1: PG Content */}
                    <div
                      className="ds-card"
                      style={{
                        padding: 12,
                        borderColor: primarySource === 'pg_content' ? 'var(--wb-purple)' : undefined,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <b style={{ fontSize: 13 }}>平台已有相关讨论</b>
                        <span className="tag">{discovery.pgChannel.matchedContentCount.toLocaleString()} 条</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                        <div>命中批次：{discovery.pgChannel.batches.length} 个授权批次</div>
                        <div>
                          时间覆盖：{discovery.pgChannel.dateRange.earliest?.slice(0, 10) || '—'} ~ {discovery.pgChannel.dateRange.latest?.slice(0, 10) || '—'}
                        </div>
                        {discovery.pgChannel.batches.slice(0, 2).map((b) => (
                          <div key={b.batchId} style={{ marginTop: 3 }}>
                            · {b.sourceLabel}：命中 {b.matchedCount}/{b.batchTotal} 条
                          </div>
                        ))}
                      </div>
                      {discovery.pgChannel.matchedContentCount > 0 && (
                        <button
                          type="button"
                          className={`ds-btn ${primarySource === 'pg_content' ? '' : 'ds-btn--ghost'}`}
                          style={{ width: '100%', marginTop: 8, fontSize: 12 }}
                          onClick={() => setPrimarySource('pg_content')}
                        >
                          {primarySource === 'pg_content' ? '已选为主资料' : '选为主资料'}
                        </button>
                      )}
                    </div>

                    {/* Card 2: R4 Archive */}
                    <div
                      className="ds-card"
                      style={{
                        padding: 12,
                        borderColor: primarySource === 'archive' ? 'var(--wb-purple)' : undefined,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <b style={{ fontSize: 13 }}>历史消费者与社媒讨论</b>
                        <span className="tag">
                          {discovery.archiveChannel.available
                            ? `${discovery.archiveChannel.matchedThreads.toLocaleString()} 讨论串`
                            : discovery.archiveChannel.status === 'forbidden'
                              ? '未授权'
                              : '未连接'}
                        </span>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                        {discovery.archiveChannel.available ? (
                          <>
                            <div>
                              计数口径：{discovery.archiveChannel.status === 'exact' ? '精确匹配' : discovery.archiveChannel.status === 'candidate' ? '候选规模（待短语复核）' : discovery.archiveChannel.status}
                            </div>
                            <div>关联归档评论：{discovery.archiveChannel.associatedComments.toLocaleString()} 条</div>
                            <div>
                              实际时间：{discovery.archiveChannel.dateRange.earliest?.slice(0, 10) || '—'} ~ {discovery.archiveChannel.dateRange.latest?.slice(0, 10) || '—'}（{discovery.archiveChannel.dateRange.activeDays} 天）
                            </div>
                            {discovery.archiveChannel.topCommunities.length > 0 && (
                              <div>热门社区：{discovery.archiveChannel.topCommunities.slice(0, 3).map((c) => `r/${c.community}`).join('、')}</div>
                            )}
                          </>
                        ) : (
                          <div>{discovery.archiveChannel.message || '历史归档当前不可用'}</div>
                        )}
                      </div>
                      {discovery.archiveChannel.matchedThreads > 0 && (
                        <button
                          type="button"
                          className={`ds-btn ${primarySource === 'archive' ? '' : 'ds-btn--ghost'}`}
                          style={{ width: '100%', marginTop: 8, fontSize: 12 }}
                          onClick={() => setPrimarySource('archive')}
                        >
                          {primarySource === 'archive' ? '已选为主资料' : '选为主资料'}
                        </button>
                      )}
                    </div>

                    {/* Card 3: Stories Feed */}
                    <div
                      className="ds-card"
                      style={{
                        padding: 12,
                        borderColor: primarySource === 'stories' ? 'var(--wb-purple)' : undefined,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <b style={{ fontSize: 13 }}>平台行业资讯流</b>
                        <span className="tag">{discovery.storiesChannel.eventCount} 个事件</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                        <div>独立来源：{discovery.storiesChannel.independentSourceCount} 个</div>
                        <div>窗口：{discovery.storiesChannel.windowFrom.slice(0, 10)} ~ {discovery.storiesChannel.windowTo.slice(0, 10)}</div>
                        {discovery.storiesChannel.samples[0] && (
                          <div style={{ marginTop: 3 }}>代表：{discovery.storiesChannel.samples[0].title.slice(0, 42)}…</div>
                        )}
                      </div>
                      {discovery.storiesChannel.eventCount > 0 && (
                        <button
                          type="button"
                          className={`ds-btn ${primarySource === 'stories' ? '' : 'ds-btn--ghost'}`}
                          style={{ width: '100%', marginTop: 8, fontSize: 12 }}
                          onClick={() => setPrimarySource('stories')}
                        >
                          {primarySource === 'stories' ? '已选为主资料' : '选为主资料'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Sample preview */}
                  {(discovery.archiveChannel.samples.length > 0 || discovery.pgChannel.samples.length > 0) && (
                    <details style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 12px', background: '#fafcfb' }}>
                      <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>
                        查看匹配代表性原文预览
                      </summary>
                      <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                        {discovery.archiveChannel.samples.slice(0, 3).map((s) => (
                          <div key={`${s.month}-${s.docId}`} style={{ fontSize: 12, padding: 8, background: '#fff', border: '1px solid var(--line)', borderRadius: 6 }}>
                            <div style={{ fontWeight: 600 }}>[r/{s.community}] {s.title}</div>
                            {s.snippet && <div style={{ color: 'var(--muted)', marginTop: 3 }}>{s.snippet.slice(0, 180)}</div>}
                          </div>
                        ))}
                        {discovery.pgChannel.samples.slice(0, 3).map((s) => (
                          <div key={s.id} style={{ fontSize: 12, padding: 8, background: '#fff', border: '1px solid var(--line)', borderRadius: 6 }}>
                            <div style={{ fontWeight: 600 }}>[{s.platform.toUpperCase()} · {s.sourceLabel}] {s.title || s.excerpt.slice(0, 60)}</div>
                            <div style={{ color: 'var(--muted)', marginTop: 3 }}>{s.excerpt.slice(0, 180)}</div>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  {/* Optional Extra Collection / Continuous Tracking Confirmation */}
                  {template !== 'industry' && (
                    <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12, display: 'grid', gap: 8 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={extraCollect}
                          onChange={(e) => {
                            setExtraCollect(e.target.checked);
                            setConfirmPaidOrTracking(false);
                          }}
                        />
                        <span>额外获取近期社媒研究资料（需确认额度与目标）</span>
                      </label>
                      {extraCollect && (
                        <div style={{ display: 'grid', gap: 8, paddingTop: 4 }}>
                          <div className="wb-grid-2">
                            <div className="wb-field">
                              <label>补充平台</label>
                              <select className="wb-select" value={collectPlatform} onChange={(e) => setCollectPlatform(e.target.value as 'x' | 'reddit' | 'bluesky')}>
                                <option value="x">X (Twitter)</option>
                                <option value="reddit">Reddit</option>
                                <option value="bluesky">Bluesky</option>
                              </select>
                            </div>
                            <div className="wb-field">
                              <label>目标类型</label>
                              <select className="wb-select" value={collectTargetType} onChange={(e) => setCollectTargetType(e.target.value as 'keyword' | 'community' | 'account')}>
                                <option value="keyword">关键词检索</option>
                                <option value="community">指定社区</option>
                                <option value="account">公开账号</option>
                              </select>
                            </div>
                          </div>
                          <div className="wb-grid-2">
                            <div className="wb-field">
                              <label>采集目标值</label>
                              <input className="wb-input" value={collectTargetValue} onChange={(e) => setCollectTargetValue(e.target.value)} placeholder="例如：open ear headphones" />
                            </div>
                            <div className="wb-field">
                              <label>目标获取规模 / 回溯天数</label>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <select className="wb-select" value={collectLimit} onChange={(e) => setCollectLimit(Number(e.target.value))}>
                                  <option value={20}>20 条（轻量测试）</option>
                                  <option value={100}>100 条</option>
                                  <option value={500}>500 条</option>
                                  <option value={1000}>1,000 条</option>
                                </select>
                                <select className="wb-select" value={collectLookbackDays} onChange={(e) => setCollectLookbackDays(Number(e.target.value))}>
                                  <option value={3}>近 3 天</option>
                                  <option value={7}>近 7 天</option>
                                  <option value={30}>近 30 天</option>
                                </select>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                      {mode === 'continuous' && (
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
                          <span>自动周期报告频率：</span>
                          <select className="wb-select" style={{ width: 160 }} value={scheduleCadence} onChange={(e) => setScheduleCadence(e.target.value as 'daily' | 'weekly')}>
                            <option value="daily">每日自动生成</option>
                            <option value="weekly">每周自动生成</option>
                          </select>
                          <span style={{ color: 'var(--muted)' }}>（周期报告默认只读取已入库数据，不自动追加付费采集）</span>
                        </div>
                      )}
                      {(extraCollect || mode === 'continuous') && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#92400e', background: '#fffbeb', padding: '8px 10px', borderRadius: 6 }}>
                          <input type="checkbox" checked={confirmPaidOrTracking} onChange={(e) => setConfirmPaidOrTracking(e.target.checked)} />
                          <span>我已核对采集目标、规模与持续计划，确认按账号当前配额执行。</span>
                        </label>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 6 }}>
                <button type="button" className="ds-btn ds-btn--ghost" onClick={() => setStep(1)}>
                  <ArrowLeft size={13} />
                  <span>上一步</span>
                </button>
                <button
                  type="button"
                  className="ds-btn"
                  disabled={discovering}
                  onClick={() => {
                    if ((extraCollect || mode === 'continuous') && !confirmPaidOrTracking) {
                      setSubmitErr('请先勾选确认补充采集或持续跟踪方案。');
                      return;
                    }
                    setSubmitErr(null);
                    setStep(3);
                  }}
                >
                  <span>确认资料方案</span>
                  <ArrowRight size={13} />
                </button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div>
                <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px' }}>确认报告章节与执行计划</h2>
                <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                  确认后任务将在服务端后台异步执行，支持关闭页面或刷新后继续追踪进度。
                </p>
              </div>

              <div className="wb-grid-2">
                <div className="wb-field">
                  <label>主数据源</label>
                  <select className="wb-select" value={primarySource} onChange={(e) => setPrimarySource(e.target.value as typeof primarySource)}>
                    {SOURCE_MODE_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="wb-field">
                  <label>报告语言与详略</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select className="wb-select" value={language} onChange={(e) => setLanguage(e.target.value as 'zh' | 'en')}>
                      <option value="zh">中文报告</option>
                      <option value="en">English Report</option>
                    </select>
                    <select className="wb-select" value={detailLevel} onChange={(e) => setDetailLevel(e.target.value as 'full' | 'compact')}>
                      <option value="full">完整版</option>
                      <option value="compact">精简版</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Module Picker (interactive for custom, inspectable/customizable for all templates) */}
              <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <strong style={{ fontSize: 13 }}>报告分析模块（可勾选与上下调整顺序）</strong>
                  <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>已选 {selectedSections.length} 章 · 范围与证据章固定</span>
                </div>
                <div style={{ display: 'grid', gap: 6, maxHeight: 340, overflowY: 'auto' }}>
                  {modules.map((mod) => {
                    const checked = selectedSections.includes(mod.id);
                    const idx = selectedSections.indexOf(mod.id);
                    return (
                      <div
                        key={mod.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          padding: '7px 10px',
                          borderRadius: 6,
                          border: '1px solid var(--line)',
                          background: checked ? '#f8fafc' : '#fff',
                        }}
                      >
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: mod.pinned ? 'default' : 'pointer', flex: 1 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={mod.pinned}
                            onChange={() => toggleModule(mod.id)}
                          />
                          <div>
                            <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                              {mod.title}
                              {mod.pinned && <span className="tag" style={{ marginLeft: 6, fontSize: 10 }}>固定</span>}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{mod.description}</div>
                          </div>
                        </label>
                        {checked && !mod.pinned && (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button type="button" className="ds-btn ds-btn--quiet" style={{ padding: '2px 5px' }} disabled={idx <= 1} onClick={() => moveModule(mod.id, -1)}>
                              <ArrowUp size={12} />
                            </button>
                            <button type="button" className="ds-btn ds-btn--quiet" style={{ padding: '2px 5px' }} disabled={idx >= selectedSections.length - 2} onClick={() => moveModule(mod.id, 1)}>
                              <ArrowDown size={12} />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 6 }}>
                <button type="button" className="ds-btn ds-btn--ghost" onClick={() => setStep(urlStudyId ? 1 : 2)}>
                  <ArrowLeft size={13} />
                  <span>上一步</span>
                </button>
                <button
                  type="button"
                  className="ds-btn"
                  disabled={createRunMut.isPending}
                  onClick={() => void handleSubmitRun()}
                >
                  <Sparkles size={14} />
                  <span>{createRunMut.isPending ? '正在提交研究任务…' : '开始研究并生成报告'}</span>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Right column: Visual Structured Report Outline */}
        {(() => {
          const tplVis = TEMPLATE_VISUAL_META[template];
          const sourceLabel = SOURCE_MODE_OPTIONS.find((s) => s.id === primarySource)?.label ?? '自动推荐主资料';
          return (
            <aside
              className="ds-card rw-outline-card"
              style={{ '--outline-accent': tplVis.accent, '--outline-tint': tplVis.tint } as CSSProperties}
            >
              {/* Scenario Banner Header with Mini Report SVG */}
              <div className="rw-outline-banner">
                <svg viewBox="0 0 42 50" className="rw-outline-thumb" aria-hidden="true">
                  <rect x="3" y="2" width="36" height="46" rx="4" fill="#ffffff" stroke="#d5dde6" />
                  <rect x="3" y="2" width="36" height="4" rx="2" fill={tplVis.accent} />
                  <rect x="8" y="11" width="18" height="2.6" rx="1" fill={tplVis.accent} />
                  <rect x="8" y="17" width="26" height="4" rx="1" fill="#334155" />
                  <rect x="8" y="25" width="26" height="3.2" rx="1" fill={tplVis.accent} opacity="0.28" />
                  <rect x="8" y="31" width="20" height="3.2" rx="1" fill={tplVis.accent} opacity="0.58" />
                  <rect x="8" y="37" width="15" height="3.2" rx="1" fill={tplVis.accent} opacity="0.82" />
                </svg>
                <div className="rw-outline-banner-copy">
                  <div className="rw-outline-eyebrow">
                    <span>预计报告目录</span>
                    <span className="rw-outline-count">共 {selectedSections.length} 章</span>
                  </div>
                  <div className="rw-outline-title">{effectiveTitle}</div>
                  <div className="rw-outline-source">
                    <Database size={11} />
                    <span>{sourceLabel}</span>
                  </div>
                </div>
              </div>

              {/* Structured Visual Chapter Timeline */}
              <div className="rw-outline-body">
                <ol className="rw-outline-list">
                  {selectedSections.map((sid, idx) => {
                    const mod = moduleMap.get(sid);
                    const meta = getOutlineSectionMeta(sid, mod?.description);
                    const Icon = meta.icon;
                    return (
                      <li key={sid} className="rw-outline-item">
                        <div className="rw-outline-rail" aria-hidden="true">
                          <span className={`rw-outline-node rw-outline-node--${meta.roleTone}`}>
                            {String(idx + 1).padStart(2, '0')}
                          </span>
                          {idx < selectedSections.length - 1 && <span className="rw-outline-line" />}
                        </div>
                        <div className="rw-outline-item-card">
                          <div className="rw-outline-item-top">
                            <span className="rw-outline-item-title">
                              <Icon size={13} color={tplVis.accent} />
                              <span>{mod?.title ?? sid}</span>
                            </span>
                            <span className={`rw-outline-role rw-outline-role--${meta.roleTone}`}>
                              {meta.roleLabel}
                            </span>
                          </div>
                          <div className="rw-outline-item-hint">{meta.shortHint}</div>
                        </div>
                      </li>
                    );
                  })}
                </ol>

                <div className="rw-outline-footer">
                  <ShieldCheck size={14} color={tplVis.accent} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>统计与图表由程序基于真实样本生成，AI 仅依据已验证指标与代表原文撰写解读。</span>
                </div>
              </div>
            </aside>
          );
        })()}
      </div>
    </div>
  );
}
