import type { Avatar } from '@parlante/shared';
import { CircleCheck, Clapperboard, Plus, Trash2, TriangleAlert, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { JobStatus } from '@/components/JobStatus';
import { ProviderBadge } from '@/components/ProviderBadge';
import { api, useApiMutation, useInvalidateApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useJobPolling } from '@/lib/jobs';
import { useSession } from '@/lib/session';
import { Button, ErrorState, Skeleton, VoiceBars, cn, toast, useErrorText } from '@/ui';
import {
  AvatarStage,
  Callout,
  LIB_ROUTES,
  QualityNote,
  portraitSeconds,
  useFailureReason,
  useStartVideo,
} from '@/features/avatars/kit';
import type { EngineStatus } from '@/features/avatars/kit';

export interface AvatarJobProps {
  avatarId: string;
  engine: EngineStatus | null;
  /** Back to the form (create another / try again). */
  onAnother: () => void;
}

/**
 * Follows the preparation of one avatar: progress and time remaining are the figures the
 * photo-avatar job persists (measured by the engine); when the server has no estimate yet
 * the client extrapolates from the observed rate and says so. Ends in the result or in the
 * stored failure reason.
 */
export function AvatarJob({ avatarId, engine, onAnother }: AvatarJobProps) {
  const { t, i18n } = useTranslation('photo-avatar');
  const format = useFormat();
  const session = useSession();
  const describe = useErrorText();
  const failureReason = useFailureReason();
  const invalidate = useInvalidateApi();
  const locale = i18n.language.startsWith('en') ? 'en' : 'es';

  const job = useJobPolling(
    api.avatars.get,
    { params: { avatarId } },
    {
      select: (avatar: Avatar) => ({
        status: avatar.status,
        progress: avatar.progress,
        etaSec: avatar.etaSec,
      }),
      onSettled: (avatar, phase) => {
        void invalidate(api.avatars.list);
        void session.refresh();
        if (phase === 'completed') toast.success(t('job.readyToast', { name: avatar.name }));
        else toast.error(t('job.failedToast', { name: avatar.name }));
      },
    },
  );
  const startVideo = useStartVideo({
    onCreated: () => toast.success(t('job.videoCreated')),
    onError: (error) => toast.error(t('job.videoFailed'), { description: describe(error).title }),
  });
  const remove = useApiMutation(api.photoAvatars.remove, {
    invalidates: [api.avatars.list],
    onSuccess: onAnother,
    onError: (error) => toast.error(t('job.deleteFailed'), { description: describe(error).title }),
  });

  const avatar = job.data;
  if (!avatar) {
    return job.error ? (
      <ErrorState
        error={job.error}
        onRetry={job.refetch}
        action={<Button onClick={onAnother}>{t('job.back')}</Button>}
      />
    ) : (
      <div className="grid gap-6 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]" aria-busy="true">
        <Skeleton className="aspect-[4/5] rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  const generated = avatar.kind === 'generated';
  const processing = avatar.status === 'processing';
  const ready = avatar.status === 'ready';
  const failed = avatar.status === 'failed';
  const failure = failureReason(avatar.error, t('job.failedUnknown'));
  const typical = generated ? portraitSeconds(engine) : null;

  return (
    <div className="grid items-start gap-6 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <div
        className={cn(
          'relative mx-auto aspect-[4/5] w-full max-w-xs overflow-hidden rounded-xl bg-media text-on-media sm:max-w-none',
        )}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(90%_70%_at_50%_10%,color-mix(in_srgb,var(--saffron)_22%,transparent),transparent_70%)]"
        />
        {ready ? (
          <>
            <AvatarStage
              avatar={avatar}
              label={t('job.resultAlt', { name: avatar.name })}
              className="absolute inset-0"
            />
            <span className="absolute inset-x-3 bottom-3 rounded-md bg-media/80 px-2.5 py-1.5 text-center text-xs">
              {t('job.standIn')}
            </span>
          </>
        ) : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <span aria-hidden="true" className="absolute inset-0 booth-grid opacity-40" />
            {failed ? (
              <TriangleAlert
                aria-hidden="true"
                className="size-12 text-on-media/60"
                strokeWidth={1.25}
              />
            ) : (
              <>
                <UserRound
                  aria-hidden="true"
                  className="size-24 text-on-media/25"
                  strokeWidth={1}
                />
                <VoiceBars size="md" label={null} className="text-saffron" />
              </>
            )}
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-5">
        <div>
          <p className="eyebrow text-fg-subtle">
            {generated ? t('job.kind.generated') : t('job.kind.photo')}
          </p>
          <h2 className="text-3xl break-words">{avatar.name}</h2>
        </div>

        {processing && (
          <>
            <JobStatus
              label={t('job.progressLabel', { name: avatar.name })}
              status={job.phase}
              progress={job.progress}
              etaSec={job.etaSec}
              etaEstimated={job.etaEstimated}
              stage={generated ? t('job.stage.generated') : t('job.stage.photo')}
            />
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-fg-muted">{t('job.elapsed')}</dt>
                <dd className="nums font-mono">{format.clock(job.elapsedSec * 1000)}</dd>
              </div>
              {typical !== null && (
                <div>
                  <dt className="text-xs text-fg-muted">{t('job.typical')}</dt>
                  <dd className="nums font-mono">≈ {format.duration(typical * 1000)}</dd>
                </div>
              )}
            </dl>
            <p className="text-sm text-pretty text-fg-muted">
              {generated ? t('job.explain.generated') : t('job.explain.photo')}{' '}
              {engine?.device === 'gpu' ? t('job.device.gpu') : t('job.device.cpu')}
            </p>
            <Callout tone="neutral">{t('job.leave')}</Callout>
          </>
        )}

        {ready && (
          <>
            <Callout
              tone="success"
              role="status"
              icon={<CircleCheck />}
              title={t('job.readyTitle')}
            >
              {t('job.readyText')}
            </Callout>
            <QualityNote quality={avatar.quality} />
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div className="col-span-2 flex flex-wrap items-center gap-2">
                <ProviderBadge provider={avatar.provider} />
              </div>
              {avatar.rig && (
                <div>
                  <dt className="text-xs text-fg-muted">{t('job.landmarks')}</dt>
                  <dd>{t(`job.landmarksSource.${avatar.rig.landmarksSource}`)}</dd>
                </div>
              )}
              {avatar.model && (
                <div>
                  <dt className="text-xs text-fg-muted">{t('job.model')}</dt>
                  <dd className="break-words">{avatar.model}</dd>
                </div>
              )}
              {avatar.seed !== null && (
                <div>
                  <dt className="text-xs text-fg-muted">{t('job.seed')}</dt>
                  <dd className="nums font-mono">{avatar.seed}</dd>
                </div>
              )}
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                leftIcon={<Clapperboard aria-hidden="true" />}
                disabled={!startVideo.canOpen}
                loading={startVideo.isPending}
                onClick={() =>
                  startVideo.start({
                    title: t('job.videoTitle', { name: avatar.name }),
                    text: t('job.videoScript', { name: avatar.name }),
                    locale,
                    avatarId: avatar.id,
                  })
                }
              >
                {t('job.use')}
              </Button>
              <Button asChild>
                <Link to={LIB_ROUTES.avatar(avatar.id)}>{t('job.open')}</Link>
              </Button>
              <Button variant="ghost" leftIcon={<Plus aria-hidden="true" />} onClick={onAnother}>
                {t('job.another')}
              </Button>
            </div>
          </>
        )}

        {failed && (
          <>
            <Callout
              tone="danger"
              role="alert"
              icon={<TriangleAlert />}
              title={t('job.failedTitle')}
            >
              <p data-failure-reason={avatar.error?.reason ?? undefined}>{failure.text}</p>
              {failure.detail && (
                <p className="mt-1 font-mono text-xs break-words opacity-80">{failure.detail}</p>
              )}
              <p className="mt-1.5">{t('job.refunded')}</p>
            </Callout>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={onAnother}>
                {t('job.retry')}
              </Button>
              <Button
                variant="ghost"
                leftIcon={<Trash2 aria-hidden="true" />}
                loading={remove.isPending}
                onClick={() => remove.mutate({ params: { avatarId: avatar.id } })}
              >
                {t('job.discard')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
