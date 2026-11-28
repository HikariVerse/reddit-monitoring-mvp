import { Type, type Static } from "@sinclair/typebox";
import { Id, Platform } from "./common";

const strict = { additionalProperties: false };

export const ExploreSourceMode = Type.Union([
  Type.Literal("archive"),
  Type.Literal("live_content"),
  Type.Literal("info_stream"),
  Type.Literal("reddit_api"),
  Type.Literal("x_api"),
  Type.Literal("project_content"),
]);

export const ExploreGroupBy = Type.Union([
  Type.Literal("group"),
  Type.Literal("source"),
  Type.Literal("dataset"),
  Type.Literal("kind"),
  Type.Literal("language"),
]);

export const ExploreProfile = Type.Union([
  Type.Literal("fast"),
  Type.Literal("balanced"),
  Type.Literal("standard"),
  Type.Literal("deep"),
]);

export const ExploreAccelMode = Type.Union([
  Type.Literal("off"),
  Type.Literal("auto"),
  Type.Literal("prefer_gpu"),
]);

export const ExplorePanelId = Type.Union([
  Type.Literal("P01"),
  Type.Literal("P02"),
  Type.Literal("P03"),
  Type.Literal("P04"),
  Type.Literal("P05"),
  Type.Literal("P06"),
  Type.Literal("P07"),
  Type.Literal("P08"),
  Type.Literal("P09"),
  Type.Literal("P10"),
  Type.Literal("P11"),
  Type.Literal("P12"),
  Type.Literal("P13"),
  Type.Literal("P14"),
]);

export const ExploreScenarioId = Type.Union([
  Type.Literal("pulse"),
  Type.Literal("audience"),
  Type.Literal("topics"),
  Type.Literal("voice"),
  Type.Literal("commercial"),
]);

export const ExploreMetricState = Type.Union([
  Type.Literal("ready"),
  Type.Literal("exploratory"),
  Type.Literal("insufficient_data"),
  Type.Literal("unsupported_source"),
  Type.Literal("missing_fields"),
  Type.Literal("unavailable_dependency"),
  Type.Literal("running"),
  Type.Literal("failed"),
]);

export const ExploreAnalyzeRequest = Type.Object(
  {
    runId: Type.Optional(Type.String({ minLength: 4, maxLength: 80, pattern: "^[a-zA-Z0-9_-]+$" })),
    query: Type.String({ maxLength: 256 }),
    sourceMode: ExploreSourceMode,
    projectId: Type.Optional(Id),
    archiveRefId: Type.Optional(Id),
    platforms: Type.Optional(Type.Array(Platform, { maxItems: 6 })),
    subreddits: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 })),
    from: Type.Optional(Type.Union([Type.String({ maxLength: 35 }), Type.Null()])),
    to: Type.Optional(Type.Union([Type.String({ maxLength: 35 }), Type.Null()])),
    groupBy: Type.Optional(ExploreGroupBy),
    profile: Type.Optional(ExploreProfile),
    accelMode: Type.Optional(ExploreAccelMode),
    useV2Sentiment: Type.Optional(Type.Boolean()),
    includeComments: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 25, maximum: 15000 })),
  },
  strict,
);

export const ExploreMetricResult = Type.Object({
  schema_version: Type.String(),
  metric_id: Type.String(),
  requested_metric: Type.Optional(Type.String()),
  title: Type.String(),
  state: ExploreMetricState,
  reason: Type.String(),
  unit: Type.String(),
  method: Type.String(),
  study_id: Type.String(),
  data_version: Type.String(),
  selected_documents: Type.Integer({ minimum: 0 }),
  sample_unit: Type.Optional(Type.String()),
  elapsed_seconds: Type.Number(),
  data: Type.Record(Type.String(), Type.Unknown()),
});

export const ExplorePanelResult = Type.Object({
  schema_version: Type.String(),
  panel_id: ExplorePanelId,
  scenario: ExploreScenarioId,
  title: Type.String(),
  chart: Type.String(),
  study_id: Type.String(),
  metrics: Type.Array(ExploreMetricResult),
});

export const ExploreSourceProfile = Type.Object({
  sourceMode: ExploreSourceMode,
  sourceLabel: Type.String(),
  engine: Type.Union([
    Type.Literal("duckdb_potion_worker"),
    Type.Literal("python_potion_worker"),
    Type.Literal("pg_builtin_fast"),
  ]),
  engineLabel: Type.String(),
  potionModelReady: Type.Boolean(),
  rawDocuments: Type.Integer({ minimum: 0 }),
  analyzedDocuments: Type.Integer({ minimum: 0 }),
  isSampled: Type.Boolean(),
  sampleCap: Type.Integer({ minimum: 0 }),
  timeRange: Type.Object({
    from: Type.Union([Type.String(), Type.Null()]),
    to: Type.Union([Type.String(), Type.Null()]),
    activeDays: Type.Integer({ minimum: 0 }),
  }),
  platformBreakdown: Type.Array(
    Type.Object({
      platform: Type.String(),
      documents: Type.Integer({ minimum: 0 }),
      sharePct: Type.Number(),
    }),
  ),
  impactNotes: Type.Array(Type.String()),
});

export const ExploreGuidedStep = Type.Object({
  id: Type.String(),
  priority: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("info")]),
  category: Type.Union([
    Type.Literal("anomaly"),
    Type.Literal("pain"),
    Type.Literal("demand"),
    Type.Literal("price"),
    Type.Literal("lexical"),
    Type.Literal("topic"),
    Type.Literal("source"),
  ]),
  title: Type.String(),
  description: Type.String(),
  actionLabel: Type.String(),
  targetScenario: Type.Optional(ExploreScenarioId),
  targetPanelId: Type.Optional(ExplorePanelId),
  suggestedQuery: Type.Optional(Type.String()),
  suggestedSourceMode: Type.Optional(ExploreSourceMode),
  evidenceRefId: Type.Optional(Type.String()),
});

export const ExploreAnalyzeResponse = Type.Object({
  studyId: Type.String(),
  dataVersion: Type.String(),
  query: Type.String(),
  generatedAt: Type.String(),
  elapsedMs: Type.Integer({ minimum: 0 }),
  sourceProfile: ExploreSourceProfile,
  panels: Type.Array(ExplorePanelResult),
  guidedNextSteps: Type.Array(ExploreGuidedStep),
});

export const ExploreEvidenceRequest = Type.Object(
  {
    studyId: Type.String({ minLength: 1, maxLength: 128 }),
    evidenceId: Type.String({ minLength: 1, maxLength: 128 }),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 50000 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  strict,
);

export const ExploreEvidenceItem = Type.Object({
  source_id: Type.String(),
  source_type: Type.String(),
  dataset_id: Type.String(),
  document_id: Type.String(),
  source_document_id: Type.Optional(Type.String()),
  thread_id: Type.Optional(Type.String()),
  author_key: Type.Optional(Type.String()),
  group: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()),
  created_utc: Type.Union([Type.Integer(), Type.Null()]),
  day: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  title: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  text: Type.String(),
  focus: Type.Optional(Type.String()),
  engagement_channels: Type.Optional(Type.Record(Type.String(), Type.Number())),
  claim: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const ExploreEvidenceResponse = Type.Object({
  id: Type.String(),
  state: Type.String(),
  total: Type.Integer({ minimum: 0 }),
  offset: Type.Integer({ minimum: 0 }),
  has_more: Type.Boolean(),
  predicate: Type.Record(Type.String(), Type.Unknown()),
  items: Type.Array(ExploreEvidenceItem),
  reason: Type.Optional(Type.String()),
});

export const ExploreCapabilitiesResponse = Type.Object({
  archiveAvailable: Type.Boolean(),
  archiveState: Type.String(),
  archiveMonths: Type.Array(Type.String()),
  pythonWorkerReady: Type.Boolean(),
  potionModelReady: Type.Boolean(),
  balancedReady: Type.Optional(Type.Boolean()),
  v2Runtime: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  liveContentCounts: Type.Object({
    total: Type.Integer({ minimum: 0 }),
    infoStream: Type.Integer({ minimum: 0 }),
    reddit: Type.Integer({ minimum: 0 }),
    x: Type.Integer({ minimum: 0 }),
    bluesky: Type.Integer({ minimum: 0 }),
  }),
  scenarios: Type.Array(
    Type.Object({
      id: ExploreScenarioId,
      title: Type.String(),
      description: Type.String(),
      panels: Type.Array(ExplorePanelId),
    }),
  ),
});

export const ExploreProgressParams = Type.Object({
  runId: Type.String({ minLength: 4, maxLength: 80, pattern: "^[a-zA-Z0-9_-]+$" }),
});

export const ExploreProgressResponse = Type.Object({
  runId: Type.String(),
  stage: Type.String(),
  stageLabel: Type.String(),
  percent: Type.Integer({ minimum: 0, maximum: 100 }),
  completedPanels: Type.Array(Type.String()),
  totalPanels: Type.Integer({ minimum: 1 }),
  currentPanel: Type.Union([Type.String(), Type.Null()]),
  rawDocuments: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  analyzedDocuments: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  elapsedMs: Type.Integer({ minimum: 0 }),
});

export type ExploreSourceMode = Static<typeof ExploreSourceMode>;
export type ExploreGroupBy = Static<typeof ExploreGroupBy>;
export type ExploreProfile = Static<typeof ExploreProfile>;
export type ExplorePanelId = Static<typeof ExplorePanelId>;
export type ExploreScenarioId = Static<typeof ExploreScenarioId>;
export type ExploreMetricState = Static<typeof ExploreMetricState>;
export type ExploreAnalyzeRequest = Static<typeof ExploreAnalyzeRequest>;
export type ExploreMetricResult = Static<typeof ExploreMetricResult>;
export type ExplorePanelResult = Static<typeof ExplorePanelResult>;
export type ExploreSourceProfile = Static<typeof ExploreSourceProfile>;
export type ExploreGuidedStep = Static<typeof ExploreGuidedStep>;
export type ExploreAnalyzeResponse = Static<typeof ExploreAnalyzeResponse>;
export type ExploreEvidenceRequest = Static<typeof ExploreEvidenceRequest>;
export type ExploreEvidenceItem = Static<typeof ExploreEvidenceItem>;
export type ExploreEvidenceResponse = Static<typeof ExploreEvidenceResponse>;
export type ExploreCapabilitiesResponse = Static<typeof ExploreCapabilitiesResponse>;
export type ExploreProgressResponse = Static<typeof ExploreProgressResponse>;
