import { useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Bookmark,
  ChevronRight,
  Clock,
  Compass,
  Copy,
  Database,
  Edit3,
  FileText,
  FolderPlus,
  Globe,
  Layers,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  formatApiError,
  useAttachProjectBatchMutation,
  useBatchesQuery,
  useRecentJobsQuery,
} from '../api/hooks';
import {
  useDiscoverReportResourcesMutation,
  useReportRunsQuery,
  useReportsListQuery,
} from '../api/reports';
import type { Actor, IntelMonitorDto, Project } from '../contracts/api';
import { useI18n } from '../i18n/translations';
import { Badge } from './ui/badge';
import { ProjectBatchesView } from './ProjectWorkspaceViews';
import { ReportLibraryView } from './reports/ReportLibraryView';
export { ResearchAllStudiesView as ResearchListView } from './research/ResearchAllStudiesView';

export type ProjectTabKey = 'summary' | 'batches' | 'overview' | 'jobs' | 'reports';

const REPORT_TEMPLATE_ZH: Record<string, string> = {
  industry: '行业情报简报',
  commerce: '电商市场研究',
  social: '社媒舆情洞察',
  custom: '自定义研究报告',
};

function resolveProjectOriginLabel(
  project: Project,
  monitors: IntelMonitorDto[],
  t: (en: string, zh: string) => string,
): { kind: 'quick_research' | 'tracking' | 'manual'; label: string } {
  const hasMonitor = monitors.some((m) => m.projectId === project.id || project.linked_monitor_id === m.id);
  if (project.origin_kind === 'tracking' || hasMonitor) {
    return { kind: 'tracking', label: t('Continuous Tracking', '持续跟踪') };
  }
  if (project.origin_kind === 'quick_research') {
    return { kind: 'quick_research', label: t('Quick Research', '快速研究') };
  }
  return { kind: 'manual', label: t('Topic Research', '专题研究') };
}

export function ProjectContextHeader({
  project,
  activeTab,
  monitors,
  reportCount,
  isAdmin,
  canWrite,
  shareUrl,
  onNavigate,
  onEdit,
  onDelete,
  onForked,
  onBanner,
  forkPublishSlot,
}: {
  project: Project;
  activeTab: ProjectTabKey;
  monitors: IntelMonitorDto[];
  reportCount: number;
  isAdmin: boolean;
  canWrite: boolean;
  shareUrl: string;
  onNavigate: (path: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onForked?: (id: string) => void;
  onBanner: (msg: string | null) => void;
  forkPublishSlot?: React.ReactNode;
}) {
  const { t } = useI18n();
  const [shareOpen, setShareOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const origin = resolveProjectOriginLabel(project, monitors, t);
  const pid = encodeURIComponent(project.id);
  const sampleCount = project.data_summary?.item_count ?? 0;
  const batchCount = project.enabled_batch_count ?? 0;

  const tabs: Array<{ key: ProjectTabKey; label: string; path: string; badge?: number }> = [
    { key: 'summary', label: t('Overview', '概览'), path: `/projects?view=summary&projectId=${pid}` },
    { key: 'batches', label: t('Materials', '研究资料'), path: `/projects?view=batches&projectId=${pid}`, badge: batchCount || undefined },
    { key: 'overview', label: t('Analysis & Explore', '分析与探索'), path: `/projects?view=overview&projectId=${pid}` },
    { key: 'jobs', label: t('Collection & Monitor', '采集与监测'), path: `/projects?view=jobs&projectId=${pid}` },
    { key: 'reports', label: t('Reports', '研究报告'), path: `/projects?view=reports&projectId=${pid}`, badge: reportCount || undefined },
  ];

  void isAdmin;
  void onForked;

  return (
    <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="page-title-row">
            <h1 className="page-title">{project.name}</h1>
            <Badge variant="secondary">{origin.label}</Badge>
            <Badge variant="outline">
              {project.visibility === 'shared' || project.is_shared ? t('Shared', '团队共享') : t('Private', '个人私有')}
            </Badge>
          </div>
          <p className="page-desc">
            {project.research_goal || project.description || t('Research workspace consolidating data materials, deep analysis, tracking, and reports.', '集中管理该主题的研究资料、深度分析、持续追踪与交付报告。')}
            {' · '}
            {project.dataset_mode === 'batch'
              ? t(`${batchCount} active datasets · ${sampleCount.toLocaleString()} items`, `${batchCount} 份启用资料 · ${sampleCount.toLocaleString()} 条样本`)
              : t(`${project.source_ids.length} bound sources`, `${project.source_ids.length} 个绑定来源`)}
          </p>
        </div>

        <div className="page-actions" data-ov-pop>
          <button
            type="button"
            className="ds-btn ds-btn--brand"
            onClick={() => onNavigate(`/reports/new?projectId=${pid}`)}
          >
            <FileText size={13} />
            <span>{t('Generate Report', '生成报告')}</span>
          </button>

          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="ds-btn ds-btn--ghost"
              onClick={() => { setShareCopied(false); setShareOpen((v) => !v); }}
            >
              <Link2 size={13} />
              <span>{t('Share', '分享')}</span>
            </button>
            {shareOpen && (
              <div className="ds-pop" style={{ top: 'calc(100% + 6px)', right: 0, width: 290 }}>
                <div className="pop-hd">
                  <span>{t('Share research link', '分享研究链接')}</span>
                </div>
                <p style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, margin: '0 4px 10px' }}>
                  {t('Recipients open this study using their own workspace permissions.', '接收者将按自身工作台权限打开此研究。')}
                </p>
                <div style={{ display: 'flex', gap: 6, padding: '6px 8px', background: '#fbfcf7', border: '1px solid var(--line)', borderRadius: 5, alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {shareUrl}
                  </span>
                  <button
                    type="button"
                    className="ds-btn"
                    style={{ height: 24, padding: '0 9px', fontSize: 10 }}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(shareUrl);
                        setShareCopied(true);
                      } catch (err) {
                        onBanner(formatApiError(err));
                      }
                    }}
                  >
                    <Copy size={11} />
                    {shareCopied ? t('Copied', '已复制') : t('Copy', '复制')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {forkPublishSlot}

          {canWrite && (
            <>
              <button type="button" className="ds-btn ds-btn--ghost" onClick={onEdit}>
                <Edit3 size={13} />
                <span>{t('Settings', '编辑')}</span>
              </button>
              <button
                type="button"
                className="icon-square"
                onClick={onDelete}
                title={t('Delete Research', '删除研究')}
              >
                <Trash2 size={14} color="#a8462f" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Fixed 5-Tab Project Navigation Bar */}
      <nav
        role="tablist"
        aria-label={t('Research tabs', '研究主区页签')}
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          borderBottom: '1px solid var(--line)',
          paddingBottom: 10,
        }}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`ds-btn ${isActive ? '' : 'ds-btn--ghost'}`}
              style={{
                height: 32,
                padding: '0 14px',
                fontSize: 12.5,
                fontWeight: isActive ? 650 : 500,
              }}
              onClick={() => onNavigate(tab.path)}
            >
              <span>{tab.label}</span>
              {tab.badge !== undefined && (
                <span
                  className="tag"
                  style={{
                    fontSize: 10,
                    padding: '0 5px',
                    minHeight: 16,
                    marginLeft: 2,
                    background: isActive ? 'rgba(255,255,255,0.2)' : undefined,
                    color: isActive ? 'inherit' : undefined,
                  }}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export function ProjectSummaryView({
  project,
  monitors,
  onNavigate,
}: {
  project: Project;
  monitors: IntelMonitorDto[];
  onNavigate: (path: string) => void;
}) {
  const { t } = useI18n();
  const reportsQuery = useReportsListQuery({ projectId: project.id, limit: 5 }, true);
  const projectReports = reportsQuery.data?.reports ?? [];
  const projectMonitors = monitors.filter((m) => m.projectId === project.id || project.linked_monitor_id === m.id);
  const pid = encodeURIComponent(project.id);
  const ds = project.data_summary;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* KPI Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <div className="ds-card" style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('Research Samples', '已纳入样本数')}</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, fontFamily: 'var(--font-mono)' }}>
            {(ds?.item_count ?? 0).toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
            {t(`${project.enabled_batch_count ?? 0} active datasets`, `${project.enabled_batch_count ?? 0} 份启用资料`)}
          </div>
        </div>
        <div className="ds-card" style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('Platforms Covered', '覆盖渠道')}</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
            {ds?.platforms.length ? ds.platforms.map((p) => p.toUpperCase()).join(' / ') : t('None yet', '待补充')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
            {ds?.source_labels.slice(0, 2).join(' · ') || t('Add materials to start', '补充资料后自动统计')}
          </div>
        </div>
        <div className="ds-card" style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('Generated Reports', '已生成报告')}</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, fontFamily: 'var(--font-mono)' }}>
            {projectReports.length}
          </div>
          <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
            {projectReports[0] ? t(`Latest: ${projectReports[0].createdAt.slice(0, 10)}`, `最近：${projectReports[0].createdAt.slice(0, 10)}`) : t('Ready to generate', '可随时生成报告')}
          </div>
        </div>
        <div className="ds-card" style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('Tracking Monitors', '持续跟踪计划')}</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, fontFamily: 'var(--font-mono)' }}>
            {projectMonitors.filter((m) => m.enabled).length}
          </div>
          <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
            {projectMonitors.length > 0 ? t(`${projectMonitors.length} configured`, `共配置 ${projectMonitors.length} 项`) : t('Not scheduled yet', '尚未开启周期跟踪')}
          </div>
        </div>
      </div>

      {/* Quick Action Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <div className="ds-card" style={{ padding: 16, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Compass size={16} color="var(--wb-purple)" />
            <b style={{ fontSize: 13.5 }}>{t('Run Analysis & Explore', '开展分析与探索')}</b>
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
            {t('Inspect content trends, pain points, audiences, or launch deep multi-panel Explore within this study scope.', '查看内容研究面板，或带着当前研究范围进入深度探索。')}
          </p>
          <div>
            <button type="button" className="ds-btn ds-btn--ghost" onClick={() => onNavigate(`/projects?view=overview&projectId=${pid}`)}>
              <span>{t('Start Analysis', '开展分析')}</span>
              <ArrowRight size={12} />
            </button>
          </div>
        </div>

        <div className="ds-card" style={{ padding: 16, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Database size={16} color="var(--wb-teal)" />
            <b style={{ fontSize: 13.5 }}>{t('Add Research Materials', '补充研究资料')}</b>
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
            {t('Auto-discover related archives and shared datasets, collect fresh discussions, or reuse existing batches.', '自动寻找站内已有相关资料、发起新采集，或手动复用已有数据。')}
          </p>
          <div>
            <button type="button" className="ds-btn ds-btn--ghost" onClick={() => onNavigate(`/projects?view=batches&projectId=${pid}&add=1`)}>
              <span>{t('Add Materials', '补充资料')}</span>
              <ArrowRight size={12} />
            </button>
          </div>
        </div>

        <div className="ds-card" style={{ padding: 16, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={16} color="#b45309" />
            <b style={{ fontSize: 13.5 }}>{t('Continuous Tracking & Auto-Reports', '设置持续跟踪与周期报告')}</b>
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
            {t('Schedule recurring monitoring collections and automatic daily or weekly research briefings.', '配置持续采集监测与按日/按周自动生成的周期研究报告。')}
          </p>
          <div>
            <button type="button" className="ds-btn ds-btn--ghost" onClick={() => onNavigate(`/projects?view=jobs&projectId=${pid}`)}>
              <span>{t('Configure Tracking', '设置跟踪')}</span>
              <ArrowRight size={12} />
            </button>
          </div>
        </div>

        <div className="ds-card" style={{ padding: 16, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileText size={16} color="var(--wb-purple)" />
            <b style={{ fontSize: 13.5 }}>{t('Generate Research Report', '生成交付报告')}</b>
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
            {t('Combine verified statistics, interactive charts, and grounded evidence into an exportable report.', '基于当前研究的真实数据与可追溯证据，一键生成可导出研究报告。')}
          </p>
          <div>
            <button type="button" className="ds-btn" onClick={() => onNavigate(`/reports/new?projectId=${pid}`)}>
              <span>{t('Generate Report', '生成报告')}</span>
              <ArrowRight size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* Recent Reports for This Study */}
      <div className="ds-card">
        <div className="ds-card-hd" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="ds-card-title">{t('Recent Reports in This Study', '本研究近期报告')}</div>
            <div className="ds-card-sub">{t('Click any report to view full findings, charts, and traceable evidence.', '点击查看完整分析结论、交互图表与可核查原文证据。')}</div>
          </div>
          <button type="button" className="ds-btn ds-btn--ghost" onClick={() => onNavigate(`/projects?view=reports&projectId=${pid}`)}>
            <span>{t('All Study Reports', '全部报告')}</span>
            <ChevronRight size={13} />
          </button>
        </div>
        <div className="ds-card-bd">
          {projectReports.length === 0 ? (
            <p className="collection-hint">
              {t('No reports generated for this research yet. Click "Generate Report" to create your first deliverable.', '本研究尚未生成正式报告。点击上方「生成报告」即可基于当前资料产出完整报告。')}
            </p>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {projectReports.map((rep) => (
                <div
                  key={rep.id}
                  className="job-row"
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}
                >
                  <div style={{ minWidth: 0 }}>
                    <b style={{ fontSize: 13 }}>{rep.title}</b>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                      {rep.createdAt.slice(0, 16).replace('T', ' ')} UTC · {REPORT_TEMPLATE_ZH[rep.template] ?? rep.template} · {rep.evidenceCount} {t('evidence items', '条证据')}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ds-btn ds-btn--ghost"
                    style={{ height: 28, fontSize: 11.5 }}
                    onClick={() => onNavigate(`/reports/${rep.id}`)}
                  >
                    <span>{t('View Report', '查看报告')}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ProjectMaterialsView({
  project,
  allProjects,
  batchId,
  initialShowAdd,
  onNavigate,
}: {
  project: Project;
  allProjects: Project[];
  batchId?: string;
  initialShowAdd?: boolean;
  onNavigate: (path: string) => void;
}) {
  const { t } = useI18n();
  const [showAddPanel, setShowAddPanel] = useState(Boolean(initialShowAdd));
  const [discoverTopic, setDiscoverTopic] = useState(project.research_goal || project.name);
  const discoverMut = useDiscoverReportResourcesMutation();
  const attachMut = useAttachProjectBatchMutation();
  const [attachMsg, setAttachMsg] = useState<string | null>(null);
  const pid = encodeURIComponent(project.id);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* Unified Add Materials Entry Card */}
      {project.can_edit && (
        <div className="ds-card">
          <div className="ds-card-hd" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div className="ds-card-title">{t('Supplement Research Materials', '补充研究资料')}</div>
              <div className="ds-card-sub">
                {t('Find existing matching resources first, collect fresh live posts when needed, or reuse authorized datasets.', '优先自动寻找站内已有相关资料，按需发起新采集，或手动引入已授权数据。')}
              </div>
            </div>
            <button
              type="button"
              className="ds-btn"
              onClick={() => setShowAddPanel((v) => !v)}
            >
              <Plus size={13} />
              <span>{showAddPanel ? t('Hide Options', '收起补充方式') : t('Add Materials', '补充资料')}</span>
            </button>
          </div>

          {showAddPanel && (
            <div className="ds-card-bd" style={{ display: 'grid', gap: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                <div style={{ padding: 12, borderRadius: 8, border: '1px solid var(--line)', background: '#fbfcf8', display: 'grid', gap: 8, minWidth: 0 }}>
                  <b style={{ fontSize: 12.5 }}>{t('1. Auto-discover related data', '方式一：自动寻找相关资料')}</b>
                  <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>
                    {t('Search authorized batches, projects, and historical Reddit archives at 0 API cost.', '零成本扫描站内已授权批次、持续源与历史 Reddit 归档。')}
                  </p>
                  <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                    <input
                      className="wb-input"
                      style={{ height: 30, fontSize: 12, flex: 1, minWidth: 0 }}
                      value={discoverTopic}
                      onChange={(e) => setDiscoverTopic(e.target.value)}
                      placeholder={t('Enter topic or keywords…', '输入主题或关键词…')}
                    />
                    <button
                      type="button"
                      className="ds-btn"
                      style={{ height: 30, fontSize: 11.5, whiteSpace: 'nowrap', flexShrink: 0 }}
                      disabled={discoverMut.isPending || !discoverTopic.trim()}
                      onClick={() => discoverMut.mutate({ topic: discoverTopic.trim(), projectId: project.id })}
                    >
                      <Search size={12} />
                      <span>{discoverMut.isPending ? t('Scanning…', '扫描中…') : t('Scan', '发现')}</span>
                    </button>
                  </div>
                </div>

                <div style={{ padding: 12, borderRadius: 8, border: '1px solid var(--line)', background: '#fbfcf8', display: 'grid', gap: 8 }}>
                  <b style={{ fontSize: 12.5 }}>{t('2. Collect fresh live data', '方式二：获取最新资料')}</b>
                  <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>
                    {t('Run preflight check, review quota cost, and launch a new collection into this research.', '经过权限与配额预检，拉取最新 Reddit / X 讨论并自动纳入本研究。')}
                  </p>
                  <div>
                    <button
                      type="button"
                      className="ds-btn ds-btn--ghost"
                      style={{ height: 30, fontSize: 11.5 }}
                      onClick={() => onNavigate(`/projects?view=collect&projectId=${pid}`)}
                    >
                      <Database size={12} />
                      <span>{t('Open Collection Intake', '前往获取最新资料')}</span>
                    </button>
                  </div>
                </div>

                <div style={{ padding: 12, borderRadius: 8, border: '1px solid var(--line)', background: '#fbfcf8', display: 'grid', gap: 8 }}>
                  <b style={{ fontSize: 12.5 }}>{t('3. Manually select existing data', '方式三：手动选择已有资料')}</b>
                  <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>
                    {t('Browse shared and private batches in the reusable pool below and attach with one click.', '在下方「可引入数据资源池」中按平台或名称挑选并一键引入。')}
                  </p>
                  <div>
                    <a href="#reusable-batch-pool" className="ds-btn ds-btn--ghost" style={{ height: 30, fontSize: 11.5, textDecoration: 'none' }}>
                      <Layers size={12} />
                      <span>{t('Jump to Reusable Pool', '定位到下方资源池')}</span>
                    </a>
                  </div>
                </div>
              </div>

              {attachMsg && <div className="wb-alert wb-alert--success">{attachMsg}</div>}
              {discoverMut.isError && <div className="wb-alert wb-alert--error">{formatApiError(discoverMut.error)}</div>}

              {discoverMut.data && (
                <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, display: 'grid', gap: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 650 }}>
                    {t('Discovery Results', '自动发现结果')} · {discoverMut.data.recommendation.rationale}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11.5 }}>
                    <span className="tag tag--lilac">
                      {t('Stored matches', '站内已存匹配')}: {discoverMut.data.pgChannel.matchedContentCount}
                    </span>
                    <span className="tag tag--mint">
                      {t('Historical Reddit archive', '历史 Reddit 归档')}:{' '}
                      {discoverMut.data.archiveChannel.available
                        ? `${discoverMut.data.archiveChannel.matchedThreads.toLocaleString()} ${t('threads', '主题')} / ${discoverMut.data.archiveChannel.associatedComments.toLocaleString()} ${t('comments', '评论')}`
                        : t('Not authorized or offline', '未授权或未连接')}
                    </span>
                  </div>
                  {discoverMut.data.pgChannel.batches.length > 0 && (
                    <div style={{ display: 'grid', gap: 6 }}>
                      {discoverMut.data.pgChannel.batches.slice(0, 5).map((b) => (
                        <div key={b.batchId} className="job-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <div style={{ fontSize: 12 }}>
                            <b>{b.label}</b>{' '}
                            <span style={{ color: 'var(--muted)' }}>
                              [{b.platform.toUpperCase()}] · {t('Matched', '命中')} {b.matchedCount} / {b.batchTotal}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="ds-btn"
                            style={{ height: 26, fontSize: 11 }}
                            disabled={attachMut.isPending}
                            onClick={async () => {
                              setAttachMsg(null);
                              try {
                                await attachMut.mutateAsync({ projectId: project.id, batchId: b.batchId });
                                setAttachMsg(t(`Attached "${b.label}" to this study.`, `已将「${b.label}」纳入当前研究。`));
                              } catch (err) {
                                setAttachMsg(formatApiError(err));
                              }
                            }}
                          >
                            <FolderPlus size={11} />
                            <span>{t('Attach', '纳入研究')}</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div id="reusable-batch-pool">
        <ProjectBatchesView project={project} batchId={batchId} allProjects={allProjects} onNavigate={onNavigate} />
      </div>
    </div>
  );
}

export function ProjectAnalysisHubHeader({
  project,
  onNavigate,
  onDrilldown,
}: {
  project: Project;
  onNavigate: (path: string) => void;
  onDrilldown: (projectId: string) => void;
}) {
  const { t } = useI18n();
  const pid = encodeURIComponent(project.id);
  const returnTo = encodeURIComponent(`/projects?view=overview&projectId=${project.id}`);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12, marginBottom: 16 }}>
      <div className="ds-card" style={{ padding: 14, borderColor: 'var(--wb-purple)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <b style={{ fontSize: 13 }}>{t('Content Research (L1 / L2 / L3)', '内容研究（当前视图）')}</b>
          <span className="tag tag--lilac" style={{ fontSize: 10 }}>{t('Active', '当前展开')}</span>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.45 }}>
          {t('Structured KPI overview, pain-point clustering, community breakdown, and representative threads.', '查看本研究的概览趋势、痛点与主题拆解、高互动代表样本。')}
        </p>
      </div>

      <div className="ds-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <b style={{ fontSize: 13 }}>{t('Smart Insights Explore (P01–P12)', '智能洞察探索（12 面板深挖）')}</b>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.45 }}>
            {t('Open unified Explore with this research scope locked; return anytime without losing context.', '携带当前研究范围进入探索，分析价格、受众、情绪与需求，随时一键返回。')}
          </p>
        </div>
        <div>
          <button
            type="button"
            className="ds-btn"
            style={{ height: 28, fontSize: 11.5 }}
            onClick={() => onNavigate(`/explore?projectId=${pid}&returnTo=${returnTo}`)}
          >
            <Sparkles size={12} />
            <span>{t('Explore in This Scope', '带着本研究范围去探索')}</span>
          </button>
        </div>
      </div>

      <div className="ds-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <b style={{ fontSize: 13 }}>{t('Original Content & Discussion Tree', '原文检索与讨论树')}</b>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.45 }}>
            {t('Filter raw posts and comments, verify citations, and bookmark key evidence into your workspace.', '按关键词、平台与信号筛查原始帖文与评论树，收藏关键证据。')}
          </p>
        </div>
        <div>
          <button
            type="button"
            className="ds-btn ds-btn--ghost"
            style={{ height: 28, fontSize: 11.5 }}
            onClick={() => onDrilldown(project.id)}
          >
            <Search size={12} />
            <span>{t('Search Original Posts', '查看原文与讨论树')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function AvailableResourcesView({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { t } = useI18n();
  const [topic, setTopic] = useState('');
  const [poolFilter, setPoolFilter] = useState('');
  const discoverMut = useDiscoverReportResourcesMutation();
  const batchesQuery = useBatchesQuery({ limit: 100 }, true);

  const batches = useMemo(() => {
    const q = poolFilter.trim().toLowerCase();
    return (batchesQuery.data?.batches ?? []).filter(
      (b) => !q || `${b.label} ${b.sourceLabel} ${b.platform}`.toLowerCase().includes(q),
    );
  }, [batchesQuery.data?.batches, poolFilter]);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="ds-card">
        <div className="ds-card-hd">
          <div className="ds-card-title">{t('Discover Available Materials', '可用资料总览与发现')}</div>
          <div className="ds-card-sub">
            {t('Check what authorized discussions, archives, and curated news already exist before starting a new collection.', '输入任意研究主题，立即盘点站内已有样本、授权共享批次、历史 Reddit 归档与行业资讯覆盖情况。')}
          </div>
        </div>
        <div className="ds-card-bd" style={{ display: 'grid', gap: 12 }}>
          <form
            style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
            onSubmit={(e) => {
              e.preventDefault();
              if (topic.trim()) discoverMut.mutate({ topic: topic.trim() });
            }}
          >
            <input
              className="wb-input"
              style={{ flex: 1, minWidth: 260 }}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={t('e.g. open ear headphones, portable power station, coding agent…', '例如：开放式耳机、便携式电源、AI 编程工具…')}
            />
            <button type="submit" className="ds-btn" disabled={discoverMut.isPending || !topic.trim()}>
              <Search size={13} />
              <span>{discoverMut.isPending ? t('Scanning…', '正在扫描…') : t('Discover Resources', '扫描可用资料')}</span>
            </button>
          </form>

          {discoverMut.isError && <div className="wb-alert wb-alert--error">{formatApiError(discoverMut.error)}</div>}

          {discoverMut.data && (
            <div style={{ display: 'grid', gap: 10, padding: 12, borderRadius: 8, background: '#fbfcf8', border: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <b style={{ fontSize: 13 }}>{discoverMut.data.recommendation.rationale}</b>
                <button
                  type="button"
                  className="ds-btn ds-btn--brand"
                  style={{ height: 28, fontSize: 11.5 }}
                  onClick={() => onNavigate(`/reports/new?topic=${encodeURIComponent(topic.trim())}`)}
                >
                  <FileText size={12} />
                  <span>{t('Generate Report with These Materials', '使用发现资料生成报告')}</span>
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, fontSize: 12 }}>
                <div className="ds-card" style={{ padding: 10 }}>
                  <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t('Stored Social Samples', '站内已存社媒样本')}</div>
                  <b style={{ fontSize: 16 }}>{discoverMut.data.pgChannel.matchedContentCount.toLocaleString()}</b>
                  <div style={{ fontSize: 10.5, color: 'var(--faint)' }}>{discoverMut.data.pgChannel.batches.length} {t('matching datasets', '个命中批次')}</div>
                </div>
                <div className="ds-card" style={{ padding: 10 }}>
                  <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t('Historical Reddit Archive', '历史 Reddit 归档')}</div>
                  <b style={{ fontSize: 16 }}>
                    {discoverMut.data.archiveChannel.available ? discoverMut.data.archiveChannel.matchedThreads.toLocaleString() : t('Locked', '未授权')}
                  </b>
                  <div style={{ fontSize: 10.5, color: 'var(--faint)' }}>
                    {discoverMut.data.archiveChannel.available
                      ? `${discoverMut.data.archiveChannel.associatedComments.toLocaleString()} ${t('comments', '条评论')}`
                      : t('Requires archive permission', '需要归档访问权限')}
                  </div>
                </div>
                <div className="ds-card" style={{ padding: 10 }}>
                  <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t('Industry Stories', '行业资讯流')}</div>
                  <b style={{ fontSize: 16 }}>{discoverMut.data.storiesChannel.eventCount.toLocaleString()}</b>
                  <div style={{ fontSize: 10.5, color: 'var(--faint)' }}>{discoverMut.data.storiesChannel.independentSourceCount} {t('active sources', '个活跃媒体源')}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="ds-card">
        <div className="ds-card-hd" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div className="ds-card-title">{t('Authorized Reusable Datasets', '当前账号可复用数据批次')} ({batches.length})</div>
            <div className="ds-card-sub">{t('Datasets you can directly attach to any research study or use in report generation.', '以下资料批次已授权给当前账号，可直接复用于任意研究与报告。')}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="search"
              className="wb-input"
              style={{ width: 210, height: 30, fontSize: 12 }}
              value={poolFilter}
              onChange={(e) => setPoolFilter(e.target.value)}
              placeholder={t('Filter datasets…', '筛选批次名称或平台…')}
            />
            <button type="button" className="ds-btn ds-btn--ghost" onClick={() => void batchesQuery.refetch()}>
              <RefreshCw size={13} />
              <span>{t('Refresh', '刷新')}</span>
            </button>
          </div>
        </div>
        <div className="ds-card-bd">
          {batchesQuery.isPending ? (
            <p className="collection-hint">{t('Loading authorized datasets…', '正在加载可用资料…')}</p>
          ) : batches.length === 0 ? (
            <p className="collection-hint">{t('No reusable datasets found yet.', '暂无可复用的数据批次。')}</p>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {batches.map((b) => (
                <div key={b.id} className="job-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <div>
                    <b style={{ fontSize: 12.5 }}>{b.label}</b>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      [{b.platform.toUpperCase()}] {b.sourceLabel} · {b.itemCount.toLocaleString()} {t('items', '条样本')} · {b.createdAt.slice(0, 16).replace('T', ' ')} UTC
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span className={`tag ${b.visibility === 'shared' ? 'tag--mint' : ''}`} style={{ fontSize: 10 }}>
                      {b.visibility === 'shared' ? t('Shared', '共享') : t('Private', '私有')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ResearchTasksView({ actor, onNavigate }: { actor: Actor; onNavigate: (path: string) => void }) {
  const { t } = useI18n();
  const runsQuery = useReportRunsQuery({ limit: 30 }, true);
  const jobsQuery = useRecentJobsQuery({ limit: 30 }, true);
  const runs = runsQuery.data?.runs ?? [];
  const jobs = jobsQuery.data?.jobs ?? [];
  void actor;

  const runStatusLabel: Record<string, string> = {
    preparing: t('Preparing', '准备中'),
    collecting: t('Collecting', '补采中'),
    analyzing: t('Analyzing', '分析计算中'),
    writing: t('Synthesizing', '撰写报告中'),
    ready: t('Completed', '已完成'),
    needs_action: t('Needs Action', '待处理'),
    failed: t('Failed', '未完成'),
    cancelled: t('Cancelled', '已取消'),
    cancel_requested: t('Cancelling', '取消中'),
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* Report Generation Runs */}
      <div className="ds-card">
        <div className="ds-card-hd" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div>
            <div className="ds-card-title">{t('Report Generation Tasks', '报告生成任务记录')} ({runs.length})</div>
            <div className="ds-card-sub">{t('Track progress, view completed deliverables, or resume failed runs.', '追踪所有报告任务的实时阶段、查看交付结果或对异常任务发起重试。')}</div>
          </div>
          <button type="button" className="ds-btn ds-btn--ghost" onClick={() => void runsQuery.refetch()}>
            <RefreshCw size={13} />
            <span>{t('Refresh', '刷新')}</span>
          </button>
        </div>
        <div className="ds-card-bd">
          {runsQuery.isPending ? (
            <p className="collection-hint">{t('Loading report tasks…', '正在加载报告任务…')}</p>
          ) : runs.length === 0 ? (
            <p className="collection-hint">{t('No report generation tasks yet.', '尚未发起过报告生成任务。')}</p>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {runs.map((run) => {
                const stIdx = typeof run.stepProgress.stageIndex === 'number' ? run.stepProgress.stageIndex : 0;
                const stTot = typeof run.stepProgress.totalStages === 'number' && run.stepProgress.totalStages > 0 ? run.stepProgress.totalStages : 4;
                const pct = run.state === 'ready' ? 100 : Math.min(99, Math.round((stIdx / stTot) * 100));
                return (
                  <div key={run.id} className="job-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <b style={{ fontSize: 12.5 }}>{run.title}</b>
                        <span className="tag" style={{ fontSize: 10 }}>{REPORT_TEMPLATE_ZH[run.template] ?? run.template}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                        <Clock size={10} style={{ display: 'inline', marginRight: 4 }} />
                        {run.createdAt.slice(0, 16).replace('T', ' ')} UTC · {run.stageLabel} ({pct}%)
                      </div>
                    </div>
                    <Badge className={`chip-state ${run.state === 'ready' ? 'active' : run.state === 'failed' || run.state === 'needs_action' ? 'archived' : 'paused'}`}>
                      {runStatusLabel[run.state] ?? run.state}
                    </Badge>
                    {run.reportId ? (
                      <button
                        type="button"
                        className="ds-btn"
                        style={{ height: 26, fontSize: 11 }}
                        onClick={() => onNavigate(`/reports/${run.reportId}`)}
                      >
                        <span>{t('View Report', '查看报告')}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="ds-btn ds-btn--ghost"
                        style={{ height: 26, fontSize: 11 }}
                        onClick={() => onNavigate(`/reports/runs/${run.id}`)}
                      >
                        <span>{t('View Progress', '查看进度')}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Personal Collection Jobs */}
      <div className="ds-card">
        <div className="ds-card-hd" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div>
            <div className="ds-card-title">{t('Collection Tasks', '数据采集任务记录')} ({jobs.length})</div>
            <div className="ds-card-sub">{t('Recent one-off and scheduled data collection runs visible to your account.', '当前账号可见的单次采集与定时监测任务记录。')}</div>
          </div>
          <button type="button" className="ds-btn ds-btn--ghost" onClick={() => void jobsQuery.refetch()}>
            <RefreshCw size={13} />
            <span>{t('Refresh', '刷新')}</span>
          </button>
        </div>
        <div className="ds-card-bd">
          {jobsQuery.isPending ? (
            <p className="collection-hint">{t('Loading collection tasks…', '正在加载采集任务…')}</p>
          ) : jobs.length === 0 ? (
            <p className="collection-hint">{t('No collection tasks recorded yet.', '暂无数据采集任务记录。')}</p>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {jobs.map((job) => (
                <div key={job.id} className="job-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <b style={{ fontSize: 12 }}>[{job.platform.toUpperCase()}] {job.sourceLabel}</b>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {job.createdAt.slice(0, 16).replace('T', ' ')} UTC · {t('Processed / Added', '处理 / 新增')}: {job.recordsProcessed} / +{job.recordsInserted}
                    </div>
                  </div>
                  <Badge className={`chip-state ${job.status === 'succeeded' ? 'active' : job.status === 'running' ? 'paused' : 'archived'}`}>
                    {job.status === 'succeeded'
                      ? t('Succeeded', '已完成')
                      : job.status === 'running'
                        ? t('Running', '采集中')
                        : job.status === 'failed'
                          ? t('Failed', '未完成')
                          : t('Queued', '排队中')}
                  </Badge>
                  {job.projectId && (
                    <button
                      type="button"
                      className="ds-btn ds-btn--ghost"
                      style={{ height: 26, fontSize: 11 }}
                      onClick={() => onNavigate(`/projects?view=batches&projectId=${encodeURIComponent(job.projectId!)}`)}
                    >
                      <span>{t('Open Study', '打开研究')}</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ProjectReportsTabView({ project, onNavigate }: { project: Project; onNavigate: (path: string) => void }) {
  return <ReportLibraryView projectId={project.id} onNavigate={onNavigate} />;
}

void Bookmark;
void Globe;
