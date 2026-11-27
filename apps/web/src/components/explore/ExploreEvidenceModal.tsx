import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileText, X } from 'lucide-react';
import type { ExploreEvidenceItem, ExploreEvidenceResponse } from '../../../../../packages/contracts/src/explore';
import { liveFetch } from '@/api/client';
import { useI18n } from '@/i18n/translations';
import { safeHttpUrl } from '@/lib/sourceLabels';
import { Alert } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';

/** Slice text by Unicode code points (matches Python str indexing so Emoji offsets never drift). */
function renderHighlightedFocus(focus: string, claim?: Record<string, unknown>) {
  const start = typeof claim?.start === 'number' ? claim.start : null;
  const end = typeof claim?.end === 'number' ? claim.end : null;
  if (start === null || end === null || start < 0 || end <= start) {
    return <span>{focus.slice(0, 480)}{focus.length > 480 ? '…' : ''}</span>;
  }
  const chars = Array.from(focus);
  const safeStart = Math.min(start, chars.length);
  const safeEnd = Math.min(end, chars.length);
  const before = chars.slice(Math.max(0, safeStart - 120), safeStart).join('');
  const hit = chars.slice(safeStart, safeEnd).join('');
  const after = chars.slice(safeEnd, Math.min(chars.length, safeEnd + 160)).join('');
  return (
    <span>
      {safeStart > 120 ? '…' : ''}
      {before}
      <mark className="rounded bg-amber-200/80 px-0.5 text-foreground">{hit}</mark>
      {after}
      {safeEnd + 160 < chars.length ? '…' : ''}
    </span>
  );
}

function EvidenceCard({ item }: { item: ExploreEvidenceItem }) {
  const { t } = useI18n();
  const safeUrl = safeHttpUrl(item.url);
  const displayFocus = item.focus || item.text || '';
  const channelEntries = Object.entries(item.engagement_channels ?? {});

  return (
    <article className="space-y-2 rounded-lg border border-border/80 bg-card p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-[10px]">
            {item.source_type}
          </Badge>
          {item.group && (
            <Badge variant="secondary" className="text-[10px]">
              {item.group}
            </Badge>
          )}
          {item.kind && (
            <span className="text-[10.5px] text-muted-foreground">{item.kind}</span>
          )}
        </div>
        <span className="font-mono text-[10.5px] text-muted-foreground">
          {item.created_utc
            ? new Date(item.created_utc * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
            : item.day || '—'}
        </span>
      </div>

      {item.title && <h4 className="m-0 text-xs font-semibold text-foreground">{item.title}</h4>}

      <p className="m-0 whitespace-pre-wrap break-words leading-relaxed text-foreground/90">
        {renderHighlightedFocus(displayFocus, item.claim)}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          {item.author_key && <span>@{item.author_key}</span>}
          {channelEntries.map(([ch, val]) => (
            <span key={ch} className="font-mono">
              {ch}: {val.toLocaleString()}
            </span>
          ))}
        </div>
        {safeUrl && (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <span>{t('Open source', '打开原文')}</span>
            <ExternalLink size={11} />
          </a>
        )}
      </div>
    </article>
  );
}

export function ExploreEvidenceModal({
  studyId,
  evidenceId,
  title,
  onClose,
}: {
  studyId: string;
  evidenceId: string;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [offset, setOffset] = useState(0);
  const limit = 15;

  const query = useQuery({
    queryKey: ['explore-evidence', studyId, evidenceId, offset],
    queryFn: ({ signal }) =>
      liveFetch<ExploreEvidenceResponse>('/explore/evidence', {
        method: 'POST',
        body: JSON.stringify({ studyId, evidenceId, offset, limit }),
        signal,
      }),
    retry: false,
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('Evidence inspection', '证据原文回查')}
      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-[1px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="flex h-full w-full max-w-2xl flex-col border-l border-border bg-background shadow-xl">
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FileText size={15} className="text-primary" />
              <h2 className="m-0 truncate text-sm font-semibold text-foreground">{title}</h2>
            </div>
            {query.data && (
              <p className="m-0 mt-0.5 text-[11px] text-muted-foreground">
                {t(
                  `Showing ${offset + 1}–${offset + query.data.items.length} of ${query.data.total} matched evidence records`,
                  `当前显示第 ${offset + 1}–${offset + query.data.items.length} 条，共 ${query.data.total} 条精确命中证据`,
                )}
              </p>
            )}
          </div>
          <Button type="button" variant="ghost" size="xs" onClick={onClose} aria-label={t('Close', '关闭')}>
            <X size={15} />
          </Button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {query.isPending && (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-24 w-full rounded-lg" />
            </div>
          )}
          {query.error && (
            <Alert variant="destructive">
              {query.error instanceof Error ? query.error.message : String(query.error)}
            </Alert>
          )}
          {query.data && query.data.items.length === 0 && (
            <p className="py-8 text-center text-xs text-muted-foreground">
              {query.data.reason || t('No evidence records available for this selection.', '该维度下暂无可展开的原文证据。')}
            </p>
          )}
          {query.data?.items.map((item) => (
            <EvidenceCard key={`${item.document_id}:${item.source_id}`} item={item} />
          ))}
        </div>

        {query.data && query.data.total > limit && (
          <footer className="flex items-center justify-between border-t border-border px-5 py-3 text-xs">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={offset === 0 || query.isFetching}
              onClick={() => setOffset((prev) => Math.max(0, prev - limit))}
            >
              {t('Previous', '上一页')}
            </Button>
            <span className="tabular-nums text-muted-foreground">
              {Math.floor(offset / limit) + 1} / {Math.max(1, Math.ceil(query.data.total / limit))}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!query.data.has_more || query.isFetching}
              onClick={() => setOffset((prev) => prev + limit)}
            >
              {t('Next', '下一页')}
            </Button>
          </footer>
        )}
      </aside>
    </div>
  );
}
