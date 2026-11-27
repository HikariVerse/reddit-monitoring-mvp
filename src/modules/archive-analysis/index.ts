import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient } from "pg";
import type { Actor } from "../../../packages/contracts/src/access";
import {
  ArchiveCatalog, ArchiveEvidence, ArchivePage, ArchiveReference, ArchiveReferences, ArchiveRefParams,
  ArchiveSearch, ArchiveSelection, ArchiveStatus, ArchiveThread, ArchiveUnlink,
} from "../../../packages/contracts/src/archive";
import { REDDIT_ARCHIVE_SOURCE_TAG } from "../../../packages/contracts/src/collection";
import { ParamsId } from "../../../packages/contracts/src/common";
import type { ExploreAnalyzeRequest, ExploreAnalyzeResponse, ExploreEvidenceRequest, ExploreEvidenceResponse } from "../../../packages/contracts/src/explore";
import { fail, AppError } from "../../shared/errors";
import { transaction } from "../../storage/db";
import { loadEffectivePolicyForUser } from "../collection/index";
import { assertProjectWritable, projectSources } from "../projects/index";
import {
  executeExploreAnalysis,
  executeExploreEvidence,
  registerExploreRoutes,
  type ExploreArchiveBridge,
  type ExploreStudyStore,
} from "./explore-routes";

export type { ExploreStudyStore };

export interface ArchiveFastDiscoveryRequest {
  query: string;
  months?: string[];
  subreddits?: string[];
  from?: string | null;
  to?: string | null;
  verifyExact?: boolean;
  includeSamples?: boolean;
  sampleLimit?: number;
  includeCommentsCount?: boolean;
}

export interface ArchiveFastDiscoveryResult {
  status: "exact" | "candidate";
  version: string;
  months: string[];
  query: string;
  ftsCandidates: number;
  matchedThreads: number;
  associatedComments: number;
  reportedCommentsSum: number;
  needsExactVerify: boolean;
  dateRange: { earliest: string | null; latest: string | null; activeDays: number };
  byMonth: Array<{ month: string; count: number }>;
  topCommunities: Array<{ community: string; count: number }>;
  samples: Array<{
    month: string;
    docId: number;
    community: string;
    createdUtc: number | null;
    score: number;
    reportedComments: number;
    title: string;
    snippet: string;
  }>;
  elapsedMs: number;
}

const ArchiveDiscoverBody = Type.Object(
  {
    query: Type.String({ maxLength: 256 }),
    months: Type.Optional(Type.Array(Type.String({ pattern: "^[0-9]{4}-(?:0[1-9]|1[0-2])$" }), { maxItems: 120 })),
    subreddits: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 })),
    from: Type.Optional(Type.Union([Type.String({ maxLength: 35 }), Type.Null()])),
    to: Type.Optional(Type.Union([Type.String({ maxLength: 35 }), Type.Null()])),
    verifyExact: Type.Optional(Type.Boolean()),
    includeSamples: Type.Optional(Type.Boolean()),
    sampleLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
    includeCommentsCount: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const EmptyFilters = { query: "", subreddits: [], from: null, to: null };
const publicErrors: Record<string, number> = {
  directory_unreadable: 503, archive_empty: 503, package_invalid: 503, archive_too_many_months: 503,
  query_timeout: 503, archive_busy: 503, query_resource_limit: 503, query_worker_failed: 503,
  archive_version_changed: 409, archive_month_unavailable: 409, cursor_invalid: 409,
  invalid_query: 400, invalid_time_range: 400, invalid_months: 400, invalid_filters: 400,
  recall_limit: 422, evidence_not_found: 404, invalid_service_token: 503,
};

const archiveResponse = { archives: ArchiveCatalog, preview: ArchivePage, search: ArchivePage, evidence: ArchiveThread };

type ArchiveConfig = {
  enabled: boolean; sourceId?: string; url?: URL; token?: string; timeoutMs: number;
};

function readConfig(): ArchiveConfig {
  const env = process.env;
  const enabled = env.ARCHIVE_ANALYSIS_ENABLED === "true";
  const sourceId = env.ARCHIVE_ANALYSIS_SOURCE_ID?.toLowerCase();
  const token = env.ARCHIVE_ANALYSIS_SERVICE_TOKEN;
  const timeoutMs = Number(env.ARCHIVE_ANALYSIS_TIMEOUT_MS ?? 8500);
  try {
    const url = new URL(env.ARCHIVE_ANALYSIS_BASE_URL ?? "http://127.0.0.1:8765");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash ||
        !token || !/^[!-~]{32,}$/.test(token) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 65_000) {
      return { enabled, sourceId, timeoutMs };
    }
    return { enabled, sourceId, url, token, timeoutMs };
  } catch {
    return { enabled, sourceId, timeoutMs };
  }
}

async function callArchive<T>(
  config: ArchiveConfig, operation: "archives" | "preview" | "search" | "evidence", data?: object,
): Promise<T> {
  if (!config.enabled) fail(503, "archive_disabled");
  if (!config.url || !config.token) fail(503, "archive_unconfigured");
  const signal = AbortSignal.timeout(config.timeoutMs);
  try {
    const response = await fetch(new URL(operation, config.url), {
      method: data ? "POST" : "GET",
      redirect: "error",
      signal,
      headers: { authorization: "Bearer " + config.token, ...(data ? { "content-type": "application/json" } : {}) },
      body: data ? JSON.stringify(data) : undefined,
    });
    const declaredLength = Number(response.headers.get("content-length"));
    if (!response.body || declaredLength < 1 || declaredLength > 1024 * 1024) fail(503, "archive_invalid_response");
    const result = await response.json() as T & { code?: string };
    if (!response.ok) {
      const code = result?.code ?? "";
      if (Object.hasOwn(publicErrors, code)) fail(publicErrors[code], code);
      fail(503, "archive_invalid_response");
    }
    if (!Value.Check(archiveResponse[operation], result)) fail(503, "archive_invalid_response");
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (signal.aborted) fail(503, "query_timeout");
    fail(503, "archive_offline");
  }
}

const References = `a.id, a.project_id AS "projectId", a.source_id AS "sourceId",
  a.archive_id AS "archiveId", a.version, a.scope`;

async function authorizedSource(
  db: Pool | PoolClient, actor: Actor, config: ArchiveConfig,
): Promise<{ id: string; label: string } | undefined> {
  const id = config.sourceId;
  if (!id || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) return;
  if (actor.allowedSourceIds !== null && !actor.allowedSourceIds.includes(id)) return;
  if (actor.role === "viewer") {
    const policy = await loadEffectivePolicyForUser(db, actor.userId);
    if (!policy.allowedSourceIds?.includes(id)) return;
  }
  const { rows } = await db.query<{ id: string; label: string }>(
    `SELECT cs.id, cs.label FROM collection_source cs JOIN source s ON s.id=cs.platform_id
     WHERE cs.id=$1 AND cs.state='active' AND cs.delivery_mode='push'
       AND cs.primary_provider='external_ingest' AND s.code='reddit' AND $2=ANY(cs.tags)`,
    [id, REDDIT_ARCHIVE_SOURCE_TAG],
  );
  return rows[0];
}

function normalize(selection: ArchiveSelection): ArchiveSelection {
  const { scope } = selection;
  const from = scope.from === null ? null : Date.parse(scope.from);
  const to = scope.to === null ? null : Date.parse(scope.to);
  if ((from !== null && !Number.isFinite(from)) || (to !== null && !Number.isFinite(to)) ||
      (from !== null && to !== null && from >= to)) fail(400, "invalid_time_range");
  return {
    archiveId: selection.archiveId, version: selection.version,
    scope: {
      months: [...scope.months].sort(), query: scope.query.trim(),
      subreddits: [...new Set(scope.subreddits.map(sub => sub.toLowerCase()))].sort(),
      from: from === null ? null : new Date(from).toISOString(),
      to: to === null ? null : new Date(to).toISOString(),
    },
  };
}

function selectionOf(ref: ArchiveReference): ArchiveSelection {
  return { archiveId: ref.archiveId, version: ref.version, scope: ref.scope };
}

async function callArchiveDiscover(
  config: ArchiveConfig,
  operation: "discover" | "discover/verify",
  data: ArchiveFastDiscoveryRequest,
): Promise<ArchiveFastDiscoveryResult> {
  if (!config.enabled) fail(503, "archive_disabled");
  if (!config.url || !config.token) fail(503, "archive_unconfigured");
  const timeout = operation === "discover/verify" ? Math.max(config.timeoutMs, 45_000) : Math.max(config.timeoutMs, 15_000);
  const signal = AbortSignal.timeout(timeout);
  try {
    const response = await fetch(new URL(operation, config.url), {
      method: "POST",
      redirect: "error",
      signal,
      headers: { authorization: "Bearer " + config.token, "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    const result = (await response.json()) as ArchiveFastDiscoveryResult & { code?: string };
    if (!response.ok) {
      const code = result?.code ?? "";
      if (Object.hasOwn(publicErrors, code)) fail(publicErrors[code], code);
      fail(503, "archive_invalid_response");
    }
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (signal.aborted) fail(503, "query_timeout");
    fail(503, "archive_offline");
  }
}

export interface ArchiveRuntimeFacade {
  checkStatus: (actor: Actor) => Promise<{
    available: boolean;
    state: string;
    months: string[];
    version?: string;
    sourceId?: string;
  }>;
  discover: (actor: Actor, req: ArchiveFastDiscoveryRequest, verifyExact?: boolean) => Promise<ArchiveFastDiscoveryResult>;
  ensureProjectArchiveRef: (
    actor: Actor,
    projectId: string,
    selection: ArchiveSelection,
  ) => Promise<ArchiveReference>;
  runExplore: (actor: Actor, req: ExploreAnalyzeRequest) => Promise<ExploreAnalyzeResponse>;
  resolveEvidence: (actor: Actor, req: ExploreEvidenceRequest) => Promise<ExploreEvidenceResponse>;
}

export async function registerArchiveAnalysisModule(
  app: FastifyInstance,
  pool: Pool,
  options?: { studyStore?: ExploreStudyStore },
): Promise<ArchiveRuntimeFacade> {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const config = readConfig();
  let checkingCatalog: Promise<ArchiveCatalog> | undefined;
  const base = "/v1/projects/:id/archives";
  const read = { auth: { access: "authenticated", browserOnly: true } } as const;
  const write = { auth: { access: "viewer_write", browserOnly: true } } as const;

  async function requireSource(db: Pool | PoolClient, actor: Actor) {
    if (!config.enabled) fail(503, "archive_disabled");
    if (!config.url || (actor.role !== "viewer" && !config.sourceId)) fail(503, "archive_unconfigured");
    const source = await authorizedSource(db, actor, config);
    if (!source) fail(actor.role === "viewer" ? 403 : 503, actor.role === "viewer" ? "archive_forbidden" : "archive_source_unavailable");
    return source;
  }

  async function reference(actor: Actor, projectId: string, refId: string) {
    await projectSources(pool, actor, projectId);
    const source = await requireSource(pool, actor);
    const { rows } = await pool.query<ArchiveReference>(
      `SELECT ${References} FROM monitor_project_archive a WHERE a.project_id=$1 AND a.id=$2 AND a.source_id=$3`,
      [projectId, refId, source.id],
    );
    if (!rows[0]) fail(404, "archive_reference_not_found");
    return rows[0];
  }

  async function ensureProjectArchiveRef(
    actor: Actor,
    projectId: string,
    rawSelection: ArchiveSelection,
  ): Promise<ArchiveReference> {
    await assertProjectWritable(pool, actor, projectId);
    const source = await requireSource(pool, actor);
    const selection = normalize(rawSelection);
    const scopeHash = createHash("sha256").update(JSON.stringify(selection.scope)).digest("hex");
    return transaction(pool, async (client) => {
      await client.query("SELECT id FROM monitor_project WHERE id=$1 FOR UPDATE", [projectId]);
      await assertProjectWritable(client, actor, projectId);
      await requireSource(client, actor);
      await client.query(
        `INSERT INTO monitor_project_archive (id, project_id, source_id, archive_id, version, scope, scope_hash, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (project_id,source_id,archive_id,version,scope_hash) DO NOTHING`,
        [randomUUID(), projectId, source.id, selection.archiveId, selection.version, selection.scope, scopeHash, actor.userId],
      );
      const { rows } = await client.query<ArchiveReference>(
        `SELECT ${References} FROM monitor_project_archive a
         WHERE a.project_id=$1 AND a.source_id=$2 AND a.archive_id=$3 AND a.version=$4 AND a.scope_hash=$5`,
        [projectId, source.id, selection.archiveId, selection.version, scopeHash],
      );
      return rows[0];
    });
  }

  // Project-free authorized R4 fast discovery endpoints
  api.post(
    "/v1/archive/discover",
    { config: read, schema: { body: ArchiveDiscoverBody } },
    async (request) => {
      await requireSource(pool, request.actor!);
      return callArchiveDiscover(config, "discover", request.body);
    },
  );
  api.post(
    "/v1/archive/discover/verify",
    { config: read, schema: { body: ArchiveDiscoverBody } },
    async (request) => {
      await requireSource(pool, request.actor!);
      return callArchiveDiscover(config, "discover/verify", { ...request.body, verifyExact: true });
    },
  );

  api.get(base + "/status", { config: read, schema: { params: ParamsId, response: { 200: ArchiveStatus } } }, async request => {
    const actor = request.actor!;
    await projectSources(pool, actor, request.params.id);
    let source: Awaited<ReturnType<typeof requireSource>> | null = null;
    try {
      source = await requireSource(pool, actor);
      checkingCatalog ??= callArchive<ArchiveCatalog>(config, "archives").finally(() => {
        checkingCatalog = undefined;
      });
      const catalog = await checkingCatalog;
      return { state: "available", catalog, source };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return { state: error.message, catalog: null, source };
    }
  });

  api.get(base, { config: read, schema: { params: ParamsId, response: { 200: ArchiveReferences } } }, async request => {
    const actor = request.actor!;
    await projectSources(pool, actor, request.params.id);
    const source = await authorizedSource(pool, actor, config);
    if (!source) return { references: [] };
    const { rows } = await pool.query<ArchiveReference>(
      `SELECT ${References} FROM monitor_project_archive a
       WHERE a.project_id=$1 AND a.source_id=$2 ORDER BY a.created_at DESC, a.id`,
      [request.params.id, source.id],
    );
    return { references: rows };
  });

  api.post(base + "/preview", { config: write, schema: { params: ParamsId, body: ArchiveSelection, response: { 200: ArchivePage } } }, async request => {
    await assertProjectWritable(pool, request.actor!, request.params.id);
    await requireSource(pool, request.actor!);
    return callArchive<ArchivePage>(config, "preview", {
      ...normalize(request.body), filters: EmptyFilters, reference: request.params.id,
    });
  });

  api.post(base, { config: write, schema: { params: ParamsId, body: ArchiveSelection, response: { 200: ArchiveReference } } }, async request => {
    const actor = request.actor!;
    const projectId = request.params.id;
    await assertProjectWritable(pool, actor, projectId);
    const source = await requireSource(pool, actor);
    const selection = normalize(request.body);
    await callArchive<ArchivePage>(config, "preview", { ...selection, filters: EmptyFilters, reference: projectId });
    const scopeHash = createHash("sha256").update(JSON.stringify(selection.scope)).digest("hex");
    return transaction(pool, async client => {
      await client.query("SELECT id FROM monitor_project WHERE id=$1 FOR UPDATE", [projectId]);
      await assertProjectWritable(client, actor, projectId);
      await requireSource(client, actor);
      await client.query(
        `INSERT INTO monitor_project_archive (id, project_id, source_id, archive_id, version, scope, scope_hash, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (project_id,source_id,archive_id,version,scope_hash) DO NOTHING`,
        [randomUUID(), projectId, source.id, selection.archiveId, selection.version, selection.scope, scopeHash, actor.userId],
      );
      const { rows } = await client.query<ArchiveReference>(
        `SELECT ${References} FROM monitor_project_archive a
         WHERE a.project_id=$1 AND a.source_id=$2 AND a.archive_id=$3 AND a.version=$4 AND a.scope_hash=$5`,
        [projectId, source.id, selection.archiveId, selection.version, scopeHash],
      );
      return rows[0];
    });
  });

  api.delete(base + "/:refId", { config: write, schema: { params: ArchiveRefParams, response: { 200: ArchiveUnlink } } }, async request =>
    transaction(pool, async client => {
      const { id, refId } = request.params;
      await client.query("SELECT id FROM monitor_project WHERE id=$1 FOR UPDATE", [id]);
      await assertProjectWritable(client, request.actor!, id);
      const deleted = await client.query("DELETE FROM monitor_project_archive WHERE project_id=$1 AND id=$2", [id, refId]);
      if (!deleted.rowCount) fail(404, "archive_reference_not_found");
      return { deleted: true };
    }),
  );

  api.post(base + "/:refId/search", { config: read, schema: { params: ArchiveRefParams, body: ArchiveSearch, response: { 200: ArchivePage } } }, async request => {
    const ref = await reference(request.actor!, request.params.id, request.params.refId);
    return callArchive<ArchivePage>(config, "search", { ...request.body, ...selectionOf(ref), reference: ref.id });
  });
  api.post(base + "/:refId/evidence", { config: read, schema: { params: ArchiveRefParams, body: ArchiveEvidence, response: { 200: ArchiveThread } } }, async request => {
    const ref = await reference(request.actor!, request.params.id, request.params.refId);
    return callArchive<ArchiveThread>(config, "evidence", { ...request.body, ...selectionOf(ref), reference: ref.id });
  });

  const bridge: ExploreArchiveBridge = {
    enabled: config.enabled,
    url: config.url,
    token: config.token,
    timeoutMs: config.timeoutMs,
    studyStore: options?.studyStore,
    checkArchiveStatus: async (db, actor) => {
      try {
        const source = await requireSource(db, actor);
        checkingCatalog ??= callArchive<ArchiveCatalog>(config, "archives").finally(() => {
          checkingCatalog = undefined;
        });
        const catalog = await checkingCatalog;
        return {
          available: true,
          state: "available",
          months: catalog.months.map((m) => m.month),
          version: catalog.version,
          sourceId: source.id,
        };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return { available: false, state: error.message, months: [] };
      }
    },
    getProjectArchiveRef: async (actor, projectId, refId) => reference(actor, projectId, refId),
  };

  registerExploreRoutes(app, pool, bridge);

  return {
    checkStatus: (actor) => bridge.checkArchiveStatus(pool, actor),
    discover: async (actor, req, verifyExact = false) => {
      await requireSource(pool, actor);
      return callArchiveDiscover(config, verifyExact ? "discover/verify" : "discover", { ...req, verifyExact });
    },
    ensureProjectArchiveRef,
    runExplore: (actor, req) => executeExploreAnalysis(pool, bridge, actor, req),
    resolveEvidence: (actor, req) => executeExploreEvidence(bridge, actor, req),
  };
}
