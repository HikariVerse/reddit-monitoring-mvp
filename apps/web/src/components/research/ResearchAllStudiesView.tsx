import { useMemo, useState } from 'react';
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Compass,
  Edit3,
  FileText,
  FolderKanban,
  FolderOpen,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  Zap,
} from 'lucide-react';
import { useReportsListQuery, useReportSchedulesQuery } from '../../api/reports';
import type { IntelMonitorDto, Project } from '../../contracts/api';
import { useI18n } from '../../i18n/translations';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';

export type ResearchCategoryKey = 'all' | 'quick_research' | 'manual' | 'tracking' | 'archived';

interface StudyMeta {
  kind: 'quick_research' | 'manual' | 'tracking';
  typeLabel: string;
  materialLabel: string;
  reportCount: number;
  updatedMs: number;
  updatedLabel: string;
  isArchived: boolean;
  sampleCount: number;
}

function formatMonthDay(iso?: string | null, lang: 'zh' | 'en' = 'zh'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  if (lang === 'zh') {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ResearchAllStudiesView({
  projects,
  activeProjectId,
  maxProjects,
  isViewer,
  monitors = [],
  onOpenSummary,
  onOpenAnalysis,
  onEdit,
  onDelete,
  onCreate,
  onNavigate,
}: {
  projects: Project[];
  activeProjectId?: string;
  maxProjects?: number;
  isViewer: boolean;
  monitors?: IntelMonitorDto[];
  onOpenSummary: (project: Project) => void;
  onOpenAnalysis: (project: Project) => void;
  onEdit?: (project: Project) => void;
  onDelete?: (project: Project) => void;
  onCreate: () => void;
  onNavigate: (path: string) => void;
}) {
  const { lang, t } = useI18n();
  const [category, setCategory] = useState<ResearchCategoryKey>('all');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'private' | 'shared' | 'has_reports' | 'has_samples'>('all');
  const [sortBy, setSortBy] = useState<'updated' | 'name' | 'samples' | 'reports'>('updated');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [pageSize, setPageSize] = useState<number>(8);
  const [page, setPage] = useState<number>(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const reportsQuery = useReportsListQuery({ limit: 100 }, true);
  const schedulesQuery = useReportSchedulesQuery(undefined, true);

  const reportStatsByProject = useMemo(() => {
    const countMap = new Map<string, number>();
    const latestMap = new Map<string, string>();
    for (const r of reportsQuery.data?.reports ?? []) {
      if (!r.projectId) continue;
      countMap.set(r.projectId, (countMap.get(r.projectId) ?? 0) + 1);
      const prev = latestMap.get(r.projectId);
      if (!prev || r.createdAt > prev) latestMap.set(r.projectId, r.createdAt);
    }
    return { countMap, latestMap };
  }, [reportsQuery.data?.reports]);

  const scheduleByProject = useMemo(() => {
    const map = new Map<string, { enabled: boolean; cadence: string }>();
    for (const s of schedulesQuery.data?.schedules ?? []) {
      if (s.projectId) map.set(s.projectId, { enabled: s.enabled, cadence: s.cadence });
    }
    return map;
  }, [schedulesQuery.data?.schedules]);

  const enriched = useMemo(() => {
    return projects.map((p) => {
      const linkedMonitor = monitors.find((m) => m.projectId === p.id || p.linked_monitor_id === m.id);
      const linkedSchedule = scheduleByProject.get(p.id);
      const kind: StudyMeta['kind'] =
        p.origin_kind === 'tracking' || Boolean(linkedMonitor) || Boolean(linkedSchedule)
          ? 'tracking'
          : p.origin_kind === 'quick_research'
            ? 'quick_research'
            : 'manual';
      const typeLabel =
        kind === 'tracking'
          ? t('Continuous Tracking', '持续跟踪')
          : kind === 'quick_research'
            ? t('Quick Research', '快速研究')
            : t('Topic Research', '专题研究');

      const sampleCount = p.data_summary?.item_count ?? 0;
      const batchCount = p.enabled_batch_count ?? 0;
      const reportCount = reportStatsByProject.countMap.get(p.id) ?? 0;

      let materialLabel = t('Not counted yet', '资料量未统计');
      if (linkedMonitor) {
        materialLabel = linkedMonitor.enabled
          ? t('Monitor · Active', '持续监测 · 运行中')
          : t('Monitor · Paused', '周期计划 · 已暂停');
      } else if (linkedSchedule) {
        materialLabel = linkedSchedule.enabled
          ? t('Schedule · Active', '周期计划 · 运行中')
          : t('Schedule · Paused', '周期计划 · 已暂停');
      } else if (sampleCount > 0) {
        materialLabel = t(`${sampleCount.toLocaleString()} project items`, `${sampleCount.toLocaleString()} 条项目样本`);
      } else if (batchCount > 0) {
        materialLabel = t(`${batchCount} active batches`, `${batchCount} 个启用批次`);
      } else if (p.source_ids.length > 0) {
        materialLabel = t(`${p.source_ids.length} bound sources`, `${p.source_ids.length} 个绑定来源`);
      }

      const latestIso = p.updated_at || reportStatsByProject.latestMap.get(p.id) || p.created_at || null;
      const updatedMs = latestIso ? Date.parse(latestIso) || 0 : 0;

      const meta: StudyMeta = {
        kind,
        typeLabel,
        materialLabel,
        reportCount,
        updatedMs,
        updatedLabel: formatMonthDay(latestIso, lang),
        isArchived: false,
        sampleCount,
      };
      return { project: p, meta };
    });
  }, [lang, monitors, projects, reportStatsByProject, scheduleByProject, t]);

  const counts = useMemo(() => {
    let quick = 0;
    let topic = 0;
    let tracking = 0;
    let archived = 0;
    for (const item of enriched) {
      if (item.meta.isArchived) {
        archived += 1;
        continue;
      }
      if (item.meta.kind === 'quick_research') quick += 1;
      else if (item.meta.kind === 'tracking') tracking += 1;
      else topic += 1;
    }
    return { total: enriched.length - archived, quick, topic, tracking, archived };
  }, [enriched]);

  const mine = projects.filter((p) => !p.is_shared);
  const atLimit = isViewer && maxProjects !== undefined && mine.length >= maxProjects;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = enriched.filter(({ project: p, meta }) => {
      if (category === 'archived') {
        if (!meta.isArchived) return false;
      } else {
        if (meta.isArchived) return false;
        if (category !== 'all' && meta.kind !== category) return false;
      }
      if (statusFilter === 'private' && p.is_shared) return false;
      if (statusFilter === 'shared' && !p.is_shared) return false;
      if (statusFilter === 'has_reports' && meta.reportCount === 0) return false;
      if (statusFilter === 'has_samples' && meta.sampleCount === 0) return false;
      if (q) {
        const hay = `${p.name} ${p.description ?? ''} ${p.research_goal ?? ''} ${meta.typeLabel}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    list.sort((a, b) => {
      if (sortBy === 'name') return a.project.name.localeCompare(b.project.name, 'zh-CN');
      if (sortBy === 'samples') return b.meta.sampleCount - a.meta.sampleCount || b.meta.updatedMs - a.meta.updatedMs;
      if (sortBy === 'reports') return b.meta.reportCount - a.meta.reportCount || b.meta.updatedMs - a.meta.updatedMs;
      return b.meta.updatedMs - a.meta.updatedMs;
    });
    return list;
  }, [category, enriched, search, sortBy, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const pageItems = filtered.slice(startIdx, startIdx + pageSize);
  const showingFrom = filtered.length === 0 ? 0 : startIdx + 1;
  const showingTo = Math.min(filtered.length, startIdx + pageSize);

  const pageIds = pageItems.map((x) => x.project.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.includes(id));

  const toggleSelectAllPage = (checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...pageIds])));
    } else {
      setSelectedIds((prev) => prev.filter((id) => !pageIds.includes(id)));
    }
  };

  const toggleSelectOne = (id: string, checked: boolean) => {
    setSelectedIds((prev) => (checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)));
  };

  const renderTypeIcon = (kind: StudyMeta['kind']) => {
    if (kind === 'quick_research') return <Zap size={14} />;
    if (kind === 'tracking') return <Activity size={14} />;
    return <FolderOpen size={14} />;
  };

  const renderRowMenu = (p: Project, meta: StudyMeta) => {
    const pid = encodeURIComponent(p.id);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Study actions', '更多操作')}
            />
          }
        >
          <MoreHorizontal size={15} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onOpenSummary(p)}>
            <FolderKanban size={13} />
            <span>{t('Open Study Overview', '打开研究空间')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onOpenAnalysis(p)}>
            <Compass size={13} />
            <span>{t('Analyze & Explore', '开展分析与探索')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onNavigate(`/reports/new?projectId=${pid}`)}>
            <FileText size={13} />
            <span>{t('Generate Report', '生成研究报告')}</span>
          </DropdownMenuItem>
          {meta.reportCount > 0 && (
            <DropdownMenuItem onClick={() => onNavigate(`/projects?view=reports&projectId=${pid}`)}>
              <FileText size={13} />
              <span>{t(`View Reports (${meta.reportCount})`, `查看已生成报告 (${meta.reportCount})`)}</span>
            </DropdownMenuItem>
          )}
          {p.can_edit && (onEdit || onDelete) && (
            <>
              <DropdownMenuSeparator />
              {onEdit && (
                <DropdownMenuItem onClick={() => onEdit(p)}>
                  <Edit3 size={13} />
                  <span>{t('Edit Settings', '编辑研究设置')}</span>
                </DropdownMenuItem>
              )}
              {onDelete && (
                <DropdownMenuItem
                  className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
                  onClick={() => onDelete(p)}
                >
                  <Trash2 size={13} />
                  <span>{t('Delete Study', '删除研究')}</span>
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const pageNumbers = useMemo(() => {
    const maxButtons = 5;
    let start = Math.max(1, safePage - 2);
    const end = Math.min(totalPages, start + maxButtons - 1);
    start = Math.max(1, end - maxButtons + 1);
    const arr: number[] = [];
    for (let i = start; i <= end; i += 1) arr.push(i);
    return arr;
  }, [safePage, totalPages]);

  const kpiCards: Array<{
    key: ResearchCategoryKey;
    label: string;
    value: number;
    caption: string;
    icon: typeof FolderKanban;
  }> = [
    { key: 'all', label: t('All Studies', '全部研究'), value: counts.total, caption: t('Accessible now', '当前可访问'), icon: FolderKanban },
    { key: 'quick_research', label: t('Quick Research', '快速研究'), value: counts.quick, caption: t('One-off studies', '单次研究记录'), icon: Zap },
    { key: 'manual', label: t('Topic Research', '专题研究'), value: counts.topic, caption: t('Ongoing topics', '长期研究课题'), icon: FolderOpen },
    { key: 'tracking', label: t('Continuous Tracking', '持续跟踪'), value: counts.tracking, caption: t('Scheduled tasks', '周期更新任务'), icon: Activity },
  ];

  const tabs: Array<{ key: ResearchCategoryKey; label: string }> = [
    { key: 'all', label: t('All Studies', '全部研究') },
    { key: 'quick_research', label: t('Quick Research', '快速研究') },
    { key: 'manual', label: t('Topic Research', '专题研究') },
    { key: 'tracking', label: t('Continuous Tracking', '持续跟踪') },
    { key: 'archived', label: t('Archived', '已归档') },
  ];

  return (
    <div className="rs-list-root">
      {/* Header Row */}
      <div className="rs-list-head">
        <div>
          <h1 className="rs-list-title">{t('All Studies', '全部研究')}</h1>
          <p className="rs-list-sub">
            {t('Find past research records, manage datasets, and oversee tracking tasks.', '找回研究记录，管理资料与持续跟踪任务。')}
            {isViewer && maxProjects !== undefined && (
              <span className="rs-list-quota">
                {' · '}
                {t(`Private studies: ${mine.length} / ${maxProjects}`, `私有研究额度：${mine.length} / ${maxProjects}`)}
              </span>
            )}
          </p>
        </div>
        <div className="rs-list-actions">
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="rs-head-btn"
            onClick={() => onNavigate('/reports/new')}
          >
            <FileText size={14} />
            <span>{t('Generate Report', '直接生成报告')}</span>
          </Button>
          <Button
            type="button"
            variant="default"
            size="lg"
            className="rs-head-btn rs-head-btn--primary"
            disabled={atLimit}
            onClick={onCreate}
          >
            <Plus size={14} />
            <span>{atLimit ? t('Limit Reached', '已达研究上限') : t('New Study', '新建研究')}</span>
          </Button>
        </div>
      </div>

      {/* 4 KPI Stat Cards */}
      <div className="rs-kpi-grid">
        {kpiCards.map((card) => {
          const Icon = card.icon;
          const active = category === card.key;
          return (
            <button
              key={card.key}
              type="button"
              className={`rs-kpi-card ${active ? 'is-active' : ''}`}
              onClick={() => {
                setCategory(card.key);
                setPage(1);
              }}
            >
              <div className="rs-kpi-icon">
                <Icon size={17} />
              </div>
              <div className="rs-kpi-main">
                <div className="rs-kpi-label">{card.label}</div>
                <div className="rs-kpi-bottom">
                  <strong className="rs-kpi-num tabular-nums">{card.value}</strong>
                  <span className="rs-kpi-cap">{card.caption}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Unified Table / Grid Surface */}
      <Card className="rs-surface">
        {/* Category Underline Tabs */}
        <div className="rs-tabs-bar" role="tablist" aria-label={t('Study categories', '研究分类')}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={category === tab.key}
              className={`rs-tab-btn ${category === tab.key ? 'is-active' : ''}`}
              onClick={() => {
                setCategory(tab.key);
                setPage(1);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Filter & View Toolbar */}
        <div className="rs-toolbar">
          <div className="rs-toolbar-left">
            <div className="rs-search-wrap">
              <Search size={14} className="rs-search-icon" aria-hidden="true" />
              <Input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder={t('Search study name or goal…', '搜索研究名称或目标…')}
                className="rs-search-input"
              />
            </div>

            <Select
              aria-label={t('Filter by status', '按状态筛选')}
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as typeof statusFilter);
                setPage(1);
              }}
            >
              <option value="all">{t('All Statuses', '全部状态')}</option>
              <option value="private">{t('Private Only', '仅个人私有')}</option>
              <option value="shared">{t('Team Shared', '仅团队共享')}</option>
              <option value="has_reports">{t('With Reports', '已生成报告')}</option>
              <option value="has_samples">{t('With Samples', '已有项目样本')}</option>
            </Select>

            <Select
              aria-label={t('Sort studies', '排序方式')}
              value={sortBy}
              onChange={(e) => {
                setSortBy(e.target.value as typeof sortBy);
                setPage(1);
              }}
            >
              <option value="updated">{t('Recently Updated', '最近更新')}</option>
              <option value="name">{t('Name A–Z', '按名称排序')}</option>
              <option value="samples">{t('Most Samples', '按样本量排序')}</option>
              <option value="reports">{t('Most Reports', '按报告数排序')}</option>
            </Select>
          </div>

          <div className="rs-toolbar-right">
            <span className="rs-view-label">{t('View', '视图')}</span>
            <ToggleGroup
              value={[viewMode]}
              onValueChange={(vals) => {
                const next = vals[0];
                if (next === 'list' || next === 'grid') setViewMode(next);
              }}
            >
              <ToggleGroupItem value="list" aria-label={t('List view', '列表视图')}>
                <List size={14} />
              </ToggleGroupItem>
              <ToggleGroupItem value="grid" aria-label={t('Grid view', '卡片视图')}>
                <LayoutGrid size={14} />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        {/* Selection Bar when checked */}
        {selectedIds.length > 0 && (
          <div className="rs-selection-bar">
            <span>{t(`${selectedIds.length} studies selected`, `已选择 ${selectedIds.length} 项研究`)}</span>
            <Button type="button" variant="ghost" size="xs" onClick={() => setSelectedIds([])}>
              {t('Clear selection', '取消选择')}
            </Button>
          </div>
        )}

        {/* Main Content: Clean Table (Default) or Spacious Grid */}
        {pageItems.length === 0 ? (
          <div className="rs-empty">
            <p className="rs-empty-title">
              {category === 'archived'
                ? t('No archived studies yet.', '当前没有已归档的研究记录。')
                : search.trim() || statusFilter !== 'all'
                  ? t('No studies match the current filters.', '没有符合当前筛选条件的研究记录。')
                  : t('No research studies yet.', '还没有研究记录。')}
            </p>
            <p className="rs-empty-sub">
              {t('Start by generating a report directly or creating a new topic study.', '你可以点击右上角「直接生成报告」（系统自动沉淀为研究）或「新建研究」。')}
            </p>
            {(search.trim() || statusFilter !== 'all' || category !== 'all') && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setCategory('all');
                  setSearch('');
                  setStatusFilter('all');
                  setPage(1);
                }}
              >
                {t('Reset Filters', '重置筛选')}
              </Button>
            )}
          </div>
        ) : viewMode === 'list' ? (
          <Table className="rs-table">
            <TableHeader>
              <TableRow className="rs-table-head-row">
                <TableHead className="rs-col-check">
                  <Checkbox
                    checked={allPageSelected}
                    onCheckedChange={(val) => toggleSelectAllPage(Boolean(val))}
                    aria-label={t('Select all on page', '全选当前页')}
                  />
                </TableHead>
                <TableHead>{t('Study Name', '研究名称')}</TableHead>
                <TableHead className="rs-col-type">{t('Type', '研究类型')}</TableHead>
                <TableHead className="rs-col-mat">{t('Materials / Status', '研究资料 / 状态')}</TableHead>
                <TableHead className="rs-col-rep">{t('Reports', '报告')}</TableHead>
                <TableHead className="rs-col-date">{t('Updated', '最近更新')}</TableHead>
                <TableHead className="rs-col-act" aria-label={t('Actions', '操作')} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageItems.map(({ project: p, meta }) => {
                const isSelected = selectedIds.includes(p.id);
                const isCurrent = p.id === activeProjectId;
                return (
                  <TableRow
                    key={p.id}
                    data-state={isSelected ? 'selected' : undefined}
                    className={`rs-table-row ${isCurrent ? 'is-current' : ''}`}
                  >
                    <TableCell className="rs-col-check">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={(val) => toggleSelectOne(p.id, Boolean(val))}
                        aria-label={t(`Select ${p.name}`, `选择 ${p.name}`)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="rs-name-cell">
                        <span className={`rs-row-icon rs-row-icon--${meta.kind}`} aria-hidden="true">
                          {renderTypeIcon(meta.kind)}
                        </span>
                        <button
                          type="button"
                          className="rs-name-link"
                          onClick={() => onOpenSummary(p)}
                        >
                          {p.name}
                        </button>
                        {p.is_shared && (
                          <Badge variant="secondary" className="rs-shared-badge">
                            {t('Shared', '共享')}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="rs-cell-muted">{meta.typeLabel}</TableCell>
                    <TableCell className="rs-cell-muted">{meta.materialLabel}</TableCell>
                    <TableCell>
                      {meta.reportCount > 0 ? (
                        <button
                          type="button"
                          className="rs-report-count-btn"
                          onClick={() => onNavigate(`/projects?view=reports&projectId=${encodeURIComponent(p.id)}`)}
                        >
                          {meta.reportCount} {t('', '份')}
                        </button>
                      ) : (
                        <span className="rs-cell-muted">0 {t('', '份')}</span>
                      )}
                    </TableCell>
                    <TableCell className="rs-cell-muted tabular-nums">{meta.updatedLabel}</TableCell>
                    <TableCell className="rs-col-act">{renderRowMenu(p, meta)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <div className="rs-grid-view">
            {pageItems.map(({ project: p, meta }) => (
              <div
                key={p.id}
                className={`rs-grid-card ${p.id === activeProjectId ? 'is-current' : ''}`}
              >
                <div className="rs-grid-card-top">
                  <div className="rs-name-cell">
                    <span className={`rs-row-icon rs-row-icon--${meta.kind}`} aria-hidden="true">
                      {renderTypeIcon(meta.kind)}
                    </span>
                    <button
                      type="button"
                      className="rs-name-link"
                      onClick={() => onOpenSummary(p)}
                    >
                      {p.name}
                    </button>
                  </div>
                  {renderRowMenu(p, meta)}
                </div>
                <div className="rs-grid-meta">
                  <span>{meta.typeLabel}</span>
                  <span>·</span>
                  <span>{meta.materialLabel}</span>
                </div>
                <div className="rs-grid-foot">
                  <span className="rs-cell-muted">
                    {t('Reports', '报告')} <b>{meta.reportCount}</b> {t('', '份')} · {meta.updatedLabel}
                  </span>
                  <Button type="button" variant="outline" size="xs" onClick={() => onOpenSummary(p)}>
                    {t('Open', '打开研究')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination Footer */}
        <div className="rs-footer">
          <div className="rs-footer-left">
            <span>
              {t(
                `Showing ${showingFrom}–${showingTo} of ${filtered.length} studies`,
                `显示 ${showingFrom}–${showingTo} 项，共 ${filtered.length} 项研究`,
              )}
            </span>
            <Select
              aria-label={t('Items per page', '每页显示数量')}
              value={String(pageSize)}
              onChange={(e) => {
                setPageSize(Number(e.target.value) || 8);
                setPage(1);
              }}
              className="h-7 text-xs"
            >
              <option value="8">{t('8 / page', '每页 8 项')}</option>
              <option value="16">{t('16 / page', '每页 16 项')}</option>
              <option value="32">{t('32 / page', '每页 32 项')}</option>
            </Select>
          </div>

          <div className="rs-pagination">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              aria-label={t('Previous page', '上一页')}
            >
              <ChevronLeft size={14} />
            </Button>
            {pageNumbers.map((num) => (
              <Button
                key={num}
                type="button"
                variant={num === safePage ? 'secondary' : 'ghost'}
                size="icon-sm"
                className={num === safePage ? 'rs-page-btn-active' : undefined}
                onClick={() => setPage(num)}
              >
                {num}
              </Button>
            ))}
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              aria-label={t('Next page', '下一页')}
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
