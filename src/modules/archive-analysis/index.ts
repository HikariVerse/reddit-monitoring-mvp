import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool, PoolClient } from "pg";
import type { Actor } from "../../../packages/contracts/src/access";
import {
  ArchiveCatalog, ArchiveEvidence, ArchivePage, ArchiveReference, ArchiveReferences, ArchiveRefParams,
  ArchiveSearch, ArchiveSelection, ArchiveStatus, ArchiveThread, ArchiveUnlink,
} from "../../../packages/contracts/src/archive";
import { REDDIT_ARCHIVE_SOURCE_TAG } from "../../../packages/contracts/src/collection";
import { ParamsId } from "../../../packages/contracts/src/common";
import { fail, AppError } from "../../shared/errors";
import { transaction } from "../../storage/db";
import { loadEffectivePolicyForUser } from "../collection/index";
import { assertProjectWritable, projectSources } from "../projects/index";

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

export async function registerArchiveAnalysisModule(app: FastifyInstance, pool: Pool) {
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
}
