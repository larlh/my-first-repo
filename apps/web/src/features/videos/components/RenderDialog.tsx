import { CREDIT_COSTS } from '@parlante/shared';
import type { Resolution, Video } from '@parlante/shared';
import { Clapperboard, Coins, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, useApiMutation, useApiQuery } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button, Dialog, SegmentedControl, cn, useErrorText } from '@/ui';
import { ROUTES } from '../lib/routes';
import { quoteRender } from '../lib/video';

export interface RenderDialogProps {
  video: Video;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Billing screen mounted: offer it when credits or the plan fall short. */
  billingAvailable: boolean;
  /** The render was queued; the page starts polling. */
  onStarted: (video: Video) => void;
}

/**
 * Confirms a render: resolution, what it reserves in credits and — for photorealistic avatars —
 * an honest, measured time estimate. The sequence itself (moderation, limits, charge, queue)
 * is the API's `startRender`; its refusals are shown here in plain words.
 */
export function RenderDialog({
  video,
  open,
  onOpenChange,
  billingAvailable,
  onStarted,
}: RenderDialogProps) {
  const { t } = useTranslation('videos');
  const format = useFormat();
  const session = useSession();
  const describe = useErrorText();
  const quotes = useMemo(
    () => quoteRender(video, session.workspace.plan, session.credits),
    [video, session.workspace.plan, session.credits],
  );
  const [resolution, setResolution] = useState<Resolution>('720p');
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const last = quotes.find((quote) => quote.resolution === video.resolution);
    setResolution(last?.allowed ? last.resolution : '720p');
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Measured speed of the neural engine on this machine, to give a real time estimate.
  const capabilities = useApiQuery(api.system.capabilities, undefined, {
    enabled: open && video.usesPhotorealAvatars,
    staleTime: 60_000,
  });
  const engine = capabilities.data?.avatarEngine;

  const render = useApiMutation(api.videos.render, {
    invalidates: [api.videos.list, api.videos.renderJobs, api.billing.overview],
    onSuccess: (started) => {
      void session.refresh();
      onStarted(started.video);
      onOpenChange(false);
    },
    onError: setError,
  });

  const quote = quotes.find((item) => item.resolution === resolution) ?? quotes[0];
  if (!quote) return null;
  const blocked = !quote.allowed || !quote.affordable;
  const describedError = error ? describe(error) : null;
  const needsBilling =
    !quote.affordable ||
    (error?.is('INSUFFICIENT_CREDITS', 'PLAN_LIMIT_EXCEEDED') ?? false) ||
    quotes.some((item) => !item.allowed);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={video.videoUrl ? t('render.titleAgain') : t('render.title')}
      description={t('render.description')}
      dismissible={!render.isPending}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={render.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            leftIcon={<Clapperboard aria-hidden="true" />}
            loading={render.isPending}
            disabled={blocked}
            onClick={() => {
              setError(null);
              render.mutate({ params: { videoId: video.id }, body: { resolution } });
            }}
          >
            {t('render.start')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold" id="render-resolution">
            {t('render.resolution')}
          </p>
          <SegmentedControl
            aria-label={t('render.resolution')}
            value={resolution}
            onValueChange={setResolution}
            block
            options={quotes.map((item) => ({
              value: item.resolution,
              label: item.resolution,
              disabled: !item.allowed,
            }))}
          />
          {quotes.some((item) => !item.allowed) && (
            <p className="text-sm text-fg-muted">
              {t('render.resolutionLocked', { plan: session.plan.name })}
            </p>
          )}
        </div>

        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 rounded-lg bg-bg-sunken p-4 text-sm">
          <dt className="text-fg-muted">{t('render.estimatedDuration')}</dt>
          <dd className="nums text-right font-medium">
            {format.duration(Math.round(video.estimatedDurationMs / 1000) * 1000)}
          </dd>
          <dt className="text-fg-muted">{t('render.cost')}</dt>
          <dd className="nums flex items-center justify-end gap-1.5 text-right font-semibold">
            <Coins className="size-4 text-saffron-text" aria-hidden="true" />
            {t('render.credits', { count: quote.credits })}
          </dd>
          <dt className="text-fg-muted">{t('render.balance')}</dt>
          <dd
            className={cn('nums text-right font-medium', !quote.affordable && 'text-danger-text')}
          >
            {t('render.credits', { count: session.credits })}
          </dd>
        </dl>
        <p className="-mt-2 text-xs text-fg-muted">
          {t('render.costNote', { seconds: 30, base: CREDIT_COSTS.renderPer30s })}
          {session.plan.limits.watermark ? ` ${t('render.watermark')}` : ''}
        </p>

        {video.usesPhotorealAvatars && (
          <div className="flex gap-3 rounded-lg border border-line bg-saffron-soft p-3.5 text-sm text-saffron-text">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-semibold">{t('render.photorealTitle')}</p>
              <p className="mt-0.5">
                {engine?.secondsPerVideoSecond
                  ? t('render.photorealMeasured', {
                      time: format.duration(
                        Math.round(
                          (video.estimatedDurationMs / 1000) * engine.secondsPerVideoSecond,
                        ) * 1000,
                      ),
                      device: engine.device === 'gpu' ? 'GPU' : 'CPU',
                    })
                  : t('render.photorealUnmeasured')}
              </p>
              {engine && !engine.operations.animate && (
                <p className="mt-1 font-medium">
                  {t('render.engineUnavailable')}
                  {engine.reason ? ` (${engine.reason})` : ''}
                </p>
              )}
              {engine?.nonCommercial && <p className="mt-1">{t('render.nonCommercial')}</p>}
            </div>
          </div>
        )}

        {!quote.affordable && !error && (
          <p role="alert" className="text-sm font-medium text-danger-text">
            {t('render.notEnough')}
          </p>
        )}
        {describedError && (
          <div role="alert" className="rounded-lg bg-danger-soft p-3.5 text-sm text-danger-text">
            <p className="font-semibold">{describedError.title}</p>
            {describedError.message && (
              <p className="mt-0.5 break-words">{describedError.message}</p>
            )}
          </div>
        )}
        {needsBilling && billingAvailable && (
          <Button asChild variant="link" className="self-start">
            <Link to={ROUTES.billing}>{t('render.seePlans')}</Link>
          </Button>
        )}
      </div>
    </Dialog>
  );
}
