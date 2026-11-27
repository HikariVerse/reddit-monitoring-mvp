import { useState } from 'react';
import { Download, ExternalLink, FileBarChart, Plus, Search, Trash2 } from 'lucide-react';
import {
  reportsApi,
  useDeleteReportMutation,
  useReportsListQuery,
  type ReportTemplateType,
} from '../../api/reports';
import { formatApiError } from '../../api/hooks';

const TEMPLATE_LABELS: Record<ReportTemplateType, string> = {
  industry: '行业情报简报',
  commerce: '电商市场研究',
  social: '社媒舆情洞察',
  custom: '自定义研究报告',
};

const MODE_LABELS: Record<string, string> = {
  llm_verified: 'AI 归纳已校验',
  partial_llm: '部分 AI 归纳',
  pure_data: '纯数据统计版',
};

export function ReportLibraryView({
  projectId,
  onNavigate,
}: {
  projectId?: string;
  onNavigate: (path: string) => void;
}) {
  const [template, setTemplate] = useState<'' | ReportTemplateType>('');
  const [search, setSearch] = useState('');
  const [banner, setBanner] = useState<string | null>(null);

  const listQuery = useReportsListQuery(
    {
      template: template || undefined,
      projectId: projectId || undefined,
      search: search.trim() || undefined,
    },
    true,
  );
  const deleteMut = useDeleteReportMutation();
  const reports = listQuery.data?.reports ?? [];

  const createHref = projectId ? `/reports/new?from=project&projectId=${encodeURIComponent(projectId)}` : '/reports/new';

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="ds-card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>
              {projectId ? '本项目研究报告' : '我的研究报告'}
            </h2>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '3px 0 0' }}>
              每份报告保存生成当时的数据快照与可溯源证据，项目后续更新不会覆盖历史结论。
            </p>
          </div>
          <button type="button" className="ds-btn" onClick={() => onNavigate(createHref)}>
            <Plus size={14} />
            <span>生成报告</span>
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--muted)' }} />
            <input
              type="text"
              className="wb-input"
              style={{ paddingLeft: 30, width: '100%' }}
              placeholder="按报告标题或摘要关键词筛选…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="wb-select"
            style={{ width: 170 }}
            value={template}
            onChange={(e) => setTemplate(e.target.value as '' | ReportTemplateType)}
          >
            <option value="">全部报告类型</option>
            <option value="industry">行业情报简报</option>
            <option value="commerce">电商市场研究</option>
            <option value="social">社媒舆情洞察</option>
            <option value="custom">自定义研究报告</option>
          </select>
        </div>

        {banner && (
          <div className="wb-alert wb-alert--error" style={{ marginBottom: 10 }}>
            {banner}
          </div>
        )}

        {listQuery.isPending ? (
          <div style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>正在加载研究报告…</div>
        ) : listQuery.isError ? (
          <div className="wb-alert wb-alert--error">{formatApiError(listQuery.error)}</div>
        ) : reports.length === 0 ? (
          <div style={{ padding: 28, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            <FileBarChart size={28} style={{ margin: '0 auto 8px', opacity: 0.5 }} />
            <div>{projectId ? '当前项目尚未生成研究报告。' : '尚未保存任何研究报告。'}</div>
            <button type="button" className="ds-btn" style={{ marginTop: 12 }} onClick={() => onNavigate(createHref)}>
              立即创建第一份报告
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {reports.map((rep) => (
              <div
                key={rep.id}
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: '14px 16px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 14,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ flex: 1, minWidth: 260 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                    <b style={{ fontSize: 14.5 }}>{rep.title}</b>
                    <span className="tag" style={{ fontSize: 10.5 }}>{TEMPLATE_LABELS[rep.template]}</span>
                    <span className="tag tag--mint" style={{ fontSize: 10.5 }}>{MODE_LABELS[rep.mode] ?? rep.mode}</span>
                    {rep.scheduleId && <span className="tag tag--lilac" style={{ fontSize: 10.5 }}>周期自动生成</span>}
                  </div>
                  <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 6px', lineHeight: 1.5 }}>
                    {rep.summary ? rep.summary.slice(0, 180) : rep.subtitle}
                  </p>
                  <div style={{ fontSize: 11.5, color: 'var(--faint)' }}>
                    资料来源：{rep.primarySourceLabel || '—'} · 有效样本 {rep.analyzedCount.toLocaleString()} · {rep.sectionCount} 个章节 · {rep.evidenceCount} 条证据 · {rep.createdAt.slice(0, 16).replace('T', ' ')} UTC
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button type="button" className="ds-btn" onClick={() => onNavigate(`/reports/${encodeURIComponent(rep.id)}`)}>
                    打开报告
                  </button>
                  {rep.projectId && !projectId && (
                    <button
                      type="button"
                      className="ds-btn ds-btn--ghost"
                      onClick={() => onNavigate(`/projects?view=summary&projectId=${encodeURIComponent(rep.projectId!)}`)}
                    >
                      <ExternalLink size={12} />
                      <span>继续研究</span>
                    </button>
                  )}
                  <a
                    className="ds-btn ds-btn--ghost"
                    href={reportsApi.exportUrl(rep.id)}
                    download
                    style={{ textDecoration: 'none' }}
                  >
                    <Download size={12} />
                    <span>导出 HTML</span>
                  </a>
                  <button
                    type="button"
                    className="ds-btn ds-btn--quiet"
                    title="删除报告"
                    disabled={deleteMut.isPending}
                    onClick={async () => {
                      if (!window.confirm(`确定删除报告“${rep.title}”？`)) return;
                      setBanner(null);
                      try {
                        await deleteMut.mutateAsync(rep.id);
                      } catch (err) {
                        setBanner(formatApiError(err));
                      }
                    }}
                  >
                    <Trash2 size={13} color="#a8462f" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
