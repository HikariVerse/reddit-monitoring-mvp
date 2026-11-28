import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Database, FileText, Info, Layers, Lock, Sparkles, Unlock } from 'lucide-react';
import '../../styles/explore.css';
import type {
  ExploreAnalyzeRequest,
  ExploreAnalyzeResponse,
  ExploreCapabilitiesResponse,
  ExploreGroupBy,
  ExploreGuidedStep,
  ExplorePanelId,
  ExplorePanelResult,
  ExploreProfile,
  ExploreScenarioId,
  ExploreSourceMode,
} from '../../../../../packages/contracts/src/explore';
import { liveFetch } from '@/api/client';
import { useProjectsQuery } from '@/api/hooks';
import { useI18n } from '@/i18n/translations';
import { AdaptiveLayerLayout } from '../research/AdaptivePanelLayout';
import { resolvePanelGroup, usePanelPreferences } from '../research/panelRegistry';
import { Alert } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Collapsible, CollapsibleTrigger } from '../ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { ExploreCapabilityPreview } from './ExploreCapabilityPreview';
import { ExploreControlPanel, type ExploreHistoryEntry } from './ExploreControlPanel';
import { ExploreEvidenceModal } from './ExploreEvidenceModal';
import { ExplorePanelCard } from './ExplorePanelCard';
import { ExploreProgressPanel } from './ExploreProgressPanel';
import { buildExplorePanelRules, EXPLORE_SCENARIO_LIST } from './explorePanelMeta';
import { EXPLORE_SOURCE_OPTIONS, formatExploreError } from './exploreSources';

const HISTORY_STORAGE_KEY = 'siftline.explore.history.v1';
const MAX_HISTORY_ITEMS = 10;

function loadStoredHistory(): ExploreHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ExploreHistoryEntry => Boolean(item && typeof item === 'object' && typeof (item as ExploreHistoryEntry).id === 'string'))
      .slice(0, MAX_HISTORY_ITEMS)
      .map((item) => ({ ...item, hasCachedResult: false }));
  } catch {
    return [];
  }
}

function saveStoredHistory(entries: readonly ExploreHistoryEntry[]) {
  if (typeof window === 'undefined') return;
  try {
    if (entries.length === 0) {
      window.sessionStorage.removeItem(HISTORY_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(
        HISTORY_STORAGE_KEY,
        JSON.stringify(
          entries.slice(0, MAX_HISTORY_ITEMS).map((item) => ({
            id: item.id,
            query: item.query,
            sourceMode: item.sourceMode,
            projectId: item.projectId,
            analyzedDocuments: item.analyzedDocuments,
            createdAt: item.createdAt,
          })),
        ),
      );
    }
  } catch {
    // ignore storage quota errors
  }
}

function createRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function ExploreInsightsWorkspace({
  initialProjectId,
  initialArchiveRefId,
  initialStudyId,
  initialQuery,
  returnTo,
  onNavigate,
}: {
  initialProjectId?: string;
  initialArchiveRefId?: string;
  initialStudyId?: string;
  initialQuery?: string;
  returnTo?: string;
  onNavigate?: (path: string) => void;
}) {
  const { t } = useI18n();
  const projectsQuery = useProjectsQuery(true);
  const capabilitiesQuery = useQuery({
    queryKey: ['explore-capabilities'],
    queryFn: ({ signal }) => liveFetch<ExploreCapabilitiesResponse>('/explore/capabilities', { signal }),
    retry: false,
  });

  const cap = capabilitiesQuery.data;
  const projects = useMemo(() => projectsQuery.data?.projects ?? [], [projectsQuery.data?.projects]);
  const hasOriginProject = Boolean(initialProjectId);
  const [inheritProjectScope, setInheritProjectScope] = useState(hasOriginProject);
  const defaultSourceMode: ExploreSourceMode =
    hasOriginProject && inheritProjectScope
      ? initialArchiveRefId
        ? 'archive'
        : 'project_content'
      : cap?.archiveAvailable
        ? 'archive'
        : 'live_content';

  const [queryText, setQueryText] = useState(initialQuery ?? '');
  const [sourceMode, setSourceMode] = useState<ExploreSourceMode | null>(
    hasOriginProject ? (initialArchiveRefId ? 'archive' : 'project_content') : null,
  );
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [archiveRefId, setArchiveRefId] = useState(initialArchiveRefId ?? '');
  const [subredditsText, setSubredditsText] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [groupBy, setGroupBy] = useState<ExploreGroupBy>('group');
  const [profile, setProfile] = useState<ExploreProfile>('fast');
  const [includeComments, setIncludeComments] = useState(false);
  const [sampleLimitText, setSampleLimitText] = useState('2000');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showImpactDetails, setShowImpactDetails] = useState(false);

  const [activeScenario, setActiveScenario] = useState<ExploreScenarioId>('pulse');
  const [evidenceState, setEvidenceState] = useState<{ studyId: string; evidenceId: string; title: string } | null>(null);

  // Live progress run tracking
  const [activeRun, setActiveRun] = useState<{ runId: string; query: string; sourceLabel: string } | null>(null);

  // History entries & in-memory instant-restore cache
  const [history, setHistory] = useState<ExploreHistoryEntry[]>(loadStoredHistory);
  const resultCacheRef = useRef<Map<string, ExploreAnalyzeResponse>>(new Map());
  const [displayedResult, setDisplayedResult] = useState<ExploreAnalyzeResponse | null>(null);
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);

  // Restore persisted study when studyId is present in URL
  const restoredStudyQuery = useQuery({
    queryKey: ['explore-study', initialStudyId],
    queryFn: ({ signal }) => liveFetch<ExploreAnalyzeResponse>(`/explore/studies/${encodeURIComponent(initialStudyId!)}`, { signal }),
    enabled: Boolean(initialStudyId),
    retry: false,
  });

  const originProject = useMemo(
    () => (initialProjectId ? projects.find((p) => p.id === initialProjectId) : undefined),
    [initialProjectId, projects],
  );

  const effectiveRestored = displayedResult ? null : restoredStudyQuery.data ?? null;
  const resolvedSourceMode = sourceMode ?? effectiveRestored?.sourceProfile.sourceMode ?? defaultSourceMode;
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const analyzeMut = useMutation({
    mutationFn: (payload: ExploreAnalyzeRequest) =>
      liveFetch<ExploreAnalyzeResponse>('/explore/analyze', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data, variables) => {
      setDisplayedResult(data);
      const entryId = `${variables.sourceMode}:${data.studyId}`;
      resultCacheRef.current.set(entryId, data);
      setActiveHistoryId(entryId);
      setHistory((prev) => {
        const nextItem: ExploreHistoryEntry = {
          id: entryId,
          query: data.query,
          sourceMode: variables.sourceMode,
          projectId: variables.projectId,
          analyzedDocuments: data.sourceProfile.analyzedDocuments,
          createdAt: data.generatedAt,
          hasCachedResult: true,
        };
        const deduped = [nextItem, ...prev.filter((item) => item.id !== entryId)].slice(0, MAX_HISTORY_ITEMS);
        saveStoredHistory(deduped);
        return deduped;
      });
    },
    onSettled: () => {
      setActiveRun(null);
    },
  });

  const result = displayedResult ?? restoredStudyQuery.data ?? null;

  const panelMap = useMemo(() => {
    const map = {} as Record<ExplorePanelId, ExplorePanelResult | undefined>;
    for (const p of result?.panels ?? []) map[p.panel_id] = p;
    return map;
  }, [result?.panels]);

  const scenarioRules = useMemo(() => buildExplorePanelRules(activeScenario), [activeScenario]);
  const layerPanelIds = useMemo(() => scenarioRules.map((r) => r.id), [scenarioRules]);
  const { overrides, setOverride, clearOverride, resetLayer } = usePanelPreferences(
    `explore-${result?.studyId ?? 'default'}`,
    layerPanelIds,
  );

  const resolvedGroup = useMemo(
    () => resolvePanelGroup(scenarioRules, panelMap, overrides, t),
    [scenarioRules, panelMap, overrides, t],
  );

  const parseSampleLimit = (raw: string): number => {
    const n = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(n)) return 2000;
    return Math.max(25, Math.min(10000, n));
  };

  const handleSampleLimitBlur = () => {
    setSampleLimitText(String(parseSampleLimit(sampleLimitText)));
  };

  const runExplore = (overridesReq?: Partial<ExploreAnalyzeRequest>) => {
    const nextMode = overridesReq?.sourceMode ?? resolvedSourceMode;
    const nextQuery = (overridesReq?.query ?? queryText).trim();
    const resolvedLimit = overridesReq?.limit ?? parseSampleLimit(sampleLimitText);
    const runId = createRunId();
    const subreddits = subredditsText
      .split(/[,，\s]+/)
      .map((s) => s.trim().replace(/^r\//i, ''))
      .filter(Boolean);

    const meta = EXPLORE_SOURCE_OPTIONS.find((s) => s.mode === nextMode);
    setActiveRun({
      runId,
      query: nextQuery,
      sourceLabel: meta ? t(meta.titleEn, meta.titleZh) : nextMode,
    });

    const payload: ExploreAnalyzeRequest = {
      runId,
      query: nextQuery,
      sourceMode: nextMode,
      projectId:
        nextMode === 'project_content' || (inheritProjectScope && archiveRefId)
          ? (overridesReq?.projectId ?? effectiveProjectId) || undefined
          : undefined,
      archiveRefId: inheritProjectScope && archiveRefId ? archiveRefId : undefined,
      subreddits: (nextMode === 'archive' || nextMode === 'reddit_api') && subreddits.length > 0 ? subreddits : undefined,
      from: fromDate ? new Date(`${fromDate}T00:00:00Z`).toISOString() : null,
      to: toDate ? new Date(`${toDate}T23:59:59Z`).toISOString() : null,
      groupBy,
      profile,
      includeComments: nextMode === 'archive' ? includeComments : undefined,
      limit: resolvedLimit,
      ...overridesReq,
    };
    analyzeMut.mutate(payload);
  };

  const resetFilters = () => {
    setSubredditsText('');
    setFromDate('');
    setToDate('');
    setGroupBy('group');
    setProfile('fast');
    setSampleLimitText('2000');
  };

  const handleSelectHistory = (entry: ExploreHistoryEntry) => {
    setQueryText(entry.query);
    setSourceMode(entry.sourceMode);
    if (entry.projectId) setProjectId(entry.projectId);

    const cached = resultCacheRef.current.get(entry.id);
    if (cached) {
      setDisplayedResult(cached);
      setActiveHistoryId(entry.id);
      return;
    }
    runExplore({
      query: entry.query,
      sourceMode: entry.sourceMode,
      projectId: entry.projectId,
    });
  };

  const handleClearHistory = () => {
    resultCacheRef.current.clear();
    setHistory([]);
    setActiveHistoryId(null);
    saveStoredHistory([]);
  };

  const handleGuidedAction = (step: ExploreGuidedStep) => {
    if (step.suggestedSourceMode) {
      setSourceMode(step.suggestedSourceMode);
      runExplore({ sourceMode: step.suggestedSourceMode });
      return;
    }
    if (step.suggestedQuery) {
      setQueryText(step.suggestedQuery);
      runExplore({ query: step.suggestedQuery });
      if (step.targetScenario) setActiveScenario(step.targetScenario);
      return;
    }
    if (step.evidenceRefId && result) {
      setEvidenceState({ studyId: result.studyId, evidenceId: step.evidenceRefId, title: step.title });
      return;
    }
    if (step.targetScenario) setActiveScenario(step.targetScenario);
  };

  const handleRefineWithTerm = (term: string) => {
    const base = queryText.trim();
    const next = base ? (base.toLowerCase().includes(term.toLowerCase()) ? base : `${base} ${term}`) : term;
    setQueryText(next);
    runExplore({ query: next });
  };

  const returnTarget = returnTo || (initialProjectId ? `/projects?view=overview&projectId=${encodeURIComponent(initialProjectId)}` : null);

  return (
    <section className="explore-page-wrap">
      {/* Project Context Inheritance Banner (when entered from a research study) */}
      {hasOriginProject && (
        <div
          className="wb-alert wb-alert--info"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            marginBottom: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {inheritProjectScope ? <Lock size={14} /> : <Unlock size={14} />}
            <span style={{ fontSize: 12.5 }}>
              <b>{t('From Study:', '来自研究：')}</b>
              {originProject?.name ?? t('Selected Study', '当前研究')}
              {' · '}
              {inheritProjectScope
                ? archiveRefId
                  ? t('Locked to this study archive scope', '已继承当前研究的归档范围')
                  : t('Locked to this study data scope', '已继承当前研究的数据范围')
                : t('Independent free exploration mode', '已切换为独立自由探索模式')}
            </span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={inheritProjectScope}
                onChange={(e) => {
                  const next = e.target.checked;
                  setInheritProjectScope(next);
                  if (next) {
                    setProjectId(initialProjectId ?? '');
                    setArchiveRefId(initialArchiveRefId ?? '');
                    setSourceMode(initialArchiveRefId ? 'archive' : 'project_content');
                  } else {
                    setArchiveRefId('');
                    if (cap?.archiveAvailable) setSourceMode('archive');
                  }
                }}
              />
              <span>{t('Keep study scope', '沿用当前研究范围')}</span>
            </label>
          </div>
          {returnTarget && onNavigate && (
            <button
              type="button"
              className="ds-btn ds-btn--ghost"
              style={{ height: 28, fontSize: 11.5 }}
              onClick={() => onNavigate(returnTarget)}
            >
              <ArrowLeft size={12} />
              <span>{t('Back to Study', '返回原研究')}</span>
            </button>
          )}
        </div>
      )}

      {/* Top Header */}
      <header className="explore-top-header">
        <div>
          <div className="explore-breadcrumb">{t('Explore / Smart Insights', '探索 / 智能洞察探索')}</div>
          <h1 className="explore-title">{t('Smart Insights Explore', '智能洞察探索')}</h1>
          <p className="explore-subtitle">
            {t(
              'Discover discussion trends, audiences, semantic topics, and demand signals across archive and live data.',
              '从归档与站内数据中发现讨论趋势、受众、主题和需求线索。',
            )}
          </p>
        </div>

        <div className="explore-header-meta">
          <span className="explore-status-dot">
            <span className={`explore-dot ${cap?.archiveAvailable ? 'explore-dot--ready' : 'explore-dot--muted'}`} />
            <span>
              {cap?.archiveAvailable
                ? t(`Archive ready · ${cap.archiveMonths.length} months`, `归档已就绪 · ${cap.archiveMonths.length} 个月`)
                : cap?.archiveState === 'archive_forbidden'
                  ? t('Archive not authorized', '未开通归档权限')
                  : t('Archive offline', '归档未连接')}
            </span>
          </span>

          <Popover>
            <PopoverTrigger render={<Button type="button" variant="ghost" size="xs" />}>
              <Info size={13} />
              <span>{t('Analytics Engine', '分析引擎')}</span>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 space-y-2 text-xs">
              <div className="font-semibold text-foreground">{t('Runtime Engines', '当前可用分析引擎')}</div>
              <div className="space-y-1.5 text-muted-foreground">
                <div className="flex items-center justify-between">
                  <span>{t('R4 DuckDB Archive', 'R4 DuckDB 归档引擎')}</span>
                  <Badge variant={cap?.archiveAvailable ? 'secondary' : 'outline'} className="text-[10px]">
                    {cap?.archiveAvailable
                      ? t(`${cap.archiveMonths.length} months`, `${cap.archiveMonths.length} 个月在线`)
                      : cap?.archiveState === 'archive_forbidden'
                        ? t('Not authorized', '未授权')
                        : t('Offline', '未连接')}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>{t('Python Potion Worker', 'Python Potion 分析服务')}</span>
                  <Badge variant={cap?.pythonWorkerReady ? 'secondary' : 'outline'} className="text-[10px]">
                    {cap?.pythonWorkerReady
                      ? cap.potionModelReady
                        ? t('Full semantic ready', '完整语义就绪')
                        : t('Rules ready', '规则就绪')
                      : t('Builtin fallback', '内置回退')}
                  </Badge>
                </div>
              </div>
              <p className="m-0 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
                {t(
                  'Offline archives run on DuckDB + Potion; live feeds run on authorized PG16 queries with automatic fallback.',
                  '离线归档直走外置 DuckDB + Potion 引擎；站内数据经 PG16 授权筛选后自动调度最优引擎。',
                )}
              </p>
            </PopoverContent>
          </Popover>
        </div>
      </header>

      {/* Search, Quick Prompts, Input History, Data Scope, Project Picker, Advanced Filters */}
      <ExploreControlPanel
        queryText={queryText}
        onQueryChange={setQueryText}
        sourceMode={resolvedSourceMode}
        onSourceModeChange={setSourceMode}
        projects={projects}
        projectId={effectiveProjectId}
        onProjectIdChange={setProjectId}
        subredditsText={subredditsText}
        onSubredditsChange={setSubredditsText}
        fromDate={fromDate}
        onFromDateChange={setFromDate}
        toDate={toDate}
        onToDateChange={setToDate}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        profile={profile}
        onProfileChange={setProfile}
        includeComments={includeComments}
        onIncludeCommentsChange={setIncludeComments}
        scopeLocked={hasOriginProject && inheritProjectScope}
        sampleLimitText={sampleLimitText}
        onSampleLimitChange={setSampleLimitText}
        onSampleLimitBlur={handleSampleLimitBlur}
        showAdvanced={showAdvanced}
        onToggleAdvanced={() => setShowAdvanced((v) => !v)}
        onResetFilters={resetFilters}
        capabilities={cap}
        isAnalyzing={analyzeMut.isPending}
        onSubmit={(overrideQuery) => runExplore(overrideQuery !== undefined ? { query: overrideQuery } : undefined)}
        history={history}
        activeHistoryId={activeHistoryId}
        onSelectHistory={handleSelectHistory}
        onClearHistory={handleClearHistory}
      />

      {analyzeMut.error && <Alert variant="destructive">{formatExploreError(t, analyzeMut.error)}</Alert>}

      {/* Real-time Stage & Panel Progress Panel while running */}
      {analyzeMut.isPending && activeRun && (
        <ExploreProgressPanel
          runId={activeRun.runId}
          query={activeRun.query}
          sourceLabel={activeRun.sourceLabel}
        />
      )}

      {!result && !analyzeMut.isPending && <ExploreCapabilityPreview />}

      {result && !analyzeMut.isPending && (
        <>
          {/* Data Source & Impact Transparency Banner */}
          <Card className="border-border/80 bg-muted/15 py-3 shadow-xs">
            <CardContent className="space-y-2.5 px-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Database size={14} className="text-primary" />
                  <strong className="text-foreground">{result.sourceProfile.sourceLabel}</strong>
                  <Badge variant="secondary" className="font-mono text-[10.5px]">
                    {result.sourceProfile.engineLabel}
                  </Badge>
                  <Badge variant="outline" className="font-mono text-[10.5px]">
                    {t('Analyzed', '有效去重')} {result.sourceProfile.analyzedDocuments.toLocaleString()} / {result.sourceProfile.rawDocuments.toLocaleString()}
                  </Badge>
                  {result.sourceProfile.timeRange.from && (
                    <span className="text-[11px] text-muted-foreground">
                      {result.sourceProfile.timeRange.from} ~ {result.sourceProfile.timeRange.to} UTC
                    </span>
                  )}
                  <span className="text-[11px] text-muted-foreground">· {result.elapsedMs} ms</span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {onNavigate && (
                    <Button
                      type="button"
                      size="xs"
                      onClick={() => {
                        const sp = new URLSearchParams({
                          from: 'explore',
                          studyId: result.studyId,
                          topic: result.query || originProject?.name || '',
                        });
                        if (hasOriginProject && inheritProjectScope && initialProjectId) {
                          sp.set('projectId', initialProjectId);
                        } else if (resolvedSourceMode === 'project_content' && effectiveProjectId) {
                          sp.set('projectId', effectiveProjectId);
                        }
                        onNavigate(`/reports/new?${sp.toString()}`);
                      }}
                    >
                      <FileText size={12} />
                      <span>{t('Generate Report from Results', '将结果生成报告')}</span>
                    </Button>
                  )}
                  <Collapsible open={showImpactDetails} onOpenChange={setShowImpactDetails}>
                    <CollapsibleTrigger render={<Button type="button" variant="ghost" size="xs" />}>
                      <Info size={12} />
                      <span>{showImpactDetails ? t('Hide source impact', '收起数据源口径说明') : t('Source impact notes', '查看数据源对结果的影响说明')}</span>
                    </CollapsibleTrigger>
                  </Collapsible>
                </div>
              </div>

              {result.sourceProfile.platformBreakdown.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-muted-foreground">{t('Source mix:', '样本来源构成：')}</span>
                  {result.sourceProfile.platformBreakdown.map((pb) => (
                    <Badge key={pb.platform} variant="outline" className="font-mono text-[10.5px]">
                      {pb.platform}: {pb.documents.toLocaleString()} ({pb.sharePct}%)
                    </Badge>
                  ))}
                </div>
              )}

              {showImpactDetails && (
                <ul className="m-0 list-disc space-y-1 border-t border-border/60 pt-2 pl-4 text-[11.5px] leading-relaxed text-muted-foreground">
                  {result.sourceProfile.impactNotes.map((note, idx) => (
                    <li key={idx}>{note}</li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Dynamic Guided Next Steps */}
          {result.guidedNextSteps.length > 0 && (
            <section aria-label={t('Guided next steps', '动态探索引导')} className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Sparkles size={13} className="text-primary" />
                <span>{t('Guided Next Steps (Tailored to This Analysis)', '基于本次分析结果的下一步挖掘引导')}</span>
              </div>
              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
                {result.guidedNextSteps.map((step) => (
                  <Card key={step.id} className="gap-2 py-3.5 shadow-2xs transition hover:border-primary/50">
                    <CardContent className="flex h-full flex-col justify-between gap-2 px-3.5">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-foreground">{step.title}</span>
                          <Badge variant={step.priority === 'high' ? 'default' : 'secondary'} className="shrink-0 text-[10px]">
                            {step.priority === 'high' ? t('Key Signal', '重点信号') : step.priority === 'medium' ? t('Drill-down', '深入挖掘') : t('Compare', '交叉验证')}
                          </Badge>
                        </div>
                        <p className="m-0 text-[11px] leading-relaxed text-muted-foreground">{step.description}</p>
                      </div>
                      <div className="flex justify-end pt-1">
                        <Button type="button" variant="outline" size="xs" onClick={() => handleGuidedAction(step)}>
                          <span>{step.actionLabel}</span>
                          <ArrowRight size={11} />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {/* Scenario Tabs + Adaptive Panel Grid */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2.5" role="tablist" aria-label={t('Business analysis scenarios', '业务分析场景')}>
              {EXPLORE_SCENARIO_LIST.map((sc) => {
                const active = activeScenario === sc.id;
                const readyCount = sc.panels.filter((pid) => {
                  const p = panelMap[pid];
                  return p?.metrics.some((m) => m.state === 'ready' || m.state === 'exploratory');
                }).length;
                return (
                  <Button
                    key={sc.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    variant={active ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setActiveScenario(sc.id)}
                  >
                    <Layers size={13} />
                    <span>{t(sc.titleEn, sc.titleZh)}</span>
                    <Badge variant={active ? 'secondary' : 'outline'} className="font-mono text-[10px]">
                      {readyCount}/{sc.panels.length}
                    </Badge>
                  </Button>
                );
              })}
            </div>

            <AdaptiveLayerLayout
              group={resolvedGroup}
              onSetOverride={setOverride}
              onClearOverride={clearOverride}
              onResetAll={resetLayer}
              renderFullPanel={(evPanel, headerExtras) => {
                const pid = evPanel.id.replace('explore.', '') as ExplorePanelId;
                const panelData = panelMap[pid];
                if (!panelData) return null;
                return (
                  <ExplorePanelCard
                    panel={panelData}
                    query={result.query}
                    sourceProfile={result.sourceProfile}
                    headerExtras={headerExtras}
                    onOpenEvidence={(evidenceId, title) =>
                      setEvidenceState({ studyId: result.studyId, evidenceId, title })
                    }
                    onRefineQuery={pid === 'P04' ? handleRefineWithTerm : undefined}
                  />
                );
              }}
            />
          </div>
        </>
      )}

      {evidenceState && (
        <ExploreEvidenceModal
          studyId={evidenceState.studyId}
          evidenceId={evidenceState.evidenceId}
          title={evidenceState.title}
          onClose={() => setEvidenceState(null)}
        />
      )}
    </section>
  );
}
