import {
  Archive,
  Check,
  ChevronUp,
  FolderKanban,
  Globe,
  History,
  Info,
  MessageSquare,
  Newspaper,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type {
  ExploreCapabilitiesResponse,
  ExploreGroupBy,
  ExploreProfile,
  ExploreSourceMode,
} from '../../../../../packages/contracts/src/explore';
import { useI18n } from '@/i18n/translations';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import {
  EXPLORE_QUICK_PROMPTS,
  EXPLORE_SOURCE_OPTIONS,
  type ExploreSourceMeta,
  resolveSourceAvailability,
} from './exploreSources';

function SourceOptionIcon({ kind, active }: { kind: ExploreSourceMeta['icon']; active: boolean }) {
  const cls = `shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`;
  if (kind === 'archive') return <Archive size={14} className={cls} />;
  if (kind === 'live') return <Globe size={14} className={cls} />;
  if (kind === 'info') return <Newspaper size={14} className={cls} />;
  if (kind === 'reddit') return <MessageSquare size={14} className={cls} />;
  if (kind === 'x') return <span className={`shrink-0 font-serif text-[13px] font-bold ${active ? 'text-primary' : 'text-muted-foreground'}`}>𝕏</span>;
  return <FolderKanban size={14} className={cls} />;
}

export interface ExploreHistoryEntry {
  id: string;
  query: string;
  sourceMode: ExploreSourceMode;
  projectId?: string;
  analyzedDocuments: number;
  createdAt: string;
  hasCachedResult: boolean;
}

export interface ExploreControlPanelProps {
  queryText: string;
  onQueryChange: (val: string) => void;
  sourceMode: ExploreSourceMode;
  onSourceModeChange: (mode: ExploreSourceMode) => void;
  projects: readonly { id: string; name: string }[];
  projectId: string;
  onProjectIdChange: (id: string) => void;
  subredditsText: string;
  onSubredditsChange: (val: string) => void;
  fromDate: string;
  onFromDateChange: (val: string) => void;
  toDate: string;
  onToDateChange: (val: string) => void;
  groupBy: ExploreGroupBy;
  onGroupByChange: (val: ExploreGroupBy) => void;
  profile: ExploreProfile;
  onProfileChange: (val: ExploreProfile) => void;
  sampleLimitText: string;
  onSampleLimitChange: (val: string) => void;
  onSampleLimitBlur: () => void;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  onResetFilters: () => void;
  capabilities?: ExploreCapabilitiesResponse;
  isAnalyzing: boolean;
  onSubmit: (overrideQuery?: string) => void;
  history: readonly ExploreHistoryEntry[];
  activeHistoryId: string | null;
  onSelectHistory: (entry: ExploreHistoryEntry) => void;
  onClearHistory: () => void;
}

export function ExploreControlPanel({
  queryText,
  onQueryChange,
  sourceMode,
  onSourceModeChange,
  projects,
  projectId,
  onProjectIdChange,
  subredditsText,
  onSubredditsChange,
  fromDate,
  onFromDateChange,
  toDate,
  onToDateChange,
  groupBy,
  onGroupByChange,
  profile,
  onProfileChange,
  sampleLimitText,
  onSampleLimitChange,
  onSampleLimitBlur,
  showAdvanced,
  onToggleAdvanced,
  onResetFilters,
  capabilities,
  isAnalyzing,
  onSubmit,
  history,
  activeHistoryId,
  onSelectHistory,
  onClearHistory,
}: ExploreControlPanelProps) {
  const { t } = useI18n();

  const currentMeta = EXPLORE_SOURCE_OPTIONS.find((s) => s.mode === sourceMode) ?? EXPLORE_SOURCE_OPTIONS[0];
  const currentAvail = resolveSourceAvailability(sourceMode, capabilities, projects.length, t);
  const currentSourceEmpty = Boolean(capabilities) && !currentAvail.hasData;
  const projectMissing = sourceMode === 'project_content' && !projectId;
  const canSubmit = !isAnalyzing && !currentSourceEmpty && !projectMissing;

  return (
    <>
      <Card className="explore-surface-card gap-0 py-0 shadow-xs">
        <CardContent className="p-0">
          <div className="explore-card-head">
            <h2 className="explore-card-title">{t('Exploration Target', '探索对象')}</h2>
            <p className="explore-card-desc">
              {t(
                'Enter a brand, product, keyword, or topic and choose the data scope for this analysis.',
                '输入品牌、产品、关键词或主题，选择本次分析的数据范围。',
              )}
            </p>
          </div>

          {/* Search Toolbar */}
          <form
            className="explore-search-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) onSubmit();
            }}
          >
            <div className="explore-search-box">
              <Search size={16} className="explore-search-icon" aria-hidden="true" />
              <Input
                type="text"
                value={queryText}
                onChange={(e) => onQueryChange(e.target.value)}
                placeholder={t(
                  'e.g. wireless earbuds, noise cancelling, DuckDB…',
                  '例如：wireless earbuds、noise cancelling、替代品',
                )}
                className="explore-search-input"
              />
              {queryText && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onQueryChange('')}
                  aria-label={t('Clear search', '清空关键词')}
                  className="h-6 w-6 p-0 text-muted-foreground"
                >
                  <X size={14} />
                </Button>
              )}
            </div>

            <Button type="submit" disabled={!canSubmit} className="explore-action-btn explore-action-btn--primary">
              <Sparkles size={14} />
              <span>{isAnalyzing ? t('Analyzing…', '分析中…') : t('Start Explore', '开始探索')}</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              onClick={onToggleAdvanced}
              className={`explore-action-btn explore-action-btn--outline ${showAdvanced ? 'is-active' : ''}`}
            >
              <SlidersHorizontal size={14} />
              <span>{t('Advanced Filters', '高级筛选')}</span>
            </Button>
          </form>

          {/* Quick Prompts + Full Panorama */}
          <div className="explore-prompts-row">
            <div className="explore-prompts-list">
              <span>{t('Try', '试试')}</span>
              {EXPLORE_QUICK_PROMPTS.map((term) => (
                <Button
                  key={term}
                  type="button"
                  variant="outline"
                  size="xs"
                  className="explore-prompt-chip"
                  onClick={() => {
                    onQueryChange(term);
                    if (!currentSourceEmpty && !projectMissing) onSubmit(term);
                  }}
                >
                  {term}
                </Button>
              ))}
            </div>

            <Button
              type="button"
              variant="link"
              size="xs"
              disabled={!canSubmit}
              className="explore-panorama-link"
              onClick={() => {
                onQueryChange('');
                onSubmit('');
              }}
            >
              {t('Analyze full data panorama', '直接分析数据全景')}
            </Button>
          </div>

          {/* Input History Row (Quickly jump back to previous results) */}
          {history.length > 0 && (
            <div className="explore-history-row" aria-label={t('Input history', '输入历史')}>
              <div className="explore-history-list">
                <span className="explore-history-label">
                  <History size={12} />
                  <span>{t('History', '输入历史')}</span>
                </span>
                {history.map((item) => {
                  const meta = EXPLORE_SOURCE_OPTIONS.find((s) => s.mode === item.sourceMode);
                  const isActive = activeHistoryId === item.id;
                  return (
                    <Button
                      key={item.id}
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={isAnalyzing}
                      className={`explore-history-chip ${isActive ? 'is-active' : ''}`}
                      onClick={() => onSelectHistory(item)}
                      title={
                        item.hasCachedResult
                          ? t('Click to restore cached result instantly', '点击立即切回已缓存的分析结果')
                          : t('Click to re-run this exploration', '点击重新运行此探索')
                      }
                    >
                      <span className="truncate">{item.query || t('Panorama', '数据全景')}</span>
                      <span className="explore-history-chip-meta">
                        {meta ? t(meta.shortEn, meta.shortZh) : item.sourceMode} · {item.analyzedDocuments}
                      </span>
                    </Button>
                  );
                })}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onClearHistory}
                className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
              >
                <Trash2 size={11} />
                <span>{t('Clear', '清空')}</span>
              </Button>
            </div>
          )}

          <div className="explore-section-divider" />

          {/* Data Scope Cards */}
          <div className="explore-source-head">
            <div className="explore-source-head-left">
              <span className="explore-source-head-title">{t('Select Data Scope', '选择数据范围')}</span>
              <span className="explore-source-head-hint">
                {t('Single-select · preserves per-source methodology', '单选 · 按来源保留分析口径')}
              </span>
            </div>
            <label
              className="explore-limit-inline"
              title={t(
                'Max sampled documents for detailed panels (25–10,000). Archive SL02 always uses exact full-corpus counts.',
                '单次明细分析样本上限（范围 25 ~ 10,000，超出时按日分层等比抽样；归档全库声量比 SL02 始终按全量精确计算）',
              )}
            >
              <span className="explore-limit-label">{t('Sample limit', '分析样本上限')}</span>
              <Input
                type="number"
                min={25}
                max={10000}
                step={500}
                inputMode="numeric"
                value={sampleLimitText}
                onChange={(e) => onSampleLimitChange(e.target.value)}
                onBlur={onSampleLimitBlur}
                disabled={isAnalyzing}
                aria-label={t('Sample limit (25 to 10000)', '分析样本上限（25 至 10000）')}
                className="explore-limit-input"
              />
              <span className="explore-limit-unit">{t('docs', '篇')}</span>
            </label>
          </div>

          <div className="explore-source-grid">
            {EXPLORE_SOURCE_OPTIONS.map((opt) => {
              const active = sourceMode === opt.mode;
              const avail = resolveSourceAvailability(opt.mode, capabilities, projects.length, t);
              return (
                <button
                  key={opt.mode}
                  type="button"
                  disabled={avail.disabled}
                  onClick={() => onSourceModeChange(opt.mode)}
                  className={`explore-source-card ${active ? 'is-active' : ''}`}
                >
                  {active && (
                    <span className="explore-source-check" aria-hidden="true">
                      <Check size={10} strokeWidth={3} />
                    </span>
                  )}
                  <div>
                    <div className="explore-source-title">
                      <SourceOptionIcon kind={opt.icon} active={active} />
                      <span>{t(opt.titleEn, opt.titleZh)}</span>
                    </div>
                    <div className="explore-source-sub">{t(opt.subEn, opt.subZh)}</div>
                  </div>
                  <div className={`explore-source-count ${avail.hasData ? 'explore-source-count--has' : 'explore-source-count--empty'}`}>
                    <span className={`explore-dot ${avail.hasData ? 'explore-dot--ready' : 'explore-dot--muted'}`} />
                    <span>{avail.label}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Inline Project Sample Selector */}
          {sourceMode === 'project_content' && (
            <div className="explore-project-bar">
              <div className="explore-project-bar-info">
                <FolderKanban size={16} className="mt-0.5 shrink-0 text-primary" />
                <div>
                  <div className="explore-project-bar-title">{t('Research Project', '研究项目')}</div>
                  <div className="explore-project-bar-desc">
                    {t('Scope includes only accessible samples within the selected project.', '分析范围仅包含该项目下可访问的样本。')}
                  </div>
                </div>
              </div>
              <div className="explore-project-bar-control">
                <Select value={projectId} onChange={(e) => onProjectIdChange(e.target.value)}>
                  <option value="">{t('Select a project…', '请选择研究项目…')}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </div>
              <span className={`explore-project-bar-status ${projectId ? 'explore-project-bar-status--ok' : 'explore-project-bar-status--pending'}`}>
                {projectId ? t('Required · Selected', '必选 · 已选择') : t('Required · Select one', '必选 · 待选择')}
              </span>
            </div>
          )}

          {/* Contextual Advanced Filters */}
          {showAdvanced && (
            <div className="explore-advanced-wrap">
              <div className="explore-advanced-head">
                <span className="explore-advanced-title">
                  <SlidersHorizontal size={13} />
                  <span>{t('Advanced Filters', '高级筛选')}</span>
                </span>
                <div className="explore-advanced-actions">
                  <Button type="button" variant="ghost" size="xs" onClick={onResetFilters}>
                    {t('Reset filters', '重置筛选')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={onToggleAdvanced}
                    aria-label={t('Collapse advanced filters', '收起高级筛选')}
                    className="h-6 w-6 p-0"
                  >
                    <ChevronUp size={15} />
                  </Button>
                </div>
              </div>

              <div className="explore-filter-grid">
                <label className="explore-filter-field">
                  <span className="explore-filter-label">{t('Start Date (UTC)', '开始日期 (UTC)')}</span>
                  <Input type="date" value={fromDate} onChange={(e) => onFromDateChange(e.target.value)} />
                </label>
                <label className="explore-filter-field">
                  <span className="explore-filter-label">{t('End Date (UTC)', '结束日期 (UTC)')}</span>
                  <Input type="date" value={toDate} onChange={(e) => onToDateChange(e.target.value)} />
                </label>
                <label className="explore-filter-field">
                  <span className="explore-filter-label">{t('Group By', '分组维度')}</span>
                  <Select value={groupBy} onChange={(e) => onGroupByChange(e.target.value as ExploreGroupBy)}>
                    <option value="group">{t('Default Group', '默认分组')}</option>
                    <option value="source">{t('Platform Source', '平台来源')}</option>
                    <option value="kind">{t('Content Kind', '内容形态')}</option>
                    <option value="language">{t('Language', '语种')}</option>
                  </Select>
                </label>
                <label className="explore-filter-field">
                  <span className="explore-filter-label">{t('Analysis Profile', '分析精度')}</span>
                  <Select value={profile} onChange={(e) => onProfileChange(e.target.value as ExploreProfile)}>
                    <option value="fast">{t('Fast · Recommended', 'Fast · 快速（推荐）')}</option>
                    <option value="balanced">{t('Balanced · Deep Linguistics', 'Balanced · 深度语言学')}</option>
                  </Select>
                </label>
                {currentMeta.supportsSubreddits && (
                  <label className="explore-filter-field explore-filter-field--span2">
                    <span className="explore-filter-label">
                      {t('Communities / Subreddits (optional, comma-separated)', '限定社区 / Subreddit（可选，逗号分隔）')}
                    </span>
                    <Input
                      value={subredditsText}
                      onChange={(e) => onSubredditsChange(e.target.value)}
                      placeholder="LocalLLaMA, programming, duckdb"
                    />
                  </label>
                )}
              </div>

              <p className={`explore-filter-footnote ${currentSourceEmpty ? 'explore-filter-footnote--warn' : ''}`}>
                {currentSourceEmpty
                  ? t(
                      `${currentMeta.shortEn} source shows applicable filters only; no collected records yet.`,
                      `${currentMeta.shortZh} 数据源仅展示适用筛选项；当前没有已采集记录。`,
                    )
                  : sourceMode === 'project_content'
                    ? t('Available filters depend on the fields present in the selected project samples.', '可用筛选项由所选项目样本的数据字段决定。')
                    : t('Filters apply strictly in UTC and preserve source-specific denominators.', '筛选严格按 UTC 口径执行，并保留各数据源独立分母与量纲。')}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Data Availability Warning Alert */}
      {currentSourceEmpty && (
        <Alert className="explore-empty-banner" role="status">
          <Info size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="explore-empty-banner-title">
              {t(`No analyzable records in ${currentMeta.titleEn}`, `当前 ${currentMeta.shortZh} 数据源暂无可分析记录`)}
            </div>
            <p className="explore-empty-banner-desc">
              {t(
                'Collect data first or switch to another data source that already contains records.',
                '采集数据后再开始探索，或切换到已有数据的数据源。',
              )}
            </p>
          </div>
        </Alert>
      )}
    </>
  );
}
