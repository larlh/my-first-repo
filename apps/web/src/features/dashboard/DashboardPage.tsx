import type { BillingOverview } from '@parlante/shared';
import {
  ArrowRight,
  ArrowUpRight,
  Clapperboard,
  Coins,
  LayoutTemplate,
  Mic,
  PenLine,
  Plus,
  Sparkles,
  UserRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ProviderBadge } from '@/components/ProviderBadge';
import { api, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, Button, ErrorState, Skeleton, VoiceBars, cn } from '@/ui';
import { useVideoActions } from '../videos/components/useVideoActions';
import { VideoCard } from '../videos/components/VideoCard';
import { ROUTES, useAvailableRoutes } from '../videos/lib/routes';
import { isVideoActive } from '../videos/lib/video';
import { creditLevel, dayPart, firstName, usageMeters } from './usage';
import type { UsageLevel, UsageMeter } from './usage';

const RECENT_COUNT = 6;
const POLL_MS = 2500;

/* ---------- create ---------- */

function CreateCard({
  number,
  icon: Icon,
  title,
  text,
  to,
  footer,
  primary = false,
}: {
  number: string;
  icon: LucideIcon;
  title: string;
  text: string;
  to: string;
  footer?: ReactNode;
  primary?: boolean;
}) {
  return (
    <li className="flex min-w-0">
      <div
        className={cn(
          'group relative flex w-full min-w-0 flex-col rounded-xl border p-5 shadow-xs',
          'transition-[box-shadow,border-color,transform] duration-200 ease-out-expo',
          'focus-within:shadow-md hover:-translate-y-0.5 hover:shadow-md',
          primary
            ? 'border-transparent bg-accent text-accent-fg'
            : 'border-line bg-surface text-fg hover:border-line-strong',
        )}
      >
        <div className="mb-6 flex items-start justify-between">
          <span
            aria-hidden="true"
            className={cn(
              'flex size-11 items-center justify-center rounded-lg',
              primary ? 'bg-accent-fg/10' : 'bg-surface-3',
            )}
          >
            <Icon className="size-5" />
          </span>
          <span
            aria-hidden="true"
            className={cn(
              'nums font-mono text-xs font-medium',
              primary ? 'text-accent-fg/70' : 'text-fg-subtle',
            )}
          >
            {number}
          </span>
        </div>
        <h3 className="text-xl">
          <Link
            to={to}
            className={cn(
              'rounded-xs outline-offset-4 after:absolute after:inset-0 after:rounded-xl after:content-[""]',
              primary && '[--ring:var(--accent-fg)]',
            )}
          >
            {title}
          </Link>
        </h3>
        <p className={cn('mt-1.5 text-sm', primary ? 'text-accent-fg/85' : 'text-fg-muted')}>
          {text}
        </p>
        <div className="mt-auto flex items-end justify-between gap-3 pt-5">
          <div className="relative z-10 min-w-0">{footer}</div>
          <ArrowRight
            aria-hidden="true"
            className="size-5 shrink-0 transition-transform duration-200 ease-out-expo group-hover:translate-x-1"
          />
        </div>
      </div>
    </li>
  );
}

/* ---------- first video guide ---------- */

function FirstVideoGuide({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation('dashboard');
  const steps: { icon: LucideIcon; key: 'script' | 'cast' | 'render' }[] = [
    { icon: PenLine, key: 'script' },
    { icon: UserRound, key: 'cast' },
    { icon: Clapperboard, key: 'render' },
  ];
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-surface">
      <div className="booth-grid absolute inset-0 text-fg-muted opacity-60" aria-hidden="true" />
      <div className="relative flex flex-col gap-6 p-6 sm:p-8">
        <div className="max-w-xl">
          <p className="eyebrow mb-2 text-accent-text">{t('guide.eyebrow')}</p>
          <h3 className="display text-2xl sm:text-3xl">{t('guide.title')}</h3>
          <p className="mt-2 text-base text-fg-muted">
            {canEdit ? t('guide.text') : t('guide.textViewer')}
          </p>
        </div>
        <ol className="grid gap-3 sm:grid-cols-3">
          {steps.map((step, index) => (
            <li
              key={step.key}
              className="flex gap-3.5 rounded-lg border border-line bg-bg p-4 sm:flex-col sm:gap-3"
            >
              <span className="flex shrink-0 items-center gap-2.5">
                <span className="nums flex size-7 items-center justify-center rounded-full bg-inverse font-mono text-xs font-semibold text-inverse-fg">
                  {index + 1}
                </span>
                <step.icon
                  className="hidden size-[1.125rem] text-fg-muted sm:block"
                  aria-hidden="true"
                />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">
                  {t(`guide.steps.${step.key}.title`)}
                </span>
                <span className="mt-0.5 block text-sm text-fg-muted">
                  {t(`guide.steps.${step.key}.text`)}
                </span>
              </span>
            </li>
          ))}
        </ol>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Button asChild variant="primary" size="lg" leftIcon={<Plus aria-hidden="true" />}>
              <Link to={ROUTES.newVideo}>{t('guide.action')}</Link>
            </Button>
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <Mic className="size-4 shrink-0" aria-hidden="true" />
              {t('guide.offline')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- credits and plan ---------- */

const LEVEL_BAR: Record<UsageLevel, string> = {
  ok: 'bg-fg',
  high: 'bg-warning',
  full: 'bg-danger',
};

function UsageRow({ meter }: { meter: UsageMeter }) {
  const { t } = useTranslation('dashboard');
  const format = useFormat();
  const value =
    meter.key === 'storage'
      ? t('usage.of', { used: format.bytes(meter.used), limit: format.bytes(meter.limit) })
      : t('usage.of', { used: format.number(meter.used), limit: format.number(meter.limit) });
  const label = t(`usage.${meter.key}`);
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-fg-muted">{label}</span>
        <span
          className={cn('nums shrink-0 font-medium', meter.level === 'full' && 'text-danger-text')}
        >
          {value}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={meter.limit}
        aria-valuenow={Math.min(meter.used, meter.limit)}
        aria-valuetext={value}
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3"
      >
        <span
          className={cn('block h-full rounded-full', LEVEL_BAR[meter.level])}
          style={{ width: `${Math.max(meter.ratio * 100, meter.used > 0 ? 3 : 0)}%` }}
        />
      </div>
    </li>
  );
}

function PlanPanel({
  overview,
  billingAvailable,
}: {
  overview: BillingOverview;
  billingAvailable: boolean;
}) {
  const { t } = useTranslation('dashboard');
  const { t: tShell } = useTranslation('shell');
  const format = useFormat();
  const { plan, credits, usage, limits } = overview;
  const level = creditLevel(credits, plan.monthlyCredits);
  const meters = usageMeters(overview);

  return (
    <section
      aria-labelledby="plan-heading"
      className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xs"
    >
      <div className="relative bg-sidebar p-5 text-sidebar-fg [--ring:var(--saffron)]">
        <div className="booth-grid absolute inset-0 opacity-40" aria-hidden="true" />
        <div className="relative">
          <div className="flex items-center justify-between gap-3">
            <h2 id="plan-heading" className="eyebrow text-sidebar-fg-muted">
              {t('plan.title')}
            </h2>
            <span className="rounded-full bg-sidebar-3 px-2.5 py-0.5 text-xs font-semibold">
              {t('plan.name', { plan: plan.name })}
            </span>
          </div>
          <p className="mt-3 flex items-baseline gap-2">
            <Coins className="size-5 shrink-0 translate-y-0.5 text-saffron" aria-hidden="true" />
            <span className="display nums text-5xl">{format.number(credits)}</span>
            <span className="text-sm text-sidebar-fg-muted">
              {t('plan.ofMonthly', { total: format.number(plan.monthlyCredits) })}
            </span>
          </p>
          <div
            role="meter"
            aria-label={tShell('credits.meter')}
            aria-valuemin={0}
            aria-valuemax={plan.monthlyCredits}
            aria-valuenow={Math.min(credits, plan.monthlyCredits)}
            aria-valuetext={tShell('credits.count', { count: credits })}
            className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-sidebar-3"
          >
            <span
              className={cn('block h-full rounded-full', level.low ? 'bg-accent' : 'bg-saffron')}
              style={{ width: `${Math.max(level.ratio * 100, credits > 0 ? 4 : 0)}%` }}
            />
          </div>
          <p className="mt-2.5 text-sm text-sidebar-fg-muted">
            {level.empty ? t('plan.empty') : level.low ? t('plan.low') : t('plan.costHint')}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5 p-5">
        <div>
          <h3 className="eyebrow mb-2.5 text-fg-subtle">{t('plan.last30')}</h3>
          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-bg-sunken p-3">
              <dd className="display nums text-2xl">{format.number(usage.renders30d)}</dd>
              <dt className="mt-0.5 text-xs text-fg-muted">
                {t('plan.renders', { count: usage.renders30d })}
              </dt>
            </div>
            <div className="rounded-lg bg-bg-sunken p-3">
              <dd className="display nums text-2xl">{format.number(usage.creditsSpent30d)}</dd>
              <dt className="mt-0.5 text-xs text-fg-muted">
                {t('plan.spent', { count: usage.creditsSpent30d })}
              </dt>
            </div>
          </dl>
        </div>

        <div>
          <h3 className="eyebrow mb-2.5 text-fg-subtle">{t('plan.usage')}</h3>
          <ul className="flex flex-col gap-3">
            {meters.map((meter) => (
              <UsageRow key={meter.key} meter={meter} />
            ))}
          </ul>
        </div>

        <ul className="flex flex-wrap gap-1.5" aria-label={t('plan.includes')}>
          <li>
            <Badge variant="outline">
              {t('plan.maxResolution', { resolution: limits.maxResolution })}
            </Badge>
          </li>
          <li>
            <Badge variant="outline">
              {t('plan.maxDuration', { time: format.duration(limits.maxVideoDurationSec * 1000) })}
            </Badge>
          </li>
          <li>
            <Badge variant="outline">
              {limits.watermark ? t('plan.watermark') : t('plan.noWatermark')}
            </Badge>
          </li>
        </ul>

        {billingAvailable && (
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <Button asChild block rightIcon={<ArrowUpRight aria-hidden="true" />}>
              <Link to={ROUTES.billing}>{t('plan.manage')}</Link>
            </Button>
            <p className="text-center text-xs text-fg-subtle">{t('plan.simulated')}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function PlanSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface" aria-hidden="true">
      <Skeleton className="h-40 rounded-none" />
      <div className="flex flex-col gap-4 p-5">
        <Skeleton className="h-16" />
        <Skeleton className="h-24" />
      </div>
    </div>
  );
}

/* ---------- page ---------- */

/** Home: start a video three ways, see what is rendering, and how much of the plan is left. */
export default function DashboardPage() {
  const { t } = useTranslation('dashboard');
  const session = useSession();
  const format = useFormat();
  const available = useAvailableRoutes();
  const canEdit = session.can('editor');

  const videos = useApiQuery(
    api.videos.list,
    { query: { limit: RECENT_COUNT } },
    {
      refetchInterval: (query) => (query.state.data?.items.some(isVideoActive) ? POLL_MS : false),
    },
  );
  const billing = useApiQuery(api.billing.overview);
  const capabilities = useApiQuery(api.system.capabilities, undefined, {
    enabled: canEdit,
    staleTime: 60_000,
  });
  const llm = capabilities.data?.active.llm;

  const items = videos.data?.items ?? [];
  const activeCount = items.filter(isVideoActive).length;
  const actions = useVideoActions();

  // When the last render on screen settles, credits and usage have changed too.
  const wasActive = useRef(false);
  const { refresh } = session;
  const refetchBilling = billing.refetch;
  useEffect(() => {
    if (wasActive.current && activeCount === 0) {
      void refresh();
      void refetchBilling();
    }
    wasActive.current = activeCount > 0;
  }, [activeCount, refresh, refetchBilling]);

  const part = dayPart(new Date().getHours());

  return (
    <div className="flex flex-col gap-8 sm:gap-10">
      {/* Hero: the booth */}
      <header className="relative overflow-hidden rounded-2xl bg-sidebar text-sidebar-fg [--ring:var(--saffron)]">
        <div className="booth-grid absolute inset-0 opacity-40" aria-hidden="true" />
        <div className="relative flex flex-col gap-6 p-6 sm:p-9 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-2.5 text-sidebar-fg-muted">
              <span className="relative flex size-2.5">
                {activeCount > 0 && (
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-70" />
                )}
                <span
                  className={cn(
                    'relative inline-flex size-2.5 rounded-full',
                    activeCount > 0 ? 'bg-accent' : 'bg-sidebar-fg-muted',
                  )}
                />
              </span>
              <span className="eyebrow" role="status">
                {activeCount > 0 ? t('hero.onAir', { count: activeCount }) : t('hero.idle')}
              </span>
            </p>
            <h1 className="display mt-4 text-4xl break-words sm:text-5xl">
              {t(`hero.greeting.${part}`, { name: firstName(session.user.name) })}
            </h1>
            <p className="mt-3 max-w-xl text-base text-sidebar-fg-muted sm:text-lg">
              {t('hero.text', { workspace: session.workspace.name })}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-5">
            <VoiceBars
              size="lg"
              active={activeCount > 0}
              label={null}
              className="hidden sm:inline-flex"
            />
            {canEdit && (
              <Button asChild variant="primary" size="lg" leftIcon={<Plus aria-hidden="true" />}>
                <Link to={ROUTES.newVideo}>{t('hero.create')}</Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      {canEdit && (
        <section aria-labelledby="create-heading">
          <h2 id="create-heading" className="mb-4 text-2xl">
            {t('create.title')}
          </h2>
          <ul className="grid gap-4 md:grid-cols-3">
            <CreateCard
              primary
              number="01"
              icon={PenLine}
              title={t('create.blank.title')}
              text={t('create.blank.text')}
              to={ROUTES.newVideo}
            />
            <CreateCard
              number="02"
              icon={LayoutTemplate}
              title={t('create.template.title')}
              text={t('create.template.text')}
              to={available.templates ? ROUTES.templates : ROUTES.newVideo}
            />
            <CreateCard
              number="03"
              icon={Sparkles}
              title={t('create.script.title')}
              text={t('create.script.text')}
              to={available.scriptWriter ? ROUTES.scriptWriter : ROUTES.newVideo}
              footer={llm ? <ProviderBadge provider={llm} size="sm" /> : undefined}
            />
          </ul>
        </section>
      )}

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        <section aria-labelledby="recent-heading" className="min-w-0" aria-busy={videos.isPending}>
          <div className="mb-4 flex items-end justify-between gap-4">
            <h2 id="recent-heading" className="text-2xl">
              {t('recent.title')}
            </h2>
            {items.length > 0 && (
              <Button asChild variant="link" rightIcon={<ArrowRight aria-hidden="true" />}>
                <Link to={ROUTES.videos}>{t('recent.all')}</Link>
              </Button>
            )}
          </div>
          {videos.isPending ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-4">
              {Array.from({ length: 3 }, (_, index) => (
                <div
                  key={index}
                  className="overflow-hidden rounded-lg border border-line bg-surface"
                >
                  <Skeleton className="aspect-video h-auto rounded-none" />
                  <div className="flex flex-col gap-2 p-3.5">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : videos.isError ? (
            <div className="rounded-xl border border-line bg-surface">
              <ErrorState
                size="sm"
                error={videos.error}
                onRetry={() => void videos.refetch()}
                retrying={videos.isRefetching}
              />
            </div>
          ) : items.length === 0 ? (
            <FirstVideoGuide canEdit={canEdit} />
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-4">
              {items.map((video) => (
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
          )}
        </section>

        <aside aria-label={t('plan.title')} className="min-w-0">
          {billing.isPending ? (
            <PlanSkeleton />
          ) : billing.isError ? (
            <div className="rounded-xl border border-line bg-surface">
              <ErrorState
                size="sm"
                title={t('plan.failed')}
                error={billing.error}
                onRetry={() => void billing.refetch()}
                retrying={billing.isRefetching}
              />
              <p className="border-t border-line px-5 py-3.5 text-center text-sm text-fg-muted">
                {t('plan.fallback', {
                  credits: format.number(session.credits),
                  plan: session.plan.name,
                })}
              </p>
            </div>
          ) : (
            <PlanPanel overview={billing.data} billingAvailable={available.billing} />
          )}
        </aside>
      </div>

      {actions.dialogs}
    </div>
  );
}
