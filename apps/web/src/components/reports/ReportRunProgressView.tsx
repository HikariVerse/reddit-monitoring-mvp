import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileBarChart,
  FolderKanban,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { useReportRunActionMutation, useReportRunQuery } from '../../api/reports';
import { formatApiError } from '../../api/hooks';

const STAGE_ORDER = [
  { key: 'preparing', label: '准备资料与研究空间' },
  { key: 'collecting', label: '补充采集最新资料', optional: true },
  { key: 'analyzing', label: '执行真实数据分析与证据抽样' },
  { key: 'writing', label: '分章归纳与结构校验' },
  { key: 'ready', label: '保存报告并交付成果' },
];

function stateRank(state: string): number {
  const map: Record<string, number> = {
    preparing: 0,
    collecting: 1,
    analyzing: 2,
    writing: 3,
    ready: 4,
    pure_data_ready: 4,
  };
  return map[state] ?? -1;
}

export function ReportRunProgressView({
  runId,
  onNavigate,
}: {
  runId: string;
  onNavigate: (path: string) => void;
}) {
  const runQuery = useReportRunQuery(runId);
  const actionMut = useReportRunActionMutation();
  const [err, setErr] = useState<string | null>(null);

  const run = runQuery.data?.run;
  const isTerminal = Boolean(run && ['ready', 'pure_data_ready', 'failed', 'canceled'].includes(run.state));
  const isNeedsAction = run?.state === 'needs_action';
  const curRank = run ? stateRank(run.state) : 0;

  const triggerAction = async (action: 'cancel' | 'retry_writing' | 'retry_analysis' | 'deliver_pure_data' | 'continue_with_partial') => {
    setErr(null);
    try {
      await actionMut.mutateAsync({ id: runId, body: { action } });
    } catch (e) {
      setErr(formatApiError(e));
    }
  };

  if (runQuery.isPending) {
    return (
      <div className="ds-page">
        <div className="ds-card" style={{ padding: 28, textAlign: 'center', color: 'var(--muted)' }}>
          正在读取研究任务进度…
        </div>
      </div>
    );
  }

  if (runQuery.isError || !run) {
    return (
      <div className="ds-page">
        <div className="ds-card" style={{ padding: 24 }}>
          <div className="wb-alert wb-alert--error">{runQuery.isError ? formatApiError(runQuery.error) : '未找到该研究任务。'}</div>
          <button type="button" className="ds-btn ds-btn--ghost" style={{ marginTop: 12 }} onClick={() => onNavigate('/reports')}>
            返回报告工作台
          </button>
        </div>
      </div>
    );
  }

  const sp = run.stepProgress ?? {};
  const usage = run.llmUsage ?? {};
  const hasCollectionStep = Boolean(sp.collectionTarget || sp.collectionJobId || run.state === 'collecting');
  const visibleStages = STAGE_ORDER.filter((s) => !s.optional || hasCollectionStep);

  return (
    <div className="ds-page" style={{ display: 'grid', gap: 16, maxWidth: 880 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>研究任务进度 · 后台持续运行，刷新或离开页面不会中断</div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 21, fontWeight: 700, margin: '4px 0 0' }}>
            {run.title}
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="ds-btn ds-btn--ghost" onClick={() => onNavigate('/reports')}>
            返回工作台
          </button>
          {run.projectId && (
            <button
              type="button"
              className="ds-btn ds-btn--ghost"
              onClick={() => onNavigate(`/projects?view=summary&projectId=${encodeURIComponent(run.projectId!)}`)}
            >
              <FolderKanban size={13} />
              <span>查看所属研究空间</span>
            </button>
          )}
        </div>
      </div>

      {err && <div className="wb-alert wb-alert--error">{err}</div>}

      {/* Live Status Card */}
      <section className="ds-card" style={{ padding: 20, display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {run.state === 'ready' || run.state === 'pure_data_ready' ? (
              <CheckCircle2 size={20} color="#0f766e" />
            ) : run.state === 'failed' || run.state === 'canceled' ? (
              <XCircle size={20} color="#a8462f" />
            ) : run.state === 'needs_action' ? (
              <AlertTriangle size={20} color="#d97706" />
            ) : (
              <Loader2 size={20} color="var(--wb-purple-deep)" className="animate-spin" />
            )}
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{run.stageLabel || '正在执行研究任务'}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                创建时间 {run.createdAt.slice(0, 19).replace('T', ' ')} UTC
                {run.finishedAt ? ` · 完成于 ${run.finishedAt.slice(0, 19).replace('T', ' ')} UTC` : ''}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {run.reportId && (
              <button type="button" className="ds-btn" onClick={() => onNavigate(`/reports/${encodeURIComponent(run.reportId!)}`)}>
                <FileBarChart size={14} />
                <span>立即查看报告</span>
              </button>
            )}
            {!isTerminal && !isNeedsAction && (
              <button
                type="button"
                className="ds-btn ds-btn--ghost"
                disabled={actionMut.isPending || run.cancelRequested}
                onClick={() => void triggerAction('cancel')}
              >
                {run.cancelRequested ? '正在取消…' : '取消任务'}
              </button>
            )}
          </div>
        </div>

        {/* Stage timeline */}
        <div style={{ display: 'grid', gap: 8 }}>
          {visibleStages.map((st, idx) => {
            const rank = stateRank(st.key);
            const done = curRank > rank || run.state === 'ready' || run.state === 'pure_data_ready';
            const active = run.state === st.key;
            return (
              <div
                key={st.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                  background: active ? 'var(--wb-tint)' : done ? '#f0fdf9' : '#fff',
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 700, color: done ? '#0f766e' : 'var(--muted)' }}>
                  0{idx + 1}
                </span>
                <span style={{ fontSize: 13, fontWeight: active || done ? 600 : 400, flex: 1 }}>{st.label}</span>
                <span style={{ fontSize: 11.5, color: done ? '#0f766e' : active ? 'var(--wb-purple-deep)' : 'var(--faint)' }}>
                  {done ? '已完成' : active ? '进行中…' : '待执行'}
                </span>
              </div>
            );
          })}
        </div>

        {/* Real metrics counters (no fake progress bar) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <div style={{ padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8 }}>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>有效分析样本</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {typeof sp.analyzedDocuments === 'number' ? sp.analyzedDocuments.toLocaleString() : '计算中'}
            </div>
          </div>
          <div style={{ padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8 }}>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>已提取证据快照</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {typeof sp.evidenceCount === 'number' ? `${sp.evidenceCount} 条` : '—'}
            </div>
          </div>
          <div style={{ padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8 }}>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>章节完成进度</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>
              {typeof sp.completedSections === 'number' && typeof sp.totalSections === 'number'
                ? `${sp.completedSections} / ${sp.totalSections}`
                : '—'}
            </div>
          </div>
          <div style={{ padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8 }}>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>模型调用与 Token 用量</div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>
              {typeof usage.totalTokens === 'number' && usage.totalTokens > 0
                ? `${Number(usage.totalTokens).toLocaleString()} tokens`
                : '尚无消耗'}
            </div>
          </div>
        </div>

        {/* Needs Action / Failure Recovery Actions */}
        {(isNeedsAction || run.state === 'failed') && (
          <div style={{ padding: 14, borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', display: 'grid', gap: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: '#92400e' }}>
              {run.errorMessage || '任务暂停，请选择后续处理方式'}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {run.errorCode === 'llm_synthesis_failed' ? (
                <>
                  <button type="button" className="ds-btn" disabled={actionMut.isPending} onClick={() => void triggerAction('retry_writing')}>
                    <RefreshCw size={13} />
                    <span>重试文字归纳（不重复分析）</span>
                  </button>
                  <button type="button" className="ds-btn ds-btn--ghost" disabled={actionMut.isPending} onClick={() => void triggerAction('deliver_pure_data')}>
                    <span>交付纯数据统计报告</span>
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="ds-btn" disabled={actionMut.isPending} onClick={() => void triggerAction('continue_with_partial')}>
                    <span>使用当前可用资料继续生成</span>
                  </button>
                  <button type="button" className="ds-btn ds-btn--ghost" disabled={actionMut.isPending} onClick={() => void triggerAction('retry_analysis')}>
                    <RefreshCw size={13} />
                    <span>重试分析阶段</span>
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </section>

      <details className="ds-card" style={{ padding: '10px 14px' }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--muted)' }}>
          <Clock size={12} style={{ display: 'inline', marginRight: 6 }} />
          展开技术诊断信息（任务编号、数据版本与模型调用摘要）
        </summary>
        <div style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--muted)', marginTop: 8, display: 'grid', gap: 4 }}>
          <div>任务编号：{run.id}</div>
          <div>范围签名：{run.scopeHash}</div>
          <div>数据版本：{run.dataVersion || '待锁定'}</div>
          {Array.isArray(usage.requestIds) && usage.requestIds.length > 0 && (
            <div>模型调用记录：{usage.requestIds.join(', ')}</div>
          )}
        </div>
      </details>
    </div>
  );
}
