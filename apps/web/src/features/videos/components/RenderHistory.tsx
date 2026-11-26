import type { RenderJob } from '@parlante/shared';
import { useTranslation } from 'react-i18next';
import { JobStatusBadge } from '@/components/JobStatus';
import { api, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle, ErrorState, Skeleton } from '@/ui';
import { useStoredErrorText } from '../lib/useStoredErrorText';

function renderSeconds(job: RenderJob): number | null {
  if (!job.startedAt || !job.finishedAt) return null;
  const ms = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime();
  return ms >= 0 ? ms : null;
}

/** Every render of the video, newest first: when, at what resolution, what it cost. */
export function RenderHistory({ videoId, polling }: { videoId: string; polling: boolean }) {
  const { t } = useTranslation('videos');
  const format = useFormat();
  const describeError = useStoredErrorText();
  const jobs = useApiQuery(
    api.videos.renderJobs,
    { params: { videoId } },
    { refetchInterval: polling ? 4000 : false },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('history.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {jobs.isPending ? (
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : jobs.isError ? (
          <ErrorState
            size="sm"
            error={jobs.error}
            onRetry={() => void jobs.refetch()}
            retrying={jobs.isRefetching}
          />
        ) : jobs.data.items.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('history.empty')}</p>
        ) : (
          <ul className="flex flex-col">
            {jobs.data.items.map((job) => {
              const took = renderSeconds(job);
              return (
                <li
                  key={job.id}
                  className="flex flex-col gap-1 border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <JobStatusBadge
                      status={job.status}
                      size="sm"
                      labels={{ running: t('status.rendering') }}
                    />
                    <span className="nums text-sm font-medium">{job.resolution}</span>
                    <span className="text-sm text-fg-muted">{format.dateTime(job.createdAt)}</span>
                    <span className="nums ml-auto text-sm text-fg-muted">
                      {t('history.credits', { count: job.creditsCharged })}
                    </span>
                  </div>
                  {took !== null && job.status === 'completed' && (
                    <p className="text-xs text-fg-subtle">
                      {t('history.took', {
                        time: format.duration(Math.max(1000, Math.round(took / 1000) * 1000)),
                      })}
                    </p>
                  )}
                  {job.status === 'failed' && job.error && (
                    <p className="text-xs break-words text-danger-text">
                      {describeError(job.error).title}
                      {describeError(job.error).detail
                        ? ` — ${describeError(job.error).detail}`
                        : ''}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
