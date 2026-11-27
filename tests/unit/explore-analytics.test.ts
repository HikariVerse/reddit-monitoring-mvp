import assert from "node:assert/strict";
import test from "node:test";
import {
  type CanonicalExploreDoc,
  resolveBuiltinEvidence,
  runBuiltinExploreAnalysis,
} from "../../src/modules/archive-analysis/explore-fallback";
import {
  buildDynamicGuidance,
  buildSourceImpactNotes,
} from "../../src/modules/archive-analysis/explore-guidance";

function sampleDocs(): CanonicalExploreDoc[] {
  const baseDay = Date.parse("2026-10-01T10:00:00Z") / 1000;
  return [
    {
      source_id: "pg:reddit",
      source_type: "reddit",
      dataset_id: "pg:live_content",
      document_id: "doc-1",
      thread_id: "t-1",
      parent_id: "",
      author_key: "alice",
      group: "LocalLLaMA",
      kind: "post",
      created_utc: baseDay,
      observed_at: baseDay + 60,
      title: "Looking for an alternative to expensive coding agents",
      url: "https://reddit.com/r/LocalLLaMA/comments/1",
      language: "en",
      text: "Looking for an alternative to expensive coding agents. The current tool is overpriced at $40/month and keeps crashing on large repos. Please add local DuckDB support!",
      engagement_channels: { score: 45, reported_comments: 12 },
    },
    {
      source_id: "pg:reddit",
      source_type: "reddit",
      dataset_id: "pg:live_content",
      document_id: "doc-2",
      thread_id: "t-1",
      parent_id: "doc-1",
      author_key: "bob",
      group: "LocalLLaMA",
      kind: "comment",
      created_utc: baseDay + 86400,
      observed_at: baseDay + 86460,
      title: "",
      url: "",
      language: "en",
      text: "I wish it had faster indexing. Right now it is too slow and buggy, not worth $20/month.",
      engagement_channels: { score: 18 },
    },
    {
      source_id: "pg:reddit",
      source_type: "reddit",
      dataset_id: "pg:live_content",
      document_id: "doc-2-dup",
      thread_id: "t-2",
      parent_id: "",
      author_key: "bob2",
      group: "LocalLLaMA",
      kind: "comment",
      created_utc: baseDay + 86500,
      observed_at: baseDay + 86600,
      title: "",
      url: "",
      language: "en",
      text: "I wish it had faster indexing. Right now it is too slow and buggy, not worth $20/month.",
      engagement_channels: { score: 1 },
    },
    {
      source_id: "pg:x",
      source_type: "x",
      dataset_id: "pg:live_content",
      document_id: "doc-3",
      thread_id: "x-1",
      parent_id: "",
      author_key: "carol",
      group: "devtools",
      kind: "post",
      created_utc: baseDay + 86400 * 2,
      observed_at: baseDay + 86400 * 2 + 60,
      title: "",
      url: "https://x.com/carol/status/1",
      language: "en",
      text: "Just bought the annual plan for $199/year. Seamless coding agent workflow, reliable and super fast!",
      engagement_channels: { likes: 120, reposts: 15, replies: 8 },
    },
    {
      source_id: "pg:web",
      source_type: "web",
      dataset_id: "pg:live_content",
      document_id: "doc-4",
      thread_id: "w-1",
      parent_id: "",
      author_key: "editor",
      group: "technews",
      kind: "article",
      created_utc: baseDay + 86400 * 3,
      observed_at: baseDay + 86400 * 3 + 60,
      title: "DuckDB analytics benchmark",
      url: "https://example.com/duckdb",
      language: "en",
      text: "DuckDB brings local analytical speed to coding agent telemetry with zero external dependencies.",
      engagement_channels: {},
    },
  ];
}

test("builtin explore analysis produces 12 canonical panels, deduplicates, and resolves evidence", () => {
  const result = runBuiltinExploreAnalysis(sampleDocs(), {
    dataVersion: "test-v1",
    groupBy: "group",
    query: "coding agent",
  });

  assert.equal(result.panels.length, 12);
  // 5 raw docs with 1 exact duplicate => 4 deduplicated docs
  assert.equal(result.analyzedDocuments, 4);

  const p01 = result.panels.find((p) => p.panel_id === "P01");
  assert.ok(p01);
  const sl02 = p01.metrics.find((m) => m.metric_id === "SL02");
  assert.equal(sl02?.state, "unsupported_source");

  const p02 = result.panels.find((p) => p.panel_id === "P02");
  const sl26 = p02?.metrics.find((m) => m.metric_id === "SL26");
  assert.equal(sl26?.data.before, 5);
  assert.equal(sl26?.data.kept, 4);
  assert.equal(sl26?.data.exact, 1);

  // Per-platform engagement channels remain separate (SR17)
  const p03 = result.panels.find((p) => p.panel_id === "P03");
  const sr17 = p03?.metrics.find((m) => m.metric_id === "SR17");
  const channels = sr17?.data.channels as Array<{ source: string; channel: string }>;
  assert.ok(channels.some((c) => c.source === "reddit" && c.channel === "score"));
  assert.ok(channels.some((c) => c.source === "x" && c.channel === "likes"));

  // Demand & Price panels extract real signals and return resolvable evidence_ref
  const p10 = result.panels.find((p) => p.panel_id === "P10");
  const pr02 = p10?.metrics.find((m) => m.metric_id === "PR02");
  assert.ok(Number(pr02?.data.hits) >= 2);
  const evRef = pr02?.data.evidence_ref as { id: string; member_count: number };
  assert.ok(evRef?.id);

  const resolved = resolveBuiltinEvidence(result.studyId, evRef.id, 0, 10);
  assert.ok(resolved);
  assert.equal(resolved.state, "ready");
  assert.equal(resolved.total, evRef.member_count);
  assert.ok(resolved.items.length >= 2);

  // Dynamic guidance adapts to demand, price, lexical terms, and archive availability
  const notes = buildSourceImpactNotes("live_content", "pg_builtin_fast", {
    potionModelReady: false,
    isSampled: false,
    sampleCap: 1000,
    analyzedDocuments: 4,
    platformCount: 3,
  });
  assert.ok(notes.length >= 3);

  const guidance = buildDynamicGuidance(
    "coding agent",
    {
      sourceMode: "live_content",
      sourceLabel: "站内全部已入库数据",
      engine: "pg_builtin_fast",
      engineLabel: "PG16 授权语料 + 主线内置快速分析引擎",
      potionModelReady: false,
      rawDocuments: 5,
      analyzedDocuments: 4,
      isSampled: false,
      sampleCap: 1000,
      timeRange: { from: "2026-10-01", to: "2026-10-04", activeDays: 4 },
      platformBreakdown: [{ platform: "reddit", documents: 2, sharePct: 50 }],
      impactNotes: notes,
    },
    result.panels,
    true,
  );
  assert.ok(guidance.some((g) => g.category === "demand"));
  assert.ok(guidance.some((g) => g.category === "price"));
  assert.ok(guidance.some((g) => g.suggestedSourceMode === "archive"));
});
