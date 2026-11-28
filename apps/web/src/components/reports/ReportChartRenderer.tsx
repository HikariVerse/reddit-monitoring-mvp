import { useMemo } from 'react';
import { EChartBox, type EChartOption } from '../charts/EChartBox';
import type { ReportChartSpec } from '../../api/reports';

const PALETTE = ['#0f766e', '#2563eb', '#d97706', '#7c3aed', '#dc2626', '#059669'];

export function ReportChartRenderer({
  chart,
  onSelectEvidence,
}: {
  chart: ReportChartSpec;
  onSelectEvidence?: (evidenceIds: string[], title: string) => void;
}) {
  const option = useMemo<EChartOption | null>(() => {
    if (chart.kind === 'table') return null;

    if (chart.kind === 'heatmap' && chart.heatmap && chart.heatmap.xLabels.length > 0 && chart.heatmap.yLabels.length > 0) {
      const hm = chart.heatmap;
      const vals = hm.values.map((v) => v[2]);
      const hasNeg = vals.some((v) => v < 0);
      const minVal = hasNeg ? -1 : 0;
      const maxVal = hasNeg ? 1 : Math.max(1, ...vals);
      return {
        tooltip: {
          position: 'top',
          formatter: (p: unknown) => {
            const d = (p as { data?: [number, number, number] })?.data;
            if (!d) return '';
            const xl = hm.xLabels[d[0]] ?? '';
            const yl = hm.yLabels[d[1]] ?? '';
            const valFmt = hasNeg ? (d[2] >= 0 ? `+${d[2].toFixed(2)}` : d[2].toFixed(2)) : String(d[2]);
            return `${yl} × ${xl}<br/><strong>${valFmt}</strong> ${chart.unit}`;
          },
        },
        grid: { left: 112, right: 24, top: 18, bottom: 78 },
        xAxis: {
          type: 'category',
          data: hm.xLabels,
          splitArea: { show: true },
          axisLabel: { fontSize: 10.5, color: '#334155', rotate: hm.xLabels.length > 4 ? 28 : 0 },
        },
        yAxis: {
          type: 'category',
          data: hm.yLabels,
          splitArea: { show: true },
          axisLabel: { fontSize: 11, color: '#334155', width: 98, overflow: 'truncate' },
        },
        visualMap: {
          min: minVal,
          max: maxVal,
          calculable: false,
          orient: 'horizontal',
          left: 'center',
          bottom: 2,
          itemHeight: 90,
          itemWidth: 10,
          textStyle: { fontSize: 10, color: '#64748b' },
          inRange: hasNeg
            ? { color: ['#dc2626', '#fca5a5', '#f8fafc', '#6ee7b7', '#0f766e'] }
            : { color: ['#f8fafc', '#99f6e4', '#0f766e'] },
        },
        series: [{
          name: chart.title,
          type: 'heatmap',
          data: hm.values,
          label: {
            show: true,
            fontSize: 10,
            color: '#0f172a',
            formatter: (p: unknown) => {
              const d = (p as { data?: [number, number, number] })?.data;
              if (!d) return '';
              return hasNeg ? (d[2] >= 0 ? `+${d[2].toFixed(2)}` : d[2].toFixed(2)) : String(d[2]);
            },
          },
          emphasis: { itemStyle: { shadowBlur: 6, shadowColor: 'rgba(15, 23, 42, 0.25)' } },
        }],
      };
    }

    if (!chart.xLabels?.length || !chart.series?.length) return null;

    if (chart.kind === 'horizontal_bar') {
      const labels = [...chart.xLabels].reverse();
      return {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 140, right: 28, top: 16, bottom: 28 },
        xAxis: { type: 'value', splitLine: { lineStyle: { color: '#eef2f6' } } },
        yAxis: {
          type: 'category',
          data: labels,
          axisLabel: { width: 128, overflow: 'truncate', fontSize: 11.5, color: '#334155' },
        },
        series: chart.series.map((s, idx) => ({
          name: s.name,
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: s.color || PALETTE[idx % PALETTE.length], borderRadius: [0, 4, 4, 0] },
          data: [...s.data].reverse(),
        })),
      };
    }

    if (chart.kind === 'bar' || chart.kind === 'stacked_bar') {
      return {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 48, right: 20, top: 20, bottom: 42 },
        xAxis: { type: 'category', data: chart.xLabels, axisLabel: { fontSize: 11, color: '#475569' } },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: '#eef2f6' } } },
        series: chart.series.map((s, idx) => ({
          name: s.name,
          type: 'bar',
          stack: chart.kind === 'stacked_bar' ? 'total' : undefined,
          barMaxWidth: 28,
          itemStyle: { color: s.color || PALETTE[idx % PALETTE.length], borderRadius: [4, 4, 0, 0] },
          data: s.data,
        })),
      };
    }

    // Default line chart
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 48, right: 20, top: 20, bottom: 36 },
      xAxis: { type: 'category', data: chart.xLabels, boundaryGap: false, axisLabel: { fontSize: 11, color: '#475569' } },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#eef2f6' } } },
      series: chart.series.map((s, idx) => ({
        name: s.name,
        type: 'line',
        smooth: true,
        symbolSize: 5,
        lineStyle: { width: 2.2, color: s.color || PALETTE[idx % PALETTE.length] },
        itemStyle: { color: s.color || PALETTE[idx % PALETTE.length] },
        areaStyle: chart.series.length === 1 ? { color: 'rgba(15, 118, 110, 0.08)' } : undefined,
        data: s.data,
      })),
    };
  }, [chart]);

  return (
    <div className="ds-card" style={{ padding: 14, marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div>
          <strong style={{ fontSize: 13 }}>{chart.title}</strong>
          <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 8 }}>
            {chart.subtitle || (chart.denominator ? `口径：${chart.denominator}` : `单位：${chart.unit}`)}
          </span>
        </div>
        {chart.evidenceIds && chart.evidenceIds.length > 0 && onSelectEvidence && (
          <button
            type="button"
            className="ds-btn ds-btn--quiet"
            style={{ fontSize: 11.5, padding: '2px 8px' }}
            onClick={() => onSelectEvidence(chart.evidenceIds!, chart.title)}
          >
            查看关联证据（{chart.evidenceIds.length}）
          </button>
        )}
      </div>

      {chart.kind === 'table' && chart.table ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                {chart.table.columns.map((col) => (
                  <th key={col} style={{ textAlign: 'left', padding: '7px 9px', borderBottom: '1px solid var(--line)', color: 'var(--muted)', fontWeight: 600 }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chart.table.rows.map((row, ri) => (
                <tr key={ri} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  {row.map((cell, ci) => (
                    <td key={ci} style={{ padding: '7px 9px', color: 'var(--ink)' }}>
                      {String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : option ? (
        <div
          onClick={() => {
            if (chart.evidenceIds && chart.evidenceIds.length > 0 && onSelectEvidence) {
              onSelectEvidence(chart.evidenceIds, chart.title);
            }
          }}
          style={{ cursor: chart.evidenceIds && chart.evidenceIds.length > 0 && onSelectEvidence ? 'pointer' : undefined }}
        >
          <EChartBox
            option={option}
            height={
              chart.kind === 'horizontal_bar'
                ? Math.max(210, Math.min(360, chart.xLabels.length * 28 + 44))
                : chart.kind === 'heatmap'
                  ? Math.max(270, Math.min(380, (chart.heatmap?.yLabels.length ?? 6) * 32 + 96))
                  : 240
            }
          />
        </div>
      ) : (
        <div style={{ padding: '18px 0', textAlign: 'center', fontSize: 12, color: 'var(--muted)' }}>
          暂无足够的有效数据点绘制图表。
        </div>
      )}
    </div>
  );
}
