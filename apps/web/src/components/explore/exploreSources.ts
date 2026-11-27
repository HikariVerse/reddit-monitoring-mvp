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
    titleEn: 'Historical Reddit Archive',
    titleZh: '历史 Reddit 讨论',
    subEn: 'Multi-month archive',
    subZh: '本地历史归档库',
    shortEn: 'Archive',
    shortZh: '历史 Reddit',
    supportsSubreddits: true,
    icon: 'archive',
  },
  {
    mode: 'live_content',
    titleEn: 'All Stored Materials',
    titleZh: '站内全部资料',
    subEn: 'News & social discussions',
    subZh: '资讯与社媒汇总',
    shortEn: 'All Materials',
    shortZh: '站内全部',
    supportsSubreddits: false,
    icon: 'live',
  },
  {
    mode: 'info_stream',
    titleEn: 'Industry News Stream',
    titleZh: '行业资讯流',
    subEn: 'Media & RSS feeds',
    subZh: '权威媒体与订阅源',
    shortEn: 'News Stream',
    shortZh: '行业资讯',
    supportsSubreddits: false,
    icon: 'info',
  },
  {
    mode: 'reddit_api',
    titleEn: 'Collected Reddit',
    titleZh: '已采集 Reddit 讨论',
    subEn: 'Live community snapshots',
    subZh: '已采集社区讨论',
    shortEn: 'Reddit',
    shortZh: '已采集 Reddit',
    supportsSubreddits: true,
    icon: 'reddit',
  },
  {
    mode: 'x_api',
    titleEn: 'Collected X Posts',
    titleZh: '已采集 X 讨论',
    subEn: 'Live social posts',
    subZh: '已采集社交动态',
    shortEn: 'X',
    shortZh: '已采集 X',
    supportsSubreddits: false,
    icon: 'x',
  },
  {
    mode: 'project_content',
    titleEn: 'Study Samples',
    titleZh: '指定研究样本',
    subEn: 'Selected study scope',
    subZh: '当前研究范围',
    shortEn: 'Study',
    shortZh: '研究样本',
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
        'Too many archive matches (exceeds 125k per shard or 500k total). Use a more specific keyword or filter by community/date.',
        '关键词命中历史归档条目过多（超过单分片 12.5 万或总计 50 万召回上限），请输入更具体的关键词，或在高级筛选中限定社区/日期范围。',
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
