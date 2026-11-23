import type { TranslationJob } from '@parlante/shared';
import { ArrowRight, Languages, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { JobStatusBadge } from '@/components/JobStatus';
import { api, useApiInfiniteQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button, EmptyState, ErrorState, LoadMore, PageHeader, ProgressBar, Skeleton } from '@/ui';
import { TOOL_ROUTES, languageShortName, useUiLocale } from '@/features/script-writer/kit';
import { countByStatus, isActive, languageResults } from './lib/translate';

function JobRow({ job }: { job: TranslationJob }) {
  const { t } = useTranslation('translate');
  const format = useFormat();
  const locale = useUiLocale();
  const counts = countByStatus(languageResults(job));
  const active = isActive(job);
  return (
    <li className="min-w-0">
      <Link
        to={TOOL_ROUTES.translation(job.id)}
        className="grid min-w-0 gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs transition-colors hover:bg-surface-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5"
      >
        <div className="min-w-0">
          <h2 className="truncate text-lg">{job.name}</h2>
          <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
            <span className="rounded-md bg-surface-3 px-2 py-0.5 font-mono text-xs font-medium text-fg uppercase">
              {job.sourceLanguage}
            </span>
            <ArrowRight aria-hidden="true" className="size-4 shrink-0" />
            <span className="sr-only">{t('detail.to')}</span>
            {job.targetLanguages.map((code) => (
              <span
                key={code}
                title={languageShortName(code, locale)}
                className="rounded-md bg-accent-soft px-2 py-0.5 font-mono text-xs font-medium text-accent-text uppercase"
              >
                {code}
              </span>
            ))}
          </p>
          <p className="nums mt-2 text-xs text-fg-subtle">
            {format.relative(job.createdAt)}
            {job.sourceDurationMs ? ` · ${format.duration(job.sourceDurationMs)}` : ''}
            {' · '}
            {t('list.credits', { count: job.creditsCharged })}
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:w-52 sm:items-end">
          <JobStatusBadge status={job.status} />
          {active ? (
            <ProgressBar
              label={t('detail.progressLabel', { name: job.name })}
              value={job.status === 'queued' ? null : job.progress}
              className="w-full"
            />
          ) : (
            <p className="nums text-xs text-fg-muted">
              {t('detail.counts', { done: counts.completed, total: job.targetLanguages.length })}
            </p>
          )}
        </div>
      </Link>
    </li>
  );
}

/** Translation jobs of the workspace, newest first, live while any of them is running. */
export default function TranslationsPage() {
  const { t } = useTranslation('translate');
  const session = useSession();
  const canWrite = session.can('editor');
  // Keep the list moving while something is in progress.
  const [live, setLive] = useState(false);
  const jobs = useApiInfiniteQuery(
    api.translations.list,
    { query: { limit: 12 } },
    { refetchInterval: live ? 3000 : false },
  );
  const anyActive = jobs.items.some(isActive);
  useEffect(() => setLive(anyActive), [anyActive]);

  const create = canWrite ? (
    <Button asChild variant="primary" leftIcon={<Plus aria-hidden="true" />}>
      <Link to={TOOL_ROUTES.translateNew}>{t('list.create')}</Link>
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        eyebrow={t('list.eyebrow')}
        title={t('list.title')}
        description={t('list.description')}
        actions={create}
      />
      {jobs.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : jobs.isError ? (
        <ErrorState
          error={jobs.error}
          onRetry={() => void jobs.refetch()}
          retrying={jobs.isRefetching}
        />
      ) : jobs.items.length === 0 ? (
        <EmptyState
          icon={<Languages aria-hidden="true" />}
          title={t('list.emptyTitle')}
          description={canWrite ? t('list.emptyText') : t('list.emptyViewer')}
          action={create}
        />
      ) : (
        <ul className="flex min-w-0 flex-col gap-3">
          {jobs.items.map((job) => (
            <JobRow key={job.id} job={job} />
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
