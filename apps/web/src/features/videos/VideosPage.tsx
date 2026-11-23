import { Film, Plus, Search, SearchX, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api, useApiInfiniteQuery } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  LoadMore,
  PageHeader,
  Skeleton,
} from '@/ui';
import { StatusFilter } from './components/StatusFilter';
import { useVideoActions } from './components/useVideoActions';
import { VideoCard } from './components/VideoCard';
import {
  EMPTY_FILTERS,
  MAX_QUERY_LENGTH,
  filtersToParams,
  filtersToQuery,
  hasActiveFilters,
  parseFilters,
} from './lib/filters';
import type { VideoFilters } from './lib/filters';
import { ROUTES, useAvailableRoutes } from './lib/routes';
import { isVideoActive } from './lib/video';

const GRID = 'grid gap-5 grid-cols-[repeat(auto-fill,minmax(min(100%,17.5rem),1fr))]';
const POLL_MS = 2500;
const SEARCH_DEBOUNCE_MS = 300;

function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <Skeleton className="aspect-video h-auto rounded-none" />
      <div className="flex flex-col gap-2 p-3.5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

/** Video library: search, status filter, cursor pagination and live render progress. */
export default function VideosPage() {
  const { t } = useTranslation('videos');
  const session = useSession();
  const available = useAvailableRoutes();
  const canEdit = session.can('editor');

  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const filtered = hasActiveFilters(filters);

  const applyFilters = (next: VideoFilters) =>
    setParams(filtersToParams(next), { replace: true, preventScrollReset: true });

  // The search box writes to the URL after a short pause; the URL (back button, links) wins.
  const [search, setSearch] = useState(filters.q);
  const latestFilters = useRef(filters);
  latestFilters.current = filters;
  useEffect(() => {
    setSearch((current) => (current.trim() === filters.q ? current : filters.q));
  }, [filters.q]);
  useEffect(() => {
    const q = search.trim();
    if (q === latestFilters.current.q) return;
    const id = window.setTimeout(
      () =>
        setParams(filtersToParams({ ...latestFilters.current, q }), {
          replace: true,
          preventScrollReset: true,
        }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(id);
  }, [search, setParams]);

  // Poll while something on screen is queued or rendering, so progress moves by itself.
  const [poll, setPoll] = useState(false);
  const list = useApiInfiniteQuery(
    api.videos.list,
    { query: filtersToQuery(filters) },
    { refetchInterval: poll ? POLL_MS : false },
  );
  const anyActive = list.items.some(isVideoActive);
  const wasActive = useRef(false);
  const { refresh } = session;
  useEffect(() => {
    // A render just settled: its credits were settled or refunded too.
    if (wasActive.current && !anyActive) void refresh();
    wasActive.current = anyActive;
    setPoll(anyActive);
  }, [anyActive, refresh]);

  const actions = useVideoActions();

  const createButton = canEdit ? (
    <Button asChild variant="primary" leftIcon={<Plus aria-hidden="true" />}>
      <Link to={ROUTES.newVideo}>{t('list.create')}</Link>
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        eyebrow={session.workspace.name}
        title={t('list.title')}
        description={t('list.description')}
        actions={createButton}
      >
        <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <StatusFilter
            value={filters.status}
            onChange={(status) => applyFilters({ ...filters, q: search.trim(), status })}
          />
          <form
            role="search"
            className="w-full lg:max-w-xs"
            onSubmit={(event) => {
              event.preventDefault();
              applyFilters({ ...filters, q: search.trim() });
            }}
          >
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              maxLength={MAX_QUERY_LENGTH}
              aria-label={t('filters.search')}
              placeholder={t('filters.searchPlaceholder')}
              leading={<Search aria-hidden="true" />}
              trailing={
                search !== '' ? (
                  <IconButton
                    label={t('filters.clearSearch')}
                    size="sm"
                    noTooltip
                    onClick={() => {
                      setSearch('');
                      applyFilters({ ...filters, q: '' });
                    }}
                  >
                    <X aria-hidden="true" />
                  </IconButton>
                ) : undefined
              }
              className="[&::-webkit-search-cancel-button]:hidden"
            />
          </form>
        </div>
        {filters.batchJobId && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="info">{t('filters.batch', { id: filters.batchJobId })}</Badge>
            <Button variant="link" onClick={() => applyFilters({ ...filters, batchJobId: null })}>
              {t('filters.batchClear')}
            </Button>
          </div>
        )}
      </PageHeader>

      <section aria-label={t('list.results')} aria-busy={list.isPending}>
        {list.isPending ? (
          <div className={GRID}>
            {Array.from({ length: 8 }, (_, index) => (
              <CardSkeleton key={index} />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState
            error={list.error}
            onRetry={() => void list.refetch()}
            retrying={list.isRefetching}
          />
        ) : list.items.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={<SearchX />}
              title={t('list.noResultsTitle')}
              description={t('list.noResultsText')}
              action={
                <Button
                  onClick={() => {
                    setSearch('');
                    applyFilters(EMPTY_FILTERS);
                  }}
                >
                  {t('filters.reset')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Film />}
              title={t('list.emptyTitle')}
              description={canEdit ? t('list.emptyText') : t('list.emptyTextViewer')}
              action={createButton}
            />
          )
        ) : (
          <>
            <ul className={GRID}>
              {list.items.map((video) => (
                <li key={video.id} className="flex min-w-0">
                  <VideoCard
                    video={video}
                    actions={actions}
                    canEdit={canEdit}
                    studioAvailable={available.studio}
                    className="w-full"
                  />
                </li>
              ))}
            </ul>
            <LoadMore
              hasMore={list.hasNextPage}
              loading={list.isFetchingNextPage}
              onLoadMore={() => void list.fetchNextPage()}
              label={t('list.loadMore')}
              endLabel={list.items.length > 8 ? t('list.end') : undefined}
              className="mt-6"
            />
          </>
        )}
      </section>

      {actions.dialogs}
    </>
  );
}
