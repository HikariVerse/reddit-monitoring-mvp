import { useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Clock,
  Compass,
  FileBarChart,
  FolderKanban,
  Newspaper,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import {
  useReportDraftsQuery,
  useReportRunsQuery,
  useReportsListQuery,
  type ReportTemplateType,
} from '../../api/reports';
import { useProjectsQuery } from '../../api/hooks';
import { useI18n } from '../../i18n/translations';

const TEMPLATE_CARDS: Array<{
  id: ReportTemplateType;
  titleZh: string;
  titleEn: string;
  badgeZh: string;
  descZh: string;
  outputZh: string;
  icon: typeof Newspaper;
}> = [
  {
    id: 'industry',
    titleZh: '行业情报简报',
    titleEn: 'Industry Intelligence Briefing',
    badgeZh: '资讯多源印证',
    descZh: '面向行业动态、科技与 AI 发布跟踪，聚合去重事件、主题与热词升温。',
    outputZh: '核心摘要 · 重点事件 · 主题动态 · 资讯趋势 · 业务启示',
    icon: Newspaper,
  },
  {
    id: 'commerce',
    titleZh: '电商市场研究',
    titleEn: 'E-Commerce Market Research',
    badgeZh: '消费者需求与痛点',
    descZh: '面向跨境选品、品类机会与产品迭代，挖掘主动需求、痛点、口碑与价格带。',
    outputZh: '样本概况 · 讨论趋势 · 主动需求 · 产品痛点 · 口碑与价格',
    icon: ShoppingBag,
  },
  {
    id: 'social',
    titleZh: '社媒舆情洞察',
    titleEn: 'Social Listening & Sentiment',
    badgeZh: '趋势与事件异常',
    descZh: '面向品牌声量、话题演化与突发事件复盘，识别异常峰值、社区分布与观点争议。',
    outputZh: '规模趋势 · 社区互动 · 核心话题 · 异常事件 · 情感口碑',
    icon: TrendingUp,
  },
  {
    id: 'custom',
    titleZh: '自定义研究报告',
    titleEn: 'Custom Research Report',
    badgeZh: '自由编排模块',
    descZh: '按研究问题自由勾选、排序全部可用分析模块，或基于已有探索结果快速成稿。',
    outputZh: '研究范围（固定）· 自选统计/语义/对比模块 · 证据索引',
    icon: SlidersHorizontal,
  },
];

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
  const reportsQuery = useReportsListQuery({ limit: 6 }, true);
  const runsQuery = useReportRunsQuery({ limit: 6 }, true);
  const draftsQuery = useReportDraftsQuery(true);
  const projectsQuery = useProjectsQuery(true);

  const reports = reportsQuery.data?.reports ?? [];
  const runs = runsQuery.data?.runs ?? [];
  const drafts = draftsQuery.data?.drafts ?? [];
  const projects = projectsQuery.data?.projects ?? [];

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
      <section style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>选择业务场景</h2>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>所有报告基于真实已授权数据与可溯源原文生成</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12 }}>
          {TEMPLATE_CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <div key={card.id} className="ds-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon size={17} color="var(--wb-purple-deep)" />
                    <b style={{ fontSize: 14 }}>{card.titleZh}</b>
                  </div>
                  <span className="tag" style={{ fontSize: 10.5 }}>{card.badgeZh}</span>
                </div>
                <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: 0, lineHeight: 1.55 }}>{card.descZh}</p>
                <div style={{ fontSize: 11.5, color: 'var(--ink-3)', background: '#f8fafc', padding: '7px 9px', borderRadius: 6, border: '1px solid var(--line)' }}>
                  默认章节：{card.outputZh}
                </div>
                <div style={{ marginTop: 'auto', display: 'flex', gap: 8, paddingTop: 4 }}>
                  <button
                    type="button"
                    className="ds-btn"
                    style={{ flex: 1 }}
                    onClick={() => onNavigate(`/reports/new?template=${card.id}`)}
                  >
                    使用模板
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Recent Reports & Recent Projects */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
        <section className="ds-card" style={{ padding: 16, display: 'grid', gap: 10, alignContent: 'start' }}>
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
              {reports.map((rep) => (
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

        <section className="ds-card" style={{ padding: 16, display: 'grid', gap: 10, alignContent: 'start' }}>
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
                      {p.is_shared ? '共享研究' : '私有研究'} · {p.data_summary?.item_count ?? 0} 条资料 · {p.enabled_batch_count} 个启用批次
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
