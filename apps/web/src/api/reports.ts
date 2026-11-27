import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { liveFetch } from './client';
import type {
  ReportDraftUpsertInputType,
  ReportRunActionInputType,
  ReportRunCreateInputType,
  ReportScheduleCreateInputType,
  ReportSchedulePatchInputType,
  ReportTemplateType,
  ResourceDiscoverRequestType,
} from '../../../../packages/contracts/src/reports';

export type { ReportTemplateType };

export interface ReportScopeSummary {
  id: string;
  sourceKind: 'stories' | 'archive' | 'pg_content' | 'project' | 'monitor' | 'ai_events';
  sourceLabel: string;
  query: string;
  range: { from: string | null; to: string | null; activeDays: number };
  dataVersion: string;
  matchedCount: number | null;
  matchedUnit: string;
  matchedStatus: 'exact' | 'candidate' | 'truncated' | 'unavailable';
  analyzedCount: number;
  analyzedUnit: string;
  samplingNote: string;
  engineLabel: string;
  projectId?: string | null;
  archiveRefId?: string | null;
  sourceIds?: string[];
  batchIds?: string[];
  monitorId?: string | null;
  studyId?: string | null;
}

export interface ReportEvidenceItem {
  id: string;
  scopeId: string;
  moduleId: string;
  groupLabel?: string;
  title: string;
  excerpt: string;
  sourceLabel: string;
  platform: string;
  community?: string | null;
  author?: string | null;
  publishedAt: string | null;
  url: string | null;
  documentId: string;
  threadId?: string | null;
  engagement?: Record<string, number>;
  reason: string;
}

export interface ReportMetricDatum {
  id: string;
  label: string;
  value: number | string | null;
  formatted: string;
  unit: string;
  denominator?: string;
  note?: string;
}

export interface ReportChartSpec {
  id: string;
  title: string;
  subtitle?: string;
  kind: 'line' | 'bar' | 'horizontal_bar' | 'stacked_bar' | 'heatmap' | 'pie' | 'table';
  unit: string;
  denominator?: string;
  xLabels: string[];
  series: Array<{ name: string; data: number[]; color?: string }>;
  heatmap?: { xLabels: string[]; yLabels: string[]; values: Array<[number, number, number]> };
  table?: { columns: string[]; rows: Array<Array<string | number>> };
  evidenceIds?: string[];
}

export interface ReportFinding {
  title: string;
  text: string;
  kind: 'observation' | 'interpretation' | 'hypothesis' | 'recommendation';
  scopeIds: string[];
  metricIds: string[];
  evidenceIds: string[];
}

export interface ReportNarrative {
  sectionId: string;
  heading: string;
  summary: string;
  findings: ReportFinding[];
  topicLabels?: Array<{ groupId: string; label: string; evidenceIds: string[] }>;
  limitations: string[];
  verified: boolean;
  validationNotes?: string[];
}

export type ModuleAvailabilityState =
  | 'ready'
  | 'exploratory'
  | 'insufficient_data'
  | 'unsupported_source'
  | 'missing_fields'
  | 'unavailable_dependency'
  | 'failed';

export interface ReportSectionData {
  id: string;
  moduleId: string;
  title: string;
  description: string;
  scopeId: string;
  state: ModuleAvailabilityState;
  stateMessage: string;
  engineSource: string;
  unit: string;
  denominatorLabel: string;
  sampleCount: number;
  metrics: ReportMetricDatum[];
  charts: ReportChartSpec[];
  evidenceIds: string[];
  method: string;
  warnings: string[];
  narrative?: ReportNarrative | null;
  pinned?: boolean;
}

export interface ReportModuleCatalogItem {
  id: string;
  title: string;
  description: string;
  engineSource: 'stories' | 'explore' | 'project_l1' | 'project_l2' | 'project_l3' | 'intel_monitor' | 'system';
  metricIds: string[];
  applicableTemplates: ReportTemplateType[];
  supportedSources: Array<'stories' | 'archive' | 'pg_content' | 'project' | 'monitor' | 'explore_study'>;
  defaultForTemplates: ReportTemplateType[];
  pinned?: boolean;
}

export interface ParsedResearchQuery {
  originalTopic: string;
  coreTerms: string[];
  aliases: string[];
  expandedTerms: string[];
  intentTerms: string[];
  pgTerms: string[];
  englishQuery: string;
  englishExactQuery: string | null;
  hasChinese: boolean;
  ambiguityWarnings: string[];
  suggestedSubreddits: string[];
  translationSource: 'passthrough' | 'dictionary' | 'user_override' | 'fallback';
}

export interface DiscoveredBatchCandidate {
  batchId: string;
  label: string;
  sourceId: string;
  sourceLabel: string;
  platform: string;
  visibility: 'private' | 'shared';
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
  visibility: 'private' | 'shared';
  canEdit: boolean;
  datasetMode: 'batch' | 'source_filter';
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
    status: 'exact' | 'empty' | 'unavailable' | 'error';
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
    status: 'exact' | 'candidate' | 'empty' | 'unavailable' | 'forbidden' | 'timeout' | 'recall_limit' | 'invalid_query' | 'error';
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
    message?: string;
  };
  storiesChannel: {
    status: 'exact' | 'empty' | 'unavailable';
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
    readiness: 'strong' | 'preliminary' | 'needs_collection';
    readinessLabel: string;
    primarySource: 'stories' | 'archive' | 'pg_content' | 'project' | 'monitor';
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

export interface ReportDraftDto {
  id: string;
  revision: number;
  template: ReportTemplateType;
  title: string;
  input: Record<string, unknown>;
  discovery: ResourceDiscoveryResponse | null;
  plan: Record<string, unknown> | null;
  sections: string[];
  projectId: string | null;
  status: 'draft' | 'submitted' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface ReportRunDto {
  id: string;
  draftId: string | null;
  scheduleId: string | null;
  scheduleSlot: string | null;
  template: ReportTemplateType;
  title: string;
  projectId: string | null;
  scopeHash: string;
  dataVersion: string;
  state: string;
  stageLabel: string;
  stepProgress: Record<string, unknown>;
  llmUsage: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  cancelRequested: boolean;
  reportId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportSummaryDto {
  id: string;
  projectId: string | null;
  projectDeleted: boolean;
  runId: string | null;
  scheduleId: string | null;
  template: ReportTemplateType;
  schemaVersion: string;
  reportVersion: number;
  title: string;
  subtitle: string;
  summary: string;
  visibility: 'private' | 'shared';
  mode: 'llm_verified' | 'pure_data' | 'partial_llm';
  sectionCount: number;
  evidenceCount: number;
  primarySourceLabel: string;
  analyzedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReportDetailDto extends ReportSummaryDto {
  scopes: ReportScopeSummary[];
  scopeMeta: Record<string, unknown>;
  sections: ReportSectionData[];
  evidence: ReportEvidenceItem[];
  provenance: Record<string, unknown>;
}

export interface ReportScheduleDto {
  id: string;
  projectId: string | null;
  monitorId: string | null;
  name: string;
  template: ReportTemplateType;
  config: Record<string, unknown>;
  cadence: 'daily' | 'weekly' | 'monthly' | 'custom_interval';
  intervalMinutes: number | null;
  timezone: string;
  windowHours: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastStatus: string | null;
  lastError: string | null;
  maxDailyTokens: number;
  createdAt: string;
  updatedAt: string;
}

export const reportsApi = {
  discoverResources(body: ResourceDiscoverRequestType, signal?: AbortSignal) {
    return liveFetch<ResourceDiscoveryResponse>('/research/resources/discover', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });
  },
  getModules() {
    return liveFetch<{ modules: ReportModuleCatalogItem[]; llm: { configured: boolean; model: string | null } }>(
      '/reports/modules',
    );
  },
  listDrafts() {
    return liveFetch<{ drafts: ReportDraftDto[] }>('/reports/drafts');
  },
  upsertDraft(body: ReportDraftUpsertInputType) {
    return liveFetch<{ draft: ReportDraftDto }>('/reports/drafts', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  deleteDraft(id: string) {
    return liveFetch<{ deleted: boolean }>(`/reports/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  listRuns(params?: { projectId?: string; limit?: number }) {
    const qs = new URLSearchParams();
    if (params?.projectId) qs.set('projectId', params.projectId);
    if (params?.limit) qs.set('limit', String(params.limit));
    return liveFetch<{ runs: ReportRunDto[] }>(`/reports/runs${qs.toString() ? `?${qs}` : ''}`);
  },
  createRun(body: ReportRunCreateInputType) {
    return liveFetch<{ run: ReportRunDto }>('/reports/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  getRun(id: string) {
    return liveFetch<{ run: ReportRunDto }>(`/reports/runs/${encodeURIComponent(id)}`);
  },
  actOnRun(id: string, body: ReportRunActionInputType) {
    return liveFetch<{ run: ReportRunDto }>(`/reports/runs/${encodeURIComponent(id)}/action`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  listReports(params?: { template?: ReportTemplateType; projectId?: string; search?: string; limit?: number }) {
    const qs = new URLSearchParams();
    if (params?.template) qs.set('template', params.template);
    if (params?.projectId) qs.set('projectId', params.projectId);
    if (params?.search) qs.set('search', params.search);
    if (params?.limit) qs.set('limit', String(params.limit));
    return liveFetch<{ reports: ReportSummaryDto[] }>(`/reports${qs.toString() ? `?${qs}` : ''}`);
  },
  getReport(id: string) {
    return liveFetch<{ report: ReportDetailDto }>(`/reports/${encodeURIComponent(id)}`);
  },
  deleteReport(id: string) {
    return liveFetch<{ deleted: boolean }>(`/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  exportUrl(id: string) {
    return `/api/v1/reports/${encodeURIComponent(id)}/export`;
  },
  listSchedules(projectId?: string) {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return liveFetch<{ schedules: ReportScheduleDto[] }>(`/reports/schedules${qs}`);
  },
  createSchedule(body: ReportScheduleCreateInputType) {
    return liveFetch<{ schedule: ReportScheduleDto }>('/reports/schedules', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  updateSchedule(id: string, body: ReportSchedulePatchInputType) {
    return liveFetch<{ schedule: ReportScheduleDto }>(`/reports/schedules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },
  deleteSchedule(id: string) {
    return liveFetch<{ deleted: boolean }>(`/reports/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  triggerSchedule(id: string) {
    return liveFetch<{ runId: string | null; status: string }>(`/reports/schedules/${encodeURIComponent(id)}/trigger`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
};

export function useDiscoverReportResourcesMutation() {
  return useMutation({
    mutationFn: (body: ResourceDiscoverRequestType) => reportsApi.discoverResources(body),
  });
}

export function useReportModulesQuery(enabled = true) {
  return useQuery({ queryKey: ['reportModules'], queryFn: () => reportsApi.getModules(), enabled, staleTime: 60_000 });
}

export function useReportDraftsQuery(enabled = true) {
  return useQuery({ queryKey: ['reportDrafts'], queryFn: () => reportsApi.listDrafts(), enabled });
}

export function useUpsertReportDraftMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReportDraftUpsertInputType) => reportsApi.upsertDraft(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reportDrafts'] }),
  });
}

export function useDeleteReportDraftMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => reportsApi.deleteDraft(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reportDrafts'] }),
  });
}

export function useReportRunsQuery(params?: { projectId?: string; limit?: number }, enabled = true) {
  return useQuery({
    queryKey: ['reportRuns', params],
    queryFn: () => reportsApi.listRuns(params),
    enabled,
    refetchInterval: (q) => {
      const list = q.state.data?.runs ?? [];
      return list.some((r) => ['preparing', 'collecting', 'analyzing', 'writing', 'cancel_requested'].includes(r.state))
        ? 2500
        : false;
    },
  });
}

export function useReportRunQuery(id: string | null) {
  return useQuery({
    queryKey: ['reportRun', id],
    queryFn: () => reportsApi.getRun(id!),
    enabled: Boolean(id),
    refetchInterval: (q) => {
      const st = q.state.data?.run?.state ?? '';
      return ['preparing', 'collecting', 'analyzing', 'writing', 'cancel_requested'].includes(st) ? 2000 : false;
    },
  });
}

export function useCreateReportRunMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReportRunCreateInputType) => reportsApi.createRun(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reportRuns'] });
      void qc.invalidateQueries({ queryKey: ['reportDrafts'] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useReportRunActionMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ReportRunActionInputType }) => reportsApi.actOnRun(id, body),
    onSuccess: (_res, { id }) => {
      void qc.invalidateQueries({ queryKey: ['reportRun', id] });
      void qc.invalidateQueries({ queryKey: ['reportRuns'] });
      void qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}

export function useReportsListQuery(
  params?: { template?: ReportTemplateType; projectId?: string; search?: string; limit?: number },
  enabled = true,
) {
  return useQuery({
    queryKey: ['reports', params],
    queryFn: () => reportsApi.listReports(params),
    enabled,
  });
}

export function useReportDetailQuery(id: string | null) {
  return useQuery({
    queryKey: ['reportDetail', id],
    queryFn: () => reportsApi.getReport(id!),
    enabled: Boolean(id),
  });
}

export function useDeleteReportMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => reportsApi.deleteReport(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reports'] }),
  });
}

export function useReportSchedulesQuery(projectId?: string, enabled = true) {
  return useQuery({
    queryKey: ['reportSchedules', projectId],
    queryFn: () => reportsApi.listSchedules(projectId),
    enabled,
  });
}

export function useCreateReportScheduleMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReportScheduleCreateInputType) => reportsApi.createSchedule(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reportSchedules'] }),
  });
}

export function useUpdateReportScheduleMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ReportSchedulePatchInputType }) => reportsApi.updateSchedule(id, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reportSchedules'] }),
  });
}

export function useDeleteReportScheduleMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => reportsApi.deleteSchedule(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reportSchedules'] }),
  });
}

export function useTriggerReportScheduleMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => reportsApi.triggerSchedule(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reportSchedules'] });
      void qc.invalidateQueries({ queryKey: ['reportRuns'] });
    },
  });
}
