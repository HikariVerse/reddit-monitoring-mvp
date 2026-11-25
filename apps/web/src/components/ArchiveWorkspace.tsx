import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  ArchiveEvidence, ArchivePage, ArchivePost, ArchiveReference,
  ArchiveSearch, ArchiveSelection, ArchiveStatus as Status, ArchiveThread,
} from '../../../../packages/contracts/src/archive';
import '../styles/collection.css';
import { explorePath } from '../lib/archiveRoutes';
import { liveFetch } from '../api/client';
import { useI18n } from '../i18n/translations';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select } from './ui/select';

type Translate = (english: string, chinese: string) => string;
const archivePath = (project: string) => '/projects/' + encodeURIComponent(project) + '/archives';
const post = (data: object) => ({ method: 'POST', body: JSON.stringify(data) });

const defaultFields = { query: '', subreddits: '', from: '', to: '' };
function toFilters(fields: typeof defaultFields): ArchiveSearch['filters'] {
  return {
    query: fields.query.trim(),
    subreddits: fields.subreddits.split(/[,，\s]+/).filter(Boolean),
    from: fields.from ? new Date(fields.from + 'Z').toISOString() : null,
    to: fields.to ? new Date(fields.to + 'Z').toISOString() : null,
  };
}

function message(t: Translate, error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  switch (code) {
    case 'archive_disabled': return t('The archive engine is disabled.', '离线归档引擎未启用。');
    case 'archive_unconfigured':
    case 'archive_source_unavailable': return t('Ask an administrator to configure the archive service and activate its R4 source.', '请管理员配置归档服务并启用关联的 R4 来源。');
    case 'archive_forbidden': return t('This account has no archive access. Contact an administrator.', '当前账号没有归档授权，请联系管理员。');
    case 'archive_offline': return t('The archive service is offline. Check the service and retry.', '归档服务离线，检查服务后重试。');
    case 'invalid_service_token': return t('The API and archive service credentials do not match.', '主线与归档服务的凭证不匹配。');
    case 'directory_unreadable': return t('The service cannot read its configured archive directory.', '归档服务无法读取配置的目录。');
    case 'archive_empty': return t('The archive directory contains no valid monthly packages.', '归档目录没有可用的月份包。');
    case 'package_invalid': return t('An archive package is damaged or incomplete.', '归档包损坏或缺少必要文件。');
    case 'archive_version_changed': return t('The archive version changed. Preview and link the new version in Data Intake.', '归档版本已变更，请在数据接入重新预览并关联新版本。');
    case 'cursor_invalid': return t('This page cursor expired. Restart the search.', '此分页游标已失效，请重新查询。');
    case 'query_timeout': return t('The query timed out. Try fewer months or a narrower query.', '查询超时，请减少月份或收窄检索范围。');
    case 'archive_month_unavailable': return t('A linked month is unavailable in this version.', '当前版本中有已关联月份不可用。');
    case 'archive_reference_not_found': return t('The selected archive link is no longer available.', '所选归档关联已不可用。');
    case 'archive_invalid_response':
    case 'query_worker_failed': return t('The archive service did not return a valid result. Retry or contact an administrator.', '归档服务未返回有效结果，请重试或联系管理员。');
    case 'archive_too_many_months': return t('The configured archive contains more than 120 packages.', '配置的归档包含超过 120 个月份包。');
    case 'archive_busy': return t('The archive engine is busy. Retry shortly.', '归档引擎正在处理其他请求，请稍后重试。');
    case 'recall_limit': return t('The full-text recall limit was exceeded. Use more specific keywords or fewer months.', '全文召回超过上限，请使用更具体的关键词或减少月份。');
    case 'invalid_query': return t('Check the Boolean expression. Each OR branch needs a positive indexed term.', '请检查布尔表达式，每个 OR 分支都需要可索引的正向关键词。');
    case 'invalid_time_range': return t('The start time must be earlier than the end time.', '起始时间必须早于结束时间。');
    case 'query_resource_limit': return t('The query exceeded the engine resource budget. Narrow the range.', '查询超过引擎资源预算，请收窄范围。');
    default: return code;
  }
}

function useArchiveStatus(project: string) {
  return useQuery({
    queryKey: ['archive-status', project],
    queryFn: ({ signal }) => liveFetch<Status>(archivePath(project) + '/status', { signal }),
    retry: false,
    gcTime: 0,
  });
}

function useArchiveReferences(project: string) {
  return useQuery({
    queryKey: ['archive-references', project],
    queryFn: ({ signal }) => liveFetch<{ references: ArchiveReference[] }>(archivePath(project), { signal }),
    retry: false,
    gcTime: 0,
  });
}

function ArchiveStatus({ status }: { status: ReturnType<typeof useArchiveStatus> }) {
  const { t } = useI18n();
  if (status.isPending) return <p role="status">{t('Checking archive connection…', '正在检测归档连接…')}</p>;
  const error = status.error ?? (status.data?.state === 'available' ? null : status.data?.state);
  return (
    <div className="archive-actions">
      {error ? <Alert role="status">{message(t, error)}</Alert> : <span role="status">{t('DuckDB connected', 'DuckDB 已连接')}</span>}
      <Button type="button" variant="outline" disabled={status.isFetching} onClick={() => void status.refetch()}>
        {t('Check connection', '检测连接')}
      </Button>
    </div>
  );
}

export function ArchiveChoice({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return <button type="button" className="intake-choice-card" onClick={onClick}>
    <span className="intake-choice-top"><strong>{t('Offline Reddit Archive', '离线 Reddit 归档')}</strong><Archive size={16} aria-hidden="true" /></span>
    <small>{t('Historical data · R4', '本地历史数据 · R4')}</small>
  </button>;
}

function ArchiveFilters({ fields, update }: {
  fields: typeof defaultFields;
  update: (value: typeof defaultFields) => void;
}) {
  const { t } = useI18n();
  return <div className="archive-fields">
    <label className="wb-field">
      {t('Keywords or Boolean query', '关键词或布尔检索')}
      <Input maxLength={256} value={fields.query} placeholder={'DuckDB AND "coding agent"'}
        onChange={event => update({ ...fields, query: event.target.value })} />
    </label>
    <label className="wb-field">
      {t('Subreddits, separated by commas', 'Subreddit（逗号分隔）')}
      <Input maxLength={1024} value={fields.subreddits} onChange={event => update({ ...fields, subreddits: event.target.value })} />
    </label>
    <label className="wb-field">
      {t('From (UTC, inclusive)', '起始时间（UTC，含）')}
      <Input type="datetime-local" value={fields.from} onChange={event => update({ ...fields, from: event.target.value })} />
    </label>
    <label className="wb-field">
      {t('To (UTC, exclusive)', '结束时间（UTC，不含）')}
      <Input type="datetime-local" value={fields.to} onChange={event => update({ ...fields, to: event.target.value })} />
    </label>
  </div>;
}

function PostMeta({ item }: { item: ArchivePost }) {
  const { t } = useI18n();
  return <p className="collection-hint">
    {item.community ? `r/${item.community} · ` : ''}
    <time dateTime={new Date(item.created_utc * 1000).toISOString()}>{new Date(item.created_utc * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC</time>
    {item.score !== null && ` · ${t('Score', '分数')} ${item.score}`}
    {item.reported_comments !== null && ` · ${t('Reported comments', '原帖报告评论')} ${item.reported_comments}`}
  </p>;
}

function ArchiveResults({ page, open }: { page: ArchivePage; open?: (item: ArchivePost) => void }) {
  const { t } = useI18n();
  return <>
    <p role="status">
      {page.totalMatches === null
        ? t(`Showing ${page.sampleSize} posts. Full match count was not calculated.`, `显示 ${page.sampleSize} 条帖子，未计算全量匹配数。`)
        : t(`${page.totalMatches} matching posts`, `${page.totalMatches} 条匹配帖子`)}
      {page.isTruncated && (open ? t(' More results are available.', ' 还有更多结果。') : t(' The preview is limited to five posts.', ' 预览最多显示五条帖子。'))}
    </p>
    {page.posts.length === 0 && <p>{t('No posts match this range.', '此范围内没有匹配帖子。')}</p>}
    <ul className="archive-results">
      {page.posts.map(item => <li key={`${item.month}/${item.doc_id}`}>
        <h3>{item.title || t('Untitled post', '无标题帖子')}</h3>
        <PostMeta item={item} />
        {item.body && <p className="archive-original">{item.body}{item.is_truncated ? '…' : ''}</p>}
        {open && <Button variant="outline" type="button" onClick={() => open(item)}>{t('View post and discussion', '查看原文与讨论串')}</Button>}
      </li>)}
    </ul>
  </>;
}

export function ArchiveIntake({ project, isAdmin, onNavigate }: {
  project: string; isAdmin: boolean; onNavigate: (path: string) => void;
}) {
  const { t } = useI18n();
  const status = useArchiveStatus(project);
  const references = useArchiveReferences(project);
  const client = useQueryClient();
  const route = archivePath(project);
  const [monthSelection, setMonths] = useState<string[] | null>(null);
  const [fields, setFields] = useState(defaultFields);
  const [invalid, setInvalid] = useState('');
  const catalog = status.data?.catalog;
  const source = status.data?.source;
  const months = catalog?.months.map(item => item.month) ?? [];
  const selected = monthSelection === null ? months : monthSelection.filter(month => months.includes(month));
  const preview = useMutation({ mutationFn: (selection: ArchiveSelection) => liveFetch<ArchivePage>(route + '/preview', post(selection)) });
  const link = useMutation({
    mutationFn: (selection: ArchiveSelection) => liveFetch<ArchiveReference>(route, post(selection)),
    onSuccess: () => client.invalidateQueries({ queryKey: ['archive-references', project] }),
  });
  const unlink = useMutation({
    mutationFn: (id: string) => liveFetch(route + '/' + encodeURIComponent(id), { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['archive-references', project] }),
  });
  const busy = preview.isPending || link.isPending || status.isFetching || unlink.isPending;
  const checked = preview.isSuccess && catalog?.version === preview.variables.version;
  function resetPreview() {
    preview.reset();
    link.reset();
    setInvalid('');
  }
  function adminConsolePath() {
    const params = new URLSearchParams({ tab: 'sources', domain: 'research', section: 'technical' });
    if (source) params.set('sourceId', source.id);
    return '/sources?' + params + (source ? '#r4-archive-console' : '');
  }

  return <div className="archive-stack">
    <h2>{t('Offline Reddit Archive', '离线 Reddit 归档')}</h2>
    <ArchiveStatus status={status} />
    {catalog && <form className="archive-stack" onSubmit={event => {
      event.preventDefault();
      resetPreview();
      try {
        const filters = toFilters(fields);
        if (filters.from && filters.to && filters.from >= filters.to) throw new Error('invalid_time_range');
        preview.mutate({ archiveId: catalog.archiveId, version: catalog.version, scope: { ...filters, months: selected } });
      } catch {
        setInvalid('invalid_time_range');
      }
    }}>
      <p className="collection-hint">{source?.label} · {t('Version', '版本')} <code>{catalog.version.slice(0, 12)}</code> · {t('Posts and archived comments', '帖子与已归档评论')}</p>
      <fieldset className="archive-months" disabled={busy}>
        <legend>{t('Archive months (UTC)', '归档月份（UTC）')}</legend>
        <label><input type="checkbox" checked={selected.length === months.length} onChange={event => {
          resetPreview();
          setMonths(event.target.checked ? null : []);
        }} /> {t('All months', '全部月份')}</label>
        {catalog.months.map(item => <label key={item.month}>
          <input type="checkbox" checked={selected.includes(item.month)} onChange={event => {
            resetPreview();
            setMonths(event.target.checked ? [...selected, item.month] : selected.filter(month => month !== item.month));
          }} /> {item.month}
          {item.postsRows !== null && <small>{item.postsRows.toLocaleString()} {t('posts', '条帖子')}</small>}
          {item.commentsRows !== null && <small>{item.commentsRows.toLocaleString()} {t('archived comments', '条已归档评论')}</small>}
        </label>)}
      </fieldset>
      <fieldset className="archive-fields-wrap" disabled={busy}>
        <ArchiveFilters fields={fields} update={value => { resetPreview(); setFields(value); }} />
      </fieldset>
      <div className="archive-actions">
        <Button type="submit" variant="outline" disabled={busy || selected.length === 0}>{preview.isPending ? t('Previewing…', '正在预览…') : t('Preview', '检查与预览')}</Button>
        {checked && <Button type="button" disabled={busy} onClick={() => link.mutate(preview.variables)}>
          {link.isPending ? t('Linking…', '正在关联…') : t('Link to project', '确认关联当前项目')}
        </Button>}
        {link.data && <Button type="button" onClick={() => onNavigate(explorePath(project, link.data.id))}>{t('Open Explore', '进入探索')}</Button>}
      </div>
    </form>}
    {(invalid || preview.error || link.error || unlink.error || references.error) &&
      <Alert role="alert" variant="destructive">{message(t, invalid || preview.error || link.error || unlink.error || references.error)}</Alert>}
    {checked && <ArchiveResults page={preview.data} />}
    <h3>{t('Linked archives', '已关联归档')}</h3>
    {references.isPending && <p role="status">{t('Loading links…', '正在读取归档关联…')}</p>}
    {references.data?.references.length === 0 && <p>{t('This project has no linked archives.', '当前项目尚未关联归档。')}</p>}
    {references.data?.references.map(ref => <div key={ref.id} className="archive-actions">
      <span>{ref.scope.months.join(', ')} · <code>{ref.version.slice(0, 12)}</code>{ref.scope.query && ` · ${ref.scope.query}`}
        {catalog && catalog.version !== ref.version && ` · ${t('Version changed', '归档版本已变更')}`}
      </span>
      <Button type="button" variant="outline" onClick={() => onNavigate(explorePath(project, ref.id))}>{t('Open Explore', '进入探索')}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => {
        if (window.confirm(t('Remove this project’s archive link?', '解除当前项目的归档关联？'))) unlink.mutate(ref.id);
      }}>{t('Unlink', '解除关联')}</Button>
    </div>)}
    {isAdmin && <details>
      <summary>{t('Advanced · Legacy ingest', '高级操作 · 旧版推流')}</summary>
      <p>{t('Use the R4 console to inspect, query, or push selected samples. After a push, attach its receipt batch in Data Batches.', '在 R4 控制台执行检查、查询或精选样本推流。推流完成后，凭收据中的批次 ID 在「数据批次」关联当前批次型项目。')}</p>
      <a href={adminConsolePath()}>{t('Open R4 operations', '打开 R4 运维控制台')}</a>
      {' · '}
      <a href={`/projects?view=batches&projectId=${encodeURIComponent(project)}`}>{t('Data Batches', '数据批次')}</a>
    </details>}
  </div>;
}

function Thread({ thread, onClose }: { thread: ArchiveThread; onClose: () => void }) {
  const { t } = useI18n();
  const postItem = thread.post;
  const focus = useRef<HTMLElement>(null);
  useEffect(() => {
    focus.current?.scrollIntoView({ block: "start" });
    focus.current?.focus({ preventScroll: true });
  }, [postItem.doc_id, postItem.month]);
  const native = /^reddit:post:([a-z0-9]+)$/.exec(postItem.content_key)?.[1];
  return <section ref={focus} tabIndex={-1} className="ds-card archive-thread archive-stack" aria-label={t('Archive evidence', '归档证据')}>
    <Button type="button" variant="outline" onClick={onClose}>{t('Close detail', '关闭详情')}</Button>
    <h2>{postItem.title || t('Untitled post', '无标题帖子')}</h2>
    <PostMeta item={postItem} />
    <p className="collection-hint">{postItem.author_key || t('Unknown author', '作者缺失')}</p>
    {postItem.body && <div className="archive-original">{postItem.body}</div>}
    {postItem.is_truncated && <p>{t('The archived or displayed post text is truncated.', '归档或当前显示的帖子文本有截断。')}</p>}
    {native && <a href={`https://www.reddit.com/comments/${native}/`} target="_blank" rel="noopener noreferrer">{t('Open original on Reddit', '打开 Reddit 原帖')}</a>}
    <h3>{t(`Archived comments (${thread.archivedComments})`, `已归档评论（${thread.archivedComments}）`)}</h3>
    {thread.commentsTruncated && <p>{t(`Showing ${thread.comments.length} of ${thread.archivedComments} archived comments.`, `当前显示 ${thread.comments.length} 条精选归档评论。`)}</p>}
    <ul className="archive-results">
      {thread.comments.map(comment => <li key={comment.comment_id}>
        <strong>{comment.author_key || t('Unknown author', '作者缺失')}</strong>
        <p className="collection-hint">{new Date(comment.created_utc * 1000).toISOString()} · {t('Score', '分数')} {comment.score ?? '—'}</p>
        {comment.parent_key && <p className="collection-hint">{t('Parent', '回复对象')} · {comment.parent_key}</p>}
        <p className="archive-original">{comment.body ?? '—'}{comment.is_truncated && '…'}</p>
      </li>)}
    </ul>
  </section>;
}

export function ArchiveSearchPanel({ reference }: { reference: ArchiveReference }) {
  const { t } = useI18n();
  const route = archivePath(reference.projectId) + '/' + encodeURIComponent(reference.id);
  const [fields, setFields] = useState(defaultFields);
  const [run, setRun] = useState<{ filters: ArchiveSearch['filters']; cursors: (string | undefined)[] }>();
  const [target, setTarget] = useState<ArchiveEvidence>();
  const [invalid, setInvalid] = useState(false);
  const page = useQuery({
    queryKey: ['archive-search', reference.id, run],
    queryFn: ({ signal }) => liveFetch<ArchivePage>(route + '/search', {
      ...post({ filters: run!.filters, cursor: run!.cursors.at(-1) }), signal,
    }),
    enabled: Boolean(run),
    retry: false,
  });
  const detail = useQuery({
    queryKey: ['archive-evidence', reference.id, target],
    queryFn: ({ signal }) => liveFetch<ArchiveThread>(route + '/evidence', { ...post(target!), signal }),
    enabled: Boolean(target),
    retry: false,
    gcTime: 0,
  });
  return <div className="archive-stack">
    <p className="collection-hint">
      {t('Linked range', '已关联范围')} · {reference.scope.months.join(', ')} · {t('Version', '版本')} <code>{reference.version.slice(0, 12)}</code>
      {reference.scope.query && ` · ${reference.scope.query}`}
      {reference.scope.subreddits.length > 0 && ` · ${reference.scope.subreddits.map(sub => 'r/' + sub).join(', ')}`}
      {reference.scope.from && ` · ≥ ${reference.scope.from}`}{reference.scope.to && ` · < ${reference.scope.to}`}
    </p>
    <form className="archive-stack" onSubmit={event => {
      event.preventDefault();
      setTarget(undefined);
      try {
        const filters = toFilters(fields);
        if (filters.from && filters.to && filters.from >= filters.to) throw new Error('invalid_time_range');
        setInvalid(false);
        setRun({ filters, cursors: [undefined] });
        if (run?.cursors.length === 1 && JSON.stringify(run.filters) === JSON.stringify(filters)) void page.refetch();
      } catch {
        setInvalid(true);
      }
    }}>
      <ArchiveFilters fields={fields} update={setFields} />
      <div><Button type="submit" disabled={page.isFetching}>{t('Search archive', '检索归档')}</Button></div>
    </form>
    {run && page.isFetching && <p role="status">{t('Searching archive…', '正在查询归档…')}</p>}
    {invalid && <Alert role="alert" variant="destructive">{message(t, 'invalid_time_range')}</Alert>}
    {page.error && <Alert role="alert" variant="destructive">{message(t, page.error)}</Alert>}
    {run && page.data && <ArchiveResults page={page.data} open={item => setTarget({ filters: run.filters, month: item.month, docId: item.doc_id })} />}
    {run && <nav className="archive-actions" aria-label={t('Archive pages', '归档分页')}>
        <Button type="button" variant="outline" disabled={run.cursors.length < 2 || page.isFetching} onClick={() => {
          setTarget(undefined);
          setRun({ ...run, cursors: run.cursors.slice(0, -1) });
        }}>{t('Previous page', '上一页')}</Button>
        <Button type="button" variant="outline" disabled={!page.data?.nextCursor || page.isFetching} onClick={() => {
          setTarget(undefined);
          setRun({ ...run, cursors: [...run.cursors, page.data!.nextCursor!] });
        }}>{t('Next page', '下一页')}</Button>
      </nav>}
    {target && <div aria-live="polite">
      {detail.isFetching && <p>{t('Loading evidence…', '正在读取证据…')}</p>}
      {detail.error && <Alert role="alert" variant="destructive">{message(t, detail.error)}</Alert>}
      {detail.data && <Thread thread={detail.data} onClose={() => setTarget(undefined)} />}
    </div>}
  </div>;
}

export function ProjectArchiveSearch({ project, refId, onNavigate }: {
  project: string; refId: string | null; onNavigate: (path: string) => void;
}) {
  const { t } = useI18n();
  const status = useArchiveStatus(project);
  const references = useArchiveReferences(project);
  const refs = references.data?.references ?? [];
  const reference = refId ? refs.find(ref => ref.id === refId) : refs[0];
  const linked = reference && reference.version === status.data?.catalog?.version;
  return <div className="archive-stack">
    <ArchiveStatus status={status} />
    {references.isPending && <p role="status">{t('Loading linked archives…', '正在读取归档关联…')}</p>}
    {references.error && <Alert role="alert" variant="destructive">{message(t, references.error)}</Alert>}
    {refs.length > 0 && <label className="wb-field">
      {t('Linked archive', '已关联归档')}
      <Select value={reference?.id ?? ''} onChange={event => onNavigate(explorePath(project, event.target.value))}>
        {!reference && <option value="">{t('Select an archive', '选择归档')}</option>}
        {refs.map(ref => <option key={ref.id} value={ref.id}>
          {ref.scope.months.join(', ')} · {ref.version.slice(0, 12)}{ref.scope.query ? ` · ${ref.scope.query}` : ''}
        </option>)}
      </Select>
    </label>}
    {references.isSuccess && refs.length === 0 && <p>{t('Link an archive in Data Intake to start exploring.', '请先在数据接入关联归档，再开始探索。')}</p>}
    {refId && refs.length > 0 && !reference && <Alert>{t('This archive link is unavailable for the current project.', '当前项目无法访问此归档关联。')}</Alert>}
    {reference && status.data?.catalog && !linked && <Alert>{message(t, 'archive_version_changed')}</Alert>}
    {linked && <ArchiveSearchPanel key={reference.id} reference={reference} />}
  </div>;
}
