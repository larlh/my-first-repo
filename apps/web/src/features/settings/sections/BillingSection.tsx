import { TOP_UP_PACKS } from '@parlante/shared';
import type { BillingOverview, CreditLedgerEntry, Plan, PlanLimits } from '@parlante/shared';
import type { TFunction } from 'i18next';
import { ArrowRight, Check, Coins, FlaskConical, Receipt } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, useApiInfiniteQuery, useApiMutation, useApiQuery } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import type { Formatters } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  LoadMore,
  Skeleton,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
  cn,
  toast,
  useErrorText,
} from '@/ui';
import { Callout } from '../components/Callout';
import { RoleNote } from '../components/RoleGate';
import { Panel, SectionHeader } from '../components/SectionHeader';
import { UsageMeter } from '../components/UsageMeter';
import {
  COMPARISON_ROWS,
  HEADLINE_LIMITS,
  comparisonValue,
  exceededLimits,
  isByteLimit,
  ledgerDetail,
  ledgerKind,
  planChange,
  signedAmount,
  usageLines,
} from '../lib/billing';
import type { ComparisonRow, ExceededLimit, LimitFormat } from '../lib/billing';

type Translate = TFunction<'settings'>;
type TopUpPack = (typeof TOP_UP_PACKS)[number];

function formatLimit(
  value: number | string | boolean,
  kind: LimitFormat,
  format: Formatters,
  t: Translate,
): string {
  switch (kind) {
    case 'bytes':
      return format.bytes(Number(value));
    case 'minutes':
      return t('billing.value.minutes', { count: Math.round(Number(value) / 60) });
    case 'resolution':
      return String(value);
    case 'watermark':
      return value ? t('billing.value.watermarkYes') : t('billing.value.watermarkNo');
    default:
      return format.number(Number(value));
  }
}

function priceLabel(plan: Plan, format: Formatters, t: Translate): string {
  return plan.priceMonthlyCents === 0
    ? t('billing.price.free')
    : t('billing.price.monthly', { price: format.price(plan.priceMonthlyCents) });
}

/* ---------- simulated checkout notice ---------- */

function SimulatedNotice() {
  const { t } = useTranslation('settings');
  return (
    <Callout tone="saffron" icon={<FlaskConical />} title={t('billing.simulated.title')}>
      {t('billing.simulated.text')}
    </Callout>
  );
}

/* ---------- balance and usage ---------- */

function BalancePanel({ overview }: { overview: BillingOverview }) {
  const { t } = useTranslation('settings');
  const format = useFormat();
  const lines = usageLines(overview.usage, overview.limits);
  return (
    <section
      aria-labelledby="balance-title"
      className="grid overflow-hidden rounded-lg border border-line bg-surface shadow-xs lg:grid-cols-[18rem_minmax(0,1fr)]"
    >
      <div className="relative flex flex-col gap-4 bg-sidebar p-5 text-sidebar-fg [--ring:var(--saffron)]">
        <div className="booth-grid absolute inset-0 opacity-20" aria-hidden="true" />
        <div className="relative flex items-center justify-between gap-3">
          <h2 id="balance-title" className="eyebrow">
            {t('billing.balance.title')}
          </h2>
          <Badge tone="saffron" variant="solid">
            {t('billing.balance.plan', { plan: overview.plan.name })}
          </Badge>
        </div>
        <p className="relative flex items-baseline gap-2">
          <Coins className="size-5 shrink-0 self-center text-saffron" aria-hidden="true" />
          <span className="display nums text-5xl">{format.number(overview.credits)}</span>
          <span className="text-sm text-sidebar-fg-muted">
            {t('billing.balance.credits', { count: overview.credits })}
          </span>
        </p>
        <dl className="relative mt-auto grid grid-cols-2 gap-3 border-t border-sidebar-line pt-4 text-sm">
          <div>
            <dt className="text-sidebar-fg-muted">{t('billing.balance.monthly')}</dt>
            <dd className="nums text-base font-semibold">
              {format.number(overview.plan.monthlyCredits)}
            </dd>
          </div>
          <div>
            <dt className="text-sidebar-fg-muted">{t('billing.balance.spent')}</dt>
            <dd className="nums text-base font-semibold">
              {format.number(overview.usage.creditsSpent30d)}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-sidebar-fg-muted">{t('billing.balance.renders')}</dt>
            <dd className="nums text-base font-semibold">
              {format.number(overview.usage.renders30d)}
            </dd>
          </div>
        </dl>
      </div>
      <div className="min-w-0 p-5">
        <h3 className="text-lg leading-6">{t('billing.usage.title')}</h3>
        <p className="mt-1 mb-4 text-sm text-fg-muted">
          {t('billing.usage.text', { plan: overview.plan.name })}
        </p>
        <ul className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {lines.map((line) => (
            <li key={line.key} className="min-w-0">
              <UsageMeter
                label={t(`billing.usage.${line.key}`)}
                valueText={t('billing.usage.of', {
                  used: line.key === 'storage' ? format.bytes(line.used) : format.number(line.used),
                  limit:
                    line.key === 'storage' ? format.bytes(line.limit) : format.number(line.limit),
                })}
                percent={line.percent}
                level={line.level}
              />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ---------- plans ---------- */

function PlanCard({
  plan,
  current,
  isOwner,
  onChoose,
}: {
  plan: Plan;
  current: Plan;
  isOwner: boolean;
  onChoose: (plan: Plan) => void;
}) {
  const { t } = useTranslation('settings');
  const format = useFormat();
  const change = planChange(current.id, plan.id);
  const isCurrent = change === 'current';
  const headline: ComparisonRow[] = COMPARISON_ROWS.filter((row) =>
    (HEADLINE_LIMITS as readonly string[]).includes(row.key),
  );
  return (
    <li
      className={cn(
        'relative flex min-w-0 flex-col gap-4 rounded-lg border bg-surface p-5',
        isCurrent ? 'border-fg shadow-[inset_0_0_0_1px_var(--fg)]' : 'border-line shadow-xs',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="display text-2xl">{plan.name}</h3>
        {isCurrent && <Badge tone="accent">{t('billing.plans.current')}</Badge>}
      </div>
      <p>
        <span className="display nums text-3xl">{priceLabel(plan, format, t)}</span>
      </p>
      <p className="flex items-center gap-2 text-sm font-medium">
        <Coins className="size-4 text-saffron-text" aria-hidden="true" />
        {t('billing.plans.credits', {
          count: plan.monthlyCredits,
          n: format.number(plan.monthlyCredits),
        })}
      </p>
      <ul className="flex flex-col gap-1.5 border-t border-line pt-4 text-sm">
        {headline.map((row) => (
          <li key={row.key} className="flex gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden="true" />
            <span>
              <span className="text-fg-muted">{t(`billing.compare.rows.${row.key}`)}:</span>{' '}
              <span className="font-medium">
                {formatLimit(comparisonValue(plan, row.key), row.format, format, t)}
              </span>
            </span>
          </li>
        ))}
        <li className="flex gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden="true" />
          <span className="font-medium">
            {plan.limits.watermark
              ? t('billing.value.watermarkYes')
              : t('billing.value.watermarkNo')}
          </span>
        </li>
      </ul>
      <div className="mt-auto pt-1">
        {isCurrent ? (
          <p className="flex h-10 items-center text-sm text-fg-muted">
            {t('billing.plans.currentHint')}
          </p>
        ) : (
          <Button
            block
            variant={change === 'upgrade' ? 'primary' : 'secondary'}
            disabled={!isOwner}
            onClick={() => onChoose(plan)}
          >
            {change === 'upgrade'
              ? t('billing.plans.upgrade', { plan: plan.name })
              : t('billing.plans.downgrade', { plan: plan.name })}
          </Button>
        )}
      </div>
    </li>
  );
}

function ComparisonTable({ plans, currentId }: { plans: Plan[]; currentId: string }) {
  const { t } = useTranslation('settings');
  const format = useFormat();
  return (
    <Table aria-label={t('billing.compare.title')} dense>
      <THead>
        <Tr>
          <Th>{t('billing.compare.limit')}</Th>
          {plans.map((plan) => (
            <Th key={plan.id} align="right">
              {plan.name}
              {plan.id === currentId && (
                <span className="sr-only"> ({t('billing.plans.current')})</span>
              )}
            </Th>
          ))}
        </Tr>
      </THead>
      <TBody>
        <Tr>
          <th scope="row" className="px-4 py-2 text-left text-sm font-medium">
            {t('billing.compare.price')}
          </th>
          {plans.map((plan) => (
            <Td key={plan.id} align="right" className="nums whitespace-nowrap">
              {priceLabel(plan, format, t)}
            </Td>
          ))}
        </Tr>
        {COMPARISON_ROWS.map((row) => (
          <Tr key={row.key}>
            <th scope="row" className="px-4 py-2 text-left text-sm font-medium">
              {t(`billing.compare.rows.${row.key}`)}
            </th>
            {plans.map((plan) => (
              <Td
                key={plan.id}
                align="right"
                className={cn(
                  'nums whitespace-nowrap',
                  plan.id === currentId && 'bg-accent-soft/40 font-medium',
                )}
              >
                {formatLimit(comparisonValue(plan, row.key), row.format, format, t)}
              </Td>
            ))}
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

function ExceededList({ items }: { items: ExceededLimit[] }) {
  const { t } = useTranslation('settings');
  const format = useFormat();
  const show = (limit: string, value: number) =>
    isByteLimit(limit) ? format.bytes(value) : format.number(value);
  return (
    <ul className="mt-2 list-disc space-y-1 pl-5">
      {items.map((item) => (
        <li key={item.limit}>
          {t('billing.change.exceededItem', {
            limit: t(`billing.compare.rows.${item.limit as keyof PlanLimits}`),
            value: show(item.limit, item.value),
            max: show(item.limit, item.max),
          })}
        </li>
      ))}
    </ul>
  );
}

/** Confirmation of a plan change. Says in plain words that nothing is charged. */
function ChangePlanDialog({
  target,
  current,
  onClose,
}: {
  target: Plan | null;
  current: Plan;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const format = useFormat();
  const session = useSession();
  const errorText = useErrorText();
  const [failure, setFailure] = useState<ApiError | null>(null);
  const change = useApiMutation(api.billing.changePlan, {
    invalidates: [api.billing.overview, api.billing.ledger],
    onSuccess: async (result) => {
      await session.refresh();
      toast.success(t('billing.change.done', { plan: target?.name ?? '' }), {
        description: result.entry
          ? t('billing.change.doneCredits', {
              count: result.entry.delta,
              n: format.number(result.entry.delta),
            })
          : t('billing.change.doneSimulated'),
      });
      close();
    },
    onError: (error) => setFailure(error),
  });
  const close = () => {
    setFailure(null);
    change.reset();
    onClose();
  };
  if (!target) return null;
  const kind = planChange(current.id, target.id);
  const exceeded = exceededLimits(failure);

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && !change.isPending && close()}
      dismissible={!change.isPending}
      title={t('billing.change.title', { plan: target.name })}
      description={t('billing.change.text')}
      footer={
        <>
          <Button onClick={close} disabled={change.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={change.isPending}
            onClick={() => {
              setFailure(null);
              change.mutate({ body: { planId: target.id } });
            }}
          >
            {t('billing.change.confirm', { plan: target.name })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-center gap-4 rounded-lg bg-surface-2 px-4 py-5 text-center">
          <div className="min-w-0">
            <p className="eyebrow text-fg-muted">{t('billing.change.from')}</p>
            <p className="display text-2xl">{current.name}</p>
            <p className="nums text-sm text-fg-muted">{priceLabel(current, format, t)}</p>
          </div>
          <ArrowRight className="size-5 shrink-0 text-fg-subtle" aria-hidden="true" />
          <div className="min-w-0">
            <p className="eyebrow text-accent-text">{t('billing.change.to')}</p>
            <p className="display text-2xl">{target.name}</p>
            <p className="nums text-sm text-fg-muted">{priceLabel(target, format, t)}</p>
          </div>
        </div>
        <p className="text-sm text-fg-muted">
          {kind === 'upgrade'
            ? t('billing.change.upgradeNote', {
                count: target.monthlyCredits,
                n: format.number(target.monthlyCredits),
              })
            : t('billing.change.downgradeNote')}
        </p>
        <Callout tone="saffron" icon={<FlaskConical />} title={t('billing.change.noCharge')}>
          {t('billing.change.noChargeText')}
        </Callout>
        {failure && (
          <Callout
            tone="danger"
            role="alert"
            title={
              exceeded.length > 0
                ? t('billing.change.exceeded', { plan: target.name })
                : errorText(failure).title
            }
          >
            {exceeded.length > 0 ? <ExceededList items={exceeded} /> : failure.message}
          </Callout>
        )}
      </div>
    </Dialog>
  );
}

/* ---------- credit packs ---------- */

function TopUpPanel({ isOwner }: { isOwner: boolean }) {
  const { t } = useTranslation('settings');
  const format = useFormat();
  const session = useSession();
  const errorText = useErrorText();
  const [pack, setPack] = useState<TopUpPack | null>(null);
  const topUp = useApiMutation(api.billing.topUp, {
    invalidates: [api.billing.overview, api.billing.ledger],
    onSuccess: async (result) => {
      await session.refresh();
      const added = result.entry?.delta ?? pack ?? 0;
      toast.success(t('billing.topUp.done', { count: added, n: format.number(added) }), {
        description: t('billing.change.doneSimulated'),
      });
      setPack(null);
    },
    onError: (error) =>
      toast.error(errorText(error).title, { description: errorText(error).message }),
  });
  return (
    <Panel id="top-up" title={t('billing.topUp.title')} description={t('billing.topUp.text')}>
      <ul className="grid gap-3 sm:grid-cols-3">
        {TOP_UP_PACKS.map((credits) => (
          <li key={credits}>
            <button
              type="button"
              disabled={!isOwner}
              onClick={() => setPack(credits)}
              className={cn(
                'group flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-4 py-3.5 text-left',
                'transition-[border-color,background-color] duration-150 hover:border-line-strong hover:bg-surface-3',
                'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-line disabled:hover:bg-surface-2',
              )}
            >
              <span className="flex items-baseline gap-2">
                <span className="display nums text-2xl">+{format.number(credits)}</span>
                <span className="text-sm text-fg-muted">{t('billing.topUp.unit')}</span>
              </span>
              <Coins className="size-5 text-saffron-text" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <Dialog
        open={pack !== null}
        onOpenChange={(next) => !next && !topUp.isPending && setPack(null)}
        dismissible={!topUp.isPending}
        size="sm"
        title={t('billing.topUp.confirmTitle', { count: pack ?? 0, n: format.number(pack ?? 0) })}
        footer={
          <>
            <Button onClick={() => setPack(null)} disabled={topUp.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={topUp.isPending}
              onClick={() => pack !== null && topUp.mutate({ body: { credits: pack } })}
            >
              {t('billing.topUp.confirm')}
            </Button>
          </>
        }
      >
        <Callout tone="saffron" icon={<FlaskConical />} title={t('billing.change.noCharge')}>
          {t('billing.topUp.noChargeText')}
        </Callout>
      </Dialog>
    </Panel>
  );
}

/* ---------- ledger ---------- */

const LEDGER_TONE = {
  grant: 'text-success-text',
  refund: 'text-info-text',
  spend: 'text-fg',
} as const;

function LedgerRow({ entry }: { entry: CreditLedgerEntry }) {
  const { t, i18n } = useTranslation('settings');
  const format = useFormat();
  const kind = ledgerKind(entry.reason, entry.delta);
  const detail = ledgerDetail(entry.description, i18n.language);
  return (
    <Tr>
      <Td className="whitespace-nowrap text-fg-muted">{format.dateTime(entry.createdAt)}</Td>
      <Td className="min-w-48">
        <p className="font-medium">{t(`billing.ledger.reason.${entry.reason}`)}</p>
        {detail && <p className="text-xs text-fg-muted">{detail}</p>}
      </Td>
      <Td align="right" className={cn('nums font-semibold whitespace-nowrap', LEDGER_TONE[kind])}>
        {signedAmount(entry.delta, format.number)}
      </Td>
      <Td align="right" className="nums whitespace-nowrap text-fg-muted">
        {format.number(entry.balanceAfter)}
      </Td>
    </Tr>
  );
}

function LedgerPanel() {
  const { t } = useTranslation('settings');
  const ledger = useApiInfiniteQuery(api.billing.ledger, { query: { limit: 15 } });
  return (
    <Panel id="ledger" title={t('billing.ledger.title')} description={t('billing.ledger.text')}>
      {ledger.isPending ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-8" />
          ))}
        </div>
      ) : ledger.isError ? (
        <ErrorState
          size="sm"
          error={ledger.error}
          onRetry={() => void ledger.refetch()}
          retrying={ledger.isRefetching}
        />
      ) : ledger.items.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<Receipt />}
          title={t('billing.ledger.empty')}
          description={t('billing.ledger.emptyText')}
        />
      ) : (
        <>
          <Table aria-label={t('billing.ledger.title')} dense>
            <THead>
              <Tr>
                <Th>{t('billing.ledger.date')}</Th>
                <Th>{t('billing.ledger.concept')}</Th>
                <Th align="right">{t('billing.ledger.amount')}</Th>
                <Th align="right">{t('billing.ledger.balance')}</Th>
              </Tr>
            </THead>
            <TBody>
              {ledger.items.map((entry) => (
                <LedgerRow key={entry.id} entry={entry} />
              ))}
            </TBody>
          </Table>
          <LoadMore
            hasMore={ledger.hasNextPage}
            loading={ledger.isFetchingNextPage}
            onLoadMore={() => void ledger.fetchNextPage()}
            className="mt-3"
          />
        </>
      )}
    </Panel>
  );
}

/* ---------- section ---------- */

export default function BillingSection() {
  const { t } = useTranslation('settings');
  const session = useSession();
  const isOwner = session.can('owner');
  const overview = useApiQuery(api.billing.overview);
  const [target, setTarget] = useState<Plan | null>(null);

  return (
    <>
      <SectionHeader
        title={t('sections.billing.title')}
        description={t('sections.billing.text')}
        meta={
          <Badge tone="saffron" icon={<FlaskConical aria-hidden="true" />}>
            {t('billing.simulated.badge')}
          </Badge>
        }
      />
      <div className="flex flex-col gap-5">
        <SimulatedNotice />
        {overview.isPending ? (
          <>
            <Skeleton className="h-56 rounded-lg" />
            <Skeleton className="h-72 rounded-lg" />
          </>
        ) : overview.isError ? (
          <div className="rounded-lg border border-line bg-surface">
            <ErrorState
              error={overview.error}
              onRetry={() => void overview.refetch()}
              retrying={overview.isRefetching}
            />
          </div>
        ) : (
          <>
            <BalancePanel overview={overview.data} />
            <Panel
              id="plans"
              title={t('billing.plans.title')}
              description={t('billing.plans.text')}
            >
              <RoleNote min="owner">{t('billing.ownerOnly')}</RoleNote>
              <ul className="grid gap-4 md:grid-cols-3">
                {overview.data.plans.map((plan) => (
                  <PlanCard
                    key={plan.id}
                    plan={plan}
                    current={overview.data.plan}
                    isOwner={isOwner}
                    onChoose={setTarget}
                  />
                ))}
              </ul>
              <details className="group mt-5">
                <summary className="inline-flex cursor-pointer items-center gap-1.5 rounded-xs text-sm font-medium text-accent-text underline-offset-4 hover:underline">
                  {t('billing.compare.toggle')}
                </summary>
                <div className="mt-4">
                  <ComparisonTable plans={overview.data.plans} currentId={overview.data.plan.id} />
                </div>
              </details>
            </Panel>
            <TopUpPanel isOwner={isOwner} />
            <ChangePlanDialog
              target={target}
              current={overview.data.plan}
              onClose={() => setTarget(null)}
            />
          </>
        )}
        <LedgerPanel />
      </div>
    </>
  );
}
