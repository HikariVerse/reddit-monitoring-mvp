import { Type, type Static } from "@sinclair/typebox";
import { Id, Platform } from "./common";

const strict = { additionalProperties: false };

export const ReportTemplate = Type.Union([
  Type.Literal("industry"),
  Type.Literal("commerce"),
  Type.Literal("social"),
  Type.Literal("custom"),
]);

export const ResearchMode = Type.Union([
  Type.Literal("comprehensive"),
  Type.Literal("recent"),
  Type.Literal("continuous"),
]);

export const ReportRunState = Type.Union([
  Type.Literal("draft"),
  Type.Literal("discovering"),
  Type.Literal("review"),
  Type.Literal("preparing"),
  Type.Literal("collecting"),
  Type.Literal("analyzing"),
  Type.Literal("writing"),
  Type.Literal("ready"),
  Type.Literal("pure_data_ready"),
  Type.Literal("needs_action"),
  Type.Literal("failed"),
  Type.Literal("cancel_requested"),
  Type.Literal("canceled"),
]);

export const ReportScheduleCadence = Type.Union([
  Type.Literal("daily"),
  Type.Literal("weekly"),
  Type.Literal("monthly"),
  Type.Literal("custom_interval"),
]);

export const ResourceDiscoverRequest = Type.Object(
  {
    topic: Type.String({ maxLength: 300 }),
    question: Type.Optional(Type.String({ maxLength: 600 })),
    template: Type.Optional(ReportTemplate),
    mode: Type.Optional(ResearchMode),
    aliases: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 16 })),
    englishQuery: Type.Optional(Type.String({ maxLength: 256 })),
    from: Type.Optional(Type.Union([Type.String({ maxLength: 35 }), Type.Null()])),
    to: Type.Optional(Type.Union([Type.String({ maxLength: 35 }), Type.Null()])),
    platforms: Type.Optional(Type.Array(Platform, { maxItems: 6 })),
    subreddits: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
    languages: Type.Optional(Type.Array(Type.String({ maxLength: 16 }), { maxItems: 8 })),
    sourceGroup: Type.Optional(Type.String({ maxLength: 64 })),
    projectId: Type.Optional(Id),
    verifyArchivePhrase: Type.Optional(Type.Boolean()),
    includeSamples: Type.Optional(Type.Boolean()),
  },
  strict,
);

export const ReportDraftUpsertInput = Type.Object(
  {
    id: Type.Optional(Id),
    revision: Type.Optional(Type.Integer({ minimum: 1 })),
    template: ReportTemplate,
    title: Type.Optional(Type.String({ maxLength: 200 })),
    input: Type.Record(Type.String(), Type.Unknown()),
    discovery: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
    plan: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
    sections: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
    projectId: Type.Optional(Type.Union([Id, Type.Null()])),
  },
  strict,
);

export const ReportRunCreateInput = Type.Object(
  {
    draftId: Type.Optional(Id),
    idempotencyKey: Type.Optional(Type.String({ minLength: 4, maxLength: 120 })),
    template: ReportTemplate,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    topic: Type.String({ maxLength: 300 }),
    question: Type.Optional(Type.String({ maxLength: 600 })),
    focus: Type.Optional(Type.String({ maxLength: 600 })),
    language: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
    detailLevel: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("compact")])),
    mode: Type.Optional(ResearchMode),
    projectId: Type.Optional(Type.Union([Id, Type.Null()])),
    reuseStudyId: Type.Optional(Type.String({ maxLength: 128 })),
    primarySource: Type.Union([
      Type.Literal("stories"),
      Type.Literal("archive"),
      Type.Literal("pg_content"),
      Type.Literal("project"),
      Type.Literal("monitor"),
      Type.Literal("explore_study"),
    ]),
    englishQuery: Type.Optional(Type.String({ maxLength: 256 })),
    subreddits: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
    from: Type.Optional(Type.Union([Type.String({ maxLength: 35 }), Type.Null()])),
    to: Type.Optional(Type.Union([Type.String({ maxLength: 35 }), Type.Null()])),
    platforms: Type.Optional(Type.Array(Platform, { maxItems: 6 })),
    sourceGroup: Type.Optional(Type.String({ maxLength: 64 })),
    storyView: Type.Optional(Type.Union([Type.Literal("latest"), Type.Literal("hot"), Type.Literal("digest")])),
    storyDate: Type.Optional(Type.Union([Type.String({ maxLength: 16 }), Type.Null()])),
    batchIds: Type.Optional(Type.Array(Id, { maxItems: 100 })),
    sourceIds: Type.Optional(Type.Array(Id, { maxItems: 100 })),
    archiveRefId: Type.Optional(Type.Union([Id, Type.Null()])),
    monitorId: Type.Optional(Type.Union([Id, Type.Null()])),
    sampleLimit: Type.Optional(Type.Integer({ minimum: 25, maximum: 10000 })),
    profile: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("balanced")])),
    includeComments: Type.Optional(Type.Boolean()),
    sections: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
    collectionAction: Type.Optional(
      Type.Object(
        {
          enabled: Type.Boolean(),
          confirmed: Type.Boolean(),
          platform: Platform,
          targetType: Type.Union([Type.Literal("keyword"), Type.Literal("community"), Type.Literal("account")]),
          targetValue: Type.String({ minLength: 1, maxLength: 200 }),
          limit: Type.Integer({ minimum: 10, maximum: 5000 }),
          lookbackDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
          includeComments: Type.Optional(Type.Boolean()),
        },
        strict,
      ),
    ),
    skipLlm: Type.Optional(Type.Boolean()),
  },
  strict,
);

export const ReportRunActionInput = Type.Object(
  {
    action: Type.Union([
      Type.Literal("cancel"),
      Type.Literal("retry_writing"),
      Type.Literal("retry_analysis"),
      Type.Literal("deliver_pure_data"),
      Type.Literal("continue_with_partial"),
      Type.Literal("regenerate_section"),
    ]),
    sectionId: Type.Optional(Type.String({ maxLength: 64 })),
    focusOverride: Type.Optional(Type.String({ maxLength: 600 })),
  },
  strict,
);

export const ReportListQuery = Type.Object(
  {
    template: Type.Optional(ReportTemplate),
    projectId: Type.Optional(Id),
    search: Type.Optional(Type.String({ maxLength: 120 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  strict,
);

export const ReportScheduleCreateInput = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 160 }),
    template: ReportTemplate,
    projectId: Type.Optional(Type.Union([Id, Type.Null()])),
    monitorId: Type.Optional(Type.Union([Id, Type.Null()])),
    cadence: ReportScheduleCadence,
    intervalMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 43200 })),
    timezone: Type.Optional(Type.String({ maxLength: 64 })),
    windowHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 8760 })),
    enabled: Type.Optional(Type.Boolean()),
    config: Type.Record(Type.String(), Type.Unknown()),
    maxDailyTokens: Type.Optional(Type.Integer({ minimum: 1000, maximum: 2000000 })),
  },
  strict,
);

export const ReportSchedulePatchInput = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    cadence: Type.Optional(ReportScheduleCadence),
    intervalMinutes: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 43200 }), Type.Null()])),
    timezone: Type.Optional(Type.String({ maxLength: 64 })),
    windowHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 8760 })),
    enabled: Type.Optional(Type.Boolean()),
    config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    maxDailyTokens: Type.Optional(Type.Integer({ minimum: 1000, maximum: 2000000 })),
  },
  strict,
);

export type ReportTemplateType = Static<typeof ReportTemplate>;
export type ResearchModeType = Static<typeof ResearchMode>;
export type ReportRunStateType = Static<typeof ReportRunState>;
export type ResourceDiscoverRequestType = Static<typeof ResourceDiscoverRequest>;
export type ReportDraftUpsertInputType = Static<typeof ReportDraftUpsertInput>;
export type ReportRunCreateInputType = Static<typeof ReportRunCreateInput>;
export type ReportRunActionInputType = Static<typeof ReportRunActionInput>;
export type ReportScheduleCreateInputType = Static<typeof ReportScheduleCreateInput>;
export type ReportSchedulePatchInputType = Static<typeof ReportSchedulePatchInput>;
