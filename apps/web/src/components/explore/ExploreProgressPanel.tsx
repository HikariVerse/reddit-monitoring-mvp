import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Clock, Loader2 } from 'lucide-react';
import type { ExplorePanelId, ExploreProgressResponse } from '../../../../../packages/contracts/src/explore';
import { liveFetch } from '@/api/client';
import { useI18n } from '@/i18n/translations';
import { Badge } from '../ui/badge';
import { Card, CardContent } from '../ui/card';
import { Progress } from '../ui/progress';

const ALL_PANELS: readonly { id: ExplorePanelId; shortZh: string; shortEn: string }[] = [
  { id: 'P01', shortZh: '声量覆盖', shortEn: 'Volume' },
  { id: 'P02', shortZh: '语料去重', shortEn: 'Dedupe' },
  { id: 'P03', shortZh: '分组互动', shortEn: 'Groups' },
  { id: 'P04', shortZh: '特征词汇', shortEn: 'Lexical' },
  { id: 'P05', shortZh: '主题聚类', shortEn: 'Topics' },
  { id: 'P06', shortZh: '主题节律', shortEn: 'Rhythm' },
  { id: 'P07', shortZh: '异常检测', shortEn: 'Anomalies' },
  { id: 'P08', shortZh: '事件周期', shortEn: 'Lifecycle' },
  { id: 'P09', shortZh: '情感口碑', shortEn: 'Sentiment' },
  { id: 'P10', shortZh: '主动需求', shortEn: 'Demand' },
  { id: 'P11', shortZh: '痛点聚类', shortEn: 'Pain' },
  { id: 'P12', shortZh: '价格决策', shortEn: 'Pricing' },
];

const STAGES: readonly { key: string; labelZh: string; labelEn: string }[] = [
  { key: 'retrieving', labelZh: '1. 召回数据', labelEn: '1. Retrieve' },
  { key: 'ingesting', labelZh: '2. 清洗去重', labelEn: '2. Dedupe' },
  { key: 'computing_panels', labelZh: '3. 计算 12 项分析', labelEn: '3. Compute Panels' },
  { key: 'finalizing', labelZh: '4. 生成洞察引导', labelEn: '4. Finalize' },
];

function stageRank(stage: string): number {
  if (stage === 'retrieving') return 0;
  if (stage === 'ingesting') return 1;
  if (stage === 'computing_panels') return 2;
  if (stage === 'finalizing' || stage === 'completed') return 3;
  return 0;
}

export function ExploreProgressPanel({
  runId,
  query,
  sourceLabel,
}: {
  runId: string;
  query: string;
  sourceLabel: string;
}) {
  const { t } = useI18n();
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSec(Math.round((Date.now() - start) / 100) / 10);
    }, 200);
    return () => window.clearInterval(timer);
  }, [runId]);

  const progressQuery = useQuery({
    queryKey: ['explore-progress', runId],
    queryFn: ({ signal }) => liveFetch<ExploreProgressResponse>(`/explore/progress/${encodeURIComponent(runId)}`, { signal }),
    refetchInterval: 800,
    retry: false,
  });

  const p = progressQuery.data;
  const percent = p?.percent ?? 6;
  const activeRank = stageRank(p?.stage ?? 'retrieving');
  const completedSet = new Set(p?.completedPanels ?? []);
  const currentPanel = p?.currentPanel ?? null;

  return (
    <Card className="explore-surface-card gap-0 py-0 shadow-xs" role="status" aria-live="polite">
      <CardContent className="space-y-4 p-0">
        {/* Top status header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Loader2 size={18} className="shrink-0 animate-spin text-primary" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">
                {p?.stageLabel || t('Connecting to analytics engine…', '正在连接分析引擎并召回数据…')}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{sourceLabel}</span>
                <span>·</span>
                <span>{query ? `「${query}」` : t('Full panorama', '数据全景')}</span>
                {p?.rawDocuments !== null && p?.rawDocuments !== undefined && (
                  <>
                    <span>·</span>
                    <span>
                      {t('Retrieved', '已召回')} {p.rawDocuments.toLocaleString()} {t('docs', '条')}
                    </span>
                  </>
                )}
                {p?.analyzedDocuments !== null && p?.analyzedDocuments !== undefined && (
                  <>
                    <span>·</span>
                    <span>
                      {t('Deduplicated', '去重保留')} {p.analyzedDocuments.toLocaleString()} {t('docs', '条')}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1 font-mono text-[11px] tabular-nums">
              <Clock size={11} />
              <span>{elapsedSec.toFixed(1)}s</span>
            </Badge>
            <Badge variant="secondary" className="font-mono text-xs tabular-nums">
              {percent}%
            </Badge>
          </div>
        </div>

        {/* Real progress bar */}
        <Progress value={percent} className="h-2" />

        {/* 4 Stage Stepper */}
        <div className="explore-stage-grid">
          {STAGES.map((st, idx) => {
            const done = idx < activeRank || p?.stage === 'completed';
            const running = idx === activeRank && p?.stage !== 'completed';
            return (
              <div
                key={st.key}
                className={`explore-stage-item ${done ? 'is-done' : running ? 'is-running' : ''}`}
              >
                {done ? (
                  <CheckCircle2 size={14} className="shrink-0 text-primary" />
                ) : running ? (
                  <Loader2 size={14} className="shrink-0 animate-spin text-primary" />
                ) : (
                  <Circle size={14} className="shrink-0 text-muted-foreground/50" />
                )}
                <span className="truncate">{t(st.labelEn, st.labelZh)}</span>
              </div>
            );
          })}
        </div>

        {/* 12 Panel live completion chips */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11.5px] text-muted-foreground">
            <span>{t('Business Panel Progress', '12 项业务分析面板实时进度')}</span>
            <span className="font-mono tabular-nums">
              {completedSet.size} / {ALL_PANELS.length}
            </span>
          </div>
          <div className="explore-panel-progress-grid">
            {ALL_PANELS.map((item) => {
              const isDone = completedSet.has(item.id);
              const isCurrent = currentPanel === item.id;
              return (
                <div
                  key={item.id}
                  className={`explore-panel-chip ${isDone ? 'is-done' : isCurrent ? 'is-running' : ''}`}
                >
                  {isDone ? (
                    <CheckCircle2 size={12} className="shrink-0 text-primary" />
                  ) : isCurrent ? (
                    <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
                  ) : (
                    <Circle size={12} className="shrink-0 opacity-40" />
                  )}
                  <span className="font-mono text-[10.5px]">{item.id}</span>
                  <span className="truncate">{t(item.shortEn, item.shortZh)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
