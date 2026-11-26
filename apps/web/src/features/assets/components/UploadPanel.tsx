import { CircleAlert, CircleCheck, RotateCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/lib/format';
import { Button, IconButton, ProgressBar, Spinner, cn, useErrorText } from '@/ui';
import { ApiError } from '@/lib/api';
import type { ApiErrorCode } from '@/lib/api';
import { isFinished } from '../lib/uploadQueue';
import type { UploadItem } from '../lib/uploadQueue';
import type { UploadQueue } from '../lib/useUploadQueue';
import { KIND_ICON } from './AssetThumb';

function UploadRow({
  item,
  queue,
  maxUploadBytes,
}: {
  item: UploadItem;
  queue: UploadQueue;
  maxUploadBytes: number;
}) {
  const { t } = useTranslation('assets');
  const format = useFormat();
  const errorText = useErrorText();
  const Icon = item.kind ? KIND_ICON[item.kind] : CircleAlert;
  const percent = Math.round(item.progress * 100);
  const processing = item.status === 'uploading' && item.progress >= 1;
  const bad = item.status === 'error' || item.status === 'rejected';

  let detail: string;
  if (item.status === 'rejected') {
    detail = t(`upload.rejected.${item.rejection ?? 'type'}`, {
      max: format.bytes(maxUploadBytes),
    });
  } else if (item.status === 'error') {
    const known = errorText(
      new ApiError((item.error?.code ?? 'INTERNAL') as ApiErrorCode, item.error?.message ?? ''),
    );
    detail = known.message ? `${known.title}. ${known.message}` : known.title;
  } else if (item.status === 'done') {
    detail = t('upload.status.done');
  } else if (item.status === 'canceled') {
    detail = t('upload.status.canceled');
  } else if (item.status === 'queued') {
    detail = t('upload.status.queued');
  } else if (processing) {
    detail = t('upload.status.processing');
  } else {
    detail = t('upload.status.uploading', {
      sent: format.bytes(item.sizeBytes * item.progress),
      total: format.bytes(item.sizeBytes),
    });
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-md',
          bad
            ? 'bg-danger-soft text-danger-text'
            : item.status === 'done'
              ? 'bg-success-soft text-success-text'
              : 'bg-surface-3 text-fg-muted',
        )}
      >
        {item.status === 'done' ? <CircleCheck className="size-4" /> : <Icon className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-sm font-medium">{item.fileName}</p>
          <span className="nums shrink-0 text-xs text-fg-muted">
            {format.bytes(item.sizeBytes)}
          </span>
        </div>
        {item.status === 'uploading' ? (
          <ProgressBar
            className="mt-1.5"
            size="sm"
            value={processing ? null : percent}
            label={t('upload.progressOf', { name: item.fileName })}
            valueText={detail}
          />
        ) : null}
        <p
          className={cn('mt-1 text-xs', bad ? 'font-medium text-danger-text' : 'text-fg-muted')}
          role={bad ? 'alert' : undefined}
        >
          {detail}
        </p>
      </div>
      <div className="flex shrink-0 items-center">
        {processing && <Spinner size="sm" label={null} />}
        {(item.status === 'error' || item.status === 'canceled') && (
          <IconButton
            size="sm"
            label={t('upload.retry', { name: item.fileName })}
            onClick={() => queue.retry(item.id)}
          >
            <RotateCw aria-hidden="true" />
          </IconButton>
        )}
        {isFinished(item.status) ? (
          <IconButton
            size="sm"
            label={t('upload.dismiss', { name: item.fileName })}
            onClick={() => queue.dismiss(item.id)}
          >
            <X aria-hidden="true" />
          </IconButton>
        ) : (
          <IconButton
            size="sm"
            label={t('upload.cancel', { name: item.fileName })}
            onClick={() => queue.cancel(item.id)}
          >
            <X aria-hidden="true" />
          </IconButton>
        )}
      </div>
    </li>
  );
}

/** The upload queue: one row per file with progress, the reason of each failure and actions. */
export function UploadPanel({
  queue,
  maxUploadBytes,
  className,
}: {
  queue: UploadQueue;
  maxUploadBytes: number;
  className?: string;
}) {
  const { t } = useTranslation('assets');
  const { items, summary } = queue;
  if (items.length === 0) return null;
  const finished = items.some((item) => isFinished(item.status));
  const bad = summary.failed + summary.rejected;
  return (
    <section
      aria-label={t('upload.title')}
      className={cn(
        'overflow-hidden rounded-lg border border-line bg-surface shadow-xs',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line bg-surface-2 px-4 py-2.5">
        <p className="text-sm font-semibold" role="status">
          {summary.active > 0
            ? t('upload.summary.active', { count: summary.active, percent: summary.percent })
            : [
                t('upload.summary.finished', { count: summary.done }),
                bad > 0 ? t('upload.summary.failed', { count: bad }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
        </p>
        {finished && (
          <Button size="sm" variant="ghost" onClick={queue.clearFinished}>
            {t('upload.clear')}
          </Button>
        )}
      </div>
      <ul className="max-h-[25rem] divide-y divide-line overflow-y-auto">
        {items.map((item) => (
          <UploadRow key={item.id} item={item} queue={queue} maxUploadBytes={maxUploadBytes} />
        ))}
      </ul>
    </section>
  );
}
