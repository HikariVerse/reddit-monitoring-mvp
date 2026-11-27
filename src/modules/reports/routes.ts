import type { FastifyInstance } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { Pool } from "pg";
import { ParamsId } from "../../../packages/contracts/src/common";
import {
  ReportDraftUpsertInput,
  ReportListQuery,
  ReportRunActionInput,
  ReportRunCreateInput,
  ReportScheduleCreateInput,
  ReportSchedulePatchInput,
  ResourceDiscoverRequest,
} from "../../../packages/contracts/src/reports";
import type { ContentProvider } from "../../connectors/shared/content-provider.interface";
import { fail } from "../../shared/errors";
import type { ArchiveRuntimeFacade } from "../archive-analysis/index";
import { assertBrowserExportAllowed } from "../collection/index";
import { discoverResearchResources } from "./discovery";
import { renderStandaloneReportHtml } from "./html-export";
import { probeReportLlm, readReportLlmConfig } from "./llm";
import {
  handleReportRunAction,
  startOrReuseReportRun,
  triggerReportScheduleOnce,
  type ReportOrchestratorDeps,
} from "./orchestrator";
import {
  createSchedule,
  deleteDraft,
  deleteReportForActor,
  deleteSchedule,
  getReportForActor,
  getRunForActor,
  listDrafts,
  listReports,
  listRuns,
  listSchedules,
  updateSchedule,
  upsertDraft,
  type ReportScheduleRow,
} from "./sql";
import { REPORT_MODULE_CATALOG } from "./types";

export async function registerReportsRoutes(
  app: FastifyInstance,
  deps: {
    pool: Pool;
    archiveRuntime?: ArchiveRuntimeFacade;
    providers?: ContentProvider[];
  },
) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const { pool, archiveRuntime, providers } = deps;
  const orchDeps: ReportOrchestratorDeps = {
    pool,
    archiveRuntime,
    providers,
    logError: (err, msg) => app.log.error({ err }, msg),
  };

  const read = { auth: { access: "authenticated", browserOnly: true } } as const;
  const write = { auth: { access: "viewer_write", browserOnly: true } } as const;

  // 1. Unified Resource Discovery (Read-only, zero side effects)
  api.post(
    "/v1/research/resources/discover",
    { config: read, schema: { body: ResourceDiscoverRequest } },
    async (request) => discoverResearchResources(pool, request.actor!, request.body, archiveRuntime),
  );

  // 2. Module Catalog & LLM readiness status (non-secret)
  api.get("/v1/reports/modules", { config: read }, async () => {
    const cfg = readReportLlmConfig();
    return {
      modules: REPORT_MODULE_CATALOG,
      llm: {
        configured: cfg.enabled,
        model: cfg.enabled ? cfg.model : null,
      },
    };
  });

  api.get("/v1/reports/llm/probe", { config: { auth: { access: "admin", browserOnly: true } } }, async () =>
    probeReportLlm(),
  );

  // 3. Drafts
  api.get("/v1/reports/drafts", { config: read }, async (request) => ({
    drafts: await listDrafts(pool, request.actor!),
  }));

  api.post(
    "/v1/reports/drafts",
    { config: write, schema: { body: ReportDraftUpsertInput } },
    async (request) => ({ draft: await upsertDraft(pool, request.actor!, request.body) }),
  );

  api.delete(
    "/v1/reports/drafts/:id",
    { config: write, schema: { params: ParamsId } },
    async (request) => deleteDraft(pool, request.actor!, request.params.id),
  );

  // 4. Runs (Async orchestrated research tasks)
  api.get("/v1/reports/runs", { config: read }, async (request) => {
    const q = request.query as { projectId?: string; limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 30));
    return { runs: await listRuns(pool, request.actor!, { projectId: q.projectId || undefined, limit }) };
  });

  api.post(
    "/v1/reports/runs",
    { config: write, schema: { body: ReportRunCreateInput } },
    async (request) => ({ run: await startOrReuseReportRun(orchDeps, request.actor!, request.body) }),
  );

  api.get(
    "/v1/reports/runs/:id",
    { config: read, schema: { params: ParamsId } },
    async (request) => ({ run: await getRunForActor(pool, request.actor!, request.params.id) }),
  );

  api.post(
    "/v1/reports/runs/:id/action",
    { config: write, schema: { params: ParamsId, body: ReportRunActionInput } },
    async (request) => ({ run: await handleReportRunAction(orchDeps, request.actor!, request.params.id, request.body) }),
  );

  // 5. Reports Library, Detail & Standalone HTML Export
  api.get(
    "/v1/reports",
    { config: read, schema: { querystring: ReportListQuery } },
    async (request) => ({ reports: await listReports(pool, request.actor!, request.query) }),
  );

  api.get(
    "/v1/reports/:id",
    { config: read, schema: { params: ParamsId } },
    async (request) => ({ report: await getReportForActor(pool, request.actor!, request.params.id, archiveRuntime) }),
  );

  api.delete(
    "/v1/reports/:id",
    { config: write, schema: { params: ParamsId } },
    async (request) => deleteReportForActor(pool, request.actor!, request.params.id),
  );

  api.get(
    "/v1/reports/:id/export",
    { config: read, schema: { params: ParamsId } },
    async (request, reply) => {
      const actor = request.actor!;
      await assertBrowserExportAllowed(pool, actor);
      const report = await getReportForActor(pool, actor, request.params.id, archiveRuntime);
      const html = renderStandaloneReportHtml(report);
      const safeName = report.title.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "siftline_report";
      reply
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.html`)
        .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
        .send(html);
    },
  );

  // 6. Periodic Report Schedules
  api.get("/v1/reports/schedules", { config: read }, async (request) => {
    const q = request.query as { projectId?: string };
    return { schedules: await listSchedules(pool, request.actor!, q.projectId || undefined) };
  });

  api.post(
    "/v1/reports/schedules",
    { config: write, schema: { body: ReportScheduleCreateInput } },
    async (request) => ({ schedule: await createSchedule(pool, request.actor!, request.body) }),
  );

  api.patch(
    "/v1/reports/schedules/:id",
    { config: write, schema: { params: ParamsId, body: ReportSchedulePatchInput } },
    async (request) => ({ schedule: await updateSchedule(pool, request.actor!, request.params.id, request.body) }),
  );

  api.delete(
    "/v1/reports/schedules/:id",
    { config: write, schema: { params: ParamsId } },
    async (request) => deleteSchedule(pool, request.actor!, request.params.id),
  );

  api.post(
    "/v1/reports/schedules/:id/trigger",
    { config: write, schema: { params: ParamsId } },
    async (request) => {
      const { rows } = await pool.query<ReportScheduleRow>(
        "SELECT * FROM report_schedule WHERE id = $1 AND owner_user_id = $2",
        [request.params.id, request.actor!.userId],
      );
      if (!rows[0]) fail(404, "Report schedule not found");
      const slot = `${rows[0].id}:manual:${Date.now()}`;
      return triggerReportScheduleOnce(orchDeps, rows[0], slot);
    },
  );
}
