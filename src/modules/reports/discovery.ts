import type { Pool } from "pg";
import type { Actor } from "../../../packages/contracts/src/access";
import type { Filter } from "../../../packages/contracts/src/content";
import type { ResourceDiscoverRequestType } from "../../../packages/contracts/src/reports";
import { AppError } from "../../shared/errors";
import type { ArchiveFastDiscoveryResult, ArchiveRuntimeFacade } from "../archive-analysis/index";
import { contentVisibility } from "../collection/index";
import {
  compileContentFilter,
  contentSourceTables,
  contentTables,
  readStoryWindow,
} from "../content/index";
import { listMonitors } from "../intelligence/index";
import { listProjects } from "../projects/index";
import { parseResearchQuery, type ParsedResearchQuery } from "./query-parser";

export interface DiscoveredBatchCandidate {
  batchId: string;
  label: string;
  sourceId: string;
  sourceLabel: string;
  platform: string;
  visibility: "private" | "shared";
  matchedCount: number;
  batchTotal: number;
  matchRatio: number;
  marginalNewCount: number;
  reusable: boolean;
  lastSuccessAt: string | null;
  scheduleEnabled: boolean;
  createdAt: string;
  projectIds: string[];
}

export interface DiscoveredProjectCandidate {
  projectId: string;
  name: string;
  description: string | null;
  visibility: "private" | "shared";
  canEdit: boolean;
  datasetMode: "batch" | "source_filter";
  originKind: string;
  matchedCount: number;
  totalItems: number;
  enabledBatchCount: number;
  hasMonitor: boolean;
}

export interface DiscoveredContinuousSource {
  sourceId: string;
  label: string;
  platform: string;
  usageDomain: string;
  state: string;
  scheduleEnabled: boolean;
  cadenceSeconds: number | null;
  lastSuccessAt: string | null;
  matchedCount: number;
  reusableForTracking: boolean;
}

export interface ResourceDiscoveryResponse {
  discoveryId: string;
  generatedAt: string;
  elapsedMs: number;
  parsedQuery: ParsedResearchQuery;
  pgChannel: {
    status: "exact" | "empty" | "unavailable" | "error";
    matchedContentCount: number;
    undatedCount: number;
    dateRange: { earliest: string | null; latest: string | null };
    byPlatform: Array<{ platform: string; count: number }>;
    byKind: Array<{ kind: string; count: number }>;
    topCommunities: Array<{ community: string; count: number }>;
    batches: DiscoveredBatchCandidate[];
    projects: DiscoveredProjectCandidate[];
    continuousSources: DiscoveredContinuousSource[];
    samples: Array<{
      id: string;
      platform: string;
      kind: string;
      title: string;
      excerpt: string;
      community: string | null;
      publishedAt: string | null;
      url: string | null;
      sourceLabel: string;
    }>;
    elapsedMs: number;
    note?: string;
  };
  archiveChannel: {
    status: "exact" | "candidate" | "empty" | "unavailable" | "forbidden" | "timeout" | "recall_limit" | "invalid_query" | "error";
    available: boolean;
    version: string | null;
    months: string[];
    queryUsed: string;
    matchedThreads: number;
    associatedComments: number;
    reportedCommentsSum: number;
    needsExactVerify: boolean;
    dateRange: { earliest: string | null; latest: string | null; activeDays: number };
    byMonth: Array<{ month: string; count: number }>;
    topCommunities: Array<{ community: string; count: number }>;
    samples: ArchiveFastDiscoveryResult["samples"];
    elapsedMs: number;
    message?: string;
  };
  storiesChannel: {
    status: "exact" | "empty" | "unavailable";
    eventCount: number;
    independentSourceCount: number;
    windowFrom: string;
    windowTo: string;
    topChannels: Array<{ channel: string; count: number }>;
    samples: Array<{
      storyKey: string;
      title: string;
      sourceLabel: string;
      tier: string;
      publishedAt: string | null;
      url: string | null;
      sourceCount: number;
    }>;
    elapsedMs: number;
  };
  recommendation: {
    readiness: "strong" | "preliminary" | "needs_collection";
    readinessLabel: string;
    primarySource: "stories" | "archive" | "pg_content" | "project" | "monitor";
    primaryLabel: string;
    rationale: string;
    supplementalSources: string[];
    gaps: string[];
    suggestCollection: boolean;
    suggestContinuousReuse: boolean;
    reusableContinuousSourceIds: string[];
    recommendedProjectId: string | null;
    recommendedBatchIds: string[];
  };
}

function buildPgDiscoveryFilter(req: ResourceDiscoverRequestType, parsed: ParsedResearchQuery): Filter {
  const filter: Filter = {};
  if (req.from) filter.from = req.from;
  if (req.to) filter.to = req.to;
  if (req.platforms?.length) filter.platforms = req.platforms;
  if (req.subreddits?.length) filter.communities = req.subreddits;
  if (req.languages?.length) filter.languages = req.languages;
  if (req.sourceGroup) filter.sourceGroup = req.sourceGroup;
  if (parsed.pgTerms.length === 1) {
    filter.query = parsed.pgTerms[0];
  } else if (parsed.pgTerms.length > 1) {
    filter.anyTerms = parsed.pgTerms;
  }
  return filter;
}

async function discoverPgChannel(
  pool: Pool,
  actor: Actor,
  req: ResourceDiscoverRequestType,
  parsed: ParsedResearchQuery,
): Promise<ResourceDiscoveryResponse["pgChannel"]> {
  const t0 = Date.now();
  const isViewer = actor.role === "viewer";
  try {
    const filter = buildPgDiscoveryFilter(req, parsed);
    const compiled = compileContentFilter(actor, filter, undefined, {}, false, contentVisibility(actor));
    const fromTables = compiled.needsSearchDocument ? contentTables : contentSourceTables;

    // 1. Authorized deduplicated content aggregation
    const aggSql = `
      WITH matched AS MATERIALIZED (
        SELECT c.id, p.code AS platform, c.kind, c.community_name, c.created_at_source, c.first_seen_at
        FROM ${fromTables}
        WHERE ${compiled.text}
      )
      SELECT
        (SELECT COUNT(*)::int FROM matched) AS total_count,
        (SELECT COUNT(*) FILTER (WHERE created_at_source IS NULL)::int FROM matched) AS undated_count,
        (SELECT MIN(created_at_source) FROM matched) AS earliest,
        (SELECT MAX(created_at_source) FROM matched) AS latest,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('platform', platform, 'count', cnt) ORDER BY cnt DESC)
          FROM (SELECT platform, COUNT(*)::int AS cnt FROM matched GROUP BY platform) x), '[]'::jsonb) AS by_platform,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'count', cnt) ORDER BY cnt DESC)
          FROM (SELECT kind, COUNT(*)::int AS cnt FROM matched GROUP BY kind) x), '[]'::jsonb) AS by_kind,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('community', community_name, 'count', cnt) ORDER BY cnt DESC)
          FROM (SELECT community_name, COUNT(*)::int AS cnt FROM matched WHERE community_name IS NOT NULL AND community_name <> '' GROUP BY community_name ORDER BY cnt DESC LIMIT 12) x), '[]'::jsonb) AS top_communities
    `;
    const { rows: [agg] } = await pool.query<{
      total_count: number;
      undated_count: number;
      earliest: Date | null;
      latest: Date | null;
      by_platform: Array<{ platform: string; count: number }>;
      by_kind: Array<{ kind: string; count: number }>;
      top_communities: Array<{ community: string; count: number }>;
    }>(aggSql, compiled.values);

    const matchedCount = agg?.total_count ?? 0;

    // 2. Reverse-lookup authorized batches, sources, and projects in parallel
    const [batchRows, sourceRows, samplesRows, visibleProjects, monitors] = await Promise.all([
      matchedCount > 0
        ? pool.query<{
            batch_id: string;
            label: string;
            source_id: string;
            source_label: string;
            platform: string;
            visibility: "private" | "shared";
            matched_count: number;
            batch_total: number;
            last_success_at: Date | null;
            schedule_enabled: boolean;
            created_at: Date;
            matched_ids: string[];
            project_ids: string[];
          }>(
            `WITH matched AS MATERIALIZED (
               SELECT c.id FROM ${fromTables} WHERE ${compiled.text}
             )
             SELECT
               cb.id AS batch_id,
               cb.label,
               cb.collection_source_id AS source_id,
               cs.label AS source_label,
               p.code AS platform,
               cb.visibility,
               COUNT(DISTINCT cbi.content_id)::int AS matched_count,
               cb.item_count::int AS batch_total,
               cs.last_success_at,
               COALESCE((cs.schedule->>'enabled')::boolean, false) AS schedule_enabled,
               cb.created_at,
               ARRAY_AGG(DISTINCT cbi.content_id::text) AS matched_ids,
               COALESCE(
                 ARRAY(
                   SELECT mpb.project_id::text
                   FROM monitor_project_batch mpb
                   JOIN monitor_project mp ON mp.id = mpb.project_id
                   WHERE mpb.batch_id = cb.id
                     AND mpb.status <> 'removed'
                     AND (NOT $${compiled.values.length + 1}::boolean OR mp.owner_user_id = $${compiled.values.length + 2}::uuid OR mp.visibility = 'shared')
                 ),
                 ARRAY[]::text[]
               ) AS project_ids
             FROM matched m
             JOIN collection_batch_item cbi ON cbi.content_id = m.id
             JOIN collection_batch cb ON cb.id = cbi.batch_id AND cb.discarded_at IS NULL
             JOIN collection_source cs ON cs.id = cb.collection_source_id
             JOIN source p ON p.id = cs.platform_id
             WHERE ($${compiled.values.length + 3}::uuid[] IS NULL OR cb.collection_source_id = ANY($${compiled.values.length + 3}::uuid[]))
               AND (NOT $${compiled.values.length + 1}::boolean OR cb.visibility = 'shared' OR cb.created_by_user_id = $${compiled.values.length + 2}::uuid)
             GROUP BY cb.id, cs.id, p.code
             ORDER BY matched_count DESC, cb.created_at DESC
             LIMIT 20`,
            [...compiled.values, isViewer, actor.userId ?? null, actor.allowedSourceIds],
          )
        : Promise.resolve({ rows: [] }),
      // Directory lookup of authorized active sources (including continuous scheduled sources)
      pool.query<{
        source_id: string;
        label: string;
        platform: string;
        usage_domain: string;
        state: string;
        schedule_enabled: boolean;
        cadence_seconds: number | null;
        last_success_at: Date | null;
      }>(
        `SELECT cs.id AS source_id, cs.label, p.code AS platform, cs.usage_domain, cs.state,
                COALESCE((cs.schedule->>'enabled')::boolean, false) AS schedule_enabled,
                NULLIF(cs.schedule->>'cadenceSeconds', '')::int AS cadence_seconds,
                cs.last_success_at
         FROM collection_source cs
         JOIN source p ON p.id = cs.platform_id
         WHERE cs.state = 'active'
           AND ($1::uuid[] IS NULL OR cs.id = ANY($1::uuid[]))
         ORDER BY COALESCE((cs.schedule->>'enabled')::boolean, false) DESC, cs.last_success_at DESC NULLS LAST
         LIMIT 50`,
        [actor.allowedSourceIds],
      ),
      matchedCount > 0 && req.includeSamples !== false
        ? pool.query<{
            id: string;
            platform: string;
            kind: string;
            title: string | null;
            body_text: string | null;
            clean_excerpt: string | null;
            community_name: string | null;
            created_at_source: Date | null;
            url: string | null;
            source_label: string | null;
          }>(
            `SELECT c.id, p.code AS platform, c.kind, c.title, LEFT(c.body_text, 320) AS body_text,
                    LEFT(c.clean_excerpt, 320) AS clean_excerpt, c.community_name, c.created_at_source, c.url,
                    (SELECT cs.label FROM content_discovery d JOIN collection_source cs ON cs.id = d.collection_source_id WHERE d.content_id = c.id LIMIT 1) AS source_label
             FROM ${fromTables}
             WHERE ${compiled.text}
             ORDER BY COALESCE(c.metric_score, c.metric_likes, 0) DESC, COALESCE(c.created_at_source, c.first_seen_at) DESC NULLS LAST
             LIMIT 6`,
            compiled.values,
          )
        : Promise.resolve({ rows: [] }),
      listProjects(pool, actor),
      listMonitors(pool, actor).catch(() => []),
    ]);

    // Compute marginal deduplicated coverage across ranked batches
    const seenContentIds = new Set<string>();
    const batches: DiscoveredBatchCandidate[] = batchRows.rows.map((row) => {
      let marginal = 0;
      for (const cid of row.matched_ids ?? []) {
        if (!seenContentIds.has(cid)) {
          seenContentIds.add(cid);
          marginal++;
        }
      }
      return {
        batchId: row.batch_id,
        label: row.label,
        sourceId: row.source_id,
        sourceLabel: row.source_label,
        platform: row.platform,
        visibility: row.visibility,
        matchedCount: row.matched_count,
        batchTotal: row.batch_total,
        matchRatio: row.batch_total > 0 ? Number((row.matched_count / row.batch_total).toFixed(3)) : 0,
        marginalNewCount: marginal,
        reusable: row.matched_count > 0,
        lastSuccessAt: row.last_success_at ? row.last_success_at.toISOString() : null,
        scheduleEnabled: Boolean(row.schedule_enabled),
        createdAt: row.created_at.toISOString(),
        projectIds: row.project_ids ?? [],
      };
    });

    // Map matched counts to visible projects
    const projectMatchCounts = new Map<string, number>();
    for (const b of batches) {
      for (const pid of b.projectIds) {
        projectMatchCounts.set(pid, (projectMatchCounts.get(pid) ?? 0) + b.matchedCount);
      }
    }
    const monitorProjectIds = new Set(monitors.map((m) => m.projectId).filter((id): id is string => Boolean(id)));
    const topicLower = parsed.originalTopic.toLowerCase();
    const projects: DiscoveredProjectCandidate[] = visibleProjects
      .map((proj) => {
        const nameMatch = topicLower.length >= 2 && (proj.name.toLowerCase().includes(topicLower) || (proj.description ?? "").toLowerCase().includes(topicLower));
        return {
          projectId: proj.id,
          name: proj.name,
          description: proj.description,
          visibility: proj.visibility,
          canEdit: proj.can_edit,
          datasetMode: proj.dataset_mode,
          originKind: proj.origin_kind ?? "manual",
          matchedCount: projectMatchCounts.get(proj.id) ?? 0,
          totalItems: proj.data_summary?.item_count ?? 0,
          enabledBatchCount: proj.enabled_batch_count,
          hasMonitor: Boolean(proj.linked_monitor_id || monitorProjectIds.has(proj.id)),
          _score: (projectMatchCounts.get(proj.id) ?? 0) * 10 + (nameMatch ? 50 : 0) + (proj.data_summary?.item_count ?? 0 > 0 ? 1 : 0),
        };
      })
      .filter((p) => p.matchedCount > 0 || p._score >= 50 || p.projectId === req.projectId)
      .sort((a, b) => b._score - a._score)
      .slice(0, 10)
      .map(({ _score: _unused, ...rest }) => rest);

    // Map matched counts to sources & highlight reusable continuous sources
    const sourceMatchCounts = new Map<string, number>();
    for (const b of batches) {
      sourceMatchCounts.set(b.sourceId, (sourceMatchCounts.get(b.sourceId) ?? 0) + b.matchedCount);
    }
    const continuousSources: DiscoveredContinuousSource[] = sourceRows.rows
      .map((s) => {
        const mCount = sourceMatchCounts.get(s.source_id) ?? 0;
        const labelHit = parsed.pgTerms.some((term) => s.label.toLowerCase().includes(term.toLowerCase()));
        return {
          sourceId: s.source_id,
          label: s.label,
          platform: s.platform,
          usageDomain: s.usage_domain,
          state: s.state,
          scheduleEnabled: s.schedule_enabled,
          cadenceSeconds: s.cadence_seconds,
          lastSuccessAt: s.last_success_at ? s.last_success_at.toISOString() : null,
          matchedCount: mCount,
          reusableForTracking: s.schedule_enabled && (mCount > 0 || labelHit),
          _rel: mCount > 0 || labelHit || (req.template === "industry" && s.usage_domain === "feed"),
        };
      })
      .filter((s) => s._rel)
      .slice(0, 15)
      .map(({ _rel: _unused, ...rest }) => rest);

    return {
      status: matchedCount > 0 ? "exact" : "empty",
      matchedContentCount: matchedCount,
      undatedCount: agg?.undated_count ?? 0,
      dateRange: {
        earliest: agg?.earliest ? agg.earliest.toISOString() : null,
        latest: agg?.latest ? agg.latest.toISOString() : null,
      },
      byPlatform: agg?.by_platform ?? [],
      byKind: agg?.by_kind ?? [],
      topCommunities: agg?.top_communities ?? [],
      batches,
      projects,
      continuousSources,
      samples: samplesRows.rows.map((r) => ({
        id: r.id,
        platform: r.platform,
        kind: r.kind,
        title: (r.title ?? "").trim(),
        excerpt: (r.clean_excerpt ?? r.body_text ?? "").trim(),
        community: r.community_name,
        publishedAt: r.created_at_source ? r.created_at_source.toISOString() : null,
        url: r.url,
        sourceLabel: r.source_label ?? r.platform,
      })),
      elapsedMs: Date.now() - t0,
      note: "站内正文索引覆盖每条内容前 1,500 字符；匹配数为当前账号有权访问的去重内容记录数。",
    };
  } catch (err) {
    return {
      status: "error",
      matchedContentCount: 0,
      undatedCount: 0,
      dateRange: { earliest: null, latest: null },
      byPlatform: [],
      byKind: [],
      topCommunities: [],
      batches: [],
      projects: [],
      continuousSources: [],
      samples: [],
      elapsedMs: Date.now() - t0,
      note: err instanceof Error ? err.message : "站内资料检索暂不可用",
    };
  }
}

async function discoverArchiveChannel(
  archiveRuntime: ArchiveRuntimeFacade | undefined,
  actor: Actor,
  req: ResourceDiscoverRequestType,
  parsed: ParsedResearchQuery,
): Promise<ResourceDiscoveryResponse["archiveChannel"]> {
  const t0 = Date.now();
  if (!archiveRuntime) {
    return {
      status: "unavailable",
      available: false,
      version: null,
      months: [],
      queryUsed: parsed.englishQuery,
      matchedThreads: 0,
      associatedComments: 0,
      reportedCommentsSum: 0,
      needsExactVerify: false,
      dateRange: { earliest: null, latest: null, activeDays: 0 },
      byMonth: [],
      topCommunities: [],
      samples: [],
      elapsedMs: Date.now() - t0,
      message: "历史讨论归档服务未启用",
    };
  }

  const queryUsed = parsed.englishQuery.trim();
  const statusInfo = await archiveRuntime.checkStatus(actor);
  if (!statusInfo.available) {
    const isForbidden = statusInfo.state === "archive_forbidden";
    return {
      status: isForbidden ? "forbidden" : "unavailable",
      available: false,
      version: null,
      months: [],
      queryUsed,
      matchedThreads: 0,
      associatedComments: 0,
      reportedCommentsSum: 0,
      needsExactVerify: false,
      dateRange: { earliest: null, latest: null, activeDays: 0 },
      byMonth: [],
      topCommunities: [],
      samples: [],
      elapsedMs: Date.now() - t0,
      message: isForbidden ? "当前账号未开通历史讨论归档访问授权" : "历史讨论归档服务暂未连接",
    };
  }

  if (!queryUsed && !(req.subreddits?.length)) {
    return {
      status: "invalid_query",
      available: true,
      version: statusInfo.version ?? null,
      months: statusInfo.months,
      queryUsed: "",
      matchedThreads: 0,
      associatedComments: 0,
      reportedCommentsSum: 0,
      needsExactVerify: false,
      dateRange: { earliest: null, latest: null, activeDays: 0 },
      byMonth: [],
      topCommunities: [],
      samples: [],
      elapsedMs: Date.now() - t0,
      message: "历史归档以英文讨论为主，请补充英文检索词或选择社区后重新匹配",
    };
  }

  try {
    const disc = await archiveRuntime.discover(
      actor,
      {
        query: queryUsed,
        subreddits: req.subreddits?.length ? req.subreddits : undefined,
        from: req.from ?? null,
        to: req.to ?? null,
        verifyExact: Boolean(req.verifyArchivePhrase),
        includeSamples: req.includeSamples !== false,
        sampleLimit: 5,
        includeCommentsCount: true,
      },
      Boolean(req.verifyArchivePhrase),
    );
    return {
      status: disc.matchedThreads === 0 ? "empty" : disc.status,
      available: true,
      version: disc.version,
      months: disc.months,
      queryUsed,
      matchedThreads: disc.matchedThreads,
      associatedComments: disc.associatedComments,
      reportedCommentsSum: disc.reportedCommentsSum,
      needsExactVerify: disc.needsExactVerify,
      dateRange: disc.dateRange,
      byMonth: disc.byMonth,
      topCommunities: disc.topCommunities,
      samples: disc.samples,
      elapsedMs: disc.elapsedMs,
      message: disc.needsExactVerify
        ? "当前为候选规模（含短语条件），可点击“精确短语复核”获取严格匹配计数"
        : undefined,
    };
  } catch (err) {
    const code = err instanceof AppError ? err.message : "archive_error";
    const statusMap: Record<string, ResourceDiscoveryResponse["archiveChannel"]["status"]> = {
      archive_forbidden: "forbidden",
      query_timeout: "timeout",
      recall_limit: "recall_limit",
      invalid_query: "invalid_query",
      archive_offline: "unavailable",
      archive_disabled: "unavailable",
    };
    const msgMap: Record<string, string> = {
      archive_forbidden: "当前账号未开通历史讨论归档访问授权",
      query_timeout: "历史归档检索超时，请收窄关键词、时间或社区后重试",
      recall_limit: "匹配范围过大（超出单分片 12.5 万 / 总计 50 万候选上限），请使用更具体的关键词或收窄范围",
      invalid_query: "英文检索表达式语法无效，请检查引号与布尔运算符后重试",
    };
    return {
      status: statusMap[code] ?? "error",
      available: code !== "archive_offline" && code !== "archive_disabled" && code !== "archive_forbidden",
      version: statusInfo.version ?? null,
      months: statusInfo.months,
      queryUsed,
      matchedThreads: 0,
      associatedComments: 0,
      reportedCommentsSum: 0,
      needsExactVerify: false,
      dateRange: { earliest: null, latest: null, activeDays: 0 },
      byMonth: [],
      topCommunities: [],
      samples: [],
      elapsedMs: Date.now() - t0,
      message: msgMap[code] ?? "历史归档检索暂时异常，可先查看其他可用资料或稍后重试",
    };
  }
}

async function discoverStoriesChannel(
  pool: Pool,
  actor: Actor,
  req: ResourceDiscoverRequestType,
  parsed: ParsedResearchQuery,
): Promise<ResourceDiscoveryResponse["storiesChannel"]> {
  const t0 = Date.now();
  try {
    const win = await readStoryWindow(
      pool,
      actor,
      {
        channelScope: "info",
        view: "latest",
        ...(req.sourceGroup ? { sourceGroup: req.sourceGroup } : {}),
        ...(req.languages?.[0] ? { language: req.languages[0] } : {}),
      },
      Date.now(),
      contentVisibility,
    );

    const needles = parsed.pgTerms.map((t) => t.toLowerCase()).filter((t) => t.length >= 2);
    const allItems = win.latest;
    const filtered =
      req.template === "industry" && (!parsed.originalTopic || needles.length === 0)
        ? allItems
        : needles.length > 0
          ? allItems.filter((item) => {
              const hay = `${item.representative.title} ${item.excerpt ?? ""}`.toLowerCase();
              return needles.some((n) => hay.includes(n));
            })
          : allItems;

    const effective = filtered.length > 0 ? filtered : req.template === "industry" ? allItems : [];
    const sources = new Set<string>();
    const channelCounts = new Map<string, number>();
    for (const s of effective) {
      sources.add(s.representative.sourceId);
      const meta = win.metaByStoryKey.get(s.storyKey);
      const ch = meta?.sourceGroup || "general";
      channelCounts.set(ch, (channelCounts.get(ch) ?? 0) + 1);
    }

    return {
      status: effective.length > 0 ? "exact" : "empty",
      eventCount: effective.length,
      independentSourceCount: sources.size,
      windowFrom: win.from,
      windowTo: win.to,
      topChannels: [...channelCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([channel, count]) => ({ channel, count })),
      samples: effective.slice(0, 5).map((s) => ({
        storyKey: s.storyKey,
        title: s.representative.title,
        sourceLabel: s.representative.sourceLabel,
        tier: s.representative.tier,
        publishedAt: s.representative.publishedAt,
        url: s.representative.url,
        sourceCount: s.sourceCount,
      })),
      elapsedMs: Date.now() - t0,
    };
  } catch {
    return {
      status: "unavailable",
      eventCount: 0,
      independentSourceCount: 0,
      windowFrom: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      windowTo: new Date().toISOString(),
      topChannels: [],
      samples: [],
      elapsedMs: Date.now() - t0,
    };
  }
}

export async function discoverResearchResources(
  pool: Pool,
  actor: Actor,
  req: ResourceDiscoverRequestType,
  archiveRuntime?: ArchiveRuntimeFacade,
): Promise<ResourceDiscoveryResponse> {
  const t0 = Date.now();
  const parsed = parseResearchQuery({
    topic: req.topic,
    question: req.question,
    aliases: req.aliases,
    englishQuery: req.englishQuery,
  });

  const skipArchiveForIndustry =
    req.template === "industry" && !(req.platforms && req.platforms.includes("reddit"));

  const [pgChannel, archiveChannel, storiesChannel] = await Promise.all([
    discoverPgChannel(pool, actor, req, parsed),
    skipArchiveForIndustry
      ? Promise.resolve<ResourceDiscoveryResponse["archiveChannel"]>({
          status: "unavailable",
          available: false,
          version: null,
          months: [],
          queryUsed: "",
          matchedThreads: 0,
          associatedComments: 0,
          reportedCommentsSum: 0,
          needsExactVerify: false,
          dateRange: { earliest: null, latest: null, activeDays: 0 },
          byMonth: [],
          topCommunities: [],
          samples: [],
          elapsedMs: 0,
          message: "行业情报简报优先使用平台实时资讯流；如需叠加历史 Reddit 社区讨论，请切换社媒/电商研究或在高级筛选中指定 Reddit。",
        })
      : discoverArchiveChannel(archiveRuntime, actor, req, parsed),
    discoverStoriesChannel(pool, actor, req, parsed),
  ]);

  const template = req.template ?? "commerce";
  const mode = req.mode ?? "comprehensive";
  const gaps: string[] = [];
  const supplementalSources: string[] = [];
  const reusableContinuousSourceIds = pgChannel.continuousSources
    .filter((s) => s.reusableForTracking)
    .map((s) => s.sourceId);

  let primarySource: ResourceDiscoveryResponse["recommendation"]["primarySource"] = "archive";
  let primaryLabel = "历史消费者与社媒讨论（Reddit 归档）";
  let readiness: "strong" | "preliminary" | "needs_collection" = "needs_collection";
  let rationale = "";
  let suggestCollection = false;

  if (template === "industry") {
    primarySource = "stories";
    primaryLabel = "平台行业资讯流（去重事件与多源印证）";
    if (storiesChannel.eventCount >= 8) {
      readiness = "strong";
      rationale = `当前窗口内已有 ${storiesChannel.eventCount} 个去重行业事件（覆盖 ${storiesChannel.independentSourceCount} 个独立来源），可直接生成行业情报简报。`;
    } else if (storiesChannel.eventCount > 0) {
      readiness = "preliminary";
      rationale = `当前窗口内匹配到 ${storiesChannel.eventCount} 条行业资讯事件，适合生成精简简报。`;
      gaps.push("近期相关资讯事件偏少，可扩大时间范围或调整频道。");
    } else {
      readiness = "needs_collection";
      rationale = "当前筛选范围内暂无已入库的行业资讯，请先调整频道/时间或由管理员刷新资讯源。";
      gaps.push("当前时间窗内暂无匹配的资讯事件。");
    }
    if (pgChannel.matchedContentCount > 0) supplementalSources.push(`站内社媒讨论 ${pgChannel.matchedContentCount} 条`);
  } else if (req.projectId && pgChannel.projects.some((p) => p.projectId === req.projectId && p.totalItems > 0)) {
    const p = pgChannel.projects.find((item) => item.projectId === req.projectId)!;
    primarySource = "project";
    primaryLabel = `当前研究项目：${p.name}`;
    readiness = p.totalItems >= 30 ? "strong" : "preliminary";
    rationale = `将直接复用研究项目“${p.name}”中的 ${p.totalItems.toLocaleString()} 条有效样本。`;
  } else if (mode === "recent") {
    if (pgChannel.matchedContentCount >= 20) {
      primarySource = "pg_content";
      primaryLabel = "平台近期已收集社媒讨论";
      readiness = "strong";
      rationale = `站内已有 ${pgChannel.matchedContentCount.toLocaleString()} 条近期讨论，可直接用于近期动态分析。`;
      if (archiveChannel.matchedThreads > 0) supplementalSources.push(`历史讨论 ${archiveChannel.matchedThreads.toLocaleString()} 个讨论串作为基线参考`);
    } else if (archiveChannel.matchedThreads >= 30) {
      primarySource = "archive";
      primaryLabel = "历史消费者与社媒讨论（Reddit 归档）";
      readiness = "preliminary";
      suggestCollection = true;
      gaps.push(`近期站内讨论仅 ${pgChannel.matchedContentCount} 条，缺少最近几周的实时社媒更新。`);
      rationale = `历史归档有 ${archiveChannel.matchedThreads.toLocaleString()} 个相关讨论串，但近期动态覆盖不足，建议补充近期采集或先基于历史资料生成初步报告。`;
    } else {
      primarySource = "pg_content";
      primaryLabel = "补充采集近期社媒讨论";
      readiness = "needs_collection";
      suggestCollection = true;
      gaps.push("站内与历史归档均缺少足够匹配资料，建议确认后执行补充采集。");
      rationale = "当前已有资料不足以支撑近期动态报告，建议配置并确认补充采集方案。";
    }
  } else {
    // comprehensive or continuous
    if (archiveChannel.matchedThreads >= 30) {
      primarySource = "archive";
      primaryLabel = "历史消费者与社媒讨论（Reddit 归档）";
      readiness = archiveChannel.matchedThreads >= 100 ? "strong" : "preliminary";
      rationale = `历史讨论归档匹配到 ${archiveChannel.matchedThreads.toLocaleString()} 个讨论串（关联 ${archiveChannel.associatedComments.toLocaleString()} 条归档评论），覆盖 ${archiveChannel.dateRange.activeDays} 个活跃日，适合开展需求、痛点与口碑研究。`;
      if (pgChannel.matchedContentCount > 0) {
        supplementalSources.push(`平台近期已存讨论 ${pgChannel.matchedContentCount} 条`);
      } else {
        gaps.push("当前主要覆盖历史归档时段，如需近一周最新动态可勾选补充采集。");
      }
    } else if (pgChannel.matchedContentCount >= 10) {
      primarySource = "pg_content";
      primaryLabel = "平台已收集讨论资料";
      readiness = pgChannel.matchedContentCount >= 40 ? "strong" : "preliminary";
      rationale = `站内已收集资料中匹配到 ${pgChannel.matchedContentCount.toLocaleString()} 条相关讨论（来自 ${pgChannel.batches.length} 个授权批次），可直接组织研究。`;
      if (archiveChannel.status === "forbidden") gaps.push("当前账号未开通历史归档授权，本次仅使用站内已存资料。");
    } else if (pgChannel.matchedContentCount > 0 || archiveChannel.matchedThreads > 0) {
      primarySource = archiveChannel.matchedThreads >= pgChannel.matchedContentCount ? "archive" : "pg_content";
      primaryLabel = primarySource === "archive" ? "历史讨论归档（小样本）" : "站内已收集资料（小样本）";
      readiness = "preliminary";
      suggestCollection = true;
      gaps.push("当前匹配样本量较少，适合生成定性精简报告，或补充采集更多讨论。");
      rationale = "仅发现少量相关讨论，可先生成精简初步报告，或经确认后补充采集。";
    } else {
      primarySource = "pg_content";
      primaryLabel = "待补充采集资料";
      readiness = "needs_collection";
      suggestCollection = true;
      gaps.push("当前条件下未命中可用资料，请检查关键词、英文别名或确认补充采集。");
      rationale = "在当前授权范围内未发现匹配资料，建议调整检索词、放宽时间范围或补充采集。";
    }
  }

  if (mode === "continuous" && reusableContinuousSourceIds.length === 0) {
    gaps.push("暂未找到覆盖该对象的持续更新来源，确认后将按需配置持续监测计划。");
  }

  const readinessLabel =
    readiness === "strong"
      ? "条件较好 · 可直接开始研究"
      : readiness === "preliminary"
        ? "适合初步研究 · 可按需补充资料"
        : "建议补充资料或调整检索条件";

  return {
    discoveryId: `disc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    parsedQuery: parsed,
    pgChannel,
    archiveChannel,
    storiesChannel,
    recommendation: {
      readiness,
      readinessLabel,
      primarySource,
      primaryLabel,
      rationale,
      supplementalSources,
      gaps,
      suggestCollection,
      suggestContinuousReuse: mode === "continuous" && reusableContinuousSourceIds.length > 0,
      reusableContinuousSourceIds,
      recommendedProjectId: req.projectId ?? pgChannel.projects[0]?.projectId ?? null,
      recommendedBatchIds: pgChannel.batches.slice(0, 5).map((b) => b.batchId),
    },
  };
}
