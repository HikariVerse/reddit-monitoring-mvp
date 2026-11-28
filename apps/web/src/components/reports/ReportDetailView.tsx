import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Copy,
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

const KIND_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  observation: { label: '观察事实', color: '#0f766e', bg: '#f0fdfa' },
  interpretation: { label: '分析解读', color: '#2563eb', bg: '#eff6ff' },
  hypothesis: { label: '待验证假设', color: '#b45309', bg: '#fffbeb' },
  recommendation: { label: '业务建议', color: '#7c3aed', bg: '#f5f3ff' },
};

const TEMPLATE_LABELS: Record<string, string> = {
  industry: '行业情报简报',
  commerce: '电商市场研究',
  social: '社媒舆情洞察',
  custom: '自定义研究报告',
};

function splitReadableParagraphs(text: string): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  const explicit = cleaned.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (explicit.length > 1) return explicit;
  if (cleaned.length <= 180) return [cleaned];
  const sentences = cleaned.split(/(?<=[。！？!?])\s*/).filter(Boolean);
  if (sentences.length <= 2) return [cleaned];
  const chunks: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf && buf.length + s.length > 165) {
      chunks.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

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
  const [drawerSearch, setDrawerSearch] = useState('');
  const [regenNotice, setRegenNotice] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<'all' | 'observation' | 'interpretation' | 'hypothesis' | 'recommendation'>('all');
  const [findingQuery, setFindingQuery] = useState('');
  const [copiedSummary, setCopiedSummary] = useState(false);

  const report = detailQuery.data?.report;
  const evidenceMap = useMemo(
    () => new Map((report?.evidence ?? []).map((e) => [e.id, e])),
    [report?.evidence],
  );

  const openEvidence = (ids: string[], title: string) => {
    const items = ids.map((id) => evidenceMap.get(id)).filter((x): x is ReportEvidenceItem => Boolean(x));
    setDrawerSearch('');
    setDrawerState({ title, items: items.length ? items : (report?.evidence ?? []).slice(0, 12) });
  };

  const filteredDrawerItems = useMemo(() => {
    if (!drawerState) return [];
    const q = drawerSearch.trim().toLowerCase();
    if (!q) return drawerState.items;
    return drawerState.items.filter((ev) =>
      `${ev.id} ${ev.title} ${ev.excerpt} ${ev.community ?? ''} ${ev.sourceLabel}`.toLowerCase().includes(q),
    );
  }, [drawerSearch, drawerState]);

  const totalFindingsCount = useMemo(
    () => (report?.sections ?? []).reduce((sum, s) => sum + (s.narrative?.findings?.length ?? 0), 0),
    [report?.sections],
  );

  const matchedFindingsCount = useMemo(() => {
    const q = findingQuery.trim().toLowerCase();
    return (report?.sections ?? []).reduce(
      (sum, s) =>
        sum +
        (s.narrative?.findings ?? []).filter(
          (f) =>
            (kindFilter === 'all' || f.kind === kindFilter) &&
            (!q || `${f.title} ${f.text}`.toLowerCase().includes(q)),
        ).length,
      0,
    );
  }, [findingQuery, kindFilter, report?.sections]);

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
  const primaryRange = report.scopes[0]?.range;
  const rangeLabel =
    primaryRange?.from || primaryRange?.to
      ? `${primaryRange.from?.slice(0, 10) || '—'} 至 ${primaryRange.to?.slice(0, 10) || '—'}`
      : '当前窗口';

  const handleCopySummary = async () => {
    const execText = report.sections[0]?.narrative?.summary || report.summary;
    const text = `${report.title}\n${report.subtitle}\n\n${execText}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSummary(true);
      window.setTimeout(() => setCopiedSummary(false), 2000);
    } catch {
      // ignore clipboard errors in restricted contexts
    }
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
          <button type="button" className="ds-btn ds-btn--ghost" onClick={() => void handleCopySummary()}>
            {copiedSummary ? <Check size={13} /> : <Copy size={13} />}
            <span>{copiedSummary ? '已复制摘要' : '复制摘要'}</span>
          </button>
          <button type="button" className="ds-btn ds-btn--ghost" onClick={() => window.print()}>
            <Printer size={13} />
            <span>打印</span>
          </button>
          <a className="ds-btn" href={reportsApi.exportUrl(report.id)} download style={{ textDecoration: 'none' }}>
            <Download size={13} />
            <span>导出交互 HTML</span>
          </a>
        </div>
      </div>

      {regenNotice && <div className="wb-alert wb-alert--success">{regenNotice}</div>}

      {/* Main Layout: Sticky TOC + Editorial Research Document */}
      <div style={{ display: 'grid', gridTemplateColumns: '232px minmax(0, 1fr)', gap: 18, alignItems: 'start' }}>
        <aside className="ds-card" style={{ padding: 14, position: 'sticky', top: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 8 }}>
            报告目录 · CONTENTS
          </div>
          <nav style={{ display: 'grid', gap: 3 }}>
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
          <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 10, fontSize: 11.5, color: 'var(--muted)', display: 'grid', gap: 4 }}>
            <div>生成时间：{report.createdAt.slice(0, 16).replace('T', ' ')} UTC</div>
            <div>保存证据：{report.evidence.length} 条</div>
            <button
              type="button"
              className="ds-btn ds-btn--ghost"
              style={{ marginTop: 6, width: '100%', justifyContent: 'center', fontSize: 12 }}
              onClick={() => {
                setDrawerSearch('');
                setDrawerState({ title: '本报告全部代表性原文证据', items: report.evidence });
              }}
            >
              查看全部证据清单 →
            </button>
          </div>
        </aside>

        <article className="ds-card" style={{ padding: '28px 34px', display: 'grid', gap: 22 }}>
          {/* Executive Hero Cover Band */}
          <header
            style={{
              background: 'linear-gradient(135deg, #f0fdfa 0%, #f8fafc 100%)',
              border: '1px solid #99f6e4',
              borderRadius: 12,
              padding: '22px 24px',
            }}
          >
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 25, fontWeight: 750, lineHeight: 1.3, margin: '0 0 8px' }}>
              {report.title}
            </h1>
            <p style={{ fontSize: 14, color: 'var(--ink-3)', margin: 0, lineHeight: 1.6 }}>{report.subtitle}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 10, marginTop: 16 }}>
              <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: '9px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>有效分析样本</div>
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                  {report.analyzedCount.toLocaleString()}
                </div>
              </div>
              <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: '9px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>时间覆盖窗口</div>
                <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 4 }}>{rangeLabel}</div>
              </div>
              <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: '9px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>研究章节</div>
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                  {report.sections.length} 章
                </div>
              </div>
              <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: '9px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>可溯源证据</div>
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                  {report.evidence.length} 条
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10, fontSize: 11.5, color: 'var(--faint)' }}>
              <span>版本 v{report.reportVersion}</span>
              <span>· 历史报告快照（项目后续变动不影响本报告内容）</span>
              {report.projectDeleted && <span>· 关联研究已删除，快照仍完整保留</span>}
            </div>
          </header>

          {/* Finding Filter & Search Toolbar */}
          {totalFindingsCount > 0 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                paddingBottom: 12,
                borderBottom: '1px solid var(--line)',
              }}
            >
              <div className="seg" role="tablist" aria-label="按观点类型筛选">
                {(
                  [
                    ['all', '全部观点'],
                    ['observation', '观察事实'],
                    ['interpretation', '分析解读'],
                    ['hypothesis', '待验证假设'],
                    ['recommendation', '业务建议'],
                  ] as const
                ).map(([k, lbl]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={kindFilter === k}
                    className={kindFilter === k ? 'on' : ''}
                    onClick={() => setKindFilter(k)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="search"
                  className="wb-input"
                  style={{ width: 210, height: 30, fontSize: 12 }}
                  value={findingQuery}
                  onChange={(e) => setFindingQuery(e.target.value)}
                  placeholder="检索报告观点与关键词…"
                />
                {(kindFilter !== 'all' || findingQuery.trim()) && (
                  <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    {matchedFindingsCount} / {totalFindingsCount} 条
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Sections */}
          {report.sections.map((sec, idx) => {
            const isExec = sec.id === 'executive_summary';
            const paragraphs = splitReadableParagraphs(sec.narrative?.summary || sec.stateMessage);
            const q = findingQuery.trim().toLowerCase();
            const visibleFindings = (sec.narrative?.findings ?? []).filter(
              (f) =>
                (kindFilter === 'all' || f.kind === kindFilter) &&
                (!q || `${f.title} ${f.text}`.toLowerCase().includes(q)),
            );

            return (
              <section
                key={sec.id}
                id={`report-sec-${sec.id}`}
                style={{ borderBottom: '1px solid var(--line)', paddingBottom: 24, display: 'grid', gap: 12 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', color: 'var(--wb-purple-deep)' }}>
                      CHAPTER {String(idx + 1).padStart(2, '0')}
                    </div>
                    <h2 style={{ fontSize: 19, fontWeight: 750, margin: '3px 0 0' }}>
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

                {/* Scannable Executive Callout / Readable Paragraphs */}
                <div
                  style={
                    isExec
                      ? {
                          background: '#f0fdfa',
                          borderLeft: '4px solid #0f766e',
                          borderRadius: '0 10px 10px 0',
                          padding: '14px 18px',
                          display: 'grid',
                          gap: 8,
                          fontSize: 14.5,
                          lineHeight: 1.78,
                          color: 'var(--ink)',
                        }
                      : {
                          display: 'grid',
                          gap: 8,
                          fontSize: 14.5,
                          lineHeight: 1.78,
                          color: 'var(--ink-2, var(--ink))',
                          maxWidth: '76ch',
                        }
                  }
                >
                  {paragraphs.map((p, pi) => (
                    <p key={pi} style={{ margin: 0 }}>
                      {p}
                    </p>
                  ))}
                </div>

                {/* Named Topic Labels Pills */}
                {sec.narrative?.topicLabels && sec.narrative.topicLabels.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>核心主题归纳：</span>
                    {sec.narrative.topicLabels.map((tl, ti) => (
                      <button
                        key={ti}
                        type="button"
                        className="tag tag--lilac"
                        style={{ cursor: 'pointer', fontSize: 11.5 }}
                        onClick={() => openEvidence(tl.evidenceIds, `主题「${tl.label}」关联证据`)}
                      >
                        {tl.label}
                      </button>
                    ))}
                  </div>
                )}

                {/* KPI Metrics */}
                {sec.metrics.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                    {sec.metrics.map((m) => (
                      <div
                        key={m.id}
                        style={{
                          padding: '11px 14px',
                          background: '#f8fafc',
                          border: '1px solid var(--line)',
                          borderTop: '3px solid #0f766e',
                          borderRadius: 9,
                        }}
                      >
                        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{m.label}</div>
                        <div style={{ fontSize: 20, fontWeight: 750, marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>
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
                {visibleFindings.length > 0 && (
                  <div style={{ display: 'grid', gap: 10, marginTop: 4 }}>
                    {visibleFindings.map((f, fi) => {
                      const meta = KIND_LABELS[f.kind] ?? { label: f.kind, color: '#475569', bg: '#f1f5f9' };
                      return (
                        <div
                          key={fi}
                          style={{
                            padding: '12px 16px',
                            border: '1px solid var(--line)',
                            borderLeft: `4px solid ${meta.color}`,
                            borderRadius: 9,
                            background: '#fcfefd',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 650,
                                padding: '2px 8px',
                                borderRadius: 5,
                                color: meta.color,
                                background: meta.bg,
                              }}
                            >
                              {meta.label}
                            </span>
                            <strong style={{ fontSize: 14, color: 'var(--ink)' }}>{f.title}</strong>
                          </div>
                          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--ink-3)', lineHeight: 1.68 }}>{f.text}</p>
                          {f.evidenceIds.length > 0 && (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
                              <span style={{ fontSize: 11, color: 'var(--muted)' }}>溯源证据：</span>
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
                  <div style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', padding: '9px 13px', borderRadius: 8 }}>
                    <b>口径与局限：</b>
                    {[...(sec.narrative?.limitations ?? []), ...sec.warnings].slice(0, 4).join('；')}
                  </div>
                )}
              </section>
            );
          })}

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

      {/* Slide-over Evidence Drawer with Search */}
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
              width: 'min(540px, 94vw)',
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
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', background: '#f8fafc', display: 'flex', gap: 8 }}>
              <input
                type="search"
                className="wb-input"
                style={{ flex: 1, height: 30, fontSize: 12 }}
                value={drawerSearch}
                onChange={(e) => setDrawerSearch(e.target.value)}
                placeholder="在当前证据中搜索关键词或社区…"
              />
              <button
                type="button"
                className="ds-btn ds-btn--ghost"
                style={{ height: 30, fontSize: 11.5 }}
                onClick={() => {
                  setDrawerSearch('');
                  setDrawerState({ title: `本报告全部原文证据（${report.evidence.length} 条）`, items: report.evidence });
                }}
              >
                全部 ({report.evidence.length})
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'grid', gap: 10, alignContent: 'start' }}>
              {filteredDrawerItems.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                  暂无匹配的原文证据快照。
                </div>
              ) : (
                filteredDrawerItems.map((ev) => {
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
          </div>
        </div>
      )}
    </div>
  );
}
