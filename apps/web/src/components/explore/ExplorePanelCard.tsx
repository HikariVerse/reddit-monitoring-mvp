import React, { useMemo, useState } from 'react';
import type { AnalysisBlock } from '@/contracts/research';
import type {
  ExploreMetricResult,
  ExplorePanelResult,
  ExploreSourceProfile,
} from '../../../../../packages/contracts/src/explore';
import { useI18n } from '@/i18n/translations';
import type { ExportTableColumn } from '@/lib/researchExport';
import { useChartColors } from '../charts/chartUtils';
import type { EChartOption } from '../charts/EChartBox';
import { AnalysisChartCard } from '../research/AnalysisChartCard';
import { Badge } from '../ui/badge';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { EXPLORE_PANEL_META } from './explorePanelMeta';

function asList<T = Record<string, unknown>>(val: unknown): T[] {
  return Array.isArray(val) ? (val as T[]) : [];
}

function asNum(val: unknown): number {
  return typeof val === 'number' && Number.isFinite(val) ? val : 0;
}

function pctStr(rate: unknown): string {
  return typeof rate === 'number' && Number.isFinite(rate) ? `${(rate * 100).toFixed(1)}%` : '—';
}

function findMetric(panel: ExplorePanelResult, id: string): ExploreMetricResult | undefined {
  return panel.metrics.find((m) => m.metric_id === id);
}

function extractEvidenceId(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const ref = (obj as { evidence_ref?: { id?: string } }).evidence_ref;
  return typeof ref?.id === 'string' ? ref.id : undefined;
}

function buildAdapterBlock(
  panel: ExplorePanelResult,
  sourceProfile: ExploreSourceProfile,
  summaryText: string,
  glossaryNotes: readonly string[],
): AnalysisBlock<unknown> {
  const primary = panel.metrics[0];
  return {
    analysisId: panel.panel_id,
    status: primary?.state === 'failed' ? 'error' : primary?.selected_documents ? 'ok' : 'empty',
    summaryText,
    summaryBullets: [...glossaryNotes],
    sampleCount: primary?.selected_documents ?? sourceProfile.analyzedDocuments,
    methodVersion: panel.schema_version,
    dataVersion: primary?.data_version ?? sourceProfile.engine,
    generatedAt: new Date().toISOString(),
    scope: {
      projectId: 'explore',
      selectedBatchIds: [],
      selectedTargetKeys: [],
      from: sourceProfile.timeRange.from,
      to: sourceProfile.timeRange.to,
      timeBasis: 'published',
      emptySelection: false,
    },
    coverage: {
      label: sourceProfile.sourceLabel,
      kind: sourceProfile.sourceMode === 'archive' ? 'full_archive' : 'stored_sample',
    },
    methodology: {
      dedupBasis: 'canonical_content_id',
      denominatorLabel: `${sourceProfile.engineLabel}（去重有效样本）`,
      denominatorValue: primary?.selected_documents ?? sourceProfile.analyzedDocuments,
      notes: [...glossaryNotes, ...sourceProfile.impactNotes.slice(0, 2)],
    },
    data: null,
  } as unknown as AnalysisBlock<unknown>;
}

const DEMAND_LABELS: Record<string, string> = {
  recommendation_request: '求推荐',
  alternative_search: '寻找替代品',
  feature_request: '显式功能请求',
  unmet_need: '明确未满足需求',
  solution_search: '寻找解决方案',
  bundled_need: '组合需求',
  explicit_need: '明确需求',
};

const STAGE_LABELS: Record<string, string> = {
  need: '需求萌生',
  research: '调研评估',
  compare: '竞品对比',
  budget: '预算考量',
  intent: '购买意向',
  purchased: '已购买/订阅',
  use: '使用体验',
  returned: '退货/取消',
};

const PAIN_LABELS: Record<string, string> = {
  reliability_bug: '故障与稳定性',
  performance_latency: '性能与延迟',
  cost_pricing: '价格与付费痛点',
  usability_ux: '易用性与体验',
};

export function ExplorePanelCard({
  panel,
  query,
  sourceProfile,
  headerExtras,
  onOpenEvidence,
  onRefineQuery,
}: {
  panel: ExplorePanelResult;
  query: string;
  sourceProfile: ExploreSourceProfile;
  headerExtras?: React.ReactNode;
  onOpenEvidence: (evidenceId: string, title: string) => void;
  onRefineQuery?: (term: string) => void;
}) {
  const { t } = useI18n();
  const rawColors = useChartColors();
  const colors = useMemo(
    () => ({
      primary: rawColors.purple,
      teal: rawColors.teal,
      amber: rawColors.apricot,
      coral: rawColors.reddit,
      muted: rawColors.muted,
      grid: rawColors.gridLine,
    }),
    [rawColors],
  );
  const meta = EXPLORE_PANEL_META[panel.panel_id];

  // Local sub-controls for multi-metric panels
  const [p01Grain, setP01Grain] = useState<'days' | 'weeks' | 'months' | 'sl02'>('days');
  const [p03Tab, setP03Tab] = useState<'groups' | 'engagement'>('groups');
  const [p04Tab, setP04Tab] = useState<'terms' | 'diff' | 'phrases'>('terms');
  const [p05Tab, setP05Tab] = useState<'topics' | 'reps'>('topics');
  const [p06Tab, setP06Tab] = useState<'weekhour' | 'calendar'>('weekhour');
  const [p11Tab, setP11Tab] = useState<'pain' | 'need'>('pain');
  const [p12Tab, setP12Tab] = useState<'stages' | 'prices'>('stages');

  const glossaryNotes = useMemo(
    () => meta.fieldGlossary.map((g) => `${g.field}：${g.meaning}`),
    [meta.fieldGlossary],
  );

  const built = useMemo((): {
    option: EChartOption | null;
    columns: ExportTableColumn[];
    rows: Array<Record<string, unknown>>;
    summary: string;
    primaryEvidenceId?: string;
    rowEvidenceIds: Array<string | undefined>;
    clickableTerms?: string[];
  } => {
    const pid = panel.panel_id;

    if (pid === 'P01') {
      const sl01 = findMetric(panel, 'SL01');
      const sl02 = findMetric(panel, 'SL02');
      const sl03 = findMetric(panel, 'SL03');

      if (p01Grain === 'sl02') {
        const days = asList<{ date: string; matched_threads: number; admitted_posts: number; relative_attention: number | null; evidence_ref?: { id?: string } }>(
          sl02?.data?.days,
        );
        const option: EChartOption | null = days.length > 0 ? {
          tooltip: { trigger: 'axis' },
          grid: { left: 52, right: 20, top: 24, bottom: 32 },
          xAxis: { type: 'category', data: days.map((d) => d.date), axisLabel: { fontSize: 10, color: colors.muted } },
          yAxis: { type: 'value', name: '每百万线程', nameTextStyle: { fontSize: 10, color: colors.muted }, splitLine: { lineStyle: { color: colors.grid } }, axisLabel: { fontSize: 10, color: colors.muted } },
          series: [{
            name: t('Per Million Archive Threads', '每百万归档线程命中数'),
            type: 'line',
            smooth: 0.25,
            areaStyle: { opacity: 0.14 },
            itemStyle: { color: colors.teal },
            lineStyle: { width: 2, color: colors.teal },
            data: days.map((d) => (typeof d.relative_attention === 'number' ? Math.round(d.relative_attention * 1e6 * 10) / 10 : 0)),
          }],
        } : null;
        const num = asNum(sl02?.data?.numerator);
        const den = asNum(sl02?.data?.denominator);
        const perM = typeof sl02?.data?.per_million === 'number' ? (sl02.data.per_million as number).toFixed(2) : '—';
        return {
          option,
          columns: [
            { key: 'date', label: t('Date (UTC)', '日期 (UTC)') },
            { key: 'matched', label: t('Matched Threads', '命中线程 (分子)') },
            { key: 'admitted', label: t('Archive Threads', '全库准入帖 (分母)') },
            { key: 'perMillion', label: t('Per Million', '每百万线程比') },
          ],
          rows: days.map((d) => ({
            date: d.date,
            matched: d.matched_threads,
            admitted: d.admitted_posts.toLocaleString(),
            perMillion: typeof d.relative_attention === 'number' ? (d.relative_attention * 1e6).toFixed(2) : '—',
          })),
          summary: sl02?.state === 'ready'
            ? `全库归档声量比（SL02）：命中 ${num.toLocaleString()} / 同期全库 ${den.toLocaleString()} 条归档主帖，折合 ${perM} 条 / 百万归档线程。`
            : sl02?.reason || '全库归档声量比仅对具备全库准入分母账本的 R4 离线归档可用。',
          primaryEvidenceId: extractEvidenceId(sl02?.data),
          rowEvidenceIds: days.map((d) => d.evidence_ref?.id),
        };
      }

      const seriesRows = asList<{ period: string; documents: number | null; delta?: number | null; growth?: number | null; collection?: string; evidence_ref?: { id?: string } }>(
        sl01?.data?.[p01Grain],
      );
      const option: EChartOption | null = seriesRows.length > 0 ? {
        tooltip: { trigger: 'axis' },
        grid: { left: 44, right: 20, top: 24, bottom: 32 },
        xAxis: { type: 'category', data: seriesRows.map((r) => r.period), axisLabel: { fontSize: 10, color: colors.muted } },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } }, axisLabel: { fontSize: 10, color: colors.muted } },
        series: [{
          name: t('Documents', '去重文档数'),
          type: 'line',
          smooth: 0.25,
          areaStyle: { opacity: 0.14 },
          itemStyle: { color: colors.primary },
          lineStyle: { width: 2, color: colors.primary },
          data: seriesRows.map((r) => r.documents ?? 0),
        }],
      } : null;

      const meaningfulRate = pctStr(sl03?.data?.meaningful_rate);
      const threads = sl03?.data?.threads;
      const authors = sl03?.data?.authors;
      const sl02Note = sl02?.state === 'ready' && typeof sl02.data?.per_million === 'number'
        ? `；全库归档声量比 ${(sl02.data.per_million as number).toFixed(1)} / 百万线程`
        : '';
      const summary = `共分析 ${sourceProfile.analyzedDocuments.toLocaleString()} 条去重文档（覆盖 ${seriesRows.length} 个${p01Grain === 'days' ? '日期' : p01Grain === 'weeks' ? '周' : '月'}分桶），有效讨论率 ${meaningfulRate}${threads ? `，独立线程 ${Number(threads).toLocaleString()}` : ''}${authors ? `，独立作者 ${Number(authors).toLocaleString()}` : ''}${sl02Note}。`;

      return {
        option,
        columns: [
          { key: 'period', label: t('Period (UTC)', '时间周期 (UTC)') },
          { key: 'documents', label: t('Documents', '去重文档数') },
          { key: 'delta', label: t('Delta', '环比变化') },
          { key: 'growth', label: t('Growth', '环比增速') },
          { key: 'collection', label: t('Coverage', '覆盖状态') },
        ],
        rows: seriesRows.map((r) => ({
          period: r.period,
          documents: r.documents ?? 0,
          delta: r.delta ?? '—',
          growth: typeof r.growth === 'number' ? `${(r.growth * 100).toFixed(1)}%` : '—',
          collection: r.collection ?? '—',
        })),
        summary,
        primaryEvidenceId: extractEvidenceId(sl03?.data),
        rowEvidenceIds: seriesRows.map((r) => r.evidence_ref?.id),
      };
    }

    if (pid === 'P02') {
      const sl26 = findMetric(panel, 'SL26');
      const before = asNum(sl26?.data?.before);
      const kept = asNum(sl26?.data?.kept);
      const exact = asNum(sl26?.data?.exact);
      const near = asNum(sl26?.data?.near);
      const groups = asList<{ retained_id: string; removed: number; evidence_ref?: { id?: string } }>(sl26?.data?.groups);
      const option: EChartOption = {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 48, right: 20, top: 20, bottom: 28 },
        xAxis: { type: 'category', data: [t('Before', '去重前'), t('Kept', '保留有效'), t('Exact Dup', '精确重复'), t('Near Dup', '近似重复')], axisLabel: { fontSize: 11, color: colors.muted } },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
        series: [{
          type: 'bar',
          barMaxWidth: 42,
          data: [
            { value: before, itemStyle: { color: colors.muted } },
            { value: kept, itemStyle: { color: colors.primary } },
            { value: exact, itemStyle: { color: colors.amber } },
            { value: near, itemStyle: { color: colors.coral } },
          ],
        }],
      };
      return {
        option,
        columns: [
          { key: 'retained_id', label: t('Retained Doc ID', '保留代表文档 ID') },
          { key: 'removed', label: t('Removed Duplicates', '归并重复条数') },
        ],
        rows: groups.length > 0
          ? groups.map((g) => ({ retained_id: g.retained_id, removed: g.removed }))
          : [{ retained_id: '全部唯一', removed: 0 }],
        summary: `去重前共 ${before.toLocaleString()} 条，保留 ${kept.toLocaleString()} 条独立文档（移除精确重复 ${exact} 条、近似重复 ${near} 条）。`,
        primaryEvidenceId: extractEvidenceId(sl26?.data),
        rowEvidenceIds: groups.map((g) => g.evidence_ref?.id),
      };
    }

    if (pid === 'P03') {
      const sr01 = findMetric(panel, 'SR01');
      const sr17 = findMetric(panel, 'SR17');
      if (p03Tab === 'engagement') {
        const channels = asList<{ source: string; channel: string; observations: number; median: number; p75: number; p90: number; max: number; coverage: number; zeros: number; evidence_ref?: { id?: string } }>(
          sr17?.data?.channels,
        );
        const option: EChartOption | null = channels.length > 0 ? {
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
          legend: { top: 0, textStyle: { fontSize: 10, color: colors.muted } },
          grid: { left: 48, right: 20, top: 30, bottom: 32 },
          xAxis: { type: 'category', data: channels.map((c) => `${c.source} · ${c.channel}`), axisLabel: { fontSize: 10, color: colors.muted } },
          yAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
          series: [
            { name: t('Median (P50)', '中位数 (P50)'), type: 'bar', data: channels.map((c) => Math.round(asNum(c.median) * 10) / 10), itemStyle: { color: colors.primary } },
            { name: 'P75', type: 'bar', data: channels.map((c) => Math.round(asNum(c.p75) * 10) / 10), itemStyle: { color: colors.teal } },
            { name: 'P90', type: 'bar', data: channels.map((c) => Math.round(asNum(c.p90) * 10) / 10), itemStyle: { color: colors.amber } },
          ],
        } : null;
        return {
          option,
          columns: [
            { key: 'channel', label: t('Platform · Channel', '平台 · 互动通道') },
            { key: 'observations', label: t('Observations', '有效观测数') },
            { key: 'median', label: 'P50 (中位数)' },
            { key: 'p75', label: 'P75' },
            { key: 'p90', label: 'P90' },
            { key: 'max', label: 'Max' },
            { key: 'zeros', label: t('True Zeros', '真实零互动') },
          ],
          rows: channels.map((c) => ({
            channel: `${c.source} · ${c.channel}`,
            observations: c.observations,
            median: Math.round(asNum(c.median) * 10) / 10,
            p75: Math.round(asNum(c.p75) * 10) / 10,
            p90: Math.round(asNum(c.p90) * 10) / 10,
            max: c.max,
            zeros: c.zeros,
          })),
          summary: channels.length > 0
            ? `共观测到 ${channels.length} 个独立平台互动通道，各平台按原生指标分别计算分位数（避免跨平台量纲混淆）。`
            : '当前数据源未携带可用的数值互动通道。',
          primaryEvidenceId: channels[0]?.evidence_ref?.id,
          rowEvidenceIds: channels.map((c) => c.evidence_ref?.id),
        };
      }

      const groups = asList<{ group: string; documents: number; share: number; authors?: number | null; threads?: number | null; evidence_ref?: { id?: string } }>(
        sr01?.data?.groups,
      ).slice(0, 12);
      const option: EChartOption | null = groups.length > 0 ? {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 110, right: 24, top: 16, bottom: 24 },
        xAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
        yAxis: { type: 'category', inverse: true, data: groups.map((g) => g.group), axisLabel: { fontSize: 10.5, color: colors.muted, width: 96, overflow: 'truncate' } },
        series: [{
          name: t('Documents', '文档数'),
          type: 'bar',
          barMaxWidth: 20,
          itemStyle: { color: colors.primary, borderRadius: [0, 4, 4, 0] },
          data: groups.map((g) => g.documents),
        }],
      } : null;
      return {
        option,
        columns: [
          { key: 'group', label: t('Community / Group', '社区 / 分组') },
          { key: 'documents', label: t('Documents', '文档数') },
          { key: 'share', label: t('Share', '占比') },
          { key: 'authors', label: t('Authors', '独立作者') },
          { key: 'threads', label: t('Threads', '独立线程') },
        ],
        rows: groups.map((g) => ({
          group: g.group,
          documents: g.documents,
          share: pctStr(g.share),
          authors: g.authors ?? '—',
          threads: g.threads ?? '—',
        })),
        summary: groups.length > 0
          ? `头部社区/分组为「${groups[0].group}」（${groups[0].documents} 条，占 ${pctStr(groups[0].share)}），共覆盖 ${groups.length} 个活跃分组。点击条形可下钻查看对应分组原文。`
          : '当前范围暂无可分组数据。',
        primaryEvidenceId: groups[0]?.evidence_ref?.id,
        rowEvidenceIds: groups.map((g) => g.evidence_ref?.id),
      };
    }

    if (pid === 'P04') {
      const sr04 = findMetric(panel, 'SR04');
      const sr05 = findMetric(panel, 'SR05');
      const sr06 = findMetric(panel, 'SR06');

      if (p04Tab === 'diff') {
        const comparisons = asList<{
          group?: string;
          label?: string;
          a?: string;
          b?: string;
          terms?: Array<{ term: string; z?: number; score?: number; log_odds?: number; documents?: number }>;
          top_a?: Array<{ term: string; z?: number; score?: number; log_odds?: number }>;
          top_b?: Array<{ term: string; z?: number; score?: number; log_odds?: number }>;
        }>(sr05?.data?.comparisons);

        const flatRows: Array<{ group: string; term: string; score: number }> = [];
        for (const comp of comparisons.slice(0, 6)) {
          const gLabel = comp.group || comp.label || comp.a || 'Group';
          const list = comp.terms ?? comp.top_a ?? [];
          for (const item of list.slice(0, 5)) {
            const val = typeof item.z === 'number' ? item.z : typeof item.log_odds === 'number' ? item.log_odds : asNum(item.score);
            flatRows.push({ group: gLabel, term: item.term, score: Math.round(val * 100) / 100 });
          }
          if (comp.b && comp.top_b?.length) {
            for (const item of comp.top_b.slice(0, 4)) {
              const val = typeof item.z === 'number' ? item.z : asNum(item.score);
              flatRows.push({ group: comp.b, term: item.term, score: -Math.abs(Math.round(val * 100) / 100) });
            }
          }
        }
        const chartRows = flatRows.slice(0, 14);
        const option: EChartOption | null = chartRows.length > 0 ? {
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
          grid: { left: 140, right: 24, top: 16, bottom: 24 },
          xAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
          yAxis: {
            type: 'category',
            inverse: true,
            data: chartRows.map((r) => `${r.term} (${r.group})`),
            axisLabel: { fontSize: 10, color: colors.muted, width: 128, overflow: 'truncate' },
          },
          series: [{
            name: 'Log-Odds Z',
            type: 'bar',
            barMaxWidth: 16,
            data: chartRows.map((r) => ({
              value: r.score,
              itemStyle: { color: r.score >= 0 ? colors.primary : colors.coral, borderRadius: 3 },
            })),
          }],
        } : null;
        return {
          option,
          columns: [
            { key: 'group', label: t('Group / Community', '分组 / 社区') },
            { key: 'term', label: t('Distinctive Term', '组间特有词') },
            { key: 'score', label: 'Log-Odds / Z' },
          ],
          rows: flatRows,
          summary: flatRows.length > 0
            ? `已基于 Dirichlet Log-Odds（SR05）识别出 ${comparisons.length} 组社区/分组间的方向性特有词。点击词条可加入当前检索二次聚焦。`
            : sr05?.reason || '至少需要 2 个活跃分组方可计算组间方向性特有词（SR05）。',
          rowEvidenceIds: [],
          clickableTerms: chartRows.map((r) => r.term),
        };
      }

      if (p04Tab === 'phrases') {
        const bigrams = asList<{ phrase?: string; term?: string; documents?: number; count?: number }>(sr06?.data?.bigrams).slice(0, 12);
        const trigrams = asList<{ phrase?: string; term?: string; documents?: number; count?: number }>(sr06?.data?.trigrams).slice(0, 6);
        const combined = [...bigrams.map((b) => ({ phrase: b.phrase || b.term || '', type: 'Bigram', docs: b.documents ?? b.count ?? 0 })),
          ...trigrams.map((tr) => ({ phrase: tr.phrase || tr.term || '', type: 'Trigram', docs: tr.documents ?? tr.count ?? 0 }))];
        const option: EChartOption | null = combined.length > 0 ? {
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
          grid: { left: 130, right: 24, top: 16, bottom: 24 },
          xAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
          yAxis: { type: 'category', inverse: true, data: combined.slice(0, 12).map((c) => c.phrase), axisLabel: { fontSize: 10.5, color: colors.muted, width: 118, overflow: 'truncate' } },
          series: [{ name: t('Docs', '文档频次'), type: 'bar', barMaxWidth: 18, itemStyle: { color: colors.teal, borderRadius: [0, 4, 4, 0] }, data: combined.slice(0, 12).map((c) => c.docs) }],
        } : null;
        return {
          option,
          columns: [
            { key: 'phrase', label: t('Collocation Phrase', '高频搭配短语') },
            { key: 'type', label: t('Type', '短语类型') },
            { key: 'docs', label: t('Documents', '文档频次') },
          ],
          rows: combined,
          summary: combined.length > 0 ? `提取出 ${combined.length} 组重复多词搭配，最高频短语为「${combined[0].phrase}」（${combined[0].docs} 篇）。点击任意词条可加入当前检索二次聚焦。` : '当前语料未提取出重复多词搭配。',
          rowEvidenceIds: [],
          clickableTerms: combined.slice(0, 12).map((c) => c.phrase),
        };
      }

      const terms = asList<{ term: string; documents?: number; df?: number; tfidf?: number; score?: number; evidence_ref?: { id?: string } }>(
        sr04?.data?.terms,
      ).slice(0, 15);
      const option: EChartOption | null = terms.length > 0 ? {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 110, right: 24, top: 16, bottom: 24 },
        xAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
        yAxis: { type: 'category', inverse: true, data: terms.map((it) => it.term), axisLabel: { fontSize: 10.5, color: colors.muted } },
        series: [{
          name: t('Doc Frequency', '文档频次'),
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: colors.primary, borderRadius: [0, 4, 4, 0] },
          data: terms.map((it) => it.documents ?? it.df ?? 0),
        }],
      } : null;
      return {
        option,
        columns: [
          { key: 'term', label: t('Distinctive Term', '核心特征词') },
          { key: 'documents', label: t('Documents', '命中文档数') },
          { key: 'tfidf', label: t('TF-IDF Weight', 'TF-IDF 权重') },
        ],
        rows: terms.map((it) => ({
          term: it.term,
          documents: it.documents ?? it.df ?? 0,
          tfidf: typeof it.tfidf === 'number' ? it.tfidf.toFixed(3) : typeof it.score === 'number' ? it.score.toFixed(3) : '—',
        })),
        summary: terms.length > 0 ? `最显著特征词包括「${terms.slice(0, 5).map((it) => it.term).join('、')}」。点击柱状条可将词条追加至搜索框进行二次聚焦探索。` : '当前语料特征词不足。',
        primaryEvidenceId: terms[0]?.evidence_ref?.id,
        rowEvidenceIds: terms.map((it) => it.evidence_ref?.id),
        clickableTerms: terms.map((it) => it.term),
      };
    }

    if (pid === 'P05') {
      const sr08 = findMetric(panel, 'SR08');
      const sr29 = findMetric(panel, 'SR29');
      const topics = asList<{
        name: string;
        documents: number;
        share: number;
        terms?: Array<{ term: string }>;
        representatives?: Array<{ excerpt?: string; similarity?: number; evidence_ref?: { id?: string } }>;
        evidence_ref?: { id?: string };
      }>((p05Tab === 'reps' ? sr29?.data?.topics : sr08?.data?.topics) ?? sr08?.data?.topics);

      if (p05Tab === 'reps') {
        const repRows: Array<{ topic: string; similarity: string; excerpt: string; evidenceId?: string }> = [];
        for (const tp of topics) {
          for (const rep of (tp.representatives ?? []).slice(0, 3)) {
            repRows.push({
              topic: tp.name,
              similarity: typeof rep.similarity === 'number' ? rep.similarity.toFixed(3) : '—',
              excerpt: (rep.excerpt ?? '').slice(0, 180) + ((rep.excerpt?.length ?? 0) > 180 ? '…' : ''),
              evidenceId: rep.evidence_ref?.id ?? tp.evidence_ref?.id,
            });
          }
        }
        return {
          option: null,
          columns: [
            { key: 'topic', label: t('Topic', '所属语义主题') },
            { key: 'similarity', label: t('Centroid Sim', '质心相似度') },
            { key: 'excerpt', label: t('Representative Excerpt', '代表性原帖摘录') },
          ],
          rows: repRows.map((r) => ({ topic: r.topic, similarity: r.similarity, excerpt: r.excerpt })),
          summary: repRows.length > 0
            ? `已为 ${topics.length} 个语义主题分别选出最贴近质心的独立线程代表内容（SR29，共 ${repRows.length} 条）。`
            : sr29?.reason || '暂无语义主题代表内容。',
          primaryEvidenceId: repRows[0]?.evidenceId,
          rowEvidenceIds: repRows.map((r) => r.evidenceId),
        };
      }

      const option: EChartOption | null = topics.length > 0 ? {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 150, right: 24, top: 16, bottom: 24 },
        xAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
        yAxis: { type: 'category', inverse: true, data: topics.map((tp) => tp.name), axisLabel: { fontSize: 10.5, color: colors.muted, width: 138, overflow: 'truncate' } },
        series: [{ name: t('Topic Docs', '主题文档数'), type: 'bar', barMaxWidth: 20, itemStyle: { color: colors.primary, borderRadius: [0, 4, 4, 0] }, data: topics.map((tp) => tp.documents) }],
      } : null;
      return {
        option,
        columns: [
          { key: 'name', label: t('Topic Cluster', '语义主题') },
          { key: 'documents', label: t('Documents', '文档数') },
          { key: 'share', label: t('Share', '占比') },
          { key: 'keywords', label: t('Top Terms', '代表词') },
        ],
        rows: topics.map((tp) => ({
          name: tp.name,
          documents: tp.documents,
          share: pctStr(tp.share),
          keywords: (tp.terms ?? []).slice(0, 5).map((k) => k.term).join(', ') || '—',
        })),
        summary: topics.length > 0
          ? `语义向量空间共识别出 ${topics.length} 个核心主题，最大主题「${topics[0].name}」占比 ${pctStr(topics[0].share)}。`
          : sr08?.reason || '当前未生成语义主题聚类。',
        primaryEvidenceId: topics[0]?.evidence_ref?.id,
        rowEvidenceIds: topics.map((tp) => tp.evidence_ref?.id),
      };
    }

    if (pid === 'P06') {
      const sr24 = findMetric(panel, 'SR24');
      const sr25 = findMetric(panel, 'SR25');

      if (p06Tab === 'calendar') {
        const cells = asList<{ date: string; topic_id: string; documents: number | null; evidence_ref?: { id?: string } }>(sr24?.data?.cells);
        const byDate = new Map<string, number>();
        for (const c of cells) {
          if (typeof c.documents === 'number') {
            byDate.set(c.date, (byDate.get(c.date) ?? 0) + c.documents);
          }
        }
        const dates = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
        const option: EChartOption | null = dates.length > 0 ? {
          tooltip: { trigger: 'axis' },
          grid: { left: 48, right: 20, top: 20, bottom: 28 },
          xAxis: { type: 'category', data: dates.map(([d]) => d), axisLabel: { fontSize: 10, color: colors.muted } },
          yAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
          series: [{
            name: t('Assigned Topic Docs', '归属主题文档数'),
            type: 'bar',
            itemStyle: { color: colors.primary, borderRadius: [3, 3, 0, 0] },
            data: dates.map(([, n]) => n),
          }],
        } : null;
        return {
          option,
          columns: [
            { key: 'date', label: t('Date (UTC)', '日期 (UTC)') },
            { key: 'documents', label: t('Assigned Topic Docs', '主题归属文档数') },
          ],
          rows: dates.map(([date, documents]) => ({ date, documents })),
          summary: dates.length > 0
            ? `已按 UTC 日历聚合 ${dates.length} 天的语义主题活跃度分布（SR24）。`
            : sr24?.reason || '暂无主题日历数据。',
          rowEvidenceIds: [],
        };
      }

      const cells = asList<{ weekday: number; hour: number; documents: number; evidence_ref?: { id?: string } }>(sr25?.data?.cells);
      const agg = new Map<string, number>();
      for (const c of cells) {
        const k = `${c.weekday}:${c.hour}`;
        agg.set(k, (agg.get(k) ?? 0) + asNum(c.documents));
      }
      const heatData = [...agg.entries()].map(([k, v]) => {
        const [d, h] = k.split(':').map(Number);
        return [h, d, v];
      });
      const maxVal = heatData.reduce((m, item) => Math.max(m, item[2]), 1);
      const option: EChartOption | null = heatData.length > 0 ? {
        tooltip: { position: 'top' },
        grid: { left: 48, right: 20, top: 16, bottom: 32 },
        xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, h) => `${h}h`), axisLabel: { fontSize: 10, color: colors.muted } },
        yAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], axisLabel: { fontSize: 10, color: colors.muted } },
        visualMap: { min: 0, max: maxVal, show: false, inRange: { color: ['#eef2ff', colors.primary] } },
        series: [{ type: 'heatmap', data: heatData }],
      } : null;
      return {
        option,
        columns: [
          { key: 'weekday', label: t('Weekday (UTC)', '星期 (UTC)') },
          { key: 'hour', label: t('Hour (UTC)', '小时 (UTC)') },
          { key: 'documents', label: t('Documents', '主题文档数') },
        ],
        rows: heatData.slice(0, 30).map(([h, d, v]) => ({ weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d] ?? d, hour: `${h}:00`, documents: v })),
        summary: heatData.length > 0 ? `已按 UTC 星期×小时绘制主题发帖节律热力图，峰值时段达 ${maxVal} 条讨论。` : sr25?.reason || '暂无主题时空分布数据。',
        rowEvidenceIds: [],
      };
    }

    if (pid === 'P07') {
      const sl04 = findMetric(panel, 'SL04');
      const days = asList<{ date: string; documents: number | null; baseline: number | null; z: number | null; is_anomaly?: boolean }>(sl04?.data?.days);
      const anomalies = asList<{ date: string; documents: number; z: number; evidence_ref?: { id?: string } }>(sl04?.data?.anomalies);
      const option: EChartOption | null = days.length > 0 ? {
        tooltip: { trigger: 'axis' },
        legend: { top: 0, textStyle: { fontSize: 10, color: colors.muted } },
        grid: { left: 44, right: 20, top: 30, bottom: 28 },
        xAxis: { type: 'category', data: days.map((d) => d.date), axisLabel: { fontSize: 10, color: colors.muted } },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
        series: [
          { name: t('Observed', '实际声量'), type: 'line', smooth: 0.2, itemStyle: { color: colors.primary }, data: days.map((d) => d.documents ?? 0) },
          { name: t('Baseline', '历史基线'), type: 'line', lineStyle: { type: 'dashed', color: colors.muted }, itemStyle: { color: colors.muted }, data: days.map((d) => d.baseline !== null ? Math.round(d.baseline * 10) / 10 : null) },
        ],
      } : null;
      return {
        option,
        columns: [
          { key: 'date', label: t('Date (UTC)', '日期 (UTC)') },
          { key: 'documents', label: t('Observed', '实际声量') },
          { key: 'baseline', label: t('Rolling Baseline', '滚动基线') },
          { key: 'z', label: 'Z-Score' },
        ],
        rows: (anomalies.length > 0 ? anomalies : days.slice(-14)).map((r) => ({
          date: r.date,
          documents: r.documents ?? 0,
          baseline: 'baseline' in r && typeof r.baseline === 'number' ? r.baseline.toFixed(1) : '—',
          z: typeof r.z === 'number' ? r.z.toFixed(2) : '—',
        })),
        summary: anomalies.length > 0
          ? `检测到 ${anomalies.length} 个显著声量异常日，最高异常日 ${anomalies[0].date}（${anomalies[0].documents} 条，Z=${asNum(anomalies[0].z).toFixed(1)}）。`
          : `已对 ${days.length} 个活跃日期计算滚动基线，当前未出现超过阈值的异常突增。`,
        primaryEvidenceId: anomalies[0]?.evidence_ref?.id,
        rowEvidenceIds: anomalies.map((a) => a.evidence_ref?.id),
      };
    }

    if (pid === 'P08') {
      const sl17 = findMetric(panel, 'SL17');
      const sl30 = findMetric(panel, 'SL30');
      const lifecycles = asList<{
        event_id: string;
        start: string;
        peak: string;
        end: string;
        duration_days?: number;
        peak_documents?: number;
        phases?: Array<{ phase?: string; documents?: number }>;
        evidence_ref?: { id?: string };
      }>(sl17?.data?.lifecycles);
      const summaries = asList<{
        event_id: string;
        documents?: number;
        terms?: Array<string | { term?: string; label?: string }>;
      }>(sl30?.data?.summaries);
      const summaryMap = new Map(summaries.map((s) => [s.event_id, s]));
      const formatTerms = (raw?: Array<string | { term?: string; label?: string }>) =>
        (raw ?? [])
          .map((item) => (typeof item === 'string' ? item : item?.term || item?.label || ''))
          .filter(Boolean)
          .join(', ');
      return {
        option: null,
        columns: [
          { key: 'event_id', label: t('Event', '事件') },
          { key: 'window', label: t('Window (UTC)', '起止区间') },
          { key: 'peak', label: t('Peak Date', '峰值日') },
          { key: 'peak_documents', label: t('Peak Docs', '峰值声量') },
          { key: 'terms', label: t('Key Terms', '核心诱因词') },
        ],
        rows: lifecycles.map((l) => {
          const sum = summaryMap.get(l.event_id);
          const peakPhaseDocs = l.phases?.find((ph) => ph.phase === 'peak')?.documents;
          return {
            event_id: l.event_id,
            window: `${l.start} ~ ${l.end}`,
            peak: l.peak,
            peak_documents: l.peak_documents ?? peakPhaseDocs ?? sum?.documents ?? '—',
            terms: formatTerms(sum?.terms) || '—',
          };
        }),
        summary: lifecycles.length > 0 ? `共梳理出 ${lifecycles.length} 个突发异常事件的完整生命周期与诱因词。` : '当前无异常事件。',
        primaryEvidenceId: lifecycles[0]?.evidence_ref?.id,
        rowEvidenceIds: lifecycles.map((l) => l.evidence_ref?.id),
      };
    }

    if (pid === 'P09') {
      const sl07 = findMetric(panel, 'SL07');
      const sl09 = findMetric(panel, 'SL09');
      const labels = asList<{ label: string; documents: number; share: number; evidence_ref?: { id?: string } }>(sl07?.data?.labels);
      const labelColor = (lbl: string) =>
        lbl === 'positive' ? colors.teal : lbl === 'negative' ? colors.coral : colors.muted;
      const option: EChartOption | null = labels.length > 0 ? {
        tooltip: { trigger: 'item' },
        grid: { left: 48, right: 20, top: 20, bottom: 28 },
        xAxis: { type: 'category', data: labels.map((l) => l.label), axisLabel: { fontSize: 11, color: colors.muted } },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
        series: [{
          name: t('Documents', '文档数'),
          type: 'bar',
          barMaxWidth: 44,
          data: labels.map((l) => ({ value: l.documents, itemStyle: { color: labelColor(l.label), borderRadius: [4, 4, 0, 0] } })),
        }],
      } : null;
      const posRate = pctStr(sl09?.data?.positive_rate);
      const negRate = pctStr(sl09?.data?.negative_rate);
      const den = asNum(sl09?.data?.denominator);
      return {
        option,
        columns: [
          { key: 'label', label: t('Polarity Label', '情感极性') },
          { key: 'documents', label: t('Documents', '文档数') },
          { key: 'share', label: t('Share of Corpus', '占总样本比') },
        ],
        rows: labels.map((l) => ({ label: l.label, documents: l.documents, share: pctStr(l.share) })),
        summary: den > 0
          ? `在 ${den.toLocaleString()} 条明确观点文档中，正面口碑占 ${posRate}，负面口碑占 ${negRate}（观点覆盖率 ${pctStr(sl07?.data?.coverage)}）。点击条形可回查对应极性原文。`
          : '当前样本以客观陈述为主，未识别出足够明确的正负观点。',
        primaryEvidenceId: labels.find((l) => l.label === 'negative')?.evidence_ref?.id ?? labels[0]?.evidence_ref?.id,
        rowEvidenceIds: labels.map((l) => l.evidence_ref?.id),
      };
    }

    if (pid === 'P10') {
      const pr02 = findMetric(panel, 'PR02');
      const states = asList<{ state: string; documents: number; rate: number; evidence_ref?: { id?: string } }>(pr02?.data?.states);
      const option: EChartOption | null = states.length > 0 ? {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 110, right: 24, top: 16, bottom: 24 },
        xAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
        yAxis: { type: 'category', inverse: true, data: states.map((s) => DEMAND_LABELS[s.state] ?? s.state), axisLabel: { fontSize: 11, color: colors.muted } },
        series: [{ name: t('Documents', '命中文档数'), type: 'bar', barMaxWidth: 20, itemStyle: { color: colors.primary, borderRadius: [0, 4, 4, 0] }, data: states.map((s) => s.documents) }],
      } : null;
      const hits = asNum(pr02?.data?.hits ?? pr02?.data?.documents);
      const rate = pctStr(pr02?.data?.rate);
      return {
        option,
        columns: [
          { key: 'state', label: t('Demand Signal', '需求信号类型') },
          { key: 'documents', label: t('Documents', '命中文档数') },
          { key: 'rate', label: t('Density', '占总样本密度') },
        ],
        rows: states.map((s) => ({ state: DEMAND_LABELS[s.state] ?? s.state, documents: s.documents, rate: pctStr(s.rate) })),
        summary: `共识别到 ${hits.toLocaleString()} 条主动需求讨论（需求密度 ${rate}），涵盖求推荐、替代方案探索、显式功能请求与未满足诉求。点击柱条可直达原句证据。`,
        primaryEvidenceId: extractEvidenceId(pr02?.data),
        rowEvidenceIds: states.map((s) => s.evidence_ref?.id),
      };
    }

    if (pid === 'P11') {
      const od05 = findMetric(panel, 'OD05');
      const od06 = findMetric(panel, 'OD06');
      const activeMetric = p11Tab === 'need' ? od05 : od06;
      const clusters = asList<{ name: string; documents?: number; passages?: number; support?: number; rate?: number; evidence_ref?: { id?: string } }>(
        activeMetric?.data?.clusters,
      );
      const valOf = (c: { documents?: number; passages?: number; support?: number }) =>
        asNum(c.documents ?? c.passages ?? c.support);
      const option: EChartOption | null = clusters.length > 0 ? {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 130, right: 24, top: 16, bottom: 24 },
        xAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
        yAxis: {
          type: 'category',
          inverse: true,
          data: clusters.map((c) => PAIN_LABELS[c.name] ?? c.name),
          axisLabel: { fontSize: 11, color: colors.muted, width: 118, overflow: 'truncate' },
        },
        series: [{
          name: p11Tab === 'need' ? t('Need Passages', '需求片段数') : t('Pain Docs', '痛点文档数'),
          type: 'bar',
          barMaxWidth: 20,
          itemStyle: { color: p11Tab === 'need' ? colors.teal : colors.coral, borderRadius: [0, 4, 4, 0] },
          data: clusters.map(valOf),
        }],
      } : null;
      return {
        option,
        columns: [
          { key: 'name', label: p11Tab === 'need' ? t('Need Cluster (OD05)', '需求语义簇 (OD05)') : t('Pain Cluster (OD06)', '痛点主题簇 (OD06)') },
          { key: 'documents', label: t('Support', '支撑文档/片段数') },
          { key: 'rate', label: t('Share', '占比') },
        ],
        rows: clusters.map((c) => ({ name: PAIN_LABELS[c.name] ?? c.name, documents: valOf(c), rate: pctStr(c.rate) })),
        summary: clusters.length > 0
          ? (p11Tab === 'need'
              ? `需求语义聚类（OD05）共归纳出 ${clusters.length} 个独立需求簇，最高频需求「${clusters[0].name}」（${valOf(clusters[0])} 条）。`
              : `痛点聚类（OD06）共识别到 ${clusters.length} 个主要痛点簇，最高频痛点为「${PAIN_LABELS[clusters[0].name] ?? clusters[0].name}」（${valOf(clusters[0])} 条）。`)
          : activeMetric?.reason || (p11Tab === 'need' ? '当前样本未形成显著需求语义簇。' : '当前样本未命中显著痛点簇。'),
        primaryEvidenceId: clusters[0]?.evidence_ref?.id,
        rowEvidenceIds: clusters.map((c) => c.evidence_ref?.id),
      };
    }

    // P12: Price & Purchase Stages
    const pr24 = findMetric(panel, 'PR24');
    const mi24 = findMetric(panel, 'MI24');
    const mi28 = findMetric(panel, 'MI28');
    if (p12Tab === 'prices') {
      const cohorts = asList<{ cohort?: string; currency?: string; period?: string; mentions?: number; min?: number; median?: number; max?: number; evidence_ref?: { id?: string } }>(
        mi24?.data?.cohorts,
      );
      const option: EChartOption | null = cohorts.length > 0 ? {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 100, right: 24, top: 16, bottom: 24 },
        xAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
        yAxis: { type: 'category', inverse: true, data: cohorts.map((c) => c.cohort || `${c.currency}/${c.period}`), axisLabel: { fontSize: 10.5, color: colors.muted } },
        series: [{ name: t('Median Amount', '中位金额'), type: 'bar', barMaxWidth: 20, itemStyle: { color: colors.amber, borderRadius: [0, 4, 4, 0] }, data: cohorts.map((c) => asNum(c.median)) }],
      } : null;
      return {
        option,
        columns: [
          { key: 'cohort', label: t('Currency / Period', '币种 / 周期') },
          { key: 'mentions', label: t('Mentions', '提及次数') },
          { key: 'min', label: t('Min', '最低') },
          { key: 'median', label: t('Median', '中位数') },
          { key: 'max', label: t('Max', '最高') },
        ],
        rows: cohorts.map((c) => ({
          cohort: c.cohort || `${c.currency}/${c.period}`,
          mentions: c.mentions ?? 0,
          min: c.min ?? '—',
          median: c.median ?? '—',
          max: c.max ?? '—',
        })),
        summary: cohorts.length > 0
          ? `共提取 ${cohorts.length} 组独立币种/周期价格区间（严格分币种统计，不跨币种混算）。价格关注文档共 ${asNum(pr24?.data?.documents)} 条（占比 ${pctStr(pr24?.data?.rate)}）。`
          : `价格关注讨论 ${asNum(pr24?.data?.documents)} 条，但未提取出带明确币种的金额数值。`,
        primaryEvidenceId: cohorts[0]?.evidence_ref?.id ?? extractEvidenceId(pr24?.data),
        rowEvidenceIds: cohorts.map((c) => c.evidence_ref?.id),
      };
    }

    const stages = asList<{ stage: string; documents: number; rate: number; evidence_ref?: { id?: string } }>(mi28?.data?.stages);
    const option: EChartOption | null = stages.length > 0 ? {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 96, right: 24, top: 16, bottom: 24 },
      xAxis: { type: 'value', splitLine: { lineStyle: { color: colors.grid } } },
      yAxis: { type: 'category', inverse: true, data: stages.map((s) => STAGE_LABELS[s.stage] ?? s.stage), axisLabel: { fontSize: 11, color: colors.muted } },
      series: [{ name: t('Documents', '命中文档数'), type: 'bar', barMaxWidth: 20, itemStyle: { color: colors.primary, borderRadius: [0, 4, 4, 0] }, data: stages.map((s) => s.documents) }],
    } : null;
    return {
      option,
      columns: [
        { key: 'stage', label: t('Purchase Stage', '购买决策阶段') },
        { key: 'documents', label: t('Documents', '命中文档数') },
        { key: 'rate', label: t('Share', '占总样本比') },
      ],
      rows: stages.map((s) => ({ stage: STAGE_LABELS[s.stage] ?? s.stage, documents: s.documents, rate: pctStr(s.rate) })),
      summary: `价格关注文档 ${asNum(pr24?.data?.documents)} 条（${pctStr(pr24?.data?.rate)}）；购买决策阶段采用多标签识别（单条讨论可同时属于多个阶段），点击阶段条可直达原文。`,
      primaryEvidenceId: extractEvidenceId(pr24?.data) ?? stages.find((s) => s.documents > 0)?.evidence_ref?.id,
      rowEvidenceIds: stages.map((s) => s.evidence_ref?.id),
    };
  }, [panel, p01Grain, p03Tab, p04Tab, p05Tab, p06Tab, p11Tab, p12Tab, colors, sourceProfile, t]);

  const block = useMemo(
    () => buildAdapterBlock(panel, sourceProfile, built.summary, glossaryNotes),
    [panel, sourceProfile, built.summary, glossaryNotes],
  );

  const controls = useMemo(() => {
    if (panel.panel_id === 'P01') {
      const hasSl02 = findMetric(panel, 'SL02')?.state === 'ready';
      return (
        <ToggleGroup value={[p01Grain]} onValueChange={(v) => { const next = v[v.length - 1]; if (next === 'days' || next === 'weeks' || next === 'months' || next === 'sl02') setP01Grain(next); }}>
          <ToggleGroupItem value="days">{t('Daily', '按日')}</ToggleGroupItem>
          <ToggleGroupItem value="weeks">{t('Weekly', '按周')}</ToggleGroupItem>
          <ToggleGroupItem value="months">{t('Monthly', '按月')}</ToggleGroupItem>
          {hasSl02 && <ToggleGroupItem value="sl02">{t('Archive Share (SL02)', '全库声量比')}</ToggleGroupItem>}
        </ToggleGroup>
      );
    }
    if (panel.panel_id === 'P03') {
      return (
        <ToggleGroup value={[p03Tab]} onValueChange={(v) => { const next = v[v.length - 1]; if (next === 'groups' || next === 'engagement') setP03Tab(next); }}>
          <ToggleGroupItem value="groups">{t('Groups', '分组份额')}</ToggleGroupItem>
          <ToggleGroupItem value="engagement">{t('Engagement', '独立互动分位')}</ToggleGroupItem>
        </ToggleGroup>
      );
    }
    if (panel.panel_id === 'P04') {
      return (
        <ToggleGroup value={[p04Tab]} onValueChange={(v) => { const next = v[v.length - 1]; if (next === 'terms' || next === 'diff' || next === 'phrases') setP04Tab(next); }}>
          <ToggleGroupItem value="terms">{t('Distinctive Terms', '核心特征词')}</ToggleGroupItem>
          <ToggleGroupItem value="diff">{t('Group Diff (SR05)', '组间差异词')}</ToggleGroupItem>
          <ToggleGroupItem value="phrases">{t('Collocations', '多词搭配')}</ToggleGroupItem>
        </ToggleGroup>
      );
    }
    if (panel.panel_id === 'P05') {
      return (
        <ToggleGroup value={[p05Tab]} onValueChange={(v) => { const next = v[v.length - 1]; if (next === 'topics' || next === 'reps') setP05Tab(next); }}>
          <ToggleGroupItem value="topics">{t('Topic Space', '主题分布')}</ToggleGroupItem>
          <ToggleGroupItem value="reps">{t('Representatives (SR29)', '主题代表原帖')}</ToggleGroupItem>
        </ToggleGroup>
      );
    }
    if (panel.panel_id === 'P06') {
      return (
        <ToggleGroup value={[p06Tab]} onValueChange={(v) => { const next = v[v.length - 1]; if (next === 'weekhour' || next === 'calendar') setP06Tab(next); }}>
          <ToggleGroupItem value="weekhour">{t('Weekday × Hour', '星期×小时热力')}</ToggleGroupItem>
          <ToggleGroupItem value="calendar">{t('Daily Calendar (SR24)', '主题日历')}</ToggleGroupItem>
        </ToggleGroup>
      );
    }
    if (panel.panel_id === 'P11') {
      return (
        <ToggleGroup value={[p11Tab]} onValueChange={(v) => { const next = v[v.length - 1]; if (next === 'pain' || next === 'need') setP11Tab(next); }}>
          <ToggleGroupItem value="pain">{t('Pain Clusters (OD06)', '痛点簇')}</ToggleGroupItem>
          <ToggleGroupItem value="need">{t('Need Clusters (OD05)', '需求语义簇')}</ToggleGroupItem>
        </ToggleGroup>
      );
    }
    if (panel.panel_id === 'P12') {
      return (
        <ToggleGroup value={[p12Tab]} onValueChange={(v) => { const next = v[v.length - 1]; if (next === 'stages' || next === 'prices') setP12Tab(next); }}>
          <ToggleGroupItem value="stages">{t('Purchase Stages', '购买决策阶段')}</ToggleGroupItem>
          <ToggleGroupItem value="prices">{t('Price Cohorts', '分币种价格带')}</ToggleGroupItem>
        </ToggleGroup>
      );
    }
    return null;
  }, [panel, p01Grain, p03Tab, p04Tab, p05Tab, p06Tab, p11Tab, p12Tab, t]);

  const onChartEvents = useMemo(
    () => ({
      click: (params: unknown) => {
        const idx = typeof (params as { dataIndex?: number })?.dataIndex === 'number'
          ? (params as { dataIndex: number }).dataIndex
          : -1;
        if (idx < 0) return;
        const evId = built.rowEvidenceIds[idx];
        if (evId) {
          onOpenEvidence(evId, `${t(meta.titleEn, meta.titleZh)} · 证据下钻`);
          return;
        }
        const term = built.clickableTerms?.[idx];
        if (term && onRefineQuery) {
          onRefineQuery(term);
        }
      },
    }),
    [built.rowEvidenceIds, built.clickableTerms, meta.titleEn, meta.titleZh, onOpenEvidence, onRefineQuery, t],
  );

  const metricStateBadges = (
    <div className="flex flex-wrap items-center gap-1">
      {panel.metrics.map((m) => (
        <Badge key={m.metric_id} variant={m.state === 'ready' ? 'secondary' : 'outline'} className="font-mono text-[10px]">
          {m.metric_id}
        </Badge>
      ))}
      {headerExtras}
    </div>
  );

  return (
    <AnalysisChartCard
      title={t(meta.titleEn, meta.titleZh)}
      subtitle={t(meta.subtitleEn, meta.subtitleZh)}
      block={block}
      projectName={`Explore · ${sourceProfile.sourceLabel}`}
      keywordLabels={query ? [query] : [t('All', '全量')]}
      option={built.option}
      height={265}
      columns={built.columns}
      rows={built.rows}
      controls={controls}
      headerExtras={metricStateBadges}
      tableOnly={!built.option}
      onChartEvents={onChartEvents}
      onTraceEvidence={
        built.primaryEvidenceId
          ? () => onOpenEvidence(built.primaryEvidenceId!, `${t(meta.titleEn, meta.titleZh)} · 精确证据`)
          : undefined
      }
      traceLabel={t('Inspect evidence', '回查原文证据')}
    />
  );
}
