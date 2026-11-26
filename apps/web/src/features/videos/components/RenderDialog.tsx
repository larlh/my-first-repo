import type { Resolution, Video } from '@parlante/shared';
import { resolutionAllowed } from '@parlante/shared';
import { Clapperboard } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RenderSettings, renderCostOf, renderGate } from '@/components/RenderSettings';
import { api, useApiMutation } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Dialog } from '@/ui';
import { ROUTES } from '../lib/routes';

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
 * Confirms a render from the page of a video. What is asked and explained (resolution, credits,
 * the photorealistic notice, refusals) is the shell's `RenderSettings`, the same the Studio
 * shows; the sequence itself (moderation, limits, charge, queue) is the API's `startRender`.
 */
export function RenderDialog({
  video,
  open,
  onOpenChange,
  billingAvailable,
  onStarted,
}: RenderDialogProps) {
  const { t } = useTranslation('videos');
  const { t: tShell } = useTranslation('shell');
  const session = useSession();
  const [resolution, setResolution] = useState<Resolution>('720p');
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setResolution(
      video.resolution && resolutionAllowed(session.plan.id, video.resolution)
        ? video.resolution
        : '720p',
    );
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const render = useApiMutation(api.videos.render, {
    invalidates: [api.videos.list, api.videos.renderJobs, api.billing.overview],
    onSuccess: (started) => {
      void session.refresh();
      onStarted(started.video);
      onOpenChange(false);
    },
    onError: setError,
  });

  const cost = renderCostOf(video.estimatedDurationMs, resolution, video.usesPhotorealAvatars);
  const gate = renderGate({
    plan: session.plan.id,
    balance: session.credits,
    resolution,
    cost,
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={video.videoUrl ? tShell('render.titleAgain') : tShell('render.title')}
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
            disabled={gate.blocked}
            onClick={() => {
              setError(null);
              render.mutate({ params: { videoId: video.id }, body: { resolution } });
            }}
          >
            {tShell('render.start')}
          </Button>
        </>
      }
    >
      <RenderSettings
        resolution={resolution}
        onResolutionChange={setResolution}
        durationMs={video.estimatedDurationMs}
        cost={cost}
        photoreal={video.usesPhotorealAvatars}
        error={error}
        billingPath={billingAvailable ? ROUTES.billing : null}
      />
    </Dialog>
  );
}
