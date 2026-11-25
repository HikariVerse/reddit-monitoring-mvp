import { Type, type Static } from "@sinclair/typebox";
import { Id } from "./common";

const Month = Type.String({ pattern: "^[0-9]{4}-(0[1-9]|1[0-2])$" });
const DateTime = Type.String({
  format: "date-time", maxLength: 35,
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$",
});
const Filters = {
  query: Type.String({ maxLength: 256 }),
  subreddits: Type.Array(Type.String({ pattern: "^[a-zA-Z0-9_]{2,32}$" }), { maxItems: 32 }),
  from: Type.Union([DateTime, Type.Null()]),
  to: Type.Union([DateTime, Type.Null()]),
};
const strict = { additionalProperties: false };
export const ArchiveScope = Type.Object({
  ...Filters, months: Type.Array(Month, { minItems: 1, maxItems: 120, uniqueItems: true }),
}, strict);
export const ArchiveSelection = Type.Object({
  archiveId: Type.Literal("reddit-local-corpus"),
  version: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  scope: ArchiveScope,
}, strict);
export const ArchiveRefParams = Type.Object({ id: Id, refId: Id });
const SearchFilters = Type.Object(Filters, strict);
export const ArchiveSearch = Type.Object({
  filters: SearchFilters,
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
}, strict);
export const ArchiveEvidence = Type.Object({
  filters: SearchFilters,
  month: Month,
  docId: Type.Integer({ minimum: 0, maximum: 4294967295 }),
  commentId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, strict);

export type ArchiveSelection = Static<typeof ArchiveSelection>;
export type ArchiveSearch = Static<typeof ArchiveSearch>;
export type ArchiveEvidence = Static<typeof ArchiveEvidence>;
const TextOrNull = Type.Union([Type.String(), Type.Null()]);
const IntOrNull = Type.Union([Type.Integer(), Type.Null()]);
export const ArchiveReference = Type.Object({
  ...ArchiveSelection.properties, id: Id, projectId: Id, sourceId: Id,
});
export const ArchiveCatalog = Type.Object({
  archiveId: ArchiveSelection.properties.archiveId,
  version: ArchiveSelection.properties.version,
  months: Type.Array(Type.Object({
    month: Month, from: Type.String(), to: Type.String(), postsRows: IntOrNull, commentsRows: IntOrNull,
  }), { minItems: 1, maxItems: 120 }),
});
const ArchivePost = Type.Object({
  month: Month, doc_id: Type.Integer({ minimum: 0, maximum: 4294967295 }), content_key: Type.String(),
  created_utc: Type.Integer(), community: Type.String(), author_key: TextOrNull,
  score: IntOrNull, reported_comments: IntOrNull, title: TextOrNull, body: TextOrNull, is_truncated: Type.Boolean(),
});
const ArchiveComment = Type.Object({
  month: Month, comment_id: Type.String(), post_doc_id: Type.Integer(), parent_key: TextOrNull,
  created_utc: Type.Integer(), author_key: TextOrNull, score: IntOrNull, body: TextOrNull,
  is_truncated: Type.Union([Type.Boolean(), Type.Null()]),
});
export const ArchivePage = Type.Object({
  posts: Type.Array(ArchivePost, { maxItems: 25 }), nextCursor: TextOrNull, totalMatches: IntOrNull,
  sampleSize: Type.Integer({ minimum: 0 }), isTruncated: Type.Boolean(), months: Type.Array(Month),
});
export const ArchiveThread = Type.Object({
  post: ArchivePost, comments: Type.Array(ArchiveComment, { maxItems: 15 }),
  archivedComments: Type.Integer({ minimum: 0 }), commentsTruncated: Type.Boolean(),
  comment: Type.Union([ArchiveComment, Type.Null()]),
});
export const ArchiveStatus = Type.Object({
  state: Type.String(), catalog: Type.Union([ArchiveCatalog, Type.Null()]),
  source: Type.Union([Type.Object({ id: Id, label: Type.String() }), Type.Null()]),
});
export const ArchiveReferences = Type.Object({ references: Type.Array(ArchiveReference) });
export const ArchiveUnlink = Type.Object({ deleted: Type.Boolean() });

export type ArchiveReference = Static<typeof ArchiveReference>;
export type ArchiveCatalog = Static<typeof ArchiveCatalog>;
export type ArchivePost = Static<typeof ArchivePost>;
export type ArchivePage = Static<typeof ArchivePage>;
export type ArchiveThread = Static<typeof ArchiveThread>;
export type ArchiveStatus = Static<typeof ArchiveStatus>;
