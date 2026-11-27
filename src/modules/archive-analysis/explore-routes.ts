import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { Pool, PoolClient } from "pg";
import type { Actor } from "../../../packages/contracts/src/access";
import type { ContentPlatform } from "../../../packages/contracts/src/common";
import type { Filter } from "../../../packages/contracts/src/content";
import {
  ExploreAnalyzeRequest,
  ExploreAnalyzeResponse,
  ExploreCapabilitiesResponse,
  ExploreEvidenceRequest,
  ExploreEvidenceResponse,
  ExploreProgressParams,
  ExploreProgressResponse,
  type ExplorePanelId,
  type ExplorePanelResult,
  type ExploreSourceMode,
  type ExploreSourceProfile,
} from "../../../packages/contracts/src/explore";
import { fail, AppError } from "../../shared/errors";
import {
  type BatchMembership,
  compileContentFilter,
  contentSourceTables,
  contentTables,
} from "../content/index";
import { resolveProjectScope } from "../projects/index";
import {
  type CanonicalExploreDoc,
  resolveBuiltinEvidence,
  runBuiltinExploreAnalysis,
} from "./explore-fallback";
import {
  buildDynamicGuidance,
  buildSourceImpactNotes,
  EXPLORE_SCENARIOS,
  PANEL_SCENARIO_MAP,
  SOURCE_MODE_LABELS,
} from "./explore-guidance";

export interface ExploreArchiveBridge {
  enabled: boolean;
  url?: URL;
  token?: string;
  timeoutMs: number;
  checkArchiveStatus: (
    db: Pool | PoolClient,
    actor: Actor,
  ) => Promise<{
    available: boolean;
    state: string;
    months: string[];
    version?: string;
    sourceId?: string;
  }>;
  getProjectArchiveRef: (
    actor: Actor,
    projectId: string,
    refId: string,
  ) => Promise<{
    id: string;
    version: string;
    scope: { months: string[]; query: string; subreddits: string[]; from: string | null; to: string | null };
  }>;
}

interface WorkerHealth {
  pythonWorkerReady: boolean;
  potionModelReady: boolean;
}

interface WorkerAnalyzePayload {
  studyId: string;
  dataVersion: string;
  engine: "duckdb_potion_worker" | "python_potion_worker";
  potionModelReady: boolean;
  analyzedDocuments: number;
  rawDocuments: number;
  isTruncated?: boolean;
  elapsedMs: number;
  panels: Array<Omit<ExplorePanelResult, "scenario"> & { panel_id: ExplorePanelId }>;
}

const DEFAULT_EXPLORE_LIMIT = 2000;

interface LocalRunProgress {
  runId: string;
  actorId: string;
  delegatedToPython: boolean;
  stage: string;
  stageLabel: string;
  percent: number;
  completedPanels: string[];
  totalPanels: number;
  currentPanel: string | null;
  rawDocuments: number | null;
  analyzedDocuments: number | null;
  startedAt: number;
}

const localProgressMap = new Map<string, LocalRunProgress>();

function setLocalProgress(runId: string | undefined, actorId: string, patch: Partial<LocalRunProgress>) {
  if (!runId) return;
  const existing: LocalRunProgress = localProgressMap.get(runId) ?? {
    runId,
    actorId,
    delegatedToPython: false,
    stage: "retrieving",
    stageLabel: "正在初始化分析任务",
    percent: 5,
    completedPanels: [],
    totalPanels: 12,
    currentPanel: null,
    rawDocuments: null,
    analyzedDocuments: null,
    startedAt: Date.now(),
  };
  localProgressMap.set(runId, { ...existing, ...patch });
  if (localProgressMap.size > 32) {
    const oldest = localProgressMap.keys().next().value;
    if (oldest) localProgressMap.delete(oldest);
  }
}

async function fetchPythonProgress(bridge: ExploreArchiveBridge, runId: string): Promise<ExploreProgressResponse | null> {
  if (!bridge.enabled || !bridge.url || !bridge.token) return null;
  const signal = AbortSignal.timeout(2000);
  try {
    const res = await fetch(new URL(`analyze/progress?runId=${encodeURIComponent(runId)}`, bridge.url), {
      method: "GET",
      redirect: "error",
      signal,
      headers: { authorization: "Bearer " + bridge.token },
    });
    if (!res.ok) return null;
    return (await res.json()) as ExploreProgressResponse;
  } catch {
    return null;
  }
}

async function checkPythonWorkerHealth(bridge: ExploreArchiveBridge): Promise<WorkerHealth> {
  if (!bridge.enabled || !bridge.url || !bridge.token) {
    return { pythonWorkerReady: false, potionModelReady: false };
  }
  const signal = AbortSignal.timeout(Math.min(bridge.timeoutMs, 2500));
  try {
    const res = await fetch(new URL("health", bridge.url), {
      method: "GET",
      redirect: "error",
      signal,
      headers: { authorization: "Bearer " + bridge.token },
    });
    if (!res.ok) return { pythonWorkerReady: false, potionModelReady: false };
    const body = (await res.json()) as { analytics?: { available?: boolean; potionModelReady?: boolean } };
    return {
      pythonWorkerReady: Boolean(body.analytics?.available),
      potionModelReady: Boolean(body.analytics?.potionModelReady),
    };
  } catch {
    return { pythonWorkerReady: false, potionModelReady: false };
  }
}

async function callPythonWorker<T>(
  bridge: ExploreArchiveBridge,
  path: "analyze/archive" | "analyze/documents" | "analyze/evidence",
  body: object,
): Promise<T> {
  if (!bridge.enabled) fail(503, "archive_disabled");
  if (!bridge.url || !bridge.token) fail(503, "archive_unconfigured");
  const timeout = Math.max(bridge.timeoutMs, 120_000);
  const signal = AbortSignal.timeout(timeout);
  try {
    const res = await fetch(new URL(path, bridge.url), {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: "Bearer " + bridge.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json()) as T & { code?: string };
    if (!res.ok) {
      fail(res.status >= 400 && res.status < 600 ? res.status : 503, parsed?.code || "analytics_unavailable");
    }
    return parsed;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (signal.aborted) fail(503, "query_timeout");
    fail(503, "archive_offline");
  }
}

interface PgContentRow {
  id: string;
  platform: string;
  kind: string;
  external_id: string;
  root_id: string | null;
  parent_id: string | null;
  author_handle: string | null;
  community_name: string | null;
  title: string | null;
  body_text: string | null;
  url: string | null;
  language: string | null;
  created_at_source: string | null;
  first_seen_at: string | null;
  metric_score: number | null;
  metric_comments: number | null;
  metric_likes: number | null;
  metric_reposts: number | null;
  metric_views: number | null;
}

function extractChannels(row: PgContentRow): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (key: string, val: number | null) => {
    if (typeof val === "number" && Number.isFinite(val)) out[key] = val;
  };
  if (row.platform === "reddit") {
    add("score", row.metric_score);
    add("reported_comments", row.metric_comments);
  } else if (row.platform === "x" || row.platform === "bluesky") {
    add("likes", row.metric_likes);
    add("reposts", row.metric_reposts);
    add("replies", row.metric_comments);
    add("views", row.metric_views);
  } else {
    add("score", row.metric_score);
    add("likes", row.metric_likes);
    add("comments", row.metric_comments);
  }
  return out;
}

function buildFilterForSourceMode(
  req: ExploreAnalyzeRequest,
): { filter: Filter; platforms?: ContentPlatform[] } {
  const filter: Filter = {};
  const trimmed = req.query.trim();
  if (trimmed.length >= 2) {
    // Pass simple terms cleanly to PG search; strip boolean operators for PG fallback
    const cleanTerm = trimmed.replace(/\b(?:AND|OR|NOT)\b/gi, " ").replace(/["()]/g, " ").replace(/\s+/g, " ").trim();
    if (cleanTerm.length >= 2) {
      const words = cleanTerm.split(" ").filter((w) => w.length >= 2);
      if (words.length === 1) filter.query = words[0];
      else if (words.length > 1) filter.allTerms = words.slice(0, 4);
    }
  }
  if (req.from) filter.from = req.from;
  if (req.to) filter.to = req.to;
  if (req.subreddits?.length) filter.communities = req.subreddits;

  if (req.sourceMode === "info_stream") {
    filter.platforms = ["web"];
  } else if (req.sourceMode === "reddit_api") {
    filter.platforms = ["reddit"];
  } else if (req.sourceMode === "x_api") {
    filter.platforms = ["x"];
  } else if (req.platforms?.length) {
    filter.platforms = req.platforms;
  }
  return { filter, platforms: filter.platforms };
}

async function loadAuthorizedPgDocuments(
  pool: Pool,
  actor: Actor,
  req: ExploreAnalyzeRequest,
): Promise<{ docs: CanonicalExploreDoc[]; rawCount: number; isSampled: boolean; sampleCap: number; dataVersion: string }> {
  const sampleCap = req.limit ?? DEFAULT_EXPLORE_LIMIT;
  const { filter } = buildFilterForSourceMode(req);

  let projectSourceIds: string[] | undefined;
  let projectFilter: Filter = {};
  let batchMembership: BatchMembership | undefined;

  if (req.sourceMode === "project_content") {
    if (!req.projectId) fail(400, "project_id_required");
    const scope = await resolveProjectScope(pool, actor, req.projectId);
    projectSourceIds = scope.source_ids;
    projectFilter = scope.filter;
    batchMembership = "batchMembership" in scope ? scope.batchMembership : undefined;
  }

  const compiled = compileContentFilter(actor, filter, projectSourceIds, projectFilter, false, batchMembership);
  const fromTables = compiled.needsSearchDocument ? contentTables : contentSourceTables;
  const limitBind = `$${compiled.values.length + 1}`;
  const sql = `
    SELECT
      c.id,
      p.code AS platform,
      c.kind,
      c.external_id,
      c.root_id,
      c.parent_id,
      c.author_handle,
      c.community_name,
      c.title,
      c.body_text,
      c.url,
      c.language,
      c.created_at_source,
      c.first_seen_at,
      c.metric_score,
      c.metric_comments,
      c.metric_likes,
      c.metric_reposts,
      c.metric_views
    FROM ${fromTables}
    WHERE ${compiled.text}
    ORDER BY COALESCE(c.created_at_source, c.first_seen_at) DESC NULLS LAST, c.id DESC
    LIMIT ${limitBind}
  `;

  const { rows } = await pool.query<PgContentRow>(sql, [...compiled.values, sampleCap + 1]);
  const isSampled = rows.length > sampleCap;
  const sliced = rows.slice(0, sampleCap);
  const datasetId = req.sourceMode === "project_content" ? `project:${req.projectId}` : `pg:${req.sourceMode}`;

  const docs: CanonicalExploreDoc[] = [];
  for (const row of sliced) {
    const title = (row.title ?? "").trim();
    const body = (row.body_text ?? "").trim();
    const text = title && body ? `${title}\n\n${body}` : title || body;
    if (!text) continue;
    const createdMs = row.created_at_source ? Date.parse(row.created_at_source) : row.first_seen_at ? Date.parse(row.first_seen_at) : NaN;
    const obsMs = row.first_seen_at ? Date.parse(row.first_seen_at) : NaN;
    docs.push({
      source_id: `pg:${row.platform}`,
      source_type: row.platform,
      dataset_id: datasetId,
      document_id: row.id,
      source_document_id: row.external_id,
      thread_id: row.root_id ?? row.id,
      parent_id: row.parent_id ?? "",
      author_key: row.author_handle ?? "",
      group: row.community_name || row.platform,
      kind: row.kind || "post",
      created_utc: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : null,
      observed_at: Number.isFinite(obsMs) ? Math.floor(obsMs / 1000) : null,
      title,
      url: row.url ?? "",
      language: row.language ?? "",
      text,
      engagement_channels: extractChannels(row),
    });
  }

  return {
    docs,
    rawCount: sliced.length,
    isSampled,
    sampleCap,
    dataVersion: `${datasetId}:${new Date().toISOString().slice(0, 16)}`,
  };
}

function summarizeSourceProfile(
  sourceMode: ExploreSourceMode,
  engine: ExploreSourceProfile["engine"],
  potionModelReady: boolean,
  rawDocuments: number,
  analyzedDocuments: number,
  isSampled: boolean,
  sampleCap: number,
  docs: readonly { source_type: string; created_utc: number | null }[],
): ExploreSourceProfile {
  const counts = new Map<string, number>();
  const days = new Set<string>();
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const d of docs) {
    const p = d.source_type || "unknown";
    counts.set(p, (counts.get(p) ?? 0) + 1);
    if (typeof d.created_utc === "number" && Number.isFinite(d.created_utc)) {
      if (d.created_utc < minTs) minTs = d.created_utc;
      if (d.created_utc > maxTs) maxTs = d.created_utc;
      days.add(new Date(d.created_utc * 1000).toISOString().slice(0, 10));
    }
  }
  const total = docs.length || 1;
  const platformBreakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([platform, documents]) => ({
      platform,
      documents,
      sharePct: Math.round((documents / total) * 1000) / 10,
    }));

  const engineLabel =
    engine === "duckdb_potion_worker"
      ? "DuckDB + Potion Python 分析引擎"
      : engine === "python_potion_worker"
        ? "PG16 授权语料 + Potion Python 分析引擎"
        : "PG16 授权语料 + 主线内置快速分析引擎";

  return {
    sourceMode,
    sourceLabel: SOURCE_MODE_LABELS[sourceMode],
    engine,
    engineLabel,
    potionModelReady,
    rawDocuments,
    analyzedDocuments,
    isSampled,
    sampleCap,
    timeRange: {
      from: Number.isFinite(minTs) ? new Date(minTs * 1000).toISOString().slice(0, 10) : null,
      to: Number.isFinite(maxTs) ? new Date(maxTs * 1000).toISOString().slice(0, 10) : null,
      activeDays: days.size,
    },
    platformBreakdown,
    impactNotes: buildSourceImpactNotes(sourceMode, engine, {
      potionModelReady,
      isSampled,
      sampleCap,
      analyzedDocuments,
      platformCount: platformBreakdown.length,
    }),
  };
}

function attachScenarios(
  rawPanels: ReadonlyArray<Omit<ExplorePanelResult, "scenario"> & { panel_id: ExplorePanelId }>,
): ExplorePanelResult[] {
  return rawPanels.map((p) => ({
    ...p,
    scenario: PANEL_SCENARIO_MAP[p.panel_id],
  }));
}

export function registerExploreRoutes(app: FastifyInstance, pool: Pool, bridge: ExploreArchiveBridge) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const read = { auth: { access: "authenticated", browserOnly: true } } as const;

  api.get(
    "/v1/explore/capabilities",
    { config: read, schema: { response: { 200: ExploreCapabilitiesResponse } } },
    async (request) => {
      const actor = request.actor!;
      const [archiveStatus, workerHealth, countRows] = await Promise.all([
        bridge.checkArchiveStatus(pool, actor),
        checkPythonWorkerHealth(bridge),
        (async () => {
          const compiled = compileContentFilter(actor, {});
          const { rows } = await pool.query<{ code: string; cnt: string }>(
            `SELECT p.code, COUNT(DISTINCT c.id)::text AS cnt FROM ${contentSourceTables} WHERE ${compiled.text} GROUP BY p.code`,
            compiled.values,
          );
          return rows;
        })(),
      ]);

      const byPlat = new Map(countRows.map((r) => [r.code, Number(r.cnt) || 0]));
      const infoStream = byPlat.get("web") ?? 0;
      const reddit = byPlat.get("reddit") ?? 0;
      const x = byPlat.get("x") ?? 0;
      const bluesky = byPlat.get("bluesky") ?? 0;
      const total = [...byPlat.values()].reduce((s, v) => s + v, 0);

      return {
        archiveAvailable: archiveStatus.available,
        archiveState: archiveStatus.state,
        archiveMonths: archiveStatus.months,
        pythonWorkerReady: workerHealth.pythonWorkerReady,
        potionModelReady: workerHealth.potionModelReady,
        liveContentCounts: { total, infoStream, reddit, x, bluesky },
        scenarios: EXPLORE_SCENARIOS,
      };
    },
  );

  api.get(
    "/v1/explore/progress/:runId",
    { config: read, schema: { params: ExploreProgressParams, response: { 200: ExploreProgressResponse } } },
    async (request) => {
      const actor = request.actor!;
      const { runId } = request.params;
      const local = localProgressMap.get(runId);
      if (local && local.actorId !== actor.userId) {
        fail(404, "progress_not_found");
      }
      if (!local || local.delegatedToPython) {
        const remote = await fetchPythonProgress(bridge, runId);
        if (remote) return remote;
      }
      if (!local) {
        return {
          runId,
          stage: "retrieving",
          stageLabel: "正在连接分析引擎并准备数据范围",
          percent: 5,
          completedPanels: [],
          totalPanels: 12,
          currentPanel: null,
          rawDocuments: null,
          analyzedDocuments: null,
          elapsedMs: 0,
        };
      }
      return {
        runId: local.runId,
        stage: local.stage,
        stageLabel: local.stageLabel,
        percent: local.percent,
        completedPanels: local.completedPanels,
        totalPanels: local.totalPanels,
        currentPanel: local.currentPanel,
        rawDocuments: local.rawDocuments,
        analyzedDocuments: local.analyzedDocuments,
        elapsedMs: Date.now() - local.startedAt,
      };
    },
  );

  api.post(
    "/v1/explore/analyze",
    { config: read, schema: { body: ExploreAnalyzeRequest, response: { 200: ExploreAnalyzeResponse } } },
    async (request) => {
      const actor = request.actor!;
      const body = request.body;
      const runId = body.runId;
      const t0 = Date.now();
      const groupBy = body.groupBy ?? "group";
      const profile = body.profile ?? "fast";
      const limit = body.limit ?? DEFAULT_EXPLORE_LIMIT;

      setLocalProgress(runId, actor.userId, {
        stage: "retrieving",
        stageLabel: "正在校验数据权限与引擎状态",
        percent: 5,
      });

      const archiveStatus = await bridge.checkArchiveStatus(pool, actor);

      if (body.sourceMode === "archive") {
        if (!archiveStatus.available) {
          fail(503, archiveStatus.state || "archive_offline");
        }
        let months = archiveStatus.months;
        let query = body.query.trim();
        let subreddits = body.subreddits ?? [];
        let from = body.from ?? null;
        let to = body.to ?? null;

        if (body.projectId && body.archiveRefId) {
          const ref = await bridge.getProjectArchiveRef(actor, body.projectId, body.archiveRefId);
          months = ref.scope.months;
          if (!query && ref.scope.query) query = ref.scope.query;
          if (!subreddits.length && ref.scope.subreddits.length) subreddits = ref.scope.subreddits;
          if (!from && ref.scope.from) from = ref.scope.from;
          if (!to && ref.scope.to) to = ref.scope.to;
        }

        setLocalProgress(runId, actor.userId, {
          delegatedToPython: true,
          stage: "retrieving",
          stageLabel: `正在通过 DuckDB + FTS5 检索 ${months.length} 个月归档数据`,
          percent: 10,
        });

        const workerResult = await callPythonWorker<WorkerAnalyzePayload>(bridge, "analyze/archive", {
          runId,
          months,
          query,
          subreddits,
          from,
          to,
          includeComments: Boolean(body.includeComments),
          groupBy,
          profile,
          limit,
        });
        const panels = attachScenarios(workerResult.panels);
        const sourceProfile: ExploreSourceProfile = {
          sourceMode: "archive",
          sourceLabel: SOURCE_MODE_LABELS.archive,
          engine: "duckdb_potion_worker",
          engineLabel: "DuckDB + Potion Python 分析引擎",
          potionModelReady: workerResult.potionModelReady,
          rawDocuments: workerResult.rawDocuments,
          analyzedDocuments: workerResult.analyzedDocuments,
          isSampled: Boolean(workerResult.isTruncated),
          sampleCap: limit,
          timeRange: {
            from: months[0] ? `${months[0]}-01` : null,
            to: months.at(-1) ? `${months.at(-1)}-28` : null,
            activeDays: 0,
          },
          platformBreakdown: [{ platform: "reddit_archive", documents: workerResult.analyzedDocuments, sharePct: 100 }],
          impactNotes: buildSourceImpactNotes("archive", "duckdb_potion_worker", {
            potionModelReady: workerResult.potionModelReady,
            isSampled: Boolean(workerResult.isTruncated),
            sampleCap: limit,
            analyzedDocuments: workerResult.analyzedDocuments,
            platformCount: 1,
          }),
        };

        return {
          studyId: workerResult.studyId,
          dataVersion: workerResult.dataVersion,
          query,
          generatedAt: new Date().toISOString(),
          elapsedMs: Date.now() - t0,
          sourceProfile,
          panels,
          guidedNextSteps: buildDynamicGuidance(query, sourceProfile, panels, true),
        };
      }

      // Live / API / Project PG16 content sources
      setLocalProgress(runId, actor.userId, {
        stage: "retrieving",
        stageLabel: "正在从 PG16 检索当前账号已授权内容",
        percent: 15,
      });
      const pg = await loadAuthorizedPgDocuments(pool, actor, body);
      const workerHealth = await checkPythonWorkerHealth(bridge);

      if (workerHealth.pythonWorkerReady && pg.docs.length > 0) {
        try {
          setLocalProgress(runId, actor.userId, {
            delegatedToPython: true,
            stage: "ingesting",
            stageLabel: `已载入 ${pg.docs.length} 条站内记录，移交 Potion 分析引擎`,
            percent: 22,
            rawDocuments: pg.rawCount,
          });
          const seeds = body.query
            .trim()
            .split(/\s+/)
            .filter((s) => s.length >= 2 && !/^(AND|OR|NOT)$/i.test(s))
            .slice(0, 8);
          const workerResult = await callPythonWorker<WorkerAnalyzePayload>(bridge, "analyze/documents", {
            runId,
            documents: pg.docs,
            dataVersion: pg.dataVersion,
            seeds,
            groupBy,
            profile,
          });
          const panels = attachScenarios(workerResult.panels);
          const sourceProfile = summarizeSourceProfile(
            body.sourceMode,
            "python_potion_worker",
            workerResult.potionModelReady,
            pg.rawCount,
            workerResult.analyzedDocuments,
            pg.isSampled,
            pg.sampleCap,
            pg.docs,
          );
          return {
            studyId: workerResult.studyId,
            dataVersion: workerResult.dataVersion,
            query: body.query.trim(),
            generatedAt: new Date().toISOString(),
            elapsedMs: Date.now() - t0,
            sourceProfile,
            panels,
            guidedNextSteps: buildDynamicGuidance(body.query.trim(), sourceProfile, panels, archiveStatus.available),
          };
        } catch {
          // Gracefully degrade to builtin fast engine if Python worker fails mid-flight
        }
      }

      const fallback = runBuiltinExploreAnalysis(pg.docs, {
        dataVersion: pg.dataVersion,
        groupBy,
        query: body.query.trim(),
      });
      const sourceProfile = summarizeSourceProfile(
        body.sourceMode,
        "pg_builtin_fast",
        false,
        pg.rawCount,
        fallback.analyzedDocuments,
        pg.isSampled,
        pg.sampleCap,
        pg.docs,
      );
      return {
        studyId: fallback.studyId,
        dataVersion: pg.dataVersion,
        query: body.query.trim(),
        generatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
        sourceProfile,
        panels: fallback.panels,
        guidedNextSteps: buildDynamicGuidance(body.query.trim(), sourceProfile, fallback.panels, archiveStatus.available),
      };
    },
  );

  api.post(
    "/v1/explore/evidence",
    { config: read, schema: { body: ExploreEvidenceRequest, response: { 200: ExploreEvidenceResponse } } },
    async (request) => {
      const { studyId, evidenceId, offset = 0, limit = 20 } = request.body;
      const local = resolveBuiltinEvidence(studyId, evidenceId, offset, limit);
      if (local) return local;
      return callPythonWorker<ExploreEvidenceResponse>(bridge, "analyze/evidence", {
        studyId,
        evidenceId,
        offset,
        limit,
      });
    },
  );
}
