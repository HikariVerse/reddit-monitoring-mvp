import type {
  ExploreCapabilitiesResponse,
  ExploreSourceMode,
} from '../../../../../packages/contracts/src/explore';

export type ExploreTranslate = (en: string, zh: string) => string;

export interface ExploreSourceMeta {
  mode: ExploreSourceMode;
  titleEn: string;
  titleZh: string;
  subEn: string;
  subZh: string;
  shortEn: string;
  shortZh: string;
  supportsSubreddits: boolean;
  icon: 'archive' | 'live' | 'info' | 'reddit' | 'x' | 'project';
}

export const EXPLORE_SOURCE_OPTIONS: readonly ExploreSourceMeta[] = [
  {
    mode: 'archive',
    titleEn: 'Offline Reddit Archive',
    titleZh: '离线 Reddit 归档',
    subEn: 'Historical · R4',
    subZh: '历史讨论 · R4',
    shortEn: 'Archive',
    shortZh: '离线归档',
    supportsSubreddits: true,
    icon: 'archive',
  },
  {
    mode: 'live_content',
    titleEn: 'All Live Data',
    titleZh: '站内全部数据',
    subEn: 'News & social streams',
    subZh: '资讯与社交采集',
    shortEn: 'All Live Data',
    shortZh: '站内全部数据',
    supportsSubreddits: false,
    icon: 'live',
  },
  {
    mode: 'info_stream',
    titleEn: 'Info Stream',
    titleZh: '资讯信息流',
    subEn: 'RSS / Web',
    subZh: 'RSS / Web',
    shortEn: 'Info Stream',
    shortZh: '资讯信息流',
    supportsSubreddits: false,
    icon: 'info',
  },
  {
    mode: 'reddit_api',
    titleEn: 'Reddit API',
    titleZh: 'Reddit API',
    subEn: 'Collected discussions',
    subZh: '已采集社区讨论',
    shortEn: 'Reddit API',
    shortZh: 'Reddit API',
    supportsSubreddits: true,
    icon: 'reddit',
  },
  {
    mode: 'x_api',
    titleEn: 'X (Twitter) API',
    titleZh: 'X (Twitter) API',
    subEn: 'Collected social posts',
    subZh: '已采集社交动态',
    shortEn: 'X',
    shortZh: 'X',
    supportsSubreddits: false,
    icon: 'x',
  },
  {
    mode: 'project_content',
    titleEn: 'Project Samples',
    titleZh: '项目样本',
    subEn: 'Selected project',
    subZh: '指定研究项目',
    shortEn: 'Project Samples',
    shortZh: '项目样本',
    supportsSubreddits: false,
    icon: 'project',
  },
];

export const EXPLORE_QUICK_PROMPTS = ['DuckDB', 'pricing', 'alternative', 'LocalLLaMA', 'coding agent'] as const;

export function resolveSourceAvailability(
  mode: ExploreSourceMode,
  cap: ExploreCapabilitiesResponse | undefined,
  projectCount: number,
  t: ExploreTranslate,
): { label: string; hasData: boolean; disabled: boolean } {
  if (!cap) return { label: '—', hasData: false, disabled: false };
  if (mode === 'archive') {
    return cap.archiveAvailable
      ? { label: `${cap.archiveMonths.length} ${t('months ready', '个月可用')}`, hasData: true, disabled: false }
      : { label: t('Offline', '未连接'), hasData: false, disabled: true };
  }
  if (mode === 'live_content') {
    const n = cap.liveContentCounts.total;
    return { label: `${n.toLocaleString()} ${t('items', '条')}`, hasData: n > 0, disabled: false };
  }
  if (mode === 'info_stream') {
    const n = cap.liveContentCounts.infoStream;
    return { label: `${n.toLocaleString()} ${t('items', '条')}`, hasData: n > 0, disabled: false };
  }
  if (mode === 'reddit_api') {
    const n = cap.liveContentCounts.reddit;
    return { label: `${n.toLocaleString()} ${t('items', '条')}`, hasData: n > 0, disabled: false };
  }
  if (mode === 'x_api') {
    const n = cap.liveContentCounts.x;
    return { label: `${n.toLocaleString()} ${t('items', '条')}`, hasData: n > 0, disabled: false };
  }
  return {
    label: `${projectCount} ${t('projects', '个项目')}`,
    hasData: projectCount > 0,
    disabled: false,
  };
}

export function formatExploreError(t: ExploreTranslate, err: unknown): string {
  const code = err instanceof Error ? err.message : String(err);
  switch (code) {
    case 'recall_limit':
      return t(
        'Too many archive matches (>125,000 candidates). Use a more specific keyword or filter by community/date.',
        '关键词命中全量归档条目过多（超过单次召回上限 12.5 万条），请输入更具体的关键词，或在高级筛选中限定社区/日期范围。',
      );
    case 'query_resource_limit':
      return t(
        'The query exceeded the DuckDB memory budget. Narrow the keywords or time window and retry.',
        '本次全量归档查询超出引擎内存预算，请收窄关键词或时间区间后重试。',
      );
    case 'query_timeout':
      return t(
        'Analysis timed out. Try a narrower query or fewer months.',
        '分析计算超时，请尝试更具体的关键词或缩小时间范围后重试。',
      );
    case 'analytics_unavailable':
      return t(
        'The external analytics service encountered a temporary error. Please retry or narrow your query.',
        '外置分析引擎暂时异常，请重试或适当收窄查询范围。',
      );
    case 'project_id_required':
      return t('Please select a research project first.', '请先选择要分析的研究项目。');
    default:
      return code;
  }
}
