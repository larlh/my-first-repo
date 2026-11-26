import { CREDIT_COSTS, creditsForRender, resolutionAllowed } from '@parlante/shared';
import type { Capabilities, PlanId, Resolution } from '@parlante/shared';
import { Coins, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, isApiError, useApiQuery } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button } from '@/ui/Button';
import { SegmentedControl } from '@/ui/SegmentedControl';
import { useErrorText, useServerMessage } from '@/ui/States';

/* -------------------------------------------------------------------------------------------
 * What a person decides and is told before a render starts — ONE implementation for every
 * place that starts one (the page of a video and the Studio): resolution within the plan,
 * length, credits, the honest notice for photorealistic avatars and the refusals of the API.
 * Each caller keeps its own dialog (the Studio also saves first and shows progress) and passes
 * what only it knows: the length and, when it measured the audio, the real cost.
 * ----------------------------------------------------------------------------------------- */

export const RENDER_RESOLUTIONS: readonly Resolution[] = ['720p', '1080p'];

export interface RenderCost {
  /** What the render ends up costing. */
  cost: number;
  /** What the API holds when it starts (it prices its own estimate of the length). */
  reserve: number;
  /** What the balance must cover for the API to accept the render. */
  needed: number;
}

/** Cost of a render whose only known length is the estimate of the API (cost = reserve). */
export function renderCostOf(
  durationMs: number,
  resolution: Resolution,
  photoreal: boolean,
): RenderCost {
  const credits = creditsForRender(durationMs, resolution, { photoreal });
  return { cost: credits, reserve: credits, needed: credits };
}

/** Whether the plan and the balance let this render start. */
export function renderGate(input: {
  plan: PlanId;
  balance: number;
  resolution: Resolution;
  cost: RenderCost;
}): { allowed: boolean; affordable: boolean; blocked: boolean } {
  const allowed = resolutionAllowed(input.plan, input.resolution);
  const affordable = input.cost.needed <= input.balance;
  return { allowed, affordable, blocked: !allowed || !affordable };
}

type Engine = Capabilities['avatarEngine'];

export interface PhotorealNoticeProps {
  /** Engine status when the caller already has it; otherwise read from `/api/capabilities`. */
  engine?: Engine | null;
  /** Length of THIS video: the estimate is given for it instead of "per 10 s of video". */
  durationMs?: number;
  /** Extra sentence (the Studio adds that its preview uses a stand-in). */
  note?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Photorealistic avatars are animated by the local neural engine: slow on CPU. Says so with the
 * speed measured on this machine, whether the engine can animate right now (and why not, in the
 * language of the interface) and the licence caveat of the installed models.
 */
export function PhotorealNotice({
  engine: given,
  durationMs,
  note,
  size = 'md',
  className,
}: PhotorealNoticeProps) {
  const { t, i18n } = useTranslation('shell');
  const format = useFormat();
  const serverMessage = useServerMessage();
  const capabilities = useApiQuery(api.system.capabilities, undefined, {
    enabled: given === undefined,
    staleTime: 60_000,
  });
  const engine = given === undefined ? capabilities.data?.avatarEngine : given;
  const device = engine?.device === 'gpu' ? 'GPU' : 'CPU';
  const speed = engine?.secondsPerVideoSecond;
  const reason = engine?.reasonCode
    ? i18n.exists(`errors.reasons.${engine.reasonCode}`, { ns: 'shell' })
      ? t(`errors.reasons.${engine.reasonCode}`)
      : serverMessage(engine.reason)
    : serverMessage(engine?.reason);
  return (
    <div
      className={cn(
        'flex rounded-lg border border-line bg-saffron-soft text-saffron-text',
        size === 'sm' ? 'gap-2.5 p-3 text-xs' : 'gap-3 p-3.5 text-sm',
        className,
      )}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-semibold">{t('render.photoreal.title')}</p>
        <p className="mt-0.5">
          {!speed
            ? t('render.photoreal.unmeasured')
            : durationMs !== undefined
              ? t('render.photoreal.measuredVideo', {
                  device,
                  time: format.duration(Math.round((durationMs / 1000) * speed) * 1000),
                })
              : t('render.photoreal.measured', {
                  device,
                  time: format.duration(Math.round(speed * 10) * 1000),
                })}
          {note ? <> {note}</> : null}
        </p>
        {engine && !engine.operations.animate && (
          <p className="mt-1 font-medium" data-photoreal-reason={engine.reasonCode ?? undefined}>
            {t('render.photoreal.unavailable')}
            {reason ? ` ${reason}` : ''}
          </p>
        )}
        {engine?.nonCommercial && <p className="mt-1">{t('render.photoreal.nonCommercial')}</p>}
      </div>
    </div>
  );
}

export interface RenderSettingsProps {
  resolution: Resolution;
  onResolutionChange: (resolution: Resolution) => void;
  /** Length the price is based on (ms). */
  durationMs: number;
  cost: RenderCost;
  /** The video uses photorealistic avatars (×2 credits, slow render, needs the engine). */
  photoreal: boolean;
  /** Engine status when the caller has it (see `PhotorealNotice`). */
  engine?: Engine | null;
  /** Something the API (or the caller) refused: shown in plain words at the end. */
  error?: unknown;
  /** Route of the plans screen, offered when credits or the plan fall short. */
  billingPath?: string | null;
  /** Caller notes shown between the cost and the alerts (stale render, plan limits…). */
  children?: ReactNode;
}

/** The body of a "render this video" dialog. */
export function RenderSettings({
  resolution,
  onResolutionChange,
  durationMs,
  cost,
  photoreal,
  engine,
  error,
  billingPath,
  children,
}: RenderSettingsProps) {
  const { t } = useTranslation('shell');
  const format = useFormat();
  const session = useSession();
  const describe = useErrorText();
  const gate = renderGate({
    plan: session.plan.id,
    balance: session.credits,
    resolution,
    cost,
  });
  const locked = RENDER_RESOLUTIONS.some((value) => !resolutionAllowed(session.plan.id, value));
  const described = error === null || error === undefined ? null : describe(error);
  const needsBilling =
    !gate.affordable ||
    locked ||
    (isApiError(error) && error.is('INSUFFICIENT_CREDITS', 'PLAN_LIMIT_EXCEEDED'));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold">{t('render.resolution')}</p>
        <SegmentedControl
          aria-label={t('render.resolution')}
          block
          value={resolution}
          onValueChange={onResolutionChange}
          options={RENDER_RESOLUTIONS.map((value) => ({
            value,
            label: value,
            disabled: !resolutionAllowed(session.plan.id, value),
          }))}
        />
        {locked && (
          <p className="text-sm text-fg-muted">
            {t('render.resolutionLocked', { plan: session.plan.name })}
          </p>
        )}
      </div>

      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 rounded-lg bg-bg-sunken p-4 text-sm">
        <dt className="text-fg-muted">{t('render.duration')}</dt>
        <dd className="nums text-right font-medium">
          ≈ {format.duration(Math.round(durationMs / 1000) * 1000)}
        </dd>
        <dt className="text-fg-muted">{t('render.cost')}</dt>
        <dd
          className="nums flex items-center justify-end gap-1.5 text-right font-semibold"
          data-testid="render-cost"
        >
          <Coins className="size-4 text-saffron-text" aria-hidden="true" />
          {t('credits.count', { count: cost.cost })}
        </dd>
        <dt className="text-fg-muted">{t('render.balance')}</dt>
        <dd className={cn('nums text-right font-medium', !gate.affordable && 'text-danger-text')}>
          {t('credits.count', { count: session.credits })}
        </dd>
      </dl>
      <p className="-mt-2 text-xs text-fg-muted">
        {t('render.costNote', {
          count: CREDIT_COSTS.renderPer30s,
          hd: CREDIT_COSTS.render1080pMultiplier,
          photoreal: CREDIT_COSTS.renderPhotorealMultiplier,
        })}
        {session.plan.limits.watermark ? ` ${t('render.watermark')}` : ''}
      </p>
      {cost.reserve !== cost.cost && (
        <p className="-mt-2 text-xs text-fg-muted" data-testid="render-reserve">
          {t('render.reserveNote', { count: cost.reserve })}
        </p>
      )}

      {photoreal && <PhotorealNotice engine={engine} durationMs={durationMs} />}
      {children}

      {!gate.affordable && !described && (
        <p role="alert" className="text-sm font-medium text-danger-text">
          {t('render.notEnough')}
        </p>
      )}
      {described && (
        <div role="alert" className="rounded-lg bg-danger-soft p-3.5 text-sm text-danger-text">
          <p className="font-semibold">{described.title}</p>
          {described.message && <p className="mt-0.5 break-words">{described.message}</p>}
        </div>
      )}
      {needsBilling && billingPath && (
        <Button asChild variant="link" className="self-start">
          <Link to={billingPath}>{t('render.seePlans')}</Link>
        </Button>
      )}
    </div>
  );
}
