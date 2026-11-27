import type {
  ReportChartSpec,
  ReportEvidenceItem,
  ReportScopeSummary,
  ReportSectionData,
} from "./types";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
  } catch {
    return null;
  }
  return null;
}

const CHART_COLORS = ["#0f766e", "#2563eb", "#d97706", "#7c3aed", "#dc2626", "#059669"];

function renderOfflineSvgChart(chart: ReportChartSpec): string {
  if (chart.kind === "table" && chart.table) {
    const head = chart.table.columns.map((c) => `<th>${esc(c)}</th>`).join("");
    const body = chart.table.rows
      .slice(0, 25)
      .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
      .join("");
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  const labels = chart.xLabels ?? [];
  const primary = chart.series?.[0];
  if (!labels.length || !primary || !primary.data.length) {
    return `<div class="chart-empty">暂无可用于绘图的有效数据点。</div>`;
  }

  if (chart.kind === "horizontal_bar" || (chart.kind === "bar" && labels.length <= 12)) {
    const rows = labels.slice(0, 12).map((lbl, i) => ({
      label: lbl,
      val: Number(primary.data[i] ?? 0),
    }));
    const maxVal = Math.max(1, ...rows.map((r) => r.val));
    const rowH = 28;
    const h = rows.length * rowH + 24;
    const bars = rows
      .map((r, i) => {
        const y = 12 + i * rowH;
        const w = Math.max(2, Math.round((r.val / maxVal) * 420));
        return `<g>
          <text x="165" y="${y + 16}" text-anchor="end" font-size="11.5" fill="#334155">${esc(r.label.slice(0, 24))}</text>
          <rect x="175" y="${y + 4}" width="${w}" height="16" rx="4" fill="${esc(primary.color || CHART_COLORS[0])}" opacity="0.88" />
          <text x="${182 + w}" y="${y + 16}" font-size="11" fill="#475569" font-family="ui-monospace,monospace">${esc(Number.isInteger(r.val) ? r.val.toLocaleString() : r.val.toFixed(1))}</text>
        </g>`;
      })
      .join("");
    return `<svg viewBox="0 0 680 ${h}" class="offline-svg" role="img" aria-label="${esc(chart.title)}">${bars}</svg>`;
  }

  // Line or multi-series chart
  const W = 680;
  const H = 220;
  const padL = 52;
  const padR = 20;
  const padT = 18;
  const padB = 38;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const allVals = chart.series.flatMap((s) => s.data.map((v) => Number(v) || 0));
  const maxVal = Math.max(1, ...allVals);
  const stepX = labels.length > 1 ? plotW / (labels.length - 1) : plotW;

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((frac) => {
      const y = padT + plotH * (1 - frac);
      const val = Math.round(maxVal * frac);
      return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e2e8f0" stroke-dasharray="3 3" />
        <text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#64748b">${esc(val.toLocaleString())}</text>`;
    })
    .join("");

  const paths = chart.series
    .slice(0, 4)
    .map((s, si) => {
      const color = s.color || CHART_COLORS[si % CHART_COLORS.length];
      const pts = s.data
        .map((v, i) => {
          const x = padL + i * stepX;
          const y = padT + plotH * (1 - (Number(v) || 0) / maxVal);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
      return `<polyline fill="none" stroke="${esc(color)}" stroke-width="2.2" points="${pts}" />`;
    })
    .join("");

  const labelStep = Math.max(1, Math.ceil(labels.length / 7));
  const xTicks = labels
    .map((lbl, i) => {
      if (i % labelStep !== 0 && i !== labels.length - 1) return "";
      const x = padL + i * stepX;
      return `<text x="${x.toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="10" fill="#64748b">${esc(lbl.slice(0, 12))}</text>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="offline-svg" role="img" aria-label="${esc(chart.title)}">${gridLines}${paths}${xTicks}</svg>`;
}

const KIND_LABELS: Record<string, string> = {
  observation: "观察事实",
  interpretation: "分析解读",
  hypothesis: "待验证假设",
  recommendation: "业务建议",
};

export function renderStandaloneReportHtml(doc: {
  id: string;
  title: string;
  subtitle: string;
  template: string;
  mode: string;
  createdAt: string;
  summary: string;
  scopes: ReportScopeSummary[];
  sections: ReportSectionData[];
  evidence: ReportEvidenceItem[];
  provenance: Record<string, unknown>;
}): string {
  const evidenceById = new Map(doc.evidence.map((e) => [e.id, e]));
  const templateLabels: Record<string, string> = {
    industry: "行业情报简报",
    commerce: "电商市场研究报告",
    social: "社媒舆情洞察报告",
    custom: "自定义研究报告",
  };
  const modeLabels: Record<string, string> = {
    llm_verified: "AI 归纳已校验",
    partial_llm: "部分章节 AI 归纳",
    pure_data: "纯数据统计报告",
  };

  const tocHtml = doc.sections
    .map((sec, i) => `<a href="#sec-${esc(sec.id)}"><span class="toc-num">${String(i + 1).padStart(2, "0")}</span>${esc(sec.title)}</a>`)
    .join("");

  const sectionsHtml = doc.sections
    .map((sec, idx) => {
      const kpis = sec.metrics.length
        ? `<div class="kpi-grid">${sec.metrics
            .map(
              (m) => `<div class="kpi-card">
                <div class="kpi-label">${esc(m.label)}</div>
                <div class="kpi-val">${esc(m.formatted)}<span class="kpi-unit">${esc(m.unit)}</span></div>
                ${m.denominator ? `<div class="kpi-sub">口径：${esc(m.denominator)}</div>` : ""}
              </div>`,
            )
            .join("")}</div>`
        : "";

      const charts = sec.charts
        .map(
          (ch) => `<div class="chart-card">
            <div class="chart-hd">
              <strong>${esc(ch.title)}</strong>
              <span>${esc(ch.subtitle || (ch.denominator ? `口径：${ch.denominator}` : `单位：${ch.unit}`))}</span>
            </div>
            ${renderOfflineSvgChart(ch)}
          </div>`,
        )
        .join("");

      const findings = sec.narrative?.findings?.length
        ? `<div class="findings">${sec.narrative.findings
            .map((f) => {
              const evChips = f.evidenceIds
                .map((eid) => `<a class="ev-chip" href="#ev-${esc(eid)}">${esc(eid)}</a>`)
                .join("");
              return `<div class="finding kind-${esc(f.kind)}">
                <div class="finding-hd">
                  <span class="badge">${esc(KIND_LABELS[f.kind] || f.kind)}</span>
                  <strong>${esc(f.title)}</strong>
                </div>
                <p>${esc(f.text)}</p>
                ${evChips ? `<div class="ev-row">证据引用：${evChips}</div>` : ""}
              </div>`;
            })
            .join("")}</div>`
        : "";

      const secEvItems = sec.evidenceIds
        .map((eid) => evidenceById.get(eid))
        .filter((e): e is ReportEvidenceItem => Boolean(e))
        .slice(0, 6);

      const evAccordion = secEvItems.length
        ? `<details class="ev-details"><summary>展开本节代表性原文证据（${secEvItems.length} 条）</summary>
            <div class="ev-list">${secEvItems
              .map((ev) => {
                const href = safeUrl(ev.url);
                return `<div class="ev-item" id="ev-${esc(ev.id)}">
                  <div class="ev-meta"><b>${esc(ev.id)}</b> · ${esc(ev.sourceLabel)}${ev.community ? ` · r/${esc(ev.community)}` : ""}${ev.publishedAt ? ` · ${esc(ev.publishedAt.slice(0, 16).replace("T", " "))} UTC` : ""}</div>
                  ${ev.title ? `<div class="ev-title">${esc(ev.title)}</div>` : ""}
                  <p class="ev-excerpt">${esc(ev.excerpt)}</p>
                  <div class="ev-foot"><span>${esc(ev.reason)}</span>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">查看原文 ↗</a>` : ""}</div>
                </div>`;
              })
              .join("")}</div>
          </details>`
        : "";

      const limitations = [...(sec.narrative?.limitations ?? []), ...sec.warnings].slice(0, 4);
      const limHtml = limitations.length
        ? `<div class="lim-box"><b>口径与局限：</b>${limitations.map((l) => esc(l)).join("；")}</div>`
        : "";

      return `<section class="report-sec" id="sec-${esc(sec.id)}">
        <div class="sec-eyebrow">CHAPTER ${String(idx + 1).padStart(2, "0")} · ${esc(sec.engineSource)}</div>
        <h2>${esc(sec.narrative?.heading || sec.title)}</h2>
        ${sec.narrative?.summary ? `<p class="sec-summary">${esc(sec.narrative.summary)}</p>` : `<p class="sec-summary">${esc(sec.stateMessage)}</p>`}
        ${kpis}
        ${charts}
        ${findings}
        ${evAccordion}
        ${limHtml}
      </section>`;
    })
    .join("");

  const scopesTable = doc.scopes
    .map(
      (s) => `<tr>
        <td>${esc(s.id)}</td>
        <td>${esc(s.sourceLabel)}</td>
        <td>${esc(s.query || "全范围")}</td>
        <td>${esc(s.range.from?.slice(0, 10) || "—")} ~ ${esc(s.range.to?.slice(0, 10) || "—")}</td>
        <td>${esc(s.matchedCount ?? "未计算")} ${esc(s.matchedUnit)}</td>
        <td>${esc(s.analyzedCount.toLocaleString())} ${esc(s.analyzedUnit)}</td>
        <td>${esc(s.dataVersion)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(doc.title)} · SIFTLINE 研究报告</title>
<style>
  :root { --bg:#f8faf9; --card:#ffffff; --ink:#0f172a; --muted:#475569; --line:#e2e8f0; --teal:#0f766e; --teal-soft:#f0fdfa; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--ink); line-height:1.65; }
  .layout { display:grid; grid-template-columns:240px minmax(0,1fr); max-width:1220px; margin:0 auto; gap:24px; padding:24px; }
  .toc { position:sticky; top:20px; align-self:start; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
  .toc h3 { margin:0 0 10px; font-size:12px; letter-spacing:.08em; color:var(--muted); text-transform:uppercase; }
  .toc a { display:flex; gap:8px; padding:6px 8px; border-radius:6px; text-decoration:none; color:var(--ink); font-size:13px; }
  .toc a:hover { background:var(--teal-soft); color:var(--teal); }
  .toc-num { font-family:ui-monospace,monospace; color:var(--teal); font-weight:600; }
  .paper { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:32px 36px; box-shadow:0 1px 3px rgba(15,23,42,.04); }
  .hero { border-bottom:2px solid var(--teal); padding-bottom:18px; margin-bottom:24px; }
  .hero-tags { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
  .tag { font-size:11.5px; padding:2px 9px; border-radius:99px; background:var(--teal-soft); color:var(--teal); border:1px solid #99f6e4; font-weight:600; }
  .hero h1 { margin:0 0 8px; font-size:26px; line-height:1.3; }
  .hero-sub { margin:0; color:var(--muted); font-size:13.5px; }
  .report-sec { padding:20px 0; border-bottom:1px solid var(--line); page-break-inside:avoid; }
  .sec-eyebrow { font-size:11px; color:var(--teal); font-weight:700; letter-spacing:.06em; text-transform:uppercase; }
  .report-sec h2 { margin:4px 0 10px; font-size:19px; }
  .sec-summary { margin:0 0 14px; font-size:14.5px; color:#1e293b; }
  .kpi-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; margin:12px 0 16px; }
  .kpi-card { background:#f8fafc; border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .kpi-label { font-size:12px; color:var(--muted); }
  .kpi-val { font-size:21px; font-weight:700; color:var(--ink); margin-top:2px; }
  .kpi-unit { font-size:12px; font-weight:500; color:var(--muted); margin-left:4px; }
  .kpi-sub { font-size:11px; color:#64748b; margin-top:3px; }
  .chart-card { border:1px solid var(--line); border-radius:10px; padding:14px; margin:12px 0; background:#fff; }
  .chart-hd { display:flex; justify-content:space-between; align-items:baseline; gap:10px; margin-bottom:8px; font-size:13px; }
  .chart-hd span { font-size:11.5px; color:var(--muted); }
  .offline-svg { width:100%; height:auto; display:block; }
  .findings { display:grid; gap:10px; margin:12px 0; }
  .finding { border:1px solid var(--line); border-left:3.5px solid var(--teal); border-radius:8px; padding:10px 14px; background:#fcfefd; }
  .finding.kind-hypothesis { border-left-color:#d97706; }
  .finding.kind-recommendation { border-left-color:#2563eb; }
  .finding-hd { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
  .badge { font-size:11px; padding:1px 7px; border-radius:4px; background:#e2e8f0; color:#334155; font-weight:600; }
  .finding p { margin:0; font-size:13.5px; color:#334155; }
  .ev-row { margin-top:6px; font-size:11.5px; color:var(--muted); }
  .ev-chip { display:inline-block; margin-right:6px; padding:1px 6px; border-radius:4px; background:var(--teal-soft); color:var(--teal); text-decoration:none; font-family:ui-monospace,monospace; }
  .ev-details { margin-top:12px; border:1px solid var(--line); border-radius:8px; padding:10px 14px; background:#f8fafc; }
  .ev-details summary { cursor:pointer; font-size:13px; font-weight:600; color:var(--teal); }
  .ev-list { display:grid; gap:10px; margin-top:10px; }
  .ev-item { background:#fff; border:1px solid var(--line); border-radius:8px; padding:10px 12px; font-size:12.5px; }
  .ev-meta { font-size:11.5px; color:var(--muted); margin-bottom:4px; }
  .ev-title { font-weight:600; margin-bottom:4px; }
  .ev-excerpt { margin:0 0 6px; color:#334155; white-space:pre-wrap; }
  .ev-foot { display:flex; justify-content:space-between; font-size:11.5px; color:#64748b; }
  .ev-foot a { color:var(--teal); }
  .lim-box { margin-top:10px; padding:8px 12px; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; font-size:12px; color:#92400e; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th, td { border-bottom:1px solid var(--line); padding:7px 9px; text-align:left; }
  th { background:#f8fafc; font-weight:600; color:#334155; }
  .footer-note { margin-top:20px; font-size:12px; color:#64748b; }
  @media (max-width: 900px) { .layout { grid-template-columns:1fr; } .toc { position:static; } .paper { padding:20px; } }
  @media print { .toc { display:none; } .layout { display:block; padding:0; } .paper { border:0; box-shadow:none; padding:0; } }
</style>
</head>
<body>
<div class="layout">
  <aside class="toc">
    <h3>报告目录</h3>
    ${tocHtml}
  </aside>
  <main class="paper">
    <header class="hero">
      <div class="hero-tags">
        <span class="tag">${esc(templateLabels[doc.template] || doc.template)}</span>
        <span class="tag">${esc(modeLabels[doc.mode] || doc.mode)}</span>
        <span class="tag">生成时间 ${esc(doc.createdAt.slice(0, 16).replace("T", " "))} UTC</span>
      </div>
      <h1>${esc(doc.title)}</h1>
      <p class="hero-sub">${esc(doc.subtitle || doc.summary)}</p>
    </header>
    ${sectionsHtml}
    <section class="report-sec" id="sec-scope-table">
      <div class="sec-eyebrow">PROVENANCE &amp; DATA SCOPES</div>
      <h2>数据范围快照</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>范围ID</th><th>资料来源</th><th>检索条件</th><th>实际时间覆盖</th><th>匹配规模</th><th>有效分析量</th><th>数据版本</th></tr></thead>
          <tbody>${scopesTable}</tbody>
        </table>
      </div>
      <p class="footer-note">本文件为 SIFTLINE 导出的离线研究报告快照（报告编号：${esc(doc.id)}，模型：${esc(String(doc.provenance.model ?? "纯数据统计"))}）。已导出副本不受后续在线权限撤销影响，请按授权范围合规使用。</p>
    </section>
  </main>
</div>
</body>
</html>`;
}
