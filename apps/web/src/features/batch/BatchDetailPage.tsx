import type { BatchItem, BatchJobDetail } from '@parlante/shared';
import { Ban, Download, ExternalLink, Film, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { JobStatus, JobStatusBadge } from '@/components/JobStatus';
import { api, toAppUrl, useApiMutation } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useJobPolling } from '@/lib/jobs';
import { useSession } from '@/lib/session';
import {
  Button,
  ErrorState,
  PageHeader,
  Skeleton,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  toast,
  useConfirm,
  useErrorText,
} from '@/ui';
import { TOOL_ROUTES, useAvailableRoutes, useStoredErrorText } from '@/features/script-writer/kit';
import { countItems, isBatchActive } from './lib/batch';

function ItemRow({
  item,
  variables,
  videoLink,
}: {
  item: BatchItem;
  variables: readonly string[];
  videoLink: boolean;
}) {
  const { t } = useTranslation('batch');
  const describe = useStoredErrorText();
  const error = item.error ? describe(item.error) : null;
  return (
    <Tr data-row={item.index + 1} data-status={item.status}>
      <Td className="nums font-mono text-xs text-fg-muted">{item.index + 1}</Td>
      <Td>
        <span className="relative flex h-10 w-16 items-center justify-center overflow-hidden rounded-md bg-media text-on-media">
          {item.thumbnailUrl ? (
            <img
              src={toAppUrl(item.thumbnailUrl)}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <Film aria-hidden="true" className="size-4 opacity-60" />
          )}
        </span>
      </Td>
      {variables.map((name) => (
        <Td key={name} className="max-w-48 truncate">
          {item.values[name] ?? <span className="text-fg-subtle">—</span>}
        </Td>
      ))}
      <Td>
        <JobStatusBadge
          status={item.status}
          size="sm"
          labels={{ queued: t(`item.status.${item.status === 'pending' ? 'pending' : 'queued'}`) }}
        />
        {error && (
          <p role="alert" className="mt-1 max-w-64 text-xs break-words text-danger-text">
            {error.title}
            {error.detail ? `: ${error.detail}` : ''}
          </p>
        )}
      </Td>
      <Td>
        <div className="flex items-center justify-end gap-1">
          {item.videoId && videoLink && (
            <Button
              asChild
              size="sm"
              variant="ghost"
              leftIcon={<ExternalLink aria-hidden="true" />}
            >
              <Link to={TOOL_ROUTES.video(item.videoId)}>
                {t('item.open')}
                <span className="sr-only"> {t('item.row', { number: item.index + 1 })}</span>
              </Link>
            </Button>
          )}
          {item.videoUrl && (
            <Button asChild size="sm" variant="ghost" leftIcon={<Download aria-hidden="true" />}>
              <a href={toAppUrl(item.downloadUrl ?? item.videoUrl)} download>
                MP4
                <span className="sr-only"> {t('item.row', { number: item.index + 1 })}</span>
              </a>
            </Button>
          )}
        </div>
      </Td>
    </Tr>
  );
}

/**
 * A batch (master prompt §3.15): overall progress, counters, and one row per video with its
 * values, state, link and download. Running batches are polled; pending rows can be cancelled.
 */
export default function BatchDetailPage() {
  const { t } = useTranslation('batch');
  const { batchId = '' } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const format = useFormat();
  const confirm = useConfirm();
  const describe = useErrorText();
  const describeStored = useStoredErrorText();
  const available = useAvailableRoutes();

  const polled = useJobPolling(
    api.batches.get,
    { params: { batchId } },
    {
      enabled: batchId !== '',
      intervalMs: 2500,
      select: (data) => ({ status: data.status, progress: data.progress }),
      onSettled: (data, phase) => {
        // Every finished render was charged on its own: the balance has moved.
        void session.refresh();
        if (phase === 'completed') toast.success(t('detail.done', { name: data.name }));
        else if (phase === 'partial') toast.warning(t('detail.partial', { name: data.name }));
        else if (phase === 'failed') toast.error(t('detail.failed', { name: data.name }));
      },
    },
  );
  const job: BatchJobDetail | undefined = polled.data;

  const cancel = useApiMutation(api.batches.cancel, {
    invalidates: [api.batches.get, api.batches.list],
    onSuccess: () => toast.success(t('detail.canceled')),
    onError: (error) =>
      toast.error(t('detail.cancelFailed'), { description: describe(error).title }),
  });
  const remove = useApiMutation(api.batches.remove, {
    invalidates: [api.batches.list],
    onSuccess: () => {
      toast.success(t('detail.deleted'));
      void navigate(TOOL_ROUTES.batch);
    },
    onError: (error) =>
      toast.error(t('detail.deleteFailed'), { description: describe(error).title }),
  });

  if (polled.isLoading || (!job && !polled.error)) {
    return (
      <>
        <PageHeader
          back={{ to: TOOL_ROUTES.batch, label: t('list.title') }}
          title={<Skeleton className="h-9 w-64" />}
        />
        <Skeleton className="h-28" />
        <Skeleton className="mt-4 h-72" />
      </>
    );
  }
  if (!job) {
    return (
      <>
        <PageHeader
          back={{ to: TOOL_ROUTES.batch, label: t('list.title') }}
          title={t('detail.missing')}
        />
        <ErrorState error={polled.error} onRetry={polled.refetch} />
      </>
    );
  }

  const active = isBatchActive(job);
  const counts = countItems(job.items);
  const waiting = counts.pending + counts.queued + counts.rendering;
  const jobError = job.error ? describeStored(job.error) : null;
  const canWrite = session.can('editor');

  const askCancel = async () => {
    const ok = await confirm({
      title: t('detail.cancelTitle'),
      description: t('detail.cancelText'),
      confirmLabel: t('detail.cancel'),
      tone: 'danger',
    });
    if (ok) cancel.mutate({ params: { batchId: job.id } });
  };
  const askDelete = async () => {
    const ok = await confirm({
      title: t('detail.deleteTitle'),
      description: t('detail.deleteText'),
      confirmLabel: t('detail.delete'),
      tone: 'danger',
    });
    if (ok) remove.mutate({ params: { batchId: job.id } });
  };

  return (
    <>
      <PageHeader
        back={{ to: TOOL_ROUTES.batch, label: t('list.title') }}
        eyebrow={t('detail.eyebrow')}
        title={job.name}
        description={t('detail.description', {
          count: job.total,
          resolution: job.resolution,
          when: format.relative(job.createdAt),
        })}
        actions={
          <>
            {available.videos && (
              <Button asChild variant="secondary" leftIcon={<Film aria-hidden="true" />}>
                <Link to={TOOL_ROUTES.videosOfBatch(job.id)}>{t('detail.videos')}</Link>
              </Button>
            )}
            {canWrite && active && (
              <Button
                variant="secondary"
                leftIcon={<Ban aria-hidden="true" />}
                loading={cancel.isPending}
                onClick={() => void askCancel()}
              >
                {t('detail.cancel')}
              </Button>
            )}
            {canWrite && !active && (
              <Button
                variant="secondary"
                leftIcon={<Trash2 aria-hidden="true" />}
                loading={remove.isPending}
                onClick={() => void askDelete()}
              >
                {t('detail.delete')}
              </Button>
            )}
          </>
        }
      />

      <section
        aria-label={t('detail.progress')}
        className="rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5"
      >
        <JobStatus
          label={t('detail.progressLabel', { name: job.name })}
          status={polled.phase}
          progress={polled.progress}
          etaSec={polled.etaSec}
          etaEstimated={polled.etaEstimated}
          stage={
            active
              ? t('detail.stage', { done: job.completed + job.failed, total: job.total })
              : undefined
          }
          error={
            jobError ? [jobError.title, jobError.detail].filter(Boolean).join('. ') : undefined
          }
        />
        <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
          <div>
            <dt className="eyebrow text-fg-subtle">{t('detail.stats.completed')}</dt>
            <dd className="display nums mt-1 text-3xl">
              {job.completed}
              <span className="text-lg text-fg-subtle"> / {job.total}</span>
            </dd>
          </div>
          <div>
            <dt className="eyebrow text-fg-subtle">{t('detail.stats.waiting')}</dt>
            <dd className="display nums mt-1 text-3xl">{waiting}</dd>
          </div>
          <div>
            <dt className="eyebrow text-fg-subtle">{t('detail.stats.failed')}</dt>
            <dd
              className={`display nums mt-1 text-3xl ${job.failed > 0 ? 'text-danger-text' : ''}`}
            >
              {job.failed}
            </dd>
          </div>
          <div>
            <dt className="eyebrow text-fg-subtle">{t('detail.stats.credits')}</dt>
            <dd className="display nums mt-1 text-3xl">{format.number(job.creditsCharged)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-fg-muted">{t('detail.creditsNote')}</p>
      </section>

      <section aria-labelledby="batch-items" className="mt-6 min-w-0">
        <h2 id="batch-items" className="mb-3 text-lg">
          {t('detail.items')}
        </h2>
        <Table dense aria-labelledby="batch-items">
          <THead>
            <Tr>
              <Th className="w-12">{t('rows.number')}</Th>
              <Th className="w-20">{t('item.video')}</Th>
              {job.variables.map((name) => (
                <Th key={name}>{name}</Th>
              ))}
              <Th>{t('rows.state')}</Th>
              <Th>
                <span className="sr-only">{t('item.actions')}</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {job.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                variables={job.variables}
                videoLink={available.video}
              />
            ))}
          </TBody>
        </Table>
      </section>
    </>
  );
}
