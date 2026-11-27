import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Download,
  ExternalLink,
  FolderKanban,
  Printer,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import {
  reportsApi,
  useReportDetailQuery,
  useReportRunActionMutation,
  type ReportEvidenceItem,
} from '../../api/reports';
import { formatApiError } from '../../api/hooks';
import { safeHttpUrl } from '../../lib/sourceLabels';
import { ReportChartRenderer } from './ReportChartRenderer';

const KIND_LABELS: Record<string, { label: string; color: string }> = {
  observation: { label: '观察事实', color: '#0f766e' },
  interpretation: { label: '分析解读', color: '#2563eb' },
  hypothesis: { label: '待验证假设', color: '#d97706' },
  recommendation: { label: '业务建议', color: '#7c3aed' },
};

const TEMPLATE_LABELS: Record<string, string> = {
  industry: '行业情报简报',
  commerce: '电商市场研究',
  social: '社媒舆情洞察',
  custom: '自定义研究报告',
};

export function ReportDetailView({
  reportId,
  onNavigate,
}: {
  reportId: string;
  onNavigate: (path: string) => void;
}) {
  const detailQuery = useReportDetailQuery(reportId);
  const runActionMut = useReportRunActionMutation();
  const [drawerState, setDrawerState] = useState<{ title: string; items: ReportEvidenceItem[] } | null>(null);
  const [regenNotice, setRegenNotice] = useState<string | null>(null);

  const report = detailQuery.data?.report;
  const evidenceMap = useMemo(
    () => new Map((report?.evidence ?? []).map((e) => [e.id, e])),
    [report?.evidence],
  );

  const openEvidence = (ids: string[], title: string) => {
    const items = ids.map((id) => evidenceMap.get(id)).filter((x): x is ReportEvidenceItem => Boolean(x));
    setDrawerState({ title, items: items.length ? items : (report?.evidence ?? []).slice(0, 10) });
  };

  if (detailQuery.isPending) {
    return (
      <div className="ds-page">
        <div className="ds-card" style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>
          正在加载研究报告快照…
        </div>
      </div>
    );
  }

  if (detailQuery.isError || !report) {
    return (
      <div className="ds-page">
        <div className="ds-card" style={{ padding: 24, display: 'grid', gap: 12 }}>
          <div className="wb-alert wb-alert--error">
            {detailQuery.isError ? formatApiError(detailQuery.error) : '无法打开该报告（可能已被删除或数据源访问权限已变更）。'}
          </div>
          <div>
            <button type="button" className="ds-btn ds-btn--ghost" onClick={() => onNavigate('/reports?view=list')}>
              返回我的报告
            </button>
          </div>
        </div>
      </div>
    );
  }

  const provenance = report.provenance as {
    model?: string | null;
    usage?: { totalTokens?: number; callCount?: number; requestIds?: string[] };
  };

  return (
    <div className="ds-page" style={{ display: 'grid', gap: 16 }}>
      {/* Top Action Bar */}
      <div
        className="ds-card"
        style={{
          padding: '12px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" className="ds-btn ds-btn--ghost" onClick={() => onNavigate('/reports?view=list')}>
            <ArrowLeft size={13} />
            <span>返回我的报告</span>
          </button>
          <span className="tag">{TEMPLATE_LABELS[report.template] ?? report.template}</span>
          <span className="tag tag--mint">
            {report.mode === 'llm_verified' ? 'AI 归纳已校验' : report.mode === 'partial_llm' ? '部分章节已归纳' : '纯数据统计版'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {report.projectId && (
            <button
              type="button"
              className="ds-btn ds-btn--ghost"
              onClick={() => onNavigate(`/projects?view=summary&projectId=${encodeURIComponent(report.projectId!)}`)}
            >
              <FolderKanban size={13} />
              <span>继续研究</span>
            </button>
          )}
          {report.scopes[0]?.studyId && (
            <button
              type="button"
              className="ds-btn ds-btn--ghost"
              onClick={() =>
                onNavigate(
                  `/explore?studyId=${encodeURIComponent(report.scopes[0].studyId!)}${report.projectId ? `&projectId=${encodeURIComponent(report.projectId)}` : ''}`,
                )
              }
            >
              <Search size={13} />
              <span>回到探索结果</span>
            </button>
          )}
          <button type="button" className="ds-btn ds-btn--ghost" onClick={() => window.print()}>
            <Printer size={13} />
            <span>打印</span>
          </button>
          <a className="ds-btn" href={reportsApi.exportUrl(report.id)} download style={{ textDecoration: 'none' }}>
            <Download size={13} />
            <span>导出离线 HTML</span>
          </a>
        </div>
      </div>

      {regenNotice && <div className="wb-alert wb-alert--success">{regenNotice}</div>}

      {/* Main Layout: Sticky TOC + Research Document */}
      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 18, alignItems: 'start' }}>
        <aside className="ds-card" style={{ padding: 14, position: 'sticky', top: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 8 }}>
            报告目录 · CONTENTS
          </div>
          <nav style={{ display: 'grid', gap: 4 }}>
            {report.sections.map((sec, idx) => (
              <a
                key={sec.id}
                href={`#report-sec-${sec.id}`}
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 6,
                  fontSize: 12.5,
                  color: 'var(--ink)',
                  textDecoration: 'none',
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--wb-purple-deep)', fontWeight: 700 }}>
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sec.title}</span>
              </a>
            ))}
          </nav>
          <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 10, fontSize: 11.5, color: 'var(--muted)' }}>
            <div>生成时间：{report.createdAt.slice(0, 16).replace('T', ' ')} UTC</div>
            <div>保存证据：{report.evidence.length} 条</div>
            <button
              type="button"
              className="ds-btn ds-btn--quiet"
              style={{ marginTop: 6, padding: '4px 0', fontSize: 12 }}
              onClick={() => setDrawerState({ title: '本报告全部代表性原文证据', items: report.evidence })}
            >
              查看全部证据清单 →
            </button>
          </div>
        </aside>

        <article className="ds-card" style={{ padding: '28px 32px', display: 'grid', gap: 24 }}>
          {/* Report Cover Header */}
          <header style={{ borderBottom: '2px solid var(--wb-purple-deep)', paddingBottom: 16 }}>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700, margin: '0 0 8px' }}>
              {report.title}
            </h1>
            <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: 0 }}>{report.subtitle}</p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10, fontSize: 12, color: 'var(--faint)' }}>
              <span>版本 v{report.reportVersion}</span>
              <span>· 历史报告快照（项目后续变动不影响本报告内容）</span>
            </div>
          </header>

          {/* Sections */}
          {report.sections.map((sec, idx) => (
            <section
              key={sec.id}
              id={`report-sec-${sec.id}`}
              style={{ borderBottom: '1px solid var(--line)', paddingBottom: 22, display: 'grid', gap: 10 }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--wb-purple-deep)' }}>
                    CHAPTER {String(idx + 1).padStart(2, '0')}
                  </div>
                  <h2 style={{ fontSize: 18, fontWeight: 700, margin: '3px 0 0' }}>
                    {sec.narrative?.heading || sec.title}
                  </h2>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {sec.evidenceIds.length > 0 && (
                    <button
                      type="button"
                      className="ds-btn ds-btn--ghost"
                      style={{ fontSize: 11.5 }}
                      onClick={() => openEvidence(sec.evidenceIds, `${sec.title} · 关联原文证据`)}
                    >
                      查看本节证据 ({sec.evidenceIds.length})
                    </button>
                  )}
                  {report.runId && !sec.pinned && (
                    <button
                      type="button"
                      className="ds-btn ds-btn--quiet"
                      style={{ fontSize: 11.5 }}
                      disabled={runActionMut.isPending}
                      onClick={async () => {
                        setRegenNotice(null);
                        await runActionMut.mutateAsync({
                          id: report.runId!,
                          body: { action: 'regenerate_section', sectionId: sec.id },
                        });
                        setRegenNotice(`已触发重新整理“${sec.title}”，完成后将自动更新报告版本。`);
                        onNavigate(`/reports/runs/${encodeURIComponent(report.runId!)}`);
                      }}
                    >
                      <RefreshCw size={11} />
                      <span>重整理本节</span>
                    </button>
                  )}
                </div>
              </div>

              <p style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--ink)', margin: 0 }}>
                {sec.narrative?.summary || sec.stateMessage}
              </p>

              {/* KPI Metrics */}
              {sec.metrics.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                  {sec.metrics.map((m) => (
                    <div key={m.id} style={{ padding: '10px 12px', background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 8 }}>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{m.label}</div>
                      <div style={{ fontSize: 19, fontWeight: 700, marginTop: 2 }}>
                        {m.formatted}
                        {m.unit && <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--muted)', marginLeft: 4 }}>{m.unit}</span>}
                      </div>
                      {m.denominator && <div style={{ fontSize: 10.5, color: 'var(--faint)', marginTop: 2 }}>口径：{m.denominator}</div>}
                    </div>
                  ))}
                </div>
              )}

              {/* Charts */}
              {sec.charts.map((ch) => (
                <ReportChartRenderer key={ch.id} chart={ch} onSelectEvidence={openEvidence} />
              ))}

              {/* Verified Findings */}
              {sec.narrative?.findings && sec.narrative.findings.length > 0 && (
                <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
                  {sec.narrative.findings.map((f, fi) => {
                    const meta = KIND_LABELS[f.kind] ?? { label: f.kind, color: '#475569' };
                    return (
                      <div
                        key={fi}
                        style={{
                          padding: '10px 14px',
                          border: '1px solid var(--line)',
                          borderLeft: `3.5px solid ${meta.color}`,
                          borderRadius: 8,
                          background: '#fcfefd',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span className="tag" style={{ fontSize: 10.5 }}>{meta.label}</span>
                          <strong style={{ fontSize: 13.5 }}>{f.title}</strong>
                        </div>
                        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6 }}>{f.text}</p>
                        {f.evidenceIds.length > 0 && (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
                            <span style={{ fontSize: 11, color: 'var(--muted)' }}>支持证据：</span>
                            {f.evidenceIds.map((eid) => (
                              <button
                                key={eid}
                                type="button"
                                className="tag tag--mint"
                                style={{ cursor: 'pointer', fontSize: 10.5, fontFamily: 'var(--font-mono)' }}
                                onClick={() => openEvidence(f.evidenceIds, f.title)}
                              >
                                {eid}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Limitations */}
              {(sec.warnings.length > 0 || (sec.narrative?.limitations?.length ?? 0) > 0) && (
                <div style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', padding: '8px 12px', borderRadius: 6 }}>
                  <b>口径与局限：</b>
                  {[...(sec.narrative?.limitations ?? []), ...sec.warnings].slice(0, 4).join('；')}
                </div>
              )}
            </section>
          ))}

          {/* Collapsible Methodology & Technical Diagnostics */}
          <details style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '10px 14px', background: '#f8fafc' }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>
              展开研究方法与技术诊断（引擎、数据版本与模型记录）
            </summary>
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 6 }}>
              <div>报告编号：{report.id} · 模式：{report.mode} · 模型：{provenance.model ?? '纯数据统计'}</div>
              {provenance.usage && (
                <div>
                  模型调用：{provenance.usage.callCount ?? 0} 次 · 总 Token：{Number(provenance.usage.totalTokens ?? 0).toLocaleString()}
                </div>
              )}
              {report.scopes.map((sc) => (
                <div key={sc.id}>
                  范围 {sc.id}：{sc.sourceLabel} · 引擎 {sc.engineLabel} · 版本 {sc.dataVersion} · 匹配 {sc.matchedCount ?? '—'} {sc.matchedUnit} / 有效 {sc.analyzedCount} {sc.analyzedUnit}
                </div>
              ))}
            </div>
          </details>
        </article>
      </div>

      {/* Slide-over Evidence Drawer */}
      {drawerState && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.35)',
            zIndex: 60,
            display: 'flex',
            justifyContent: 'flex-end',
          }}
          onClick={() => setDrawerState(null)}
        >
          <div
            style={{
              width: 'min(520px, 94vw)',
              height: '100%',
              background: '#fff',
              boxShadow: '-8px 0 28px rgba(15,23,42,0.16)',
              display: 'flex',
              flexDirection: 'column',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--wb-purple-deep)' }}>EVIDENCE SNAPSHOT · 原文证据快照</div>
                <div style={{ fontWeight: 700, fontSize: 14, marginTop: 2 }}>{drawerState.title}</div>
              </div>
              <button type="button" className="ds-btn ds-btn--quiet" onClick={() => setDrawerState(null)}>
                <X size={16} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'grid', gap: 10, alignContent: 'start' }}>
              {drawerState.items.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                  暂无可展示的原文证据快照。
                </div>
              ) : (
                drawerState.items.map((ev) => {
                  const href = safeHttpUrl(ev.url);
                  return (
                    <div key={ev.id} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12, display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--muted)' }}>
                        <span>
                          <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--wb-purple-deep)' }}>{ev.id}</b> · {ev.sourceLabel}
                          {ev.community ? ` · r/${ev.community}` : ''}
                        </span>
                        <span>{ev.publishedAt ? ev.publishedAt.slice(0, 16).replace('T', ' ') : ''}</span>
                      </div>
                      {ev.title && <div style={{ fontWeight: 600, fontSize: 13 }}>{ev.title}</div>}
                      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                        {ev.excerpt}
                      </p>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11.5, color: 'var(--faint)' }}>
                        <span>{ev.reason}</span>
                        {href && (
                          <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--wb-purple-deep)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            <span>原文链接</span>
                            <ExternalLink size={11} />
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <button
                type="button"
                className="ds-btn ds-btn--ghost"
                onClick={() => {
                  setDrawerState(null);
                  onNavigate(report.projectId ? `/content?projectId=${encodeURIComponent(report.projectId)}` : '/content');
                }}
              >
                <Search size={13} />
                <span>打开原文检索</span>
              </button>
              <button type="button" className="ds-btn" onClick={() => setDrawerState(null)}>
                返回当前章节
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
