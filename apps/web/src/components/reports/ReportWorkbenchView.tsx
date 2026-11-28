import { useState, type CSSProperties } from 'react';
import {
  ArrowRight,
  BookOpen,
  Clock,
  Compass,
  FileBarChart,
  FolderKanban,
  MessageCircleMore,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import {
  useReportDraftsQuery,
  useReportRunsQuery,
  useReportsListQuery,
  type ReportTemplateType,
} from '../../api/reports';
import { useProjectsQuery } from '../../api/hooks';
import { useI18n } from '../../i18n/translations';

interface TemplateCardSpec {
  id: ReportTemplateType;
  titleZh: string;
  titleEn: string;
  badgeZh: string;
  descZh: string;
  tagsZh: string;
  accent: string;
  tint: string;
  icon: typeof BookOpen;
}

const TEMPLATE_CARDS: TemplateCardSpec[] = [
  {
    id: 'industry',
    titleZh: '行业情报简报',
    titleEn: 'Industry Intelligence Briefing',
    badgeZh: '资讯多源印证',
    descZh: '把分散的资讯整理成重点事件、行业动态与业务启示。',
    tagsZh: '日报 · 周报 · 专题简报',
    accent: '#3c70a8',
    tint: '#eaf1fa',
    icon: BookOpen,
  },
  {
    id: 'commerce',
    titleZh: '电商市场研究',
    titleEn: 'E-Commerce Market Research',
    badgeZh: '消费者需求与痛点',
    descZh: '洞察消费者需求、产品痛点、价格关注与购买行为。',
    tagsZh: '消费者洞察 · 产品研究 · 竞品观察',
    accent: '#287f75',
    tint: '#e6f3ef',
    icon: ShoppingBag,
  },
  {
    id: 'social',
    titleZh: '社媒舆情洞察',
    titleEn: 'Social Listening & Sentiment',
    badgeZh: '趋势与事件异常',
    descZh: '梳理讨论趋势、主要话题、观点结构与异常事件。',
    tagsZh: '品牌口碑 · 热点事件 · 话题研究',
    accent: '#7463a5',
    tint: '#f0edf8',
    icon: MessageCircleMore,
  },
  {
    id: 'custom',
    titleZh: '自定义研究报告',
    titleEn: 'Custom Research Report',
    badgeZh: '自由编排模块',
    descZh: '选择研究数据，自由组合章节、图表与 AI 研究重点。',
    tagsZh: '已有分析结果 · 自由组合',
    accent: '#a5773e',
    tint: '#f8f0e4',
    icon: SlidersHorizontal,
  },
];

function TemplateMiniSvg({ template, accent }: { template: ReportTemplateType; accent: string }) {
  return (
    <svg viewBox="0 0 110 130" aria-hidden="true" className="wb-tpl-svg">
      <rect x="8" y="3" width="94" height="124" rx="4" fill="#ffffff" stroke="#d8e0e8" />
      <rect x="8" y="3" width="94" height="4" rx="2" fill={accent} />
      <rect x="19" y="15" width="44" height="3" rx="1" fill={accent} />
      <rect x="19" y="23" width="70" height="7" rx="1" fill="#34465a" />
      <rect x="19" y="35" width="47" height="2" rx="1" fill="#c8d2de" />

      {template === 'industry' && (
        <>
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <rect x="19" y={47 + i * 23} width="22" height="16" rx="2" fill={accent} opacity="0.19" />
              <rect x="47" y={48 + i * 23} width="40" height="3" rx="1" fill={accent} opacity="0.82" />
              <path d={`M47 ${55 + i * 23}h44m-44 5h31`} stroke="#ccd5e0" strokeWidth="1.4" />
            </g>
          ))}
        </>
      )}

      {template === 'social' && (
        <>
          <path d="M19 82h74M19 66h74M19 50h74" stroke="#e0e5ec" strokeWidth="1" />
          <path
            d="M19 78 31 71 43 74 55 49 67 65 79 43 91 59"
            fill="none"
            stroke={accent}
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="34" cy="104" r="12" fill="none" stroke="#dce0e6" strokeWidth="7" />
          <circle
            cx="34"
            cy="104"
            r="12"
            fill="none"
            stroke={accent}
            strokeWidth="7"
            strokeDasharray="45 76"
          />
          <path d="M55 96h33m-33 8h27m-27 8h35" stroke="#c9d2dd" strokeWidth="3" strokeLinecap="round" />
        </>
      )}

      {(template === 'commerce' || template === 'custom') && (
        <>
          <g fill={accent} opacity="0.18">
            <rect x="19" y="44" width="22" height="14" rx="2" />
            <rect x="44" y="44" width="22" height="14" rx="2" />
            <rect x="69" y="44" width="22" height="14" rx="2" />
          </g>
          {[59, 43, 36, 25].map((w, i) => (
            <g key={i}>
              <rect x="19" y={67 + i * 9} width="72" height="5" rx="1" fill="#e7edf1" />
              <rect x="19" y={67 + i * 9} width={w} height="5" rx="1" fill={accent} opacity="0.78" />
            </g>
          ))}
          <path d="M19 109h72m-72 5h56" stroke="#cdd5df" strokeWidth="1.4" />
        </>
      )}
    </svg>
  );
}

const QUICK_CHIPS = [
  { label: '开放式耳机消费者需求', template: 'commerce' as const },
  { label: '便携式电源选购痛点', template: 'commerce' as const },
  { label: 'Grok 社媒讨论动态', template: 'social' as const },
  { label: 'AI 编程代理行业观察', template: 'industry' as const },
];

function inferTemplateFromQuestion(text: string): ReportTemplateType {
  if (/简报|日报|周报|行业|资讯|发布/.test(text)) return 'industry';
  if (/舆情|口碑|危机|热点|声量|品牌/.test(text)) return 'social';
  if (/自定义|定制/.test(text)) return 'custom';
  return 'commerce';
}

export function ReportWorkbenchView({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { t } = useI18n();
  const [question, setQuestion] = useState('');
  const reportsQuery = useReportsListQuery({ limit: 20 }, true);
  const runsQuery = useReportRunsQuery({ limit: 6 }, true);
  const draftsQuery = useReportDraftsQuery(true);
  const projectsQuery = useProjectsQuery(true);

  const reports = reportsQuery.data?.reports ?? [];
  const runs = runsQuery.data?.runs ?? [];
  const drafts = draftsQuery.data?.drafts ?? [];
  const projects = projectsQuery.data?.projects ?? [];

  const latestReportByTemplate = new Map<ReportTemplateType, (typeof reports)[number]>();
  for (const rep of reports) {
    if (!latestReportByTemplate.has(rep.template)) {
      latestReportByTemplate.set(rep.template, rep);
    }
  }

  const activeRun = runs.find((r) => ['preparing', 'collecting', 'analyzing', 'writing', 'needs_action'].includes(r.state));
  const latestDraft = drafts[0];

  const startWithQuestion = (raw: string, template?: ReportTemplateType) => {
    const q = raw.trim();
    const chosen = template ?? inferTemplateFromQuestion(q);
    const qs = new URLSearchParams({ template: chosen });
    if (q) qs.set('topic', q);
    onNavigate(`/reports/new?${qs.toString()}`);
  };

  return (
    <div className="ds-page" style={{ display: 'grid', gap: 18 }}>
      {/* Hero Banner */}
      <section
        className="ds-card"
        style={{
          padding: '26px 28px',
          background: 'linear-gradient(135deg, var(--wb-tint) 0%, var(--wb-card) 75%)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 680 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--wb-purple-deep)', marginBottom: 6 }}>
              SIFTLINE · 报告优先研究工作台
            </div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700, margin: '0 0 8px' }}>
              {t('What do you want to research today?', '今天，你想研究什么？')}
            </h1>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px' }}>
              提出业务问题后，系统自动在已授权资料中发现相关讨论与资讯，确认方案后自动完成分析、归纳并生成可导出报告。
            </p>
          </div>
          <button type="button" className="ds-btn" onClick={() => onNavigate('/reports/new')}>
            <Sparkles size={14} />
            <span>创建研究报告</span>
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            startWithQuestion(question);
          }}
          style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}
        >
          <input
            type="text"
            className="wb-input"
            style={{ flex: 1, minWidth: 260, height: 40, fontSize: 13.5, background: '#fff' }}
            placeholder="例如：开放式耳机消费者核心痛点与价格敏感度、本周 AI 行业重点动态…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button type="submit" className="ds-btn" style={{ height: 40, padding: '0 18px' }}>
            <span>开始研究</span>
            <ArrowRight size={14} />
          </button>
        </form>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>快捷研究方向：</span>
          {QUICK_CHIPS.map((chip) => (
            <button
              key={chip.label}
              type="button"
              className="ds-btn ds-btn--ghost"
              style={{ height: 27, fontSize: 11.5, padding: '0 10px' }}
              onClick={() => startWithQuestion(chip.label, chip.template)}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </section>

      {/* Active Run or Draft Resume Banner */}
      {activeRun && (
        <section
          className="ds-card"
          style={{
            padding: '12px 16px',
            borderColor: 'var(--wb-purple)',
            background: 'var(--wb-tint)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Clock size={16} color="var(--wb-purple-deep)" />
            <div style={{ fontSize: 13 }}>
              <b>进行中的研究任务：{activeRun.title}</b>
              <span style={{ color: 'var(--muted)', marginLeft: 8 }}>{activeRun.stageLabel}</span>
            </div>
          </div>
          <button type="button" className="ds-btn" onClick={() => onNavigate(`/reports/runs/${encodeURIComponent(activeRun.id)}`)}>
            查看进度
          </button>
        </section>
      )}

      {!activeRun && latestDraft && (
        <section
          className="ds-card"
          style={{
            padding: '12px 16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: 13 }}>
            <b>未提交的研究草稿：{latestDraft.title || String(latestDraft.input?.topic ?? '未命名草稿')}</b>
            <span style={{ color: 'var(--muted)', marginLeft: 8 }}>更新于 {latestDraft.updatedAt.slice(0, 16).replace('T', ' ')} UTC</span>
          </div>
          <button
            type="button"
            className="ds-btn ds-btn--ghost"
            onClick={() => onNavigate(`/reports/new?draftId=${encodeURIComponent(latestDraft.id)}`)}
          >
            恢复草稿
          </button>
        </section>
      )}

      {/* Four Business Templates */}
      <section style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ fontSize: 15.5, fontWeight: 700, margin: 0 }}>选择业务场景</h2>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>三类预设模板 · 自定义研究（基于真实已授权数据与可溯源原文）</span>
        </div>
        <div className="wb-tpl-grid">
          {TEMPLATE_CARDS.map((card) => {
            const Icon = card.icon;
            const latestRep = latestReportByTemplate.get(card.id);
            return (
              <article
                key={card.id}
                className="ds-card wb-tpl-card"
                style={{ '--tpl-accent': card.accent, '--tpl-tint': card.tint } as CSSProperties}
              >
                <button
                  type="button"
                  className="wb-tpl-preview"
                  onClick={() =>
                    onNavigate(latestRep ? `/reports/${encodeURIComponent(latestRep.id)}` : `/reports/new?template=${card.id}`)
                  }
                  title={latestRep ? `查看最近一份${card.titleZh}：${latestRep.title}` : `使用${card.titleZh}模板开始研究`}
                >
                  <TemplateMiniSvg template={card.id} accent={card.accent} />
                </button>
                <div className="wb-tpl-body">
                  <h3 className="wb-tpl-title">
                    <Icon size={16} color={card.accent} />
                    <span>{card.titleZh}</span>
                  </h3>
                  <p className="wb-tpl-desc">{card.descZh}</p>
                  <div className="wb-tpl-tags">{card.tagsZh}</div>
                  <div className="wb-tpl-actions">
                    {latestRep ? (
                      <button
                        type="button"
                        className="wb-tpl-link"
                        onClick={() => onNavigate(`/reports/${encodeURIComponent(latestRep.id)}`)}
                      >
                        查看最近成稿
                      </button>
                    ) : (
                      <span className="wb-tpl-badge">{card.badgeZh}</span>
                    )}
                    <button
                      type="button"
                      className="ds-btn ds-btn--ghost wb-tpl-cta"
                      onClick={() => onNavigate(`/reports/new?template=${card.id}`)}
                    >
                      <span>使用模板</span>
                      <ArrowRight size={13} />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* Recent Reports & Recent Projects */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 14 }}>
        <section className="ds-card" style={{ padding: 16, display: 'grid', gap: 10, alignContent: 'start', minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <FileBarChart size={15} color="var(--wb-purple-deep)" />
              <b style={{ fontSize: 14 }}>最近报告</b>
            </div>
            <button type="button" className="ds-btn ds-btn--quiet" style={{ fontSize: 12 }} onClick={() => onNavigate('/reports?view=list')}>
              全部报告 ({reports.length})
            </button>
          </div>
          {reports.length === 0 ? (
            <div style={{ padding: '20px 10px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
              还没有已生成的报告。点击上方业务模板或输入研究问题即可开始。
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {reports.slice(0, 5).map((rep) => (
                <div
                  key={rep.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {rep.title}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                      {rep.primarySourceLabel || rep.template} · 有效样本 {rep.analyzedCount.toLocaleString()} · {rep.createdAt.slice(0, 10)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ds-btn ds-btn--ghost"
                    style={{ flexShrink: 0, fontSize: 12 }}
                    onClick={() => onNavigate(`/reports/${encodeURIComponent(rep.id)}`)}
                  >
                    打开报告
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="ds-card" style={{ padding: 16, display: 'grid', gap: 10, alignContent: 'start', minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <FolderKanban size={15} color="var(--wb-purple-deep)" />
              <b style={{ fontSize: 14 }}>最近研究</b>
            </div>
            <button type="button" className="ds-btn ds-btn--quiet" style={{ fontSize: 12 }} onClick={() => onNavigate('/projects?view=list')}>
              全部研究 ({projects.length})
            </button>
          </div>
          {projects.length === 0 ? (
            <div style={{ padding: '20px 10px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
              暂无研究课题。完成一次报告任务后会自动沉淀为研究空间记录，也可手动新建专题研究。
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {projects.slice(0, 5).map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.name}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                      {p.is_shared ? '共享研究' : '私有研究'} ·{' '}
                      {(p.data_summary?.item_count ?? 0) > 0
                        ? `${(p.data_summary?.item_count ?? 0).toLocaleString()} 条项目样本 · ${p.enabled_batch_count} 个启用批次`
                        : (p.data_summary?.latest_report_analyzed_count ?? 0) > 0
                          ? `${p.data_summary?.archive_ref_count || p.data_summary?.latest_report_source_kind === 'archive' ? '历史归档' : p.data_summary?.latest_report_source_kind === 'stories' ? '行业资讯' : '研究快照'} · 已分析 ${(p.data_summary?.latest_report_analyzed_count ?? 0).toLocaleString()} 条`
                          : (p.data_summary?.archive_ref_count ?? 0) > 0
                            ? `已关联 ${p.data_summary?.archive_ref_count} 个历史归档范围`
                            : `${p.enabled_batch_count} 个启用批次`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="ds-btn ds-btn--ghost"
                      style={{ fontSize: 12 }}
                      onClick={() => onNavigate(`/projects?view=summary&projectId=${encodeURIComponent(p.id)}`)}
                    >
                      打开研究
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Quick Research Tools */}
      <section className="ds-card" style={{ padding: 16 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 10 }}>直接进入专业研究工具</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
          <button type="button" className="ds-btn ds-btn--ghost" style={{ justifyContent: 'flex-start', padding: '10px 12px', height: 'auto' }} onClick={() => onNavigate('/app/feed')}>
            <BookOpen size={15} />
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>资讯信息流</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>今日精选、热榜与日报</div>
            </div>
          </button>
          <button type="button" className="ds-btn ds-btn--ghost" style={{ justifyContent: 'flex-start', padding: '10px 12px', height: 'auto' }} onClick={() => onNavigate('/projects?view=list')}>
            <FolderKanban size={15} />
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>研究空间</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>项目管理、L1/L2/L3 与监测</div>
            </div>
          </button>
          <button type="button" className="ds-btn ds-btn--ghost" style={{ justifyContent: 'flex-start', padding: '10px 12px', height: 'auto' }} onClick={() => onNavigate('/explore')}>
            <Compass size={15} />
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>智能洞察探索</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>自由查询历史归档与社媒</div>
            </div>
          </button>
          <button type="button" className="ds-btn ds-btn--ghost" style={{ justifyContent: 'flex-start', padding: '10px 12px', height: 'auto' }} onClick={() => onNavigate('/content')}>
            <Search size={15} />
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>原文检索</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>全站筛选、讨论树与批注</div>
            </div>
          </button>
        </div>
      </section>
    </div>
  );
}
