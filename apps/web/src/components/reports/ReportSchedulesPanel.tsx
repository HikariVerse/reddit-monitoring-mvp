import { useState } from 'react';
import { CalendarClock, Pause, Play, Plus, Trash2, Zap } from 'lucide-react';
import {
  useCreateReportScheduleMutation,
  useDeleteReportScheduleMutation,
  useReportSchedulesQuery,
  useTriggerReportScheduleMutation,
  useUpdateReportScheduleMutation,
  type ReportTemplateType,
} from '../../api/reports';
import { formatApiError } from '../../api/hooks';

export function ReportSchedulesPanel({
  projectId,
  projectName,
  onNavigate,
}: {
  projectId?: string;
  projectName?: string;
  onNavigate: (path: string) => void;
}) {
  const schedQuery = useReportSchedulesQuery(projectId, true);
  const createMut = useCreateReportScheduleMutation();
  const updateMut = useUpdateReportScheduleMutation();
  const deleteMut = useDeleteReportScheduleMutation();
  const triggerMut = useTriggerReportScheduleMutation();

  const [openForm, setOpenForm] = useState(false);
  const [name, setName] = useState(projectName ? `${projectName} · 定期研究报告` : '每日行业情报简报');
  const [template, setTemplate] = useState<ReportTemplateType>(projectId ? 'social' : 'industry');
  const [cadence, setCadence] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [windowHours, setWindowHours] = useState(24);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const schedules = schedQuery.data?.schedules ?? [];

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setNotice(null);
    try {
      await createMut.mutateAsync({
        name: name.trim() || '定期研究报告',
        template,
        projectId: projectId ?? null,
        cadence,
        windowHours,
        enabled: true,
        config: {
          topic: projectName || name.trim(),
          primarySource: template === 'industry' ? 'stories' : projectId ? 'project' : 'stories',
        },
      });
      setOpenForm(false);
      setNotice('定期报告计划已创建。暂停定期报告不会影响全站公共数据源。');
    } catch (e2) {
      setErr(formatApiError(e2));
    }
  };

  return (
    <section className="ds-card" style={{ padding: 16, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, fontSize: 14 }}>
            <CalendarClock size={15} color="var(--wb-purple-deep)" />
            <span>定期自动报告计划</span>
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '3px 0 0' }}>
            按日/周自动基于已入库或持续监测数据生成报告，不会自动触发额外付费采集；停用个人报告计划不影响全站共享来源。
          </p>
        </div>
        <button type="button" className="ds-btn ds-btn--ghost" onClick={() => setOpenForm((v) => !v)}>
          <Plus size={13} />
          <span>新建定期报告</span>
        </button>
      </div>

      {err && <div className="wb-alert wb-alert--error">{err}</div>}
      {notice && <div className="wb-alert wb-alert--success">{notice}</div>}

      {openForm && (
        <form onSubmit={(e) => void handleCreate(e)} style={{ padding: 12, background: '#f8fafc', borderRadius: 8, border: '1px solid var(--line)', display: 'grid', gap: 10 }}>
          <div className="wb-grid-2">
            <div className="wb-field">
              <label>计划名称</label>
              <input className="wb-input" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="wb-field">
              <label>报告模板</label>
              <select className="wb-select" value={template} onChange={(e) => setTemplate(e.target.value as ReportTemplateType)}>
                <option value="industry">行业情报简报</option>
                <option value="social">社媒舆情洞察</option>
                <option value="commerce">电商市场研究</option>
                <option value="custom">自定义研究报告</option>
              </select>
            </div>
          </div>
          <div className="wb-grid-2">
            <div className="wb-field">
              <label>自动产出频率</label>
              <select
                className="wb-select"
                value={cadence}
                onChange={(e) => {
                  const next = e.target.value as 'daily' | 'weekly' | 'monthly';
                  setCadence(next);
                  setWindowHours(next === 'weekly' ? 168 : next === 'monthly' ? 720 : 24);
                }}
              >
                <option value="daily">每日（默认 08:00 北京时间）</option>
                <option value="weekly">每周（过去 7 天窗口）</option>
                <option value="monthly">每月（过去 30 天窗口）</option>
              </select>
            </div>
            <div className="wb-field">
              <label>回溯数据窗口（小时）</label>
              <input type="number" className="wb-input" min={1} max={720} value={windowHours} onChange={(e) => setWindowHours(Number(e.target.value) || 24)} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="ds-btn" disabled={createMut.isPending}>保存并启用</button>
            <button type="button" className="ds-btn ds-btn--ghost" onClick={() => setOpenForm(false)}>取消</button>
          </div>
        </form>
      )}

      {schedules.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 0' }}>
          暂未配置定期自动报告计划。
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {schedules.map((s) => (
            <div key={s.id} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <b style={{ fontSize: 13 }}>{s.name}</b>
                  <span className={`tag ${s.enabled ? 'tag--mint' : ''}`} style={{ fontSize: 10.5 }}>
                    {s.enabled ? '运行中' : '已暂停'}
                  </span>
                  <span className="tag" style={{ fontSize: 10.5 }}>
                    {s.cadence === 'daily' ? '每日' : s.cadence === 'weekly' ? '每周' : s.cadence === 'monthly' ? '每月' : `每 ${s.intervalMinutes} 分钟`} · {s.windowHours}h 窗口
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                  下次运行：{s.nextRunAt.slice(0, 16).replace('T', ' ')} UTC
                  {s.lastRunAt ? ` · 最近运行：${s.lastRunAt.slice(0, 16).replace('T', ' ')} UTC (${s.lastStatus ?? 'ok'})` : ' · 尚未执行'}
                  {s.lastError ? ` · 异常：${s.lastError}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="ds-btn ds-btn--ghost"
                  style={{ fontSize: 11.5 }}
                  disabled={triggerMut.isPending}
                  onClick={async () => {
                    const res = await triggerMut.mutateAsync(s.id);
                    if (res.runId) onNavigate(`/reports/runs/${encodeURIComponent(res.runId)}`);
                  }}
                >
                  <Zap size={12} />
                  <span>立即生成一次</span>
                </button>
                <button
                  type="button"
                  className="ds-btn ds-btn--ghost"
                  style={{ fontSize: 11.5 }}
                  disabled={updateMut.isPending}
                  onClick={() => void updateMut.mutateAsync({ id: s.id, body: { enabled: !s.enabled } })}
                >
                  {s.enabled ? <Pause size={12} /> : <Play size={12} />}
                  <span>{s.enabled ? '暂停' : '恢复'}</span>
                </button>
                <button
                  type="button"
                  className="ds-btn ds-btn--quiet"
                  disabled={deleteMut.isPending}
                  onClick={() => {
                    if (window.confirm(`确定删除定期报告计划“${s.name}”？`)) {
                      void deleteMut.mutateAsync(s.id);
                    }
                  }}
                >
                  <Trash2 size={12} color="#a8462f" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
