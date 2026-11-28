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

function safeJsonForScriptTag(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
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

function formatSummaryParagraphs(text: string): string {
  const cleaned = text.trim();
  if (!cleaned) return "";
  const explicit = cleaned.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (explicit.length > 1) {
    return explicit.map((p) => `<p>${esc(p)}</p>`).join("");
  }
  if (cleaned.length <= 180) return `<p>${esc(cleaned)}</p>`;
  const sentences = cleaned.split(/(?<=[。！？!?])\s*/).filter(Boolean);
  if (sentences.length <= 2) return `<p>${esc(cleaned)}</p>`;
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && buf.length + s.length > 165) {
      chunks.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.map((p) => `<p>${esc(p)}</p>`).join("");
}

function renderOfflineSvgChart(chart: ReportChartSpec): string {
  if (chart.kind === "table" && chart.table) {
    const head = chart.table.columns
      .map((c, ci) => `<th data-sort-col="${ci}" title="点击按此列排序">${esc(c)} <span class="sort-ind" aria-hidden="true">↕</span></th>`)
      .join("");
    const body = chart.table.rows
      .slice(0, 30)
      .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
      .join("");
    return `<div class="table-wrap"><table class="sortable-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  if (chart.kind === "heatmap" && chart.heatmap && chart.heatmap.xLabels.length > 0 && chart.heatmap.yLabels.length > 0) {
    const hm = chart.heatmap;
    const cols = hm.xLabels.slice(0, 10);
    const rows = hm.yLabels.slice(0, 10);
    const valMap = new Map<string, number>();
    let hasNeg = false;
    let maxAbs = 1;
    for (const [xi, yi, v] of hm.values) {
      valMap.set(`${xi}:${yi}`, v);
      if (v < 0) hasNeg = true;
      if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
    const padL = 112;
    const padT = 36;
    const cellW = Math.max(54, Math.min(78, Math.floor((660 - padL) / Math.max(1, cols.length))));
    const cellH = 30;
    const W = padL + cols.length * cellW + 18;
    const H = padT + rows.length * cellH + 16;

    const colorFor = (v: number): string => {
      if (hasNeg) {
        if (v >= 0.45) return "#0f766e";
        if (v >= 0.15) return "#5eead4";
        if (v > -0.15) return "#f1f5f9";
        if (v > -0.45) return "#fca5a5";
        return "#dc2626";
      }
      const ratio = Math.min(1, Math.max(0, v / maxAbs));
      return ratio > 0.66 ? "#0f766e" : ratio > 0.33 ? "#5eead4" : "#e2f5f2";
    };

    const colHeads = cols
      .map((c, ci) => `<text x="${padL + ci * cellW + cellW / 2}" y="22" text-anchor="middle" font-size="10.5" class="svg-lbl">${esc(c.length > 7 ? c.slice(0, 6) + "…" : c)}</text>`)
      .join("");
    const cellMarkup: string[] = [];
    for (let ri = 0; ri < rows.length; ri++) {
      const y = padT + ri * cellH;
      cellMarkup.push(`<text x="${padL - 8}" y="${y + 19}" text-anchor="end" font-size="11" class="svg-lbl">${esc(rows[ri].length > 13 ? rows[ri].slice(0, 12) + "…" : rows[ri])}</text>`);
      for (let ci = 0; ci < cols.length; ci++) {
        const x = padL + ci * cellW;
        const v = valMap.get(`${ci}:${ri}`);
        if (v === undefined) {
          cellMarkup.push(`<rect x="${x + 2}" y="${y + 2}" width="${cellW - 4}" height="${cellH - 4}" rx="4" fill="#f8fafc" stroke="#e2e8f0" stroke-width="0.6" />`);
          cellMarkup.push(`<text x="${x + cellW / 2}" y="${y + 19}" text-anchor="middle" font-size="10" fill="#94a3b8">—</text>`);
        } else {
          const bg = colorFor(v);
          const fg = (hasNeg && Math.abs(v) >= 0.45) || (!hasNeg && v / maxAbs > 0.66) ? "#ffffff" : "#0f172a";
          const txt = hasNeg ? (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)) : String(v);
          cellMarkup.push(
            `<g class="svg-bar-row" data-tip-title="${esc(rows[ri])} × ${esc(cols[ci])}" data-tip-val="${esc(txt)} ${esc(chart.unit)}" data-tip-sub="${esc(chart.subtitle || chart.title)}">` +
            `<rect x="${x + 2}" y="${y + 2}" width="${cellW - 4}" height="${cellH - 4}" rx="4" fill="${bg}" />` +
            `<text x="${x + cellW / 2}" y="${y + 19}" text-anchor="middle" font-size="10.5" font-weight="600" fill="${fg}" pointer-events="none">${esc(txt)}</text></g>`,
          );
        }
      }
    }
    return `<svg viewBox="0 0 ${W} ${H}" class="offline-svg" role="img" aria-label="${esc(chart.title)}">${colHeads}${cellMarkup.join("")}</svg>`;
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
    const sumVal = rows.reduce((s, r) => s + Math.max(0, r.val), 0);
    const rowH = 32;
    const h = rows.length * rowH + 22;
    const barColor = primary.color || CHART_COLORS[0];
    const bars = rows
      .map((r, i) => {
        const y = 10 + i * rowH;
        const w = Math.max(4, Math.round((r.val / maxVal) * 390));
        const valFmt = Number.isInteger(r.val) ? r.val.toLocaleString() : r.val.toFixed(1);
        const pct = sumVal > 0 ? `${((r.val / sumVal) * 100).toFixed(1)}%` : "";
        return `<g class="svg-bar-row" pointer-events="bounding-box" data-tip-title="${esc(r.label)}" data-tip-val="${esc(valFmt)} ${esc(chart.unit)}" data-tip-sub="${esc(pct ? `占当前展示项 ${pct}` : primary.name)}">
          <rect x="0" y="${y}" width="680" height="${rowH}" rx="6" fill="transparent" pointer-events="all" class="svg-hit" />
          <text x="176" y="${y + 20}" text-anchor="end" font-size="12" pointer-events="none" class="svg-lbl">${esc(r.label.length > 22 ? r.label.slice(0, 21) + "…" : r.label)}</text>
          <rect x="188" y="${y + 7}" width="390" height="18" rx="5" pointer-events="none" class="svg-track" />
          <rect x="188" y="${y + 7}" width="${w}" height="18" rx="5" fill="${esc(barColor)}" pointer-events="none" class="svg-bar" />
          <text x="${196 + w}" y="${y + 20}" font-size="11.5" font-weight="600" pointer-events="none" class="svg-val">${esc(valFmt)}</text>
        </g>`;
      })
      .join("");
    return `<svg viewBox="0 0 680 ${h}" class="offline-svg" role="img" aria-label="${esc(chart.title)}">${bars}</svg>`;
  }

  // Interactive Line / Area Chart with Hover Data Points
  const W = 680;
  const H = 240;
  const padL = 54;
  const padR = 22;
  const padT = 22;
  const padB = 42;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const allVals = chart.series.flatMap((s) => s.data.map((v) => Number(v) || 0));
  const maxVal = Math.max(1, ...allVals);
  const stepX = labels.length > 1 ? plotW / (labels.length - 1) : plotW;

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((frac) => {
      const y = padT + plotH * (1 - frac);
      const val = Math.round(maxVal * frac);
      return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="svg-grid" stroke-dasharray="3 3" />
        <text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="10.5" class="svg-axis">${esc(val.toLocaleString())}</text>`;
    })
    .join("");

  const seriesMarkup = chart.series
    .slice(0, 4)
    .map((s, si) => {
      const color = s.color || CHART_COLORS[si % CHART_COLORS.length];
      const coords = s.data.map((v, i) => ({
        x: padL + i * stepX,
        y: padT + plotH * (1 - (Number(v) || 0) / maxVal),
        v: Number(v) || 0,
        lbl: labels[i] ?? `#${i + 1}`,
      }));
      const pts = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
      const areaPts =
        si === 0 && coords.length > 1
          ? `${padL},${padT + plotH} ${pts} ${coords[coords.length - 1].x.toFixed(1)},${padT + plotH}`
          : "";
      const dots = coords
        .map((c) => {
          const valFmt = Number.isInteger(c.v) ? c.v.toLocaleString() : c.v.toFixed(2);
          return `<g class="svg-pt-group" data-tip-title="${esc(c.lbl)}" data-tip-val="${esc(valFmt)} ${esc(chart.unit)}" data-tip-sub="${esc(s.name)}">
            <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="10" fill="transparent" />
            <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.4" fill="${esc(color)}" stroke="#ffffff" stroke-width="1.5" class="svg-pt" />
          </g>`;
        })
        .join("");
      return `${areaPts ? `<polygon points="${areaPts}" fill="${esc(color)}" opacity="0.09" />` : ""}
        <polyline fill="none" stroke="${esc(color)}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" points="${pts}" />
        ${dots}`;
    })
    .join("");

  const labelStep = Math.max(1, Math.ceil(labels.length / 7));
  const xTicks = labels
    .map((lbl, i) => {
      if (i % labelStep !== 0 && i !== labels.length - 1) return "";
      const x = padL + i * stepX;
      return `<text x="${x.toFixed(1)}" y="${H - 14}" text-anchor="middle" font-size="10.5" class="svg-axis">${esc(lbl.slice(0, 12))}</text>`;
    })
    .join("");

  const legend =
    chart.series.length > 1
      ? `<div class="chart-legend">${chart.series
          .slice(0, 4)
          .map(
            (s, si) =>
              `<span><i style="background:${esc(s.color || CHART_COLORS[si % CHART_COLORS.length])}"></i>${esc(s.name)}</span>`,
          )
          .join("")}</div>`
      : "";

  return `${legend}<svg viewBox="0 0 ${W} ${H}" class="offline-svg" role="img" aria-label="${esc(chart.title)}">${gridLines}${seriesMarkup}${xTicks}</svg>`;
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

  const totalAnalyzed = doc.scopes.reduce((sum, s) => sum + (s.analyzedCount || 0), 0);
  const primaryRange = doc.scopes[0]?.range;
  const rangeLabel =
    primaryRange?.from || primaryRange?.to
      ? `${primaryRange.from?.slice(0, 10) || "—"} 至 ${primaryRange.to?.slice(0, 10) || "—"}`
      : "当前窗口";

  const tocHtml = doc.sections
    .map(
      (sec, i) =>
        `<a href="#sec-${esc(sec.id)}" class="toc-link" data-sec-id="${esc(sec.id)}"><span class="toc-num">${String(i + 1).padStart(2, "0")}</span><span class="toc-text">${esc(sec.title)}</span></a>`,
    )
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

      const topicPills = sec.narrative?.topicLabels?.length
        ? `<div class="topic-pills"><span class="topic-pills-lbl">归纳主题：</span>${sec.narrative.topicLabels
            .map(
              (tl) =>
                `<button type="button" class="topic-pill" data-open-ev="${esc(tl.evidenceIds.join(","))}" data-ev-title="${esc(`主题「${tl.label}」关联证据`)}">${esc(tl.label)}</button>`,
            )
            .join("")}</div>`
        : "";

      const resolveChartLabels = (ch: ReportChartSpec): ReportChartSpec => {
        if (ch.id !== "C_P05_TOPICS" || !sec.narrative?.topicLabels?.length || !ch.xLabels?.length) return ch;
        const byGroup = new Map(sec.narrative.topicLabels.map((tl) => [tl.groupId, tl.label]));
        const nextLabels = ch.xLabels.map((raw, i) => {
          if (raw.startsWith("其他零散讨论")) return raw;
          const exact = byGroup.get(raw) ?? byGroup.get(`T${i + 1}`) ?? sec.narrative?.topicLabels?.[i]?.label;
          return exact && exact.trim() ? exact.trim() : raw;
        });
        return { ...ch, xLabels: nextLabels };
      };

      const charts = sec.charts
        .map((rawCh) => {
          const ch = resolveChartLabels(rawCh);
          return `<div class="chart-card">
            <div class="chart-hd">
              <div>
                <strong>${esc(ch.title)}</strong>
                <span class="chart-sub">${esc(ch.subtitle || (ch.denominator ? `口径：${ch.denominator}` : `单位：${ch.unit}`))}</span>
              </div>
              ${ch.evidenceIds?.length ? `<button type="button" class="mini-btn" data-open-ev="${esc(ch.evidenceIds.join(","))}" data-ev-title="${esc(ch.title)}">查看关联证据 (${ch.evidenceIds.length})</button>` : ""}
            </div>
            ${renderOfflineSvgChart(ch)}
          </div>`;
        })
        .join("");

      const findings = sec.narrative?.findings?.length
        ? `<div class="findings">${sec.narrative.findings
            .map((f) => {
              const evChips = f.evidenceIds
                .map(
                  (eid) =>
                    `<button type="button" class="ev-chip" data-open-ev="${esc(eid)}" data-ev-title="${esc(f.title)}">${esc(eid)}</button>`,
                )
                .join("");
              return `<article class="finding kind-${esc(f.kind)}" data-finding-kind="${esc(f.kind)}">
                <div class="finding-hd">
                  <span class="badge badge-${esc(f.kind)}">${esc(KIND_LABELS[f.kind] || f.kind)}</span>
                  <strong>${esc(f.title)}</strong>
                </div>
                <p>${esc(f.text)}</p>
                ${evChips ? `<div class="ev-row"><span>溯源证据：</span>${evChips}</div>` : ""}
              </article>`;
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

      const summaryHtml = formatSummaryParagraphs(sec.narrative?.summary || sec.stateMessage);
      const isExec = sec.id === "executive_summary";
      const chapterTag =
        sec.engineSource === "system"
          ? "核心综合"
          : sec.engineSource
              .replace(/^Explore\s+P\d+\s*\([^)]*\)/i, "深度统计分析")
              .replace(/^StoryInsights.*/i, "热点资讯聚类")
              .replace(/^SIFTLINE.*/i, "报告与溯源");

      return `<section class="report-sec ${isExec ? "report-sec--exec" : ""}" id="sec-${esc(sec.id)}" data-sec-id="${esc(sec.id)}">
        <div class="sec-top">
          <div>
            <div class="sec-eyebrow">第 ${String(idx + 1).padStart(2, "0")} 章 · ${esc(chapterTag)}</div>
            <h2>${esc(sec.narrative?.heading || sec.title)}</h2>
          </div>
          ${sec.evidenceIds.length > 0 ? `<button type="button" class="mini-btn" data-open-ev="${esc(sec.evidenceIds.join(","))}" data-ev-title="${esc(`${sec.title} · 关联原文证据`)}">本节证据 (${sec.evidenceIds.length})</button>` : ""}
        </div>
        <div class="sec-summary ${isExec ? "sec-summary--callout" : ""}">${summaryHtml}</div>
        ${topicPills}
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
        <td><code>${esc(s.id)}</code></td>
        <td>${esc(s.sourceLabel)}</td>
        <td>${esc(s.query || "全范围")}</td>
        <td>${esc(s.range.from?.slice(0, 10) || "—")} ~ ${esc(s.range.to?.slice(0, 10) || "—")}</td>
        <td>${esc(s.matchedCount ?? "未计算")} ${esc(s.matchedUnit)}</td>
        <td>${esc(s.analyzedCount.toLocaleString())} ${esc(s.analyzedUnit)}</td>
        <td><code>${esc(s.dataVersion)}</code></td>
      </tr>`,
    )
    .join("");

  const safeEvidencePayload = safeJsonForScriptTag(
    doc.evidence.map((ev) => ({
      id: ev.id,
      sourceLabel: ev.sourceLabel,
      community: ev.community ?? "",
      publishedAt: ev.publishedAt ? ev.publishedAt.slice(0, 16).replace("T", " ") + " UTC" : "",
      title: ev.title,
      excerpt: ev.excerpt,
      reason: ev.reason,
      url: safeUrl(ev.url),
    })),
  );

  const plainExecSummary = safeJsonForScriptTag(
    `${doc.title}\n${doc.subtitle}\n\n${doc.sections[0]?.narrative?.summary || doc.summary}`,
  );

  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(doc.title)} · SIFTLINE 研究报告</title>
<style>
  :root {
    --bg:#f4f7f6; --card:#ffffff; --card-alt:#f8fafc; --ink:#0f172a; --ink-2:#334155; --muted:#64748b;
    --line:#e2e8f0; --teal:#0f766e; --teal-dark:#115e59; --teal-soft:#f0fdfa; --teal-border:#99f6e4;
    --warn-bg:#fffbeb; --warn-border:#fde68a; --warn-ink:#92400e; --shadow:0 4px 20px rgba(15,23,42,.05);
  }
  html[data-theme="sepia"] {
    --bg:#f5f1e8; --card:#fcf9f2; --card-alt:#f4efe3; --ink:#292524; --ink-2:#44403c; --muted:#78716c;
    --line:#e6dec8; --teal:#0f766e; --teal-dark:#115e59; --teal-soft:#e8f5f1; --teal-border:#a7d9cc;
  }
  html[data-theme="dark"] {
    --bg:#0b1220; --card:#111827; --card-alt:#1e293b; --ink:#f1f5f9; --ink-2:#cbd5e1; --muted:#94a3b8;
    --line:#243247; --teal:#2dd4bf; --teal-dark:#14b8a6; --teal-soft:rgba(45,212,191,.12); --teal-border:rgba(45,212,191,.35);
    --warn-bg:rgba(245,158,11,.12); --warn-border:rgba(245,158,11,.35); --warn-ink:#fcd34d;
  }
  * { box-sizing:border-box; }
  html { scroll-behavior:smooth; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--ink); line-height:1.75; -webkit-font-smoothing:antialiased; }
  #read-progress { position:fixed; top:0; left:0; height:3px; width:0; background:linear-gradient(90deg,var(--teal),#2563eb); z-index:100; transition:width .12s linear; }
  .layout { display:grid; grid-template-columns:256px minmax(0,1fr); max-width:1280px; margin:0 auto; gap:26px; padding:24px; }
  .toc { position:sticky; top:18px; align-self:start; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; box-shadow:var(--shadow); max-height:calc(100vh - 36px); overflow-y:auto; }
  .toc h3 { margin:0 0 10px; font-size:11px; letter-spacing:.1em; color:var(--muted); text-transform:uppercase; }
  .toc-link { display:flex; gap:8px; padding:7px 9px; border-radius:8px; text-decoration:none; color:var(--ink-2); font-size:12.5px; transition:all .15s; align-items:baseline; }
  .toc-link:hover { background:var(--teal-soft); color:var(--teal); }
  .toc-link.is-active { background:var(--teal-soft); color:var(--teal); font-weight:650; border-left:3px solid var(--teal); padding-left:6px; }
  .toc-num { font-family:ui-monospace,SFMono-Regular,monospace; color:var(--teal); font-weight:700; font-size:11.5px; flex-shrink:0; }
  .toc-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .toc-actions { border-top:1px solid var(--line); margin-top:14px; padding-top:12px; display:grid; gap:7px; }
  .tool-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:7px 11px; border-radius:8px; border:1px solid var(--line); background:var(--card-alt); color:var(--ink); font-size:12px; font-weight:500; cursor:pointer; transition:all .15s; }
  .tool-btn:hover { border-color:var(--teal); color:var(--teal); background:var(--teal-soft); }
  .tool-btn--primary { background:var(--teal); color:#fff; border-color:var(--teal); }
  .tool-btn--primary:hover { background:var(--teal-dark); color:#fff; }
  .theme-row { display:grid; grid-template-columns:repeat(3,1fr); gap:4px; }
  .theme-row button { padding:5px 4px; font-size:11px; border-radius:6px; border:1px solid var(--line); background:var(--card-alt); color:var(--muted); cursor:pointer; }
  .theme-row button.on { background:var(--teal-soft); color:var(--teal); border-color:var(--teal-border); font-weight:650; }
  .paper { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:36px 42px; box-shadow:var(--shadow); min-width:0; }
  .hero { border-bottom:1px solid var(--line); padding-bottom:24px; margin-bottom:22px; }
  .hero-band { background:linear-gradient(135deg,var(--teal-soft),rgba(37,99,235,.06)); border:1px solid var(--teal-border); border-radius:14px; padding:24px 26px; }
  .hero-tags { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
  .tag { font-size:11.5px; padding:3px 10px; border-radius:99px; background:var(--card); color:var(--teal); border:1px solid var(--teal-border); font-weight:650; }
  .hero h1 { margin:0 0 10px; font-size:28px; line-height:1.28; letter-spacing:-.015em; }
  .hero-sub { margin:0; color:var(--ink-2); font-size:14.5px; line-height:1.65; }
  .hero-kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-top:16px; }
  .hero-kpi { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 14px; }
  .hero-kpi small { display:block; font-size:11px; color:var(--muted); }
  .hero-kpi strong { font-size:16px; color:var(--ink); font-family:ui-monospace,SFMono-Regular,monospace; }
  .filter-bar { position:sticky; top:0; z-index:20; background:var(--card); border-bottom:1px solid var(--line); padding:12px 0; margin-bottom:18px; display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between; }
  .filter-pills { display:flex; gap:6px; flex-wrap:wrap; }
  .fpill { padding:5px 11px; border-radius:99px; border:1px solid var(--line); background:var(--card-alt); color:var(--ink-2); font-size:12px; cursor:pointer; transition:all .15s; }
  .fpill:hover { border-color:var(--teal); }
  .fpill.on { background:var(--teal); color:#fff; border-color:var(--teal); font-weight:600; }
  .search-box { display:flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:8px; padding:4px 10px; background:var(--card-alt); min-width:210px; }
  .search-box input { border:0; background:transparent; outline:none; color:var(--ink); font-size:12.5px; width:100%; }
  .search-count { font-size:11px; color:var(--muted); white-space:nowrap; }
  .report-sec { padding:24px 0; border-bottom:1px solid var(--line); scroll-margin-top:64px; }
  .sec-top { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; margin-bottom:10px; }
  .sec-eyebrow { font-size:11px; color:var(--teal); font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
  .report-sec h2 { margin:4px 0 0; font-size:21px; line-height:1.35; }
  .sec-summary { font-size:15px; color:var(--ink-2); margin:0 0 16px; max-width:74ch; }
  .sec-summary p { margin:0 0 10px; }
  .sec-summary p:last-child { margin-bottom:0; }
  .sec-summary--callout { background:var(--teal-soft); border-left:4px solid var(--teal); padding:16px 20px; border-radius:0 12px 12px 0; color:var(--ink); font-size:15.5px; }
  .topic-pills { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:14px; }
  .topic-pills-lbl { font-size:12px; color:var(--muted); font-weight:600; }
  .topic-pill { padding:4px 10px; border-radius:99px; border:1px solid var(--teal-border); background:var(--teal-soft); color:var(--teal); font-size:12px; font-weight:600; cursor:pointer; }
  .kpi-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin:14px 0 18px; }
  .kpi-card { background:var(--card-alt); border:1px solid var(--line); border-top:3px solid var(--teal); border-radius:10px; padding:12px 15px; }
  .kpi-label { font-size:12px; color:var(--muted); }
  .kpi-val { font-size:22px; font-weight:750; color:var(--ink); margin-top:3px; font-variant-numeric:tabular-nums; }
  .kpi-unit { font-size:12px; font-weight:500; color:var(--muted); margin-left:4px; }
  .kpi-sub { font-size:11px; color:var(--muted); margin-top:3px; }
  .chart-card { border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin:14px 0; background:var(--card); }
  .chart-hd { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
  .chart-hd strong { font-size:14px; display:block; }
  .chart-sub { font-size:11.5px; color:var(--muted); }
  .chart-legend { display:flex; gap:14px; flex-wrap:wrap; font-size:11.5px; color:var(--muted); margin-bottom:6px; }
  .chart-legend i { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:5px; vertical-align:-1px; }
  .offline-svg { width:100%; height:auto; display:block; overflow:visible; }
  .svg-lbl { fill:var(--ink-2); }
  .svg-val { fill:var(--ink); font-family:ui-monospace,SFMono-Regular,monospace; }
  .svg-track { fill:var(--card-alt); }
  .svg-bar { opacity:.9; transition:opacity .15s, filter .15s; cursor:pointer; }
  .svg-bar-row:hover .svg-bar { opacity:1; filter:brightness(1.08); }
  .svg-bar-row:hover .svg-hit { fill:var(--teal-soft); }
  .svg-grid { stroke:var(--line); }
  .svg-axis { fill:var(--muted); }
  .svg-pt { transition:r .15s; cursor:pointer; }
  .svg-pt-group:hover .svg-pt { r:5.5; }
  .mini-btn { padding:4px 10px; border-radius:7px; border:1px solid var(--line); background:var(--card-alt); color:var(--teal); font-size:11.5px; font-weight:600; cursor:pointer; }
  .mini-btn:hover { background:var(--teal-soft); border-color:var(--teal-border); }
  .findings { display:grid; gap:12px; margin:14px 0; }
  .finding { border:1px solid var(--line); border-left:4px solid var(--teal); border-radius:10px; padding:13px 16px; background:var(--card-alt); transition:transform .12s, box-shadow .12s; }
  .finding:hover { box-shadow:0 3px 12px rgba(15,23,42,.06); }
  .finding.kind-interpretation { border-left-color:#2563eb; }
  .finding.kind-hypothesis { border-left-color:#d97706; }
  .finding.kind-recommendation { border-left-color:#7c3aed; }
  .finding.is-hidden { display:none; }
  .finding-hd { display:flex; align-items:center; gap:9px; margin-bottom:6px; flex-wrap:wrap; }
  .finding-hd strong { font-size:14.5px; color:var(--ink); }
  .badge { font-size:11px; padding:2px 8px; border-radius:5px; font-weight:650; }
  .badge-observation { background:var(--teal-soft); color:var(--teal); }
  .badge-interpretation { background:rgba(37,99,235,.12); color:#2563eb; }
  .badge-hypothesis { background:rgba(217,119,6,.14); color:#b45309; }
  .badge-recommendation { background:rgba(124,58,237,.12); color:#7c3aed; }
  .finding p { margin:0; font-size:14px; color:var(--ink-2); line-height:1.7; }
  .ev-row { margin-top:8px; font-size:11.5px; color:var(--muted); display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .ev-chip { display:inline-block; padding:2px 8px; border-radius:5px; background:var(--teal-soft); color:var(--teal); border:1px solid var(--teal-border); font-family:ui-monospace,SFMono-Regular,monospace; font-size:11px; font-weight:650; cursor:pointer; }
  .ev-chip:hover { background:var(--teal); color:#fff; }
  .ev-details { margin-top:14px; border:1px solid var(--line); border-radius:10px; padding:10px 14px; background:var(--card-alt); }
  .ev-details summary { cursor:pointer; font-size:13px; font-weight:650; color:var(--teal); }
  .ev-list { display:grid; gap:10px; margin-top:10px; }
  .ev-item { background:var(--card); border:1px solid var(--line); border-radius:9px; padding:12px 14px; font-size:13px; }
  .ev-meta { font-size:11.5px; color:var(--muted); margin-bottom:4px; }
  .ev-title { font-weight:650; margin-bottom:4px; color:var(--ink); }
  .ev-excerpt { margin:0 0 6px; color:var(--ink-2); white-space:pre-wrap; line-height:1.6; }
  .ev-foot { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; font-size:11.5px; color:var(--muted); }
  .ev-foot a { color:var(--teal); font-weight:600; }
  .lim-box { margin-top:12px; padding:10px 14px; background:var(--warn-bg); border:1px solid var(--warn-border); border-radius:9px; font-size:12.5px; color:var(--warn-ink); }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { border-bottom:1px solid var(--line); padding:8px 10px; text-align:left; }
  th { background:var(--card-alt); font-weight:650; color:var(--ink); cursor:pointer; user-select:none; white-space:nowrap; }
  th:hover { color:var(--teal); }
  .sort-ind { opacity:.45; font-size:10px; margin-left:3px; }
  .footer-note { margin-top:18px; font-size:12px; color:var(--muted); }
  #svg-tooltip { position:fixed; pointer-events:none; z-index:90; opacity:0; transition:opacity .12s; background:rgba(15,23,42,.94); color:#f8fafc; padding:8px 12px; border-radius:8px; font-size:12px; box-shadow:0 8px 24px rgba(0,0,0,.22); max-width:280px; }
  #svg-tooltip b { display:block; font-size:13px; color:#5eead4; margin-top:2px; font-family:ui-monospace,SFMono-Regular,monospace; }
  #svg-tooltip small { display:block; color:#cbd5e1; margin-top:2px; font-size:11px; }
  .drawer-backdrop { position:fixed; inset:0; background:rgba(15,23,42,.42); z-index:80; display:none; justify-content:flex-end; }
  .drawer-backdrop.open { display:flex; }
  .drawer { width:min(540px,94vw); height:100%; background:var(--card); color:var(--ink); box-shadow:-8px 0 32px rgba(0,0,0,.22); display:flex; flex-direction:column; }
  .drawer-hd { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:10px; }
  .drawer-hd strong { font-size:15px; }
  .drawer-search { padding:10px 18px; border-bottom:1px solid var(--line); background:var(--card-alt); display:flex; gap:8px; }
  .drawer-search input { flex:1; padding:6px 10px; border-radius:7px; border:1px solid var(--line); background:var(--card); color:var(--ink); font-size:12.5px; }
  .drawer-bd { flex:1; overflow-y:auto; padding:16px 18px; display:grid; gap:10px; align-content:start; }
  #toast { position:fixed; bottom:22px; right:22px; z-index:95; background:var(--ink); color:var(--card); padding:9px 15px; border-radius:9px; font-size:12.5px; opacity:0; transform:translateY(8px); transition:all .2s; pointer-events:none; }
  #toast.show { opacity:1; transform:translateY(0); }
  mark.hl { background:#fef08a; color:#0f172a; padding:0 2px; border-radius:3px; }
  @media (max-width: 960px) { .layout { grid-template-columns:1fr; padding:14px; } .toc { position:static; max-height:none; } .paper { padding:22px 18px; } }
  @media print { #read-progress, .toc, .filter-bar, .mini-btn, .drawer-backdrop, #svg-tooltip, #toast { display:none !important; } .layout { display:block; padding:0; } .paper { border:0; box-shadow:none; padding:0; } .report-sec { page-break-inside:avoid; } details.ev-details { display:block; } }
</style>
</head>
<body>
<div id="read-progress" aria-hidden="true"></div>
<div class="layout">
  <aside class="toc">
    <h3>报告目录 · CONTENTS</h3>
    <nav id="toc-nav">${tocHtml}</nav>
    <div class="toc-actions">
      <div class="theme-row" role="group" aria-label="阅读主题">
        <button type="button" data-set-theme="light" class="on">浅色</button>
        <button type="button" data-set-theme="sepia">纸感</button>
        <button type="button" data-set-theme="dark">深色</button>
      </div>
      <button type="button" class="tool-btn tool-btn--primary" id="btn-all-ev">查看全部证据（${doc.evidence.length}）</button>
      <button type="button" class="tool-btn" id="btn-copy-summary">复制核心摘要</button>
      <button type="button" class="tool-btn" id="btn-toggle-ev">展开 / 收起内联证据</button>
      <button type="button" class="tool-btn" onclick="window.print()">打印 / 导出 PDF</button>
    </div>
  </aside>

  <main class="paper">
    <header class="hero">
      <div class="hero-band">
        <div class="hero-tags">
          <span class="tag">${esc(templateLabels[doc.template] || doc.template)}</span>
          <span class="tag">${esc(modeLabels[doc.mode] || doc.mode)}</span>
          <span class="tag">生成于 ${esc(doc.createdAt.slice(0, 16).replace("T", " "))} UTC</span>
        </div>
        <h1>${esc(doc.title)}</h1>
        <p class="hero-sub">${esc(doc.subtitle || doc.summary)}</p>
        <div class="hero-kpis">
          <div class="hero-kpi"><small>有效分析样本</small><strong>${esc(totalAnalyzed.toLocaleString())}</strong></div>
          <div class="hero-kpi"><small>时间覆盖窗口</small><strong>${esc(rangeLabel)}</strong></div>
          <div class="hero-kpi"><small>研究章节</small><strong>${doc.sections.length} 章</strong></div>
          <div class="hero-kpi"><small>可溯源原文证据</small><strong>${doc.evidence.length} 条</strong></div>
        </div>
      </div>
    </header>

    <div class="filter-bar" role="region" aria-label="结论筛选与检索">
      <div class="filter-pills" id="kind-filters">
        <button type="button" class="fpill on" data-kind="all">全部观点</button>
        <button type="button" class="fpill" data-kind="observation">观察事实</button>
        <button type="button" class="fpill" data-kind="interpretation">分析解读</button>
        <button type="button" class="fpill" data-kind="hypothesis">待验证假设</button>
        <button type="button" class="fpill" data-kind="recommendation">业务建议</button>
      </div>
      <div class="search-box">
        <input type="search" id="report-search" placeholder="筛选报告观点与关键词…" aria-label="筛选报告观点" />
        <span class="search-count" id="search-count"></span>
      </div>
    </div>

    ${sectionsHtml}

    <section class="report-sec" id="sec-scope-table">
      <div class="sec-eyebrow">PROVENANCE &amp; DATA SCOPES</div>
      <h2>数据范围快照</h2>
      <div class="table-wrap">
        <table class="sortable-table">
          <thead><tr><th>范围ID</th><th>资料来源</th><th>检索条件</th><th>实际时间覆盖</th><th>匹配规模</th><th>有效分析量</th><th>数据版本</th></tr></thead>
          <tbody>${scopesTable}</tbody>
        </table>
      </div>
      <p class="footer-note">本文件为 SIFTLINE 导出的离线交互研究报告快照（报告编号：${esc(doc.id)}，模型：${esc(String(doc.provenance.model ?? "纯数据统计"))}）。零外部脚本依赖，断网可直接查看图表提示、筛选观点与检索证据。</p>
    </section>
  </main>
</div>

<div id="svg-tooltip" role="tooltip"></div>
<div id="toast" role="status" aria-live="polite"></div>

<div class="drawer-backdrop" id="ev-drawer" role="dialog" aria-modal="true" aria-label="原文证据抽屉">
  <div class="drawer">
    <div class="drawer-hd">
      <div>
        <div class="sec-eyebrow">EVIDENCE SNAPSHOT · 原文证据快照</div>
        <strong id="drawer-title">原文证据</strong>
      </div>
      <button type="button" class="tool-btn" id="drawer-close">关闭 ✕</button>
    </div>
    <div class="drawer-search">
      <input type="search" id="drawer-filter" placeholder="在当前证据中搜索关键词或社区…" />
      <button type="button" class="tool-btn" id="drawer-show-all">全部 (${doc.evidence.length})</button>
    </div>
    <div class="drawer-bd" id="drawer-body"></div>
  </div>
</div>

<script type="application/json" id="siftline-evidence-data">${safeEvidencePayload}</script>
<script type="application/json" id="siftline-summary-text">${plainExecSummary}</script>
<script>
(function(){
  const evidenceList = JSON.parse(document.getElementById('siftline-evidence-data').textContent || '[]');
  const summaryText = JSON.parse(document.getElementById('siftline-summary-text').textContent || '""');
  const evMap = new Map(evidenceList.map(e => [e.id, e]));

  function showToast(msg){
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // 1. Reading progress bar + Scrollspy active TOC
  const prog = document.getElementById('read-progress');
  const tocLinks = Array.from(document.querySelectorAll('.toc-link'));
  const secNodes = Array.from(document.querySelectorAll('.report-sec[data-sec-id]'));
  function onScroll(){
    const h = document.documentElement.scrollHeight - window.innerHeight;
    prog.style.width = h > 0 ? Math.min(100, Math.max(0, (window.scrollY / h) * 100)) + '%' : '0%';
    let activeId = secNodes[0]?.dataset.secId || '';
    for (const s of secNodes) {
      if (s.getBoundingClientRect().top <= 130) activeId = s.dataset.secId;
    }
    tocLinks.forEach(a => a.classList.toggle('is-active', a.dataset.secId === activeId));
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // 2. Theme switcher
  document.querySelectorAll('[data-set-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.documentElement.setAttribute('data-theme', btn.dataset.setTheme);
      document.querySelectorAll('[data-set-theme]').forEach(b => b.classList.toggle('on', b === btn));
    });
  });

  // 3. Copy Executive Summary
  document.getElementById('btn-copy-summary').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(summaryText);
      showToast('已复制核心研究摘要到剪贴板');
    } catch {
      showToast('当前环境不支持自动复制，请手动选择复制');
    }
  });

  // 4. Toggle all inline evidence accordions
  let evExpanded = false;
  document.getElementById('btn-toggle-ev').addEventListener('click', () => {
    evExpanded = !evExpanded;
    document.querySelectorAll('details.ev-details').forEach(d => { d.open = evExpanded; });
    showToast(evExpanded ? '已展开全部章节原文证据' : '已收起内联原文证据');
  });

  // 5. Finding kind filter + live keyword search
  let activeKind = 'all';
  let searchQ = '';
  const findings = Array.from(document.querySelectorAll('.finding[data-finding-kind]'));
  const countEl = document.getElementById('search-count');
  function applyFilters(){
    let shown = 0;
    const q = searchQ.trim().toLowerCase();
    findings.forEach(el => {
      const kindOk = activeKind === 'all' || el.dataset.findingKind === activeKind;
      const textOk = !q || el.textContent.toLowerCase().includes(q);
      const vis = kindOk && textOk;
      el.classList.toggle('is-hidden', !vis);
      if (vis) shown++;
    });
    countEl.textContent = (activeKind !== 'all' || q) ? (shown + ' / ' + findings.length + ' 条观点') : '';
  }
  document.querySelectorAll('#kind-filters .fpill').forEach(btn => {
    btn.addEventListener('click', () => {
      activeKind = btn.dataset.kind;
      document.querySelectorAll('#kind-filters .fpill').forEach(b => b.classList.toggle('on', b === btn));
      applyFilters();
    });
  });
  document.getElementById('report-search').addEventListener('input', e => {
    searchQ = e.target.value || '';
    applyFilters();
  });

  // 6. Interactive SVG hover tooltips
  const tip = document.getElementById('svg-tooltip');
  document.querySelectorAll('[data-tip-title]').forEach(el => {
    const showTip = (e) => {
      tip.textContent = '';
      const t = document.createElement('div'); t.textContent = el.dataset.tipTitle || '';
      const v = document.createElement('b'); v.textContent = el.dataset.tipVal || '';
      const s = document.createElement('small'); s.textContent = el.dataset.tipSub || '';
      tip.append(t, v, s);
      if (e) {
        const x = Math.min(window.innerWidth - 290, e.clientX + 14);
        const y = Math.max(10, e.clientY - 46);
        tip.style.left = x + 'px';
        tip.style.top = y + 'px';
      }
      tip.style.opacity = '1';
    };
    el.addEventListener('pointerenter', showTip);
    el.addEventListener('mouseenter', showTip);
    el.addEventListener('mousemove', showTip);
    el.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
  });

  // 7. Sortable tables
  document.querySelectorAll('table.sortable-table').forEach(tbl => {
    const ths = Array.from(tbl.querySelectorAll('thead th'));
    ths.forEach((th, colIdx) => {
      let asc = true;
      th.addEventListener('click', () => {
        const tbody = tbl.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.sort((a, b) => {
          const av = (a.children[colIdx]?.textContent || '').trim();
          const bv = (b.children[colIdx]?.textContent || '').trim();
          const an = parseFloat(av.replace(/[,%]/g, ''));
          const bn = parseFloat(bv.replace(/[,%]/g, ''));
          if (!Number.isNaN(an) && !Number.isNaN(bn)) return asc ? an - bn : bn - an;
          return asc ? av.localeCompare(bv, 'zh-CN') : bv.localeCompare(av, 'zh-CN');
        });
        rows.forEach(r => tbody.appendChild(r));
        asc = !asc;
      });
    });
  });

  // 8. Slide-over Evidence Drawer
  const drawerWrap = document.getElementById('ev-drawer');
  const drawerTitle = document.getElementById('drawer-title');
  const drawerBody = document.getElementById('drawer-body');
  const drawerFilter = document.getElementById('drawer-filter');
  let currentDrawerItems = evidenceList;

  function renderDrawer(items){
    drawerBody.textContent = '';
    const q = (drawerFilter.value || '').trim().toLowerCase();
    const list = q ? items.filter(it => (it.id + ' ' + it.title + ' ' + it.excerpt + ' ' + it.community + ' ' + it.sourceLabel).toLowerCase().includes(q)) : items;
    if (!list.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:24px;text-align:center;color:var(--muted);font-size:13px;';
      empty.textContent = '暂无匹配的原文证据。';
      drawerBody.appendChild(empty);
      return;
    }
    list.forEach(ev => {
      const card = document.createElement('div');
      card.className = 'ev-item';
      const meta = document.createElement('div');
      meta.className = 'ev-meta';
      const b = document.createElement('b'); b.textContent = ev.id;
      meta.appendChild(b);
      meta.appendChild(document.createTextNode(' · ' + ev.sourceLabel + (ev.community ? ' · r/' + ev.community : '') + (ev.publishedAt ? ' · ' + ev.publishedAt : '')));
      card.appendChild(meta);
      if (ev.title) {
        const tl = document.createElement('div');
        tl.className = 'ev-title';
        tl.textContent = ev.title;
        card.appendChild(tl);
      }
      const ex = document.createElement('p');
      ex.className = 'ev-excerpt';
      ex.textContent = ev.excerpt;
      card.appendChild(ex);
      const ft = document.createElement('div');
      ft.className = 'ev-foot';
      const rs = document.createElement('span'); rs.textContent = ev.reason;
      ft.appendChild(rs);
      if (ev.url) {
        const a = document.createElement('a');
        a.href = ev.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = '查看原文 ↗';
        ft.appendChild(a);
      }
      card.appendChild(ft);
      drawerBody.appendChild(card);
    });
  }

  function openDrawer(ids, title){
    const picked = ids ? ids.split(',').map(id => evMap.get(id.trim())).filter(Boolean) : evidenceList;
    currentDrawerItems = picked.length ? picked : evidenceList;
    drawerTitle.textContent = title || '本报告全部原文证据';
    drawerFilter.value = '';
    renderDrawer(currentDrawerItems);
    drawerWrap.classList.add('open');
  }

  document.querySelectorAll('[data-open-ev]').forEach(btn => {
    btn.addEventListener('click', () => openDrawer(btn.dataset.openEv, btn.dataset.evTitle));
  });
  document.getElementById('btn-all-ev').addEventListener('click', () => openDrawer(null, '本报告全部原文证据（' + evidenceList.length + ' 条）'));
  document.getElementById('drawer-show-all').addEventListener('click', () => openDrawer(null, '本报告全部原文证据（' + evidenceList.length + ' 条）'));
  drawerFilter.addEventListener('input', () => renderDrawer(currentDrawerItems));
  document.getElementById('drawer-close').addEventListener('click', () => drawerWrap.classList.remove('open'));
  drawerWrap.addEventListener('click', e => { if (e.target === drawerWrap) drawerWrap.classList.remove('open'); });
  window.addEventListener('keydown', e => { if (e.key === 'Escape') drawerWrap.classList.remove('open'); });
})();
</script>
</body>
</html>`;
}
