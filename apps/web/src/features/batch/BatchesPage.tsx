import type { BatchJob } from '@parlante/shared';
import { Plus, Rows3 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { JobStatusBadge } from '@/components/JobStatus';
import { api, useApiInfiniteQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button, EmptyState, ErrorState, LoadMore, PageHeader, ProgressBar, Skeleton } from '@/ui';
import { TOOL_ROUTES } from '@/features/script-writer/kit';
import { EXAMPLE_VARIABLE, isBatchActive } from './lib/batch';

function BatchRow({ job }: { job: BatchJob }) {
  const { t } = useTranslation('batch');
  const format = useFormat();
  const active = isBatchActive(job);
  return (
    <li className="min-w-0">
      <Link
        to={TOOL_ROUTES.batchJob(job.id)}
        className="grid min-w-0 gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs transition-colors hover:bg-surface-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5"
      >
        <div className="min-w-0">
          <h2 className="truncate text-lg">{job.name}</h2>
          <p className="nums mt-1 text-sm text-fg-muted">
            {t('list.summary', { done: job.completed, total: job.total })}
            {job.failed > 0 && <> · {t('list.failed', { count: job.failed })}</>}
            {' · '}
            {job.resolution}
          </p>
          <p className="nums mt-2 text-xs text-fg-subtle">
            {format.relative(job.createdAt)} · {t('list.credits', { count: job.creditsCharged })}
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:w-52 sm:items-end">
          <JobStatusBadge status={job.status} />
          {active && (
            <ProgressBar
              label={t('detail.progressLabel', { name: job.name })}
              value={job.status === 'queued' ? null : job.progress}
              className="w-full"
            />
          )}
        </div>
      </Link>
    </li>
  );
}

/** Batches of the workspace, newest first, live while any of them is running. */
export default function BatchesPage() {
  const { t } = useTranslation('batch');
  const session = useSession();
  const canWrite = session.can('editor');
  // Keep the list moving while something is in progress.
  const [live, setLive] = useState(false);
  const jobs = useApiInfiniteQuery(
    api.batches.list,
    { query: { limit: 12 } },
    { refetchInterval: live ? 3000 : false },
  );
  const anyActive = jobs.items.some(isBatchActive);
  useEffect(() => setLive(anyActive), [anyActive]);

  const create = canWrite ? (
    <Button asChild variant="primary" leftIcon={<Plus aria-hidden="true" />}>
      <Link to={TOOL_ROUTES.batchNew}>{t('list.create')}</Link>
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        eyebrow={t('list.eyebrow')}
        title={t('list.title')}
        description={t('list.description', { example: EXAMPLE_VARIABLE })}
        actions={create}
      />
      {jobs.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : jobs.isError ? (
        <ErrorState
          error={jobs.error}
          onRetry={() => void jobs.refetch()}
          retrying={jobs.isRefetching}
        />
      ) : jobs.items.length === 0 ? (
        <EmptyState
          icon={<Rows3 aria-hidden="true" />}
          title={t('list.emptyTitle')}
          description={
            canWrite ? t('list.emptyText', { example: EXAMPLE_VARIABLE }) : t('list.emptyViewer')
          }
          action={create}
        />
      ) : (
        <ul className="flex min-w-0 flex-col gap-3">
          {jobs.items.map((job) => (
            <BatchRow key={job.id} job={job} />
          ))}
        </ul>
      )}
      <LoadMore
        hasMore={jobs.hasNextPage}
        loading={jobs.isFetchingNextPage}
        onLoadMore={() => void jobs.fetchNextPage()}
      />
    </>
  );
}
