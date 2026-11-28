import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Actor } from "../../../packages/contracts/src/access";
import type {
  ReportRunActionInputType,
  ReportRunCreateInputType,
  ReportRunStateType,
} from "../../../packages/contracts/src/reports";
import type { ContentProvider } from "../../connectors/shared/content-provider.interface";
import { fail } from "../../shared/errors";
import { notifyChannel } from "../../platform/pg-notify";
import { transaction } from "../../storage/db";
import { getUserRoleStatus } from "../access/index";
import type { ArchiveRuntimeFacade } from "../archive-analysis/index";
import { enqueueOnDemandCollection, loadEffectivePolicyForUser } from "../collection/index";
import { attachBatchToProject, projectSources, writeProject } from "../projects/index";
import {
  adaptExploreAnalysis,
  adaptMonitorAnalysis,
  adaptProjectL1L2L3Analysis,
  adaptStoriesAnalysis,
  type AdaptedAnalysisBundle,
} from "./adapters";
import {
  buildPureDataNarrative,
  readReportLlmConfig,
  synthesizeExecutiveSummary,
  synthesizeSectionNarrative,
  type LlmCallMetrics,
} from "./llm";
import { parseResearchQuery } from "./query-parser";
import {
  computeNextRunAt,
  formatRun,
  insertReportDocumentAtomic,
  type ReportRunRow,
  type ReportScheduleRow,
} from "./sql";
import {
  defaultSectionsForTemplate,
  REPORT_MODULE_CATALOG,
  type ReportEvidenceItem,
  type ReportNarrative,
  type ReportScopeSummary,
  type ReportSectionData,
} from "./types";

const MAX_CONCURRENT_RUNS = Math.max(1, Math.min(4, Number(process.env.REPORT_MAX_CONCURRENT_RUNS) || 2));
const activeRunIds = new Set<string>();
const runQueue: Array<() => Promise<void>> = [];

function scheduleRunWork(runId: string, fn: () => Promise<void>) {
  if (activeRunIds.has(runId)) return;
  const wrapped = async () => {
    activeRunIds.add(runId);
    try {
      await fn();
    } finally {
      activeRunIds.delete(runId);
      const next = runQueue.shift();
      if (next) void next();
    }
  };
  if (activeRunIds.size < MAX_CONCURRENT_RUNS) {
    void wrapped();
  } else {
    runQueue.push(wrapped);
  }
}

export interface ReportOrchestratorDeps {
  pool: Pool;
  archiveRuntime?: ArchiveRuntimeFacade;
  providers?: ContentProvider[];
  logError?: (err: unknown, msg: string) => void;
}

async function hydrateActorByUserId(pool: Pool, userId: string): Promise<Actor | null> {
  const user = await getUserRoleStatus(pool, userId);
  if (!user || user.status !== "active") return null;
  const policy = user.role === "viewer" ? await loadEffectivePolicyForUser(pool, userId) : null;
  return {
    sessionId: "00000000-0000-0000-0000-000000000000",
    userId: user.id,
    email: "",
    role: user.role as Actor["role"],
    planTier: policy?.planTier ?? "free",
    clientKind: "browser",
    scopes: ["read", "export", "collect", "projects:write"],
    allowedSourceIds: policy ? policy.allowedSourceIds : null,
  };
}

async function updateRunState(
  pool: Pool,
  runId: string,
  patch: Partial<{
    state: ReportRunStateType;
    stageLabel: string;
    projectId: string | null;
    dataVersion: string;
    stepProgress: Record<string, unknown>;
    snapshot: Record<string, unknown> | null;
    narrativeCheckpoint: Record<string, unknown>;
    llmUsage: Record<string, unknown>;
    errorCode: string | null;
    errorMessage: string | null;
    reportId: string | null;
    startedAt: boolean;
    finishedAt: boolean;
  }>,
) {
  const sets: string[] = ["updated_at = NOW()"];
  const vals: unknown[] = [runId];
  const push = (col: string, val: unknown, cast = "") => {
    vals.push(val);
    sets.push(`${col} = $${vals.length}${cast}`);
  };
  if (patch.state !== undefined) push("state", patch.state);
  if (patch.stageLabel !== undefined) push("stage_label", patch.stageLabel);
  if (patch.projectId !== undefined) push("project_id", patch.projectId);
  if (patch.dataVersion !== undefined) push("data_version", patch.dataVersion);
  if (patch.stepProgress !== undefined) push("step_progress_json", JSON.stringify(patch.stepProgress), "::jsonb");
  if (patch.snapshot !== undefined) push("snapshot_json", patch.snapshot ? JSON.stringify(patch.snapshot) : null, "::jsonb");
  if (patch.narrativeCheckpoint !== undefined) push("narrative_checkpoint_json", JSON.stringify(patch.narrativeCheckpoint), "::jsonb");
  if (patch.llmUsage !== undefined) push("llm_usage_json", JSON.stringify(patch.llmUsage), "::jsonb");
  if (patch.errorCode !== undefined) push("error_code", patch.errorCode);
  if (patch.errorMessage !== undefined) push("error_message", patch.errorMessage);
  if (patch.reportId !== undefined) push("report_id", patch.reportId);
  if (patch.startedAt) sets.push("started_at = COALESCE(started_at, NOW())");
  if (patch.finishedAt) sets.push("finished_at = NOW()");

  await pool.query(`UPDATE report_run SET ${sets.join(", ")} WHERE id = $1`, vals);
}

async function isRunCancelled(pool: Pool, runId: string): Promise<boolean> {
  const { rows } = await pool.query<{ cancel_requested: boolean }>(
    "SELECT cancel_requested FROM report_run WHERE id = $1",
    [runId],
  );
  return Boolean(rows[0]?.cancel_requested);
}

function buildAppendixSection(scopes: ReportScopeSummary[], evidence: ReportEvidenceItem[]): ReportSectionData {
  return {
    id: "sources_appendix",
    moduleId: "sources_appendix",
    title: "数据来源、方法与证据索引",
    description: "本次研究的数据范围快照、数据版本与代表性原文清单",
    scopeId: scopes[0]?.id ?? "S1",
    state: "ready",
    stateMessage: `共记录 ${scopes.length} 个数据范围与 ${evidence.length} 条可溯源代表证据。`,
    engineSource: "SIFTLINE 报告引擎",
    unit: "条",
    denominatorLabel: "代表性证据快照",
    sampleCount: evidence.length,
    metrics: [
      { id: "M_APP_SCOPES", label: "数据范围数", value: scopes.length, formatted: String(scopes.length), unit: "个" },
      { id: "M_APP_EVIDENCE", label: "持久证据快照", value: evidence.length, formatted: String(evidence.length), unit: "条" },
    ],
    charts: [
      {
        id: "C_APP_SCOPES",
        title: "数据范围与版本对照",
        kind: "table",
        unit: "条",
        xLabels: [],
        series: [],
        table: {
          columns: ["范围ID", "资料来源", "检索条件", "匹配量", "有效样本量", "分析引擎"],
          rows: scopes.map((s) => [
            s.id,
            s.sourceLabel,
            s.query || "全范围",
            s.matchedCount !== null ? `${s.matchedCount.toLocaleString()} ${s.matchedUnit}` : "未计算",
            `${s.analyzedCount.toLocaleString()} ${s.analyzedUnit}`,
            s.engineLabel,
          ]),
        },
      },
    ],
    evidenceIds: evidence.map((e) => e.id),
    method: "所有统计均由程序基于已授权数据范围计算并固化快照，修改项目数据不影响历史报告。",
    warnings: [],
    pinned: true,
  };
}

function assembleOrderedSections(
  plan: ReportRunCreateInputType,
  bundle: AdaptedAnalysisBundle,
): ReportSectionData[] {
  const requested = plan.sections?.length ? plan.sections : defaultSectionsForTemplate(plan.template);
  const catalogMap = new Map(REPORT_MODULE_CATALOG.map((m) => [m.id, m]));
  const primaryScopeId = bundle.scopes[0]?.id ?? "S1";

  // Always guarantee executive_summary (unless pure data omits it cleanly), scope_overview, and sources_appendix
  const orderedIds: string[] = [];
  if (!requested.includes("executive_summary")) orderedIds.push("executive_summary");
  for (const id of requested) {
    if (!orderedIds.includes(id)) orderedIds.push(id);
  }
  if (!orderedIds.includes("scope_overview")) orderedIds.splice(1, 0, "scope_overview");
  if (!orderedIds.includes("sources_appendix")) orderedIds.push("sources_appendix");

  return orderedIds.map((id) => {
    if (id === "sources_appendix") return buildAppendixSection(bundle.scopes, bundle.evidence);
    const existing = bundle.sectionsById.get(id);
    if (existing) return existing;
    const spec = catalogMap.get(id);
    return {
      id,
      moduleId: id,
      title: spec?.title ?? id,
      description: spec?.description ?? "",
      scopeId: primaryScopeId,
      state: id === "executive_summary" || id === "business_actions" ? "ready" : "unsupported_source",
      stateMessage:
        id === "executive_summary"
          ? "基于已校验章节综合生成核心摘要。"
          : id === "business_actions"
            ? "基于已校验观察提出后续核查与行动方向。"
            : "当前所选数据源或样本范围暂不适用该分析模块，已在报告中诚实说明。",
      engineSource: spec?.engineSource ?? "system",
      unit: "",
      denominatorLabel: "当前研究范围",
      sampleCount: bundle.scopes[0]?.analyzedCount ?? 0,
      metrics: [],
      charts: [],
      evidenceIds: [],
      method: "受控模板模块",
      warnings: [],
      pinned: spec?.pinned,
    };
  });
}

async function waitForCollectionJob(
  pool: Pool,
  jobId: string,
  runId: string,
  maxWaitMs = 120_000,
): Promise<{ status: string; batchId: string | null; insertedCount: number; processedCount: number; error: string | null }> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await isRunCancelled(pool, runId)) {
      return { status: "canceled", batchId: null, insertedCount: 0, processedCount: 0, error: "User cancelled" };
    }
    const { rows: [job] } = await pool.query<{
      status: string;
      records_inserted: number | null;
      records_processed: number | null;
      error: string | null;
      batch_id: string | null;
    }>(
      `SELECT j.status, j.records_inserted, j.records_processed, j.error,
              (SELECT cb.id FROM collection_batch cb WHERE cb.job_id = j.id AND cb.discarded_at IS NULL LIMIT 1) AS batch_id
       FROM source_collection_job j WHERE j.id = $1`,
      [jobId],
    );
    if (!job) return { status: "failed", batchId: null, insertedCount: 0, processedCount: 0, error: "Collection job not found" };
    if (["succeeded", "completed", "failed", "cancelled", "blocked"].includes(job.status)) {
      return {
        status: job.status,
        batchId: job.batch_id,
        insertedCount: job.records_inserted ?? 0,
        processedCount: job.records_processed ?? 0,
        error: job.error,
      };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: "timeout", batchId: null, insertedCount: 0, processedCount: 0, error: "Collection job timed out" };
}

export async function executeReportRun(
  deps: ReportOrchestratorDeps,
  runId: string,
  actorOverride?: Actor,
  options?: { deliverPureDataOnly?: boolean; retryFrom?: "analysis" | "writing"; regenerateSectionId?: string; focusOverride?: string },
): Promise<void> {
  const { pool, archiveRuntime, providers } = deps;
  const { rows: [runRow] } = await pool.query<ReportRunRow>("SELECT * FROM report_run WHERE id = $1", [runId]);
  if (!runRow) return;

  const actor = actorOverride ?? (await hydrateActorByUserId(pool, runRow.owner_user_id));
  if (!actor) {
    await updateRunState(pool, runId, {
      state: "failed",
      stageLabel: "账号授权已失效，任务已停止",
      errorCode: "actor_revoked",
      errorMessage: "创建者账号已停用或无权执行该任务",
      finishedAt: true,
    });
    return;
  }

  const plan = runRow.plan_json as unknown as ReportRunCreateInputType;
  const lang = plan.language ?? "zh";
  const progress: Record<string, unknown> = { ...(runRow.step_progress_json ?? {}) };

  try {
    let projectId = runRow.project_id ?? plan.projectId ?? null;
    let archiveRefId = plan.archiveRefId ?? null;
    let batchIds = [...(plan.batchIds ?? [])];

    // ---------------- PHASE 1: Preparing (Auto-create/reuse project, attach batches/archiveRef) ----------------
    const hasExistingSnapshot = Boolean(runRow.snapshot_json && options?.retryFrom !== "analysis");
    if (!hasExistingSnapshot) {
      await updateRunState(pool, runId, {
        state: "preparing",
        stageLabel: "正在组织研究空间与数据范围",
        startedAt: true,
        errorCode: null,
        errorMessage: null,
        stepProgress: { ...progress, stageIndex: 1, totalStages: plan.collectionAction?.enabled ? 5 : 4 },
      });

      const needsProject =
        plan.primarySource !== "stories" || Boolean(plan.collectionAction?.enabled) || plan.mode === "continuous";

      if (needsProject && !projectId) {
        // Auto-create private project for this research run
        const autoName = `${(plan.topic || plan.title).slice(0, 60)} · ${new Date().toISOString().slice(0, 10)}`;
        try {
          const created = await writeProject(pool, actor, {
            name: autoName,
            description: plan.question || plan.focus || `由报告任务自动创建：${plan.title}`,
            datasetMode: "batch",
            visibility: "private",
            originKind: plan.mode === "continuous" ? "tracking" : "quick_research",
            researchGoal: plan.question || plan.topic,
          });
          projectId = created.id;
          await updateRunState(pool, runId, { projectId });
        } catch (projErr) {
          // If viewer hit project quota limit, pause cleanly as needs_action (preserve draft/run!)
          await updateRunState(pool, runId, {
            state: "needs_action",
            stageLabel: "自动创建研究项目受限，请处理后继续",
            errorCode: "project_create_failed",
            errorMessage: projErr instanceof Error ? projErr.message : "无法自动创建研究项目（可能已达项目上限）",
          });
          return;
        }
      } else if (projectId) {
        // Verify project is readable; if writable, we can attach batches/archiveRef
        const proj = await projectSources(pool, actor, projectId);
        if (proj.can_edit && batchIds.length > 0 && proj.dataset_mode === "batch") {
          for (const bid of batchIds) {
            await attachBatchToProject(pool, actor, projectId, bid).catch(() => {});
          }
        }
      }

      // Attach batches to newly auto-created project
      if (projectId && batchIds.length > 0 && !plan.projectId) {
        for (const bid of batchIds) {
          await attachBatchToProject(pool, actor, projectId, bid).catch(() => {});
        }
      }

      // Create archive reference if using archive primary source & writable project
      if (projectId && plan.primarySource === "archive" && !archiveRefId && archiveRuntime) {
        const st = await archiveRuntime.checkStatus(actor);
        if (st.available && st.version && st.months.length > 0) {
          const parsed = parseResearchQuery({ topic: plan.topic, englishQuery: plan.englishQuery });
          try {
            const ref = await archiveRuntime.ensureProjectArchiveRef(actor, projectId, {
              archiveId: "reddit-local-corpus",
              version: st.version,
              scope: {
                months: st.months,
                query: parsed.englishQuery || plan.topic,
                subreddits: plan.subreddits ?? [],
                from: plan.from ?? null,
                to: plan.to ?? null,
              },
            });
            archiveRefId = ref.id;
          } catch {
            // Read-only shared project: continue archive analysis without mutating project
          }
        }
      }

      // ---------------- PHASE 2: Optional Real Collection (F03) ----------------
      if (plan.collectionAction?.enabled) {
        if (!plan.collectionAction.confirmed) {
          await updateRunState(pool, runId, {
            state: "needs_action",
            stageLabel: "等待确认补充采集方案",
            errorCode: "collection_unconfirmed",
            errorMessage: "执行外部补充采集前需要明确确认预算与采集范围",
          });
          return;
        }
        await updateRunState(pool, runId, {
          state: "collecting",
          stageLabel: `正在提交并执行补充采集（${plan.collectionAction.platform.toUpperCase()} · ${plan.collectionAction.targetValue}）`,
          stepProgress: { ...progress, stageIndex: 2, totalStages: 5, collectionTarget: plan.collectionAction.targetValue },
        });
        try {
          const ca = plan.collectionAction;
          const providerName = ca.platform === "x" ? "twitterapis" : ca.platform === "reddit" ? "kaix" : "bluesky_appview";
          const provider = (providers ?? []).find((p) => p.capability.provider === providerName);
          if (!provider || !provider.capability.enabled) {
            await updateRunState(pool, runId, {
              state: "needs_action",
              stageLabel: "补充采集渠道暂不可用",
              errorCode: "collection_provider_unavailable",
              errorMessage: `渠道 ${providerName} 当前未启用或未配置有效凭证，可改用已有资料继续生成报告。`,
            });
            return;
          }
          const toIso = new Date().toISOString();
          const fromIso = new Date(Date.now() - (ca.lookbackDays ?? 7) * 86_400_000).toISOString();
          const targetTypeMapped = ca.targetType === "keyword" ? "search" : ca.targetType;
          const enqueued = await transaction(pool, (client) =>
            enqueueOnDemandCollection(client, actor, providers ?? [], {
              platform: ca.platform as "reddit" | "x" | "bluesky",
              targetType: targetTypeMapped,
              targetValue: ca.targetValue,
              projectId: projectId ?? undefined,
              limit: ca.limit,
              from: fromIso,
              to: toIso,
              includeComments: Boolean(ca.includeComments),
              requestKey: `report-run:${runId}:collect`,
            }),
          );
          const jobId = enqueued.jobId;
          if (enqueued.created) {
            await notifyChannel(pool, "collection_jobs_ready");
          }
          await updateRunState(pool, runId, {
            stepProgress: { ...progress, stageIndex: 2, totalStages: 5, collectionJobId: jobId, collectionStatus: "running" },
          });
          const outcome = await waitForCollectionJob(pool, jobId, runId);
          if (outcome.status === "canceled") {
            await updateRunState(pool, runId, { state: "canceled", stageLabel: "任务已取消", finishedAt: true });
            return;
          }
          if (outcome.batchId) {
            batchIds = [...new Set([...batchIds, outcome.batchId])];
            if (projectId) await attachBatchToProject(pool, actor, projectId, outcome.batchId).catch(() => {});
          }
          if (outcome.status !== "succeeded" && outcome.status !== "completed") {
            await updateRunState(pool, runId, {
              state: "needs_action",
              stageLabel: "补充采集未完全成功，可选择使用已有资料继续",
              errorCode: "collection_partial_or_failed",
              errorMessage: outcome.error || `采集任务状态：${outcome.status}`,
              stepProgress: { ...progress, collectionJobId: jobId, collectionStatus: outcome.status, collectionBatchId: outcome.batchId },
            });
            return;
          }
          progress.collectionJobId = jobId;
          progress.collectionBatchId = outcome.batchId;
          progress.collectionInserted = outcome.insertedCount;
          progress.collectionProcessed = outcome.processedCount;
          progress.collectionZeroNew = outcome.insertedCount === 0 && outcome.processedCount === 0;
        } catch (colErr) {
          await updateRunState(pool, runId, {
            state: "needs_action",
            stageLabel: "补充采集提交失败",
            errorCode: "collection_submit_failed",
            errorMessage: colErr instanceof Error ? colErr.message : "未能提交采集任务",
          });
          return;
        }
      }
    }

    if (await isRunCancelled(pool, runId)) {
      await updateRunState(pool, runId, { state: "canceled", stageLabel: "任务已取消", finishedAt: true });
      return;
    }

    // ---------------- PHASE 3: Analyzing (Reuse or run real engines) ----------------
    let scopes: ReportScopeSummary[] = [];
    let orderedSections: ReportSectionData[] = [];
    let evidence: ReportEvidenceItem[] = [];
    let dataVersion = runRow.data_version;

    if (hasExistingSnapshot && runRow.snapshot_json) {
      const snap = runRow.snapshot_json as {
        scopes: ReportScopeSummary[];
        sections: ReportSectionData[];
        evidence: ReportEvidenceItem[];
      };
      scopes = snap.scopes ?? [];
      orderedSections = snap.sections ?? [];
      evidence = snap.evidence ?? [];
    } else {
      await updateRunState(pool, runId, {
        state: "analyzing",
        stageLabel: "正在执行真实数据分析与证据抽样",
        stepProgress: { ...progress, stageIndex: plan.collectionAction?.enabled ? 3 : 2, totalStages: plan.collectionAction?.enabled ? 5 : 4 },
      });

      let bundle: AdaptedAnalysisBundle;
      const parsed = parseResearchQuery({ topic: plan.topic, question: plan.question, englishQuery: plan.englishQuery });

      if (plan.primarySource === "stories") {
        bundle = await adaptStoriesAnalysis(pool, actor, plan);
      } else if (plan.primarySource === "monitor" && plan.monitorId) {
        const days = plan.from && plan.to ? Math.max(1, Math.ceil((Date.parse(plan.to) - Date.parse(plan.from)) / 86_400_000)) : 14;
        bundle = await adaptMonitorAnalysis(pool, actor, plan.monitorId, days);
      } else if (plan.primarySource === "explore_study" && plan.reuseStudyId) {
        const { rows: [saved] } = await pool.query<{ response_json: unknown; project_id: string | null; archive_ref_id: string | null }>(
          "SELECT response_json, project_id, archive_ref_id FROM report_explore_study WHERE study_id = $1 AND owner_user_id = $2",
          [plan.reuseStudyId, actor.userId],
        );
        if (!saved) fail(404, "Referenced explore study not found or unauthorized");
        bundle = await adaptExploreAnalysis(saved.response_json as never, actor, archiveRuntime, {
          projectId: saved.project_id ?? projectId,
          archiveRefId: saved.archive_ref_id ?? archiveRefId,
        });
      } else {
        if (!archiveRuntime) fail(503, "Analysis runtime unavailable");
        const useCollectedProject = Boolean(plan.collectionAction?.enabled && projectId && batchIds.length > 0 && plan.primarySource !== "archive");
        const sourceMode =
          plan.primarySource === "archive"
            ? "archive"
            : useCollectedProject || (plan.primarySource === "project" && projectId)
              ? "project_content"
              : "live_content";
        const exploreRes = await archiveRuntime.runExplore(actor, {
          runId: `rep_${runId.replace(/-/g, "").slice(0, 16)}`,
          query: useCollectedProject
            ? ""
            : plan.englishQuery?.trim() ||
              (sourceMode === "archive"
                ? parsed.englishQuery || plan.topic
                : parsed.pgTerms.length > 0
                  ? parsed.pgTerms.join(" OR ")
                  : plan.topic || ""),
          sourceMode,
          projectId: sourceMode === "project_content" || (sourceMode === "archive" && archiveRefId) ? (projectId ?? undefined) : undefined,
          archiveRefId: sourceMode === "archive" ? (archiveRefId ?? undefined) : undefined,
          subreddits: plan.subreddits?.length ? plan.subreddits : undefined,
          from: plan.from ?? null,
          to: plan.to ?? null,
          platforms: plan.platforms?.length ? plan.platforms : undefined,
          profile: plan.profile ?? "fast",
          accelMode: plan.accelMode,
          includeComments: Boolean(plan.includeComments),
          limit: plan.sampleLimit ?? 2000,
        });
        bundle = await adaptExploreAnalysis(exploreRes, actor, archiveRuntime, {
          projectId,
          archiveRefId,
          batchIds,
          sourceIds: plan.sourceIds,
        });

        // If analyzing a project, also enrich with L2 competitor comparison / L3 tasks when available!
        if (projectId && (sourceMode === "project_content" || (plan.sections ?? []).includes("competitor_comparison"))) {
          const projBundle = await adaptProjectL1L2L3Analysis(pool, actor, projectId, lang).catch(() => null);
          if (projBundle) {
            for (const [k, v] of projBundle.sectionsById.entries()) {
              if (!bundle.sectionsById.has(k) || k === "competitor_comparison") {
                bundle.sectionsById.set(k, v);
              }
            }
            if (bundle.evidence.length === 0) bundle.evidence.push(...projBundle.evidence);
          }
        }
      }

      scopes = bundle.scopes;
      evidence = bundle.evidence;
      dataVersion = bundle.dataVersion;
      orderedSections = assembleOrderedSections(plan, bundle);

      await updateRunState(pool, runId, {
        dataVersion,
        snapshot: { scopes, sections: orderedSections, evidence },
        stepProgress: {
          ...progress,
          analyzedDocuments: scopes.reduce((s, sc) => s + sc.analyzedCount, 0),
          evidenceCount: evidence.length,
          sectionsPlanned: orderedSections.length,
        },
      });
    }

    if (await isRunCancelled(pool, runId)) {
      await updateRunState(pool, runId, { state: "canceled", stageLabel: "任务已取消", finishedAt: true });
      return;
    }

    // ---------------- PHASE 4: Writing (Real LLM chapter synthesis with checkpoints & pure-data fallback) ----------------
    const llmCfg = readReportLlmConfig();
    const skipLlm = Boolean(plan.skipLlm || options?.deliverPureDataOnly);
    const checkpoints: Record<string, ReportNarrative> = {
      ...((runRow.narrative_checkpoint_json as Record<string, ReportNarrative>) ?? {}),
    };
    if (options?.regenerateSectionId) {
      delete checkpoints[options.regenerateSectionId];
      delete checkpoints.executive_summary;
    }

    const calls: LlmCallMetrics[] = Array.isArray((runRow.llm_usage_json as { calls?: LlmCallMetrics[] })?.calls)
      ? [...((runRow.llm_usage_json as { calls: LlmCallMetrics[] }).calls)]
      : [];

    const dataChapters = orderedSections.filter(
      (s) => !["executive_summary", "business_actions", "sources_appendix"].includes(s.id),
    );

    let llmSuccessCount = 0;
    let llmErrorCount = 0;

    if (!skipLlm && llmCfg.enabled) {
      await updateRunState(pool, runId, {
        state: "writing",
        stageLabel: `正在分章归纳研究发现（共 ${dataChapters.length} 个数据章节）`,
        stepProgress: { ...progress, stageIndex: plan.collectionAction?.enabled ? 4 : 3, totalStages: plan.collectionAction?.enabled ? 5 : 4, completedSections: Object.keys(checkpoints).length, totalSections: orderedSections.length },
      });

      const pendingChapters = dataChapters.filter((sec) => {
        if (checkpoints[sec.id]) {
          sec.narrative = checkpoints[sec.id];
          llmSuccessCount++;
          return false;
        }
        if (sec.state === "unsupported_source" || sec.state === "unavailable_dependency") {
          sec.narrative = buildPureDataNarrative(sec, lang);
          checkpoints[sec.id] = sec.narrative;
          return false;
        }
        return true;
      });

      // Bounded parallel section synthesis (maxConcurrency 2-4)
      for (let i = 0; i < pendingChapters.length; i += llmCfg.maxConcurrency) {
        if (await isRunCancelled(pool, runId)) {
          await updateRunState(pool, runId, { state: "canceled", stageLabel: "任务已取消", finishedAt: true });
          return;
        }
        const batch = pendingChapters.slice(i, i + llmCfg.maxConcurrency);
        const results = await Promise.all(
          batch.map((sec) =>
            synthesizeSectionNarrative({
              template: plan.template,
              topic: plan.topic,
              question: plan.question || plan.topic,
              focus: options?.focusOverride || plan.focus || "",
              language: lang,
              scopes,
              section: sec,
              evidence,
              config: llmCfg,
            }),
          ),
        );
        for (let j = 0; j < batch.length; j++) {
          const sec = batch[j];
          const res = results[j];
          sec.narrative = res.narrative;
          calls.push(res.call);
          if (res.call.status === "ok") {
            checkpoints[sec.id] = res.narrative;
            llmSuccessCount++;
          } else {
            llmErrorCount++;
          }
        }
        await updateRunState(pool, runId, {
          narrativeCheckpoint: checkpoints,
          llmUsage: summarizeUsage(llmCfg.model, calls),
          stepProgress: {
            ...progress,
            completedSections: Object.keys(checkpoints).length,
            totalSections: orderedSections.length,
          },
        });
      }

      // If ALL LLM calls failed with hard network/provider error, pause at needs_action so user can retry writing OR deliver pure data!
      if (llmSuccessCount === 0 && llmErrorCount > 0 && !runRow.schedule_id) {
        await updateRunState(pool, runId, {
          state: "needs_action",
          stageLabel: "报告文字整理暂不可用，分析结果已完整保留",
          errorCode: "llm_synthesis_failed",
          errorMessage: "AI 文字整理服务暂时超时或不可用。您可以重试文字整理，或直接交付纯数据统计报告。",
          narrativeCheckpoint: checkpoints,
          llmUsage: summarizeUsage(llmCfg.model, calls),
        });
        return;
      }

      // Synthesize Executive Summary & Business Actions from verified chapters
      const synth = await synthesizeExecutiveSummary({
        template: plan.template,
        topic: plan.topic,
        question: plan.question || plan.topic,
        focus: options?.focusOverride || plan.focus || "",
        language: lang,
        scopes,
        verifiedSections: orderedSections,
        evidence,
        config: llmCfg,
      });
      calls.push(...synth.calls);
      for (const sec of orderedSections) {
        if (sec.id === "executive_summary") sec.narrative = synth.summaryNarrative;
        if (sec.id === "business_actions") sec.narrative = synth.actionsNarrative;
      }
      checkpoints.executive_summary = synth.summaryNarrative;
      checkpoints.business_actions = synth.actionsNarrative;
    } else {
      // Pure-data report mode
      for (const sec of orderedSections) {
        sec.narrative = buildPureDataNarrative(sec, lang);
      }
    }

    // ---------------- PHASE 5: Persist Report Document Atomically ----------------
    const mode: "llm_verified" | "pure_data" | "partial_llm" =
      skipLlm || !llmCfg.enabled || llmSuccessCount === 0
        ? "pure_data"
        : llmErrorCount > 0
          ? "partial_llm"
          : "llm_verified";

    const usageSummary = summarizeUsage(llmCfg.model, calls);
    const execSummary = orderedSections.find((s) => s.id === "executive_summary")?.narrative?.summary ?? "";

    const doc = await insertReportDocumentAtomic(pool, {
      ownerUserId: runRow.owner_user_id,
      projectId,
      runId,
      scheduleId: runRow.schedule_id,
      template: plan.template,
      title: plan.title,
      subtitle: `${scopes[0]?.sourceLabel ?? ""} · 有效样本 ${scopes.reduce((s, sc) => s + sc.analyzedCount, 0).toLocaleString()} 条`,
      summary: execSummary,
      mode,
      scopes,
      sections: orderedSections,
      evidence,
      provenance: {
        model: mode === "pure_data" ? null : llmCfg.model,
        promptVersion: "v1.0",
        schemaVersion: "1.0",
        mode,
        usage: usageSummary,
        generatedAt: new Date().toISOString(),
      },
    });

    const finalState: ReportRunStateType = mode === "pure_data" && !skipLlm && !llmCfg.enabled ? "pure_data_ready" : "ready";
    await updateRunState(pool, runId, {
      state: finalState,
      stageLabel: mode === "pure_data" ? "纯数据研究报告已生成" : "研究报告已生成",
      projectId,
      reportId: doc.id,
      narrativeCheckpoint: checkpoints,
      llmUsage: usageSummary,
      errorCode: null,
      errorMessage: null,
      stepProgress: {
        ...progress,
        stageIndex: plan.collectionAction?.enabled ? 5 : 4,
        totalStages: plan.collectionAction?.enabled ? 5 : 4,
        completedSections: orderedSections.length,
        totalSections: orderedSections.length,
      },
      finishedAt: true,
    });
  } catch (err) {
    deps.logError?.(err, "Report run execution failed");
    await updateRunState(pool, runId, {
      state: "failed",
      stageLabel: "研究任务执行遇到异常",
      errorCode: "run_failed",
      errorMessage: err instanceof Error ? err.message : "分析或报告生成过程中发生未知错误",
      finishedAt: true,
    });
  }
}

function summarizeUsage(model: string, calls: LlmCallMetrics[]) {
  return {
    model,
    callCount: calls.length,
    succeededCalls: calls.filter((c) => c.status === "ok").length,
    failedCalls: calls.filter((c) => c.status === "error").length,
    fallbackCalls: calls.filter((c) => c.status === "fallback").length,
    promptTokens: calls.reduce((s, c) => s + c.promptTokens, 0),
    completionTokens: calls.reduce((s, c) => s + c.completionTokens, 0),
    totalTokens: calls.reduce((s, c) => s + c.totalTokens, 0),
    totalLatencyMs: calls.reduce((s, c) => s + c.latencyMs, 0),
    requestIds: calls.map((c) => c.requestId).filter((id): id is string => Boolean(id)),
    calls: calls.map(({ requestId, sectionId, model: m, promptTokens, completionTokens, totalTokens, latencyMs, status, repaired, error }) => ({
      requestId,
      sectionId,
      model: m,
      promptTokens,
      completionTokens,
      totalTokens,
      latencyMs,
      status,
      repaired,
      ...(error ? { error } : {}),
    })),
  };
}

export async function startOrReuseReportRun(
  deps: ReportOrchestratorDeps,
  actor: Actor,
  input: ReportRunCreateInputType,
  extra?: { scheduleId?: string | null; scheduleSlot?: string | null },
) {
  const { pool } = deps;
  const scopeHash = createHash("sha256")
    .update(JSON.stringify([actor.userId, input.template, input.primarySource, input.topic, input.englishQuery ?? "", input.projectId ?? null, input.from ?? null, input.to ?? null, input.batchIds ?? [], input.archiveRefId ?? null, input.sections ?? []]))
    .digest("hex")
    .slice(0, 32);

  // Check idempotency key (prevents double-click duplicate projects/runs/charges!)
  if (input.idempotencyKey) {
    const existing = await pool.query<ReportRunRow>(
      "SELECT * FROM report_run WHERE owner_user_id = $1 AND idempotency_key = $2 LIMIT 1",
      [actor.userId, input.idempotencyKey],
    );
    if (existing.rows[0]) return formatRun(existing.rows[0]);
  }
  if (extra?.scheduleId && extra?.scheduleSlot) {
    const existing = await pool.query<ReportRunRow>(
      "SELECT * FROM report_run WHERE schedule_id = $1 AND schedule_slot = $2 LIMIT 1",
      [extra.scheduleId, extra.scheduleSlot],
    );
    if (existing.rows[0]) return formatRun(existing.rows[0]);
  }

  const runId = randomUUID();
  const { rows: [inserted] } = await pool.query<ReportRunRow>(
    `INSERT INTO report_run (
       id, owner_user_id, draft_id, schedule_id, schedule_slot, idempotency_key,
       template, title, project_id, scope_hash, plan_json, state, stage_label
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'preparing','已提交研究任务，准备启动')
     RETURNING *`,
    [
      runId,
      actor.userId,
      input.draftId ?? null,
      extra?.scheduleId ?? null,
      extra?.scheduleSlot ?? null,
      input.idempotencyKey ?? null,
      input.template,
      input.title.trim(),
      input.projectId ?? null,
      scopeHash,
      JSON.stringify(input),
    ],
  );

  if (input.draftId) {
    await pool.query("UPDATE report_draft SET status = 'submitted', updated_at = NOW() WHERE id = $1 AND owner_user_id = $2", [
      input.draftId,
      actor.userId,
    ]);
  }

  scheduleRunWork(runId, () => executeReportRun(deps, runId, actor));
  return formatRun(inserted);
}

export async function handleReportRunAction(
  deps: ReportOrchestratorDeps,
  actor: Actor,
  runId: string,
  action: ReportRunActionInputType,
) {
  const { pool } = deps;
  const { rows: [run] } = await pool.query<ReportRunRow>(
    "SELECT * FROM report_run WHERE id = $1 AND owner_user_id = $2",
    [runId, actor.userId],
  );
  if (!run) fail(404, "Research run not found");

  if (action.action === "cancel") {
    await pool.query(
      "UPDATE report_run SET cancel_requested = TRUE, state = CASE WHEN state IN ('ready','pure_data_ready','failed','canceled') THEN state ELSE 'cancel_requested' END, stage_label = '正在取消任务', updated_at = NOW() WHERE id = $1",
      [runId],
    );
    const { rows: [updated] } = await pool.query<ReportRunRow>("SELECT * FROM report_run WHERE id = $1", [runId]);
    return formatRun(updated);
  }

  if (action.action === "deliver_pure_data") {
    scheduleRunWork(runId, () => executeReportRun(deps, runId, actor, { deliverPureDataOnly: true, retryFrom: "writing" }));
    await updateRunState(pool, runId, { state: "writing", stageLabel: "正在生成纯数据统计报告" });
  } else if (action.action === "retry_writing") {
    scheduleRunWork(runId, () => executeReportRun(deps, runId, actor, { retryFrom: "writing" }));
    await updateRunState(pool, runId, { state: "writing", stageLabel: "正在重试文字归纳" });
  } else if (action.action === "retry_analysis" || action.action === "continue_with_partial") {
    const plan = { ...(run.plan_json as Record<string, unknown>) };
    if (action.action === "continue_with_partial") {
      plan.collectionAction = undefined;
      await pool.query("UPDATE report_run SET plan_json = $2::jsonb WHERE id = $1", [runId, JSON.stringify(plan)]);
    }
    scheduleRunWork(runId, () => executeReportRun(deps, runId, actor, { retryFrom: "analysis" }));
    await updateRunState(pool, runId, { state: "analyzing", stageLabel: "正在使用当前可用资料继续分析" });
  } else if (action.action === "regenerate_section" && action.sectionId) {
    scheduleRunWork(runId, () =>
      executeReportRun(deps, runId, actor, {
        retryFrom: "writing",
        regenerateSectionId: action.sectionId,
        focusOverride: action.focusOverride,
      }),
    );
    await updateRunState(pool, runId, { state: "writing", stageLabel: `正在重新整理章节：${action.sectionId}` });
  }

  const { rows: [refreshed] } = await pool.query<ReportRunRow>("SELECT * FROM report_run WHERE id = $1", [runId]);
  return formatRun(refreshed);
}

// ---------------- Restart Recovery & Real Periodic Report Scheduler ----------------

export async function recoverInterruptedReportRuns(deps: ReportOrchestratorDeps): Promise<number> {
  const { rows } = await deps.pool.query<ReportRunRow>(
    `SELECT * FROM report_run
     WHERE state IN ('preparing', 'collecting', 'analyzing', 'writing')
       AND cancel_requested = FALSE
     ORDER BY created_at ASC LIMIT 10`,
  );
  for (const row of rows) {
    scheduleRunWork(row.id, () => executeReportRun(deps, row.id));
  }
  return rows.length;
}

export async function triggerReportScheduleOnce(
  deps: ReportOrchestratorDeps,
  schedule: ReportScheduleRow,
  slotOverride?: string,
): Promise<{ runId: string | null; status: string; skippedReason?: string }> {
  const { pool } = deps;
  const actor = await hydrateActorByUserId(pool, schedule.owner_user_id);
  if (!actor) {
    await pool.query(
      "UPDATE report_schedule SET enabled = FALSE, last_status = 'revoked', last_error = 'Owner account inactive', updated_at = NOW() WHERE id = $1",
      [schedule.id],
    );
    return { runId: null, status: "revoked", skippedReason: "owner_inactive" };
  }
  if (schedule.project_id) {
    try {
      await projectSources(pool, actor, schedule.project_id);
    } catch {
      await pool.query(
        "UPDATE report_schedule SET enabled = FALSE, last_status = 'revoked', last_error = 'Project access revoked', updated_at = NOW() WHERE id = $1",
        [schedule.id],
      );
      return { runId: null, status: "revoked", skippedReason: "project_revoked" };
    }
  }

  const now = new Date();
  const windowTo = now.toISOString();
  const windowFrom = new Date(now.getTime() - schedule.window_hours * 3_600_000).toISOString();
  const slot =
    slotOverride ??
    (schedule.cadence === "custom_interval"
      ? `${schedule.id}:${Math.floor(now.getTime() / ((schedule.interval_minutes ?? 5) * 60_000))}`
      : `${schedule.id}:${windowTo.slice(0, 13)}`);

  const cfg = schedule.config_json ?? {};
  const runInput: ReportRunCreateInputType = {
    template: schedule.template,
    title: `${schedule.name} · ${windowTo.slice(0, 16).replace("T", " ")} UTC`,
    topic: String(cfg.topic ?? schedule.name),
    question: typeof cfg.question === "string" ? cfg.question : undefined,
    focus: typeof cfg.focus === "string" ? cfg.focus : undefined,
    language: cfg.language === "en" ? "en" : "zh",
    mode: "continuous",
    projectId: schedule.project_id,
    monitorId: schedule.monitor_id,
    primarySource: (cfg.primarySource as ReportRunCreateInputType["primarySource"]) ?? (schedule.template === "industry" ? "stories" : schedule.monitor_id ? "monitor" : schedule.project_id ? "project" : "stories"),
    sourceGroup: typeof cfg.sourceGroup === "string" ? cfg.sourceGroup : undefined,
    englishQuery: typeof cfg.englishQuery === "string" ? cfg.englishQuery : undefined,
    from: windowFrom,
    to: windowTo,
    sections: Array.isArray(cfg.sections) ? (cfg.sections as string[]) : undefined,
    sampleLimit: typeof cfg.sampleLimit === "number" ? cfg.sampleLimit : 1000,
    // Periodic reports strictly read already-collected/monitored data — never trigger paid external collection automatically!
  };

  const run = await startOrReuseReportRun(deps, actor, runInput, { scheduleId: schedule.id, scheduleSlot: slot });
  const nextRunAt = computeNextRunAt(schedule.cadence, schedule.interval_minutes, now);
  await pool.query(
    `UPDATE report_schedule
     SET last_run_at = NOW(), last_run_id = $2, last_status = 'triggered', last_error = NULL,
         next_run_at = $3, updated_at = NOW()
     WHERE id = $1`,
    [schedule.id, run.id, nextRunAt.toISOString()],
  );
  return { runId: run.id, status: "triggered" };
}

export async function tickDueReportSchedules(deps: ReportOrchestratorDeps): Promise<number> {
  const { rows } = await deps.pool.query<ReportScheduleRow>(
    `SELECT * FROM report_schedule
     WHERE enabled = TRUE AND next_run_at <= NOW()
     ORDER BY next_run_at ASC LIMIT 5`,
  );
  let count = 0;
  for (const sched of rows) {
    try {
      await triggerReportScheduleOnce(deps, sched);
      count++;
    } catch (err) {
      deps.logError?.(err, `Report schedule ${sched.id} failed`);
      await deps.pool.query(
        "UPDATE report_schedule SET last_status = 'error', last_error = $2, next_run_at = NOW() + INTERVAL '15 minutes', updated_at = NOW() WHERE id = $1",
        [sched.id, err instanceof Error ? err.message : "schedule_error"],
      );
    }
  }
  return count;
}

export function startReportScheduler(deps: ReportOrchestratorDeps): () => void {
  const intervalMs = Math.max(5_000, Number(process.env.REPORT_SCHEDULER_TICK_MS) || 30_000);
  void recoverInterruptedReportRuns(deps).catch((err) => deps.logError?.(err, "Failed recovering interrupted report runs"));
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void tickDueReportSchedules(deps)
      .catch((err) => deps.logError?.(err, "Report scheduler tick failed"))
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
