import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Actor } from "../../../packages/contracts/src/access";
import type { ExploreAnalyzeResponse } from "../../../packages/contracts/src/explore";
import type {
  ReportDraftUpsertInputType,
  ReportListQuery,
  ReportRunStateType,
  ReportScheduleCreateInputType,
  ReportSchedulePatchInputType,
  ReportTemplateType,
} from "../../../packages/contracts/src/reports";
import type { Static } from "@sinclair/typebox";
import { fail } from "../../shared/errors";
import { loadAuthorizedBatches } from "../collection/index";
import { projectSources } from "../projects/index";
import type { ArchiveRuntimeFacade, ExploreStudyStore } from "../archive-analysis/index";
import type {
  ReportEvidenceItem,
  ReportScopeSummary,
  ReportSectionData,
} from "./types";

export interface ReportDraftRow {
  id: string;
  owner_user_id: string;
  revision: number;
  template: ReportTemplateType;
  title: string;
  input_json: Record<string, unknown>;
  discovery_json: Record<string, unknown> | null;
  plan_json: Record<string, unknown> | null;
  sections_json: string[];
  project_id: string | null;
  status: "draft" | "submitted" | "archived";
  created_at: Date;
  updated_at: Date;
}

export interface ReportRunRow {
  id: string;
  owner_user_id: string;
  draft_id: string | null;
  schedule_id: string | null;
  schedule_slot: string | null;
  idempotency_key: string | null;
  template: ReportTemplateType;
  title: string;
  project_id: string | null;
  scope_hash: string;
  data_version: string;
  plan_json: Record<string, unknown>;
  state: ReportRunStateType;
  stage_label: string;
  step_progress_json: Record<string, unknown>;
  snapshot_json: Record<string, unknown> | null;
  narrative_checkpoint_json: Record<string, unknown>;
  llm_usage_json: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  cancel_requested: boolean;
  report_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ReportDocumentRow {
  id: string;
  owner_user_id: string;
  project_id: string | null;
  project_deleted: boolean;
  run_id: string | null;
  schedule_id: string | null;
  template: ReportTemplateType;
  schema_version: string;
  report_version: number;
  title: string;
  subtitle: string;
  summary: string;
  visibility: "private" | "shared";
  mode: "llm_verified" | "pure_data" | "partial_llm";
  scope_json: { scopes?: ReportScopeSummary[]; [key: string]: unknown };
  sections_json: ReportSectionData[];
  evidence_json: ReportEvidenceItem[];
  provenance_json: Record<string, unknown>;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ReportScheduleRow {
  id: string;
  owner_user_id: string;
  project_id: string | null;
  monitor_id: string | null;
  name: string;
  template: ReportTemplateType;
  config_json: Record<string, unknown>;
  cadence: "daily" | "weekly" | "monthly" | "custom_interval";
  interval_minutes: number | null;
  timezone: string;
  window_hours: number;
  enabled: boolean;
  next_run_at: Date;
  last_run_at: Date | null;
  last_run_id: string | null;
  last_status: string | null;
  last_error: string | null;
  max_daily_tokens: number;
  created_at: Date;
  updated_at: Date;
}

// ---------------- Explore Study Store (persisted in report_explore_study) ----------------

export function createPgExploreStudyStore(pool: Pool): ExploreStudyStore {
  return {
    async saveStudy(entry) {
      await pool.query(
        `INSERT INTO report_explore_study (
           study_id, owner_user_id, project_id, archive_ref_id, source_mode,
           scope_hash, data_version, request_json, response_json, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb, NOW() + INTERVAL '7 days')
         ON CONFLICT (study_id) DO UPDATE SET
           response_json = EXCLUDED.response_json,
           request_json = EXCLUDED.request_json,
           expires_at = EXCLUDED.expires_at
         WHERE report_explore_study.owner_user_id = EXCLUDED.owner_user_id`,
        [
          entry.studyId,
          entry.ownerUserId,
          entry.projectId ?? null,
          entry.archiveRefId ?? null,
          entry.sourceMode,
          entry.scopeHash,
          entry.dataVersion,
          JSON.stringify(entry.request),
          JSON.stringify(entry.response),
        ],
      );
    },
    async loadStudyForOwner(studyId, ownerUserId) {
      const { rows } = await pool.query<{
        study_id: string;
        project_id: string | null;
        archive_ref_id: string | null;
        source_mode: string;
        scope_hash: string;
        data_version: string;
        request_json: unknown;
        response_json: ExploreAnalyzeResponse;
      }>(
        `SELECT study_id, project_id, archive_ref_id, source_mode, scope_hash, data_version, request_json, response_json
         FROM report_explore_study
         WHERE study_id = $1 AND owner_user_id = $2 AND expires_at > NOW()`,
        [studyId, ownerUserId],
      );
      if (!rows[0]) return null;
      return {
        studyId: rows[0].study_id,
        projectId: rows[0].project_id,
        archiveRefId: rows[0].archive_ref_id,
        sourceMode: rows[0].source_mode,
        scopeHash: rows[0].scope_hash,
        dataVersion: rows[0].data_version,
        request: rows[0].request_json,
        response: rows[0].response_json,
      };
    },
    async verifyStudyOwner(studyId, ownerUserId) {
      const { rows } = await pool.query<{ owner_user_id: string }>(
        "SELECT owner_user_id FROM report_explore_study WHERE study_id = $1",
        [studyId],
      );
      return Boolean(rows[0] && rows[0].owner_user_id === ownerUserId);
    },
  };
}

// ---------------- Drafts ----------------

export async function listDrafts(pool: Pool, actor: Actor) {
  const { rows } = await pool.query<ReportDraftRow>(
    `SELECT * FROM report_draft
     WHERE owner_user_id = $1 AND status = 'draft'
     ORDER BY updated_at DESC LIMIT 20`,
    [actor.userId],
  );
  return rows.map(formatDraft);
}

export async function upsertDraft(pool: Pool, actor: Actor, input: ReportDraftUpsertInputType) {
  if (input.id) {
    const { rows } = await pool.query<ReportDraftRow>(
      `UPDATE report_draft
       SET template = $3, title = $4, input_json = $5::jsonb, discovery_json = $6::jsonb,
           plan_json = $7::jsonb, sections_json = $8::jsonb, project_id = $9,
           revision = revision + 1, updated_at = NOW()
       WHERE id = $1 AND owner_user_id = $2
       RETURNING *`,
      [
        input.id,
        actor.userId,
        input.template,
        input.title ?? "",
        JSON.stringify(input.input),
        input.discovery ? JSON.stringify(input.discovery) : null,
        input.plan ? JSON.stringify(input.plan) : null,
        JSON.stringify(input.sections ?? []),
        input.projectId ?? null,
      ],
    );
    if (!rows[0]) fail(404, "Draft not found");
    return formatDraft(rows[0]);
  }
  const { rows } = await pool.query<ReportDraftRow>(
    `INSERT INTO report_draft (id, owner_user_id, template, title, input_json, discovery_json, plan_json, sections_json, project_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9)
     RETURNING *`,
    [
      randomUUID(),
      actor.userId,
      input.template,
      input.title ?? "",
      JSON.stringify(input.input),
      input.discovery ? JSON.stringify(input.discovery) : null,
      input.plan ? JSON.stringify(input.plan) : null,
      JSON.stringify(input.sections ?? []),
      input.projectId ?? null,
    ],
  );
  return formatDraft(rows[0]);
}

export async function deleteDraft(pool: Pool, actor: Actor, id: string) {
  const res = await pool.query("DELETE FROM report_draft WHERE id = $1 AND owner_user_id = $2", [id, actor.userId]);
  if (!res.rowCount) fail(404, "Draft not found");
  return { deleted: true };
}

export function formatDraft(row: ReportDraftRow) {
  return {
    id: row.id,
    revision: row.revision,
    template: row.template,
    title: row.title,
    input: row.input_json,
    discovery: row.discovery_json,
    plan: row.plan_json,
    sections: row.sections_json,
    projectId: row.project_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ---------------- Runs ----------------

export async function listRuns(pool: Pool, actor: Actor, opts?: { projectId?: string; limit?: number }) {
  const { rows } = await pool.query<ReportRunRow>(
    `SELECT * FROM report_run
     WHERE owner_user_id = $1
       AND ($2::uuid IS NULL OR project_id = $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [actor.userId, opts?.projectId ?? null, opts?.limit ?? 30],
  );
  return rows.map(formatRun);
}

export async function getRunForActor(pool: Pool, actor: Actor, runId: string) {
  const { rows } = await pool.query<ReportRunRow>(
    "SELECT * FROM report_run WHERE id = $1 AND owner_user_id = $2",
    [runId, actor.userId],
  );
  if (!rows[0]) fail(404, "Research run not found");
  return formatRun(rows[0]);
}

export function formatRun(row: ReportRunRow) {
  return {
    id: row.id,
    draftId: row.draft_id,
    scheduleId: row.schedule_id,
    scheduleSlot: row.schedule_slot,
    template: row.template,
    title: row.title,
    projectId: row.project_id,
    scopeHash: row.scope_hash,
    dataVersion: row.data_version,
    state: row.state,
    stageLabel: row.stage_label,
    stepProgress: row.step_progress_json,
    llmUsage: row.llm_usage_json,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    cancelRequested: row.cancel_requested,
    reportId: row.report_id,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ---------------- Reports & Access Re-verification ----------------

export async function assertReportAccessReverified(
  pool: Pool,
  actor: Actor,
  row: ReportDocumentRow,
  archiveRuntime?: ArchiveRuntimeFacade,
): Promise<void> {
  // Default private: only owner can read/export personal reports (Admin/Owner do not bypass personal report privacy)
  if (row.owner_user_id !== actor.userId) {
    fail(403, "report_forbidden");
  }
  const scopes = row.scope_json?.scopes ?? [];
  for (const scope of scopes) {
    if (scope.sourceKind === "archive" && archiveRuntime) {
      const st = await archiveRuntime.checkStatus(actor);
      if (st.state === "archive_forbidden") {
        fail(403, "report_source_revoked");
      }
    }
    if (scope.batchIds?.length) {
      const authBatches = await loadAuthorizedBatches(pool, actor, scope.batchIds);
      if (authBatches.length < scope.batchIds.length) {
        fail(403, "report_source_revoked");
      }
    }
    if (scope.projectId && !row.project_deleted) {
      try {
        await projectSources(pool, actor, scope.projectId);
      } catch {
        // If project was deleted, check if row.project_id is NULL (ON DELETE SET NULL); if project still exists but access was revoked -> 403!
        const exists = await pool.query("SELECT 1 FROM monitor_project WHERE id = $1", [scope.projectId]);
        if (exists.rowCount) {
          fail(403, "report_source_revoked");
        }
      }
    }
  }
}

export async function listReports(pool: Pool, actor: Actor, query: Static<typeof ReportListQuery>) {
  const searchPattern = query.search?.trim() ? `%${query.search.trim().toLowerCase()}%` : null;
  const { rows } = await pool.query<ReportDocumentRow>(
    `SELECT * FROM report_document
     WHERE owner_user_id = $1
       AND deleted_at IS NULL
       AND ($2::text IS NULL OR template = $2)
       AND ($3::uuid IS NULL OR project_id = $3)
       AND ($4::text IS NULL OR LOWER(title) LIKE $4 OR LOWER(summary) LIKE $4)
     ORDER BY created_at DESC
     LIMIT $5`,
    [actor.userId, query.template ?? null, query.projectId ?? null, searchPattern, query.limit ?? 50],
  );
  return rows.map(formatReportSummary);
}

export async function getReportForActor(
  pool: Pool,
  actor: Actor,
  reportId: string,
  archiveRuntime?: ArchiveRuntimeFacade,
) {
  const { rows } = await pool.query<ReportDocumentRow>(
    "SELECT * FROM report_document WHERE id = $1 AND deleted_at IS NULL",
    [reportId],
  );
  if (!rows[0]) fail(404, "Report not found");
  await assertReportAccessReverified(pool, actor, rows[0], archiveRuntime);
  return formatReportDetail(rows[0]);
}

export async function deleteReportForActor(pool: Pool, actor: Actor, reportId: string) {
  const res = await pool.query(
    "UPDATE report_document SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL",
    [reportId, actor.userId],
  );
  if (!res.rowCount) fail(404, "Report not found");
  return { deleted: true };
}

export function formatReportSummary(row: ReportDocumentRow) {
  const scopes = row.scope_json?.scopes ?? [];
  return {
    id: row.id,
    projectId: row.project_id,
    projectDeleted: row.project_deleted,
    runId: row.run_id,
    scheduleId: row.schedule_id,
    template: row.template,
    schemaVersion: row.schema_version,
    reportVersion: row.report_version,
    title: row.title,
    subtitle: row.subtitle,
    summary: row.summary,
    visibility: row.visibility,
    mode: row.mode,
    sectionCount: Array.isArray(row.sections_json) ? row.sections_json.length : 0,
    evidenceCount: Array.isArray(row.evidence_json) ? row.evidence_json.length : 0,
    primarySourceLabel: scopes[0]?.sourceLabel ?? "",
    analyzedCount: scopes.reduce((s, sc) => s + (sc.analyzedCount || 0), 0),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function formatReportDetail(row: ReportDocumentRow) {
  return {
    ...formatReportSummary(row),
    scopes: row.scope_json?.scopes ?? [],
    scopeMeta: row.scope_json,
    sections: row.sections_json ?? [],
    evidence: row.evidence_json ?? [],
    provenance: row.provenance_json ?? {},
  };
}

// ---------------- Schedules ----------------

export function computeNextRunAt(
  cadence: "daily" | "weekly" | "monthly" | "custom_interval",
  intervalMinutes: number | null | undefined,
  fromDate = new Date(),
): Date {
  const base = fromDate.getTime();
  if (cadence === "custom_interval" && intervalMinutes && intervalMinutes >= 1) {
    return new Date(base + intervalMinutes * 60_000);
  }
  if (cadence === "weekly") return new Date(base + 7 * 86_400_000);
  if (cadence === "monthly") return new Date(base + 30 * 86_400_000);
  // Daily: next 08:00 Asia/Shanghai (= 00:00 UTC next day)
  const nextUtcMidnight = Math.floor(base / 86_400_000 + 1) * 86_400_000;
  return new Date(nextUtcMidnight);
}

export async function listSchedules(pool: Pool, actor: Actor, projectId?: string) {
  const { rows } = await pool.query<ReportScheduleRow>(
    `SELECT * FROM report_schedule
     WHERE owner_user_id = $1
       AND ($2::uuid IS NULL OR project_id = $2)
     ORDER BY created_at DESC LIMIT 50`,
    [actor.userId, projectId ?? null],
  );
  return rows.map(formatSchedule);
}

export async function createSchedule(pool: Pool, actor: Actor, input: ReportScheduleCreateInputType) {
  if (input.projectId) {
    await projectSources(pool, actor, input.projectId);
  }
  const nextRun = computeNextRunAt(input.cadence, input.intervalMinutes);
  const { rows } = await pool.query<ReportScheduleRow>(
    `INSERT INTO report_schedule (
       id, owner_user_id, project_id, monitor_id, name, template, config_json,
       cadence, interval_minutes, timezone, window_hours, enabled, next_run_at, max_daily_tokens
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      randomUUID(),
      actor.userId,
      input.projectId ?? null,
      input.monitorId ?? null,
      input.name.trim(),
      input.template,
      JSON.stringify(input.config ?? {}),
      input.cadence,
      input.intervalMinutes ?? null,
      input.timezone ?? "Asia/Shanghai",
      input.windowHours ?? (input.cadence === "weekly" ? 168 : 24),
      input.enabled ?? true,
      nextRun.toISOString(),
      input.maxDailyTokens ?? 120_000,
    ],
  );
  return formatSchedule(rows[0]);
}

export async function updateSchedule(pool: Pool, actor: Actor, id: string, patch: ReportSchedulePatchInputType) {
  const existing = await pool.query<ReportScheduleRow>(
    "SELECT * FROM report_schedule WHERE id = $1 AND owner_user_id = $2",
    [id, actor.userId],
  );
  if (!existing.rows[0]) fail(404, "Report schedule not found");
  const cur = existing.rows[0];
  const nextCadence = patch.cadence ?? cur.cadence;
  const nextInterval = patch.intervalMinutes !== undefined ? patch.intervalMinutes : cur.interval_minutes;
  const nextRun = patch.cadence || patch.intervalMinutes !== undefined
    ? computeNextRunAt(nextCadence, nextInterval)
    : cur.next_run_at;
  const { rows } = await pool.query<ReportScheduleRow>(
    `UPDATE report_schedule
     SET name = $3, cadence = $4, interval_minutes = $5, timezone = $6, window_hours = $7,
         enabled = $8, config_json = $9::jsonb, max_daily_tokens = $10, next_run_at = $11, updated_at = NOW()
     WHERE id = $1 AND owner_user_id = $2
     RETURNING *`,
    [
      id,
      actor.userId,
      patch.name?.trim() || cur.name,
      nextCadence,
      nextInterval,
      patch.timezone ?? cur.timezone,
      patch.windowHours ?? cur.window_hours,
      patch.enabled ?? cur.enabled,
      JSON.stringify(patch.config ?? cur.config_json),
      patch.maxDailyTokens ?? cur.max_daily_tokens,
      nextRun.toISOString(),
    ],
  );
  return formatSchedule(rows[0]);
}

export async function deleteSchedule(pool: Pool, actor: Actor, id: string) {
  const res = await pool.query("DELETE FROM report_schedule WHERE id = $1 AND owner_user_id = $2", [id, actor.userId]);
  if (!res.rowCount) fail(404, "Report schedule not found");
  return { deleted: true };
}

export function formatSchedule(row: ReportScheduleRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    monitorId: row.monitor_id,
    name: row.name,
    template: row.template,
    config: row.config_json,
    cadence: row.cadence,
    intervalMinutes: row.interval_minutes,
    timezone: row.timezone,
    windowHours: row.window_hours,
    enabled: row.enabled,
    nextRunAt: row.next_run_at.toISOString(),
    lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : null,
    lastRunId: row.last_run_id,
    lastStatus: row.last_status,
    lastError: row.last_error,
    maxDailyTokens: row.max_daily_tokens,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function insertReportDocumentAtomic(
  client: Pool | PoolClient,
  input: {
    ownerUserId: string;
    projectId: string | null;
    runId: string;
    scheduleId: string | null;
    template: ReportTemplateType;
    title: string;
    subtitle: string;
    summary: string;
    mode: "llm_verified" | "pure_data" | "partial_llm";
    scopes: ReportScopeSummary[];
    sections: ReportSectionData[];
    evidence: ReportEvidenceItem[];
    provenance: Record<string, unknown>;
  },
): Promise<ReportDocumentRow> {
  const { rows } = await client.query<ReportDocumentRow>(
    `INSERT INTO report_document (
       id, owner_user_id, project_id, run_id, schedule_id, template,
       title, subtitle, summary, visibility, mode, scope_json,
       sections_json, evidence_json, provenance_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'private',$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb)
     ON CONFLICT (run_id) DO UPDATE SET
       title = EXCLUDED.title,
       subtitle = EXCLUDED.subtitle,
       summary = EXCLUDED.summary,
       mode = EXCLUDED.mode,
       scope_json = EXCLUDED.scope_json,
       sections_json = EXCLUDED.sections_json,
       evidence_json = EXCLUDED.evidence_json,
       provenance_json = EXCLUDED.provenance_json,
       report_version = report_document.report_version + 1,
       updated_at = NOW()
     RETURNING *`,
    [
      randomUUID(),
      input.ownerUserId,
      input.projectId,
      input.runId,
      input.scheduleId,
      input.template,
      input.title,
      input.subtitle,
      input.summary,
      input.mode,
      JSON.stringify({ scopes: input.scopes }),
      JSON.stringify(input.sections),
      JSON.stringify(input.evidence),
      JSON.stringify(input.provenance),
    ],
  );
  return rows[0];
}
