import type { WebhookDelivery, WebhookEndpoint, WebhookEndpointCreated } from '@parlante/shared';
import {
  ChevronDown,
  Ellipsis,
  KeyRound,
  Pencil,
  Plus,
  RotateCw,
  Send,
  ShieldAlert,
  Trash2,
  Webhook,
} from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, useApiInfiniteQuery, useApiMutation, useApiQuery, useInvalidateApi } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  LoadMore,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Skeleton,
  Switch,
  cn,
  toast,
  useConfirm,
  useErrorText,
} from '@/ui';
import { Callout } from '../components/Callout';
import { LockedSection } from '../components/RoleGate';
import { SecretField } from '../components/SecretField';
import { Panel, SectionHeader } from '../components/SectionHeader';
import { UsageMeter } from '../components/UsageMeter';
import { usageLevel, usagePercent } from '../lib/billing';
import {
  SUBSCRIBABLE_EVENTS,
  VERIFY_SNIPPET,
  checkWebhookUrl,
  deliveryView,
  eventKey,
  hasActiveDeliveries,
} from '../lib/webhooks';
import type { SubscribableEvent } from '../lib/webhooks';
import { sectionPath } from '../sections';

const DESCRIPTION_MAX = 200;
const POLL_MS = 2000;

/* ---------- create / edit ---------- */

function EndpointDialog({
  open,
  onOpenChange,
  endpoint,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing. */
  endpoint?: WebhookEndpoint;
  onCreated: (created: WebhookEndpointCreated) => void;
}) {
  const { t } = useTranslation('settings');
  const errorText = useErrorText();
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [events, setEvents] = useState<SubscribableEvent[]>(
    endpoint
      ? SUBSCRIBABLE_EVENTS.filter((event) => endpoint.events.includes(event))
      : [...SUBSCRIBABLE_EVENTS],
  );
  const [urlError, setUrlError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const onError = (error: ApiError) => {
    if (error.is('UNSAFE_URL')) setUrlError(t('webhooks.form.unsafe'));
    else if (error.is('PLAN_LIMIT_EXCEEDED')) setFormError(t('webhooks.form.full'));
    else if (error.is('VALIDATION_ERROR')) setUrlError(t('webhooks.form.url.invalid'));
    else setFormError(errorText(error).title);
  };
  const create = useApiMutation(api.webhooks.create, {
    invalidates: [api.webhooks.list, api.billing.overview],
    onSuccess: (created) => {
      onOpenChange(false);
      onCreated(created);
    },
    onError,
  });
  const update = useApiMutation(api.webhooks.update, {
    invalidates: [api.webhooks.list],
    onSuccess: () => {
      onOpenChange(false);
      toast.success(t('webhooks.saved'));
    },
    onError,
  });
  const busy = create.isPending || update.isPending;
  const check = checkWebhookUrl(url);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setUrlError(check.error ? t(`webhooks.form.url.${check.error}`) : null);
    setEventsError(events.length === 0 ? t('webhooks.form.eventsRequired') : null);
    if (check.error || events.length === 0) return;
    const body = { url: url.trim(), events, description: description.trim() };
    if (endpoint) update.mutate({ params: { webhookId: endpoint.id }, body });
    else create.mutate({ body });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      dismissible={!busy}
      title={endpoint ? t('webhooks.form.editTitle') : t('webhooks.form.createTitle')}
      description={t('webhooks.form.text')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="webhook-form" variant="primary" loading={busy}>
            {endpoint ? t('webhooks.form.save') : t('webhooks.form.create')}
          </Button>
        </>
      }
    >
      <form id="webhook-form" onSubmit={submit} noValidate className="flex flex-col gap-5">
        <Input
          label={t('webhooks.form.url.label')}
          name="webhook-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://ejemplo.com/hooks/parlante"
          required
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setUrlError(null);
          }}
          error={urlError ?? undefined}
          hint={
            check.warning === 'insecure'
              ? t('webhooks.form.url.insecure')
              : t('webhooks.form.url.hint')
          }
          className="font-mono"
        />
        <fieldset className="min-w-0">
          <legend className="mb-2 text-sm font-semibold">{t('webhooks.form.events')}</legend>
          <div className="flex flex-col gap-3 rounded-md border border-line p-3.5">
            {SUBSCRIBABLE_EVENTS.map((event) => (
              <Checkbox
                key={event}
                checked={events.includes(event)}
                onCheckedChange={(checked) => {
                  setEventsError(null);
                  setEvents((current) =>
                    checked ? [...current, event] : current.filter((item) => item !== event),
                  );
                }}
                label={<code className="font-mono text-sm font-medium">{event}</code>}
                description={t(`webhooks.events.${eventKey(event)}`)}
              />
            ))}
          </div>
          {eventsError ? (
            <p role="alert" className="mt-1.5 text-sm font-medium text-danger-text">
              {eventsError}
            </p>
          ) : (
            <p className="mt-1.5 text-sm text-fg-muted">{t('webhooks.form.pingHint')}</p>
          )}
        </fieldset>
        <Input
          label={t('webhooks.form.description')}
          optionalLabel={t('common.optional')}
          name="webhook-description"
          maxLength={DESCRIPTION_MAX}
          placeholder={t('webhooks.form.descriptionPlaceholder')}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        {formError && (
          <Callout tone="danger" role="alert">
            {formError}
          </Callout>
        )}
      </form>
    </Dialog>
  );
}

/** The signing secret is shown once: on creation and after a rotation. */
function SecretDialog({
  created,
  rotated,
  onClose,
}: {
  created: WebhookEndpointCreated | null;
  rotated: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <Dialog
      open={created !== null}
      onOpenChange={(next) => !next && onClose()}
      dismissible={false}
      size="lg"
      title={rotated ? t('webhooks.secret.rotatedTitle') : t('webhooks.secret.createdTitle')}
      description={t('webhooks.secret.text')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('webhooks.secret.done')}
        </Button>
      }
    >
      {created && (
        <div className="flex flex-col gap-5">
          <Callout tone="warning" icon={<ShieldAlert />} title={t('webhooks.secret.onceTitle')}>
            {t('webhooks.secret.onceText')}
          </Callout>
          <SecretField label={t('webhooks.secret.label')} value={created.secret} />
          <p className="text-sm text-fg-muted">
            {t('webhooks.secret.endpoint')}{' '}
            <code className="font-mono text-xs break-all text-fg">{created.url}</code>
          </p>
        </div>
      )}
    </Dialog>
  );
}

/* ---------- deliveries ---------- */

function DeliveryRow({ delivery, webhookId }: { delivery: WebhookDelivery; webhookId: string }) {
  const { t } = useTranslation('settings');
  const format = useFormat();
  const errorText = useErrorText();
  const view = deliveryView(delivery);
  const retry = useApiMutation(api.webhooks.retryDelivery, {
    invalidates: [api.webhooks.listDeliveries],
    onSuccess: () => toast.success(t('webhooks.deliveries.requeued')),
    onError: (error) => toast.error(errorText(error).title, { description: error.message }),
  });
  return (
    <li
      data-webhook={webhookId}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
    >
      <div className="col-span-2 sm:col-span-1">
        <Badge tone={view.tone} dot pulse={view.active}>
          {t(`webhooks.deliveries.state.${view.state}`)}
        </Badge>
      </div>
      <div className="min-w-0 text-sm">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <code className="font-mono text-xs font-medium">{delivery.eventType}</code>
          <span className="text-fg-muted">{format.dateTime(delivery.createdAt)}</span>
        </p>
        <p className="nums mt-0.5 text-fg-muted">
          {[
            t('webhooks.deliveries.attempts', { count: delivery.attempts }),
            delivery.responseStatus !== null
              ? t('webhooks.deliveries.http', { status: delivery.responseStatus })
              : null,
            delivery.durationMs !== null
              ? t('webhooks.deliveries.took', { ms: format.number(delivery.durationMs) })
              : null,
            view.state === 'retrying' && delivery.nextRetryAt
              ? t('webhooks.deliveries.nextRetry', { when: format.relative(delivery.nextRetryAt) })
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {delivery.error && (
          <p className="mt-1 font-mono text-xs break-words text-danger-text">{delivery.error}</p>
        )}
      </div>
      <div className="flex justify-end">
        {view.canRetry && (
          <Button
            size="sm"
            leftIcon={<RotateCw aria-hidden="true" />}
            loading={retry.isPending}
            onClick={() => retry.mutate({ params: { deliveryId: delivery.id } })}
          >
            {t('webhooks.deliveries.retry')}
          </Button>
        )}
      </div>
    </li>
  );
}

function Deliveries({ endpoint }: { endpoint: WebhookEndpoint }) {
  const { t } = useTranslation('settings');
  const [live, setLive] = useState(false);
  const deliveries = useApiInfiniteQuery(
    api.webhooks.listDeliveries,
    { params: { webhookId: endpoint.id }, query: { limit: 10 } },
    { refetchInterval: live ? POLL_MS : false },
  );
  // Poll only while something is still being attempted (state derived from the data itself).
  const active = hasActiveDeliveries(deliveries.items);
  if (active !== live) setLive(active);

  return (
    <div className="border-t border-line bg-bg-sunken/60 px-5 py-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="eyebrow text-fg-muted">{t('webhooks.deliveries.title')}</h3>
        {active && <span className="text-xs text-fg-muted">{t('webhooks.deliveries.live')}</span>}
      </div>
      {deliveries.isPending ? (
        <div className="flex flex-col gap-3 py-3" aria-hidden="true">
          <Skeleton className="w-72 max-w-full" />
          <Skeleton className="w-56 max-w-full" />
        </div>
      ) : deliveries.isError ? (
        <ErrorState
          size="sm"
          error={deliveries.error}
          onRetry={() => void deliveries.refetch()}
          retrying={deliveries.isRefetching}
        />
      ) : deliveries.items.length === 0 ? (
        <p className="py-4 text-sm text-fg-muted">{t('webhooks.deliveries.empty')}</p>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {deliveries.items.map((delivery) => (
              <DeliveryRow key={delivery.id} delivery={delivery} webhookId={endpoint.id} />
            ))}
          </ul>
          <LoadMore
            hasMore={deliveries.hasNextPage}
            loading={deliveries.isFetchingNextPage}
            onLoadMore={() => void deliveries.fetchNextPage()}
            className="mt-2"
          />
        </>
      )}
    </div>
  );
}

/* ---------- endpoint card ---------- */

function EndpointCard({
  endpoint,
  onSecret,
}: {
  endpoint: WebhookEndpoint;
  onSecret: (created: WebhookEndpointCreated, rotated: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const format = useFormat();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const invalidate = useInvalidateApi();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const report = (error: ApiError) =>
    toast.error(errorText(error).title, { description: error.message });

  const toggle = useApiMutation(api.webhooks.update, {
    invalidates: [api.webhooks.list],
    onError: report,
  });
  const test = useApiMutation(api.webhooks.test, {
    onSuccess: async () => {
      setExpanded(true);
      await invalidate(api.webhooks.listDeliveries);
      toast.success(t('webhooks.test.queued'), { description: t('webhooks.test.queuedText') });
    },
    onError: (error) =>
      error.is('SERVICE_UNAVAILABLE')
        ? toast.error(t('webhooks.test.unavailable'), { description: error.message })
        : report(error),
  });
  const rotate = useApiMutation(api.webhooks.rotateSecret, {
    invalidates: [api.webhooks.list],
    onSuccess: (created) => onSecret(created, true),
    onError: report,
  });
  const remove = useApiMutation(api.webhooks.remove, {
    invalidates: [api.webhooks.list, api.billing.overview],
    onSuccess: () => toast.success(t('webhooks.deleted')),
    onError: report,
  });

  const onRotate = async () => {
    const ok = await confirm({
      title: t('webhooks.rotate.title'),
      description: t('webhooks.rotate.text'),
      confirmLabel: t('webhooks.rotate.action'),
      tone: 'danger',
    });
    if (ok) rotate.mutate({ params: { webhookId: endpoint.id } });
  };
  const onRemove = async () => {
    const ok = await confirm({
      title: t('webhooks.remove.title'),
      description: t('webhooks.remove.text', { url: endpoint.url }),
      confirmLabel: t('webhooks.remove.action'),
      tone: 'danger',
    });
    if (ok) remove.mutate({ params: { webhookId: endpoint.id } });
  };

  const subscribed = endpoint.events.filter((event) => event !== 'ping');
  const panelId = `deliveries-${endpoint.id}`;

  return (
    <li className="overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={cn(
              'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md',
              endpoint.enabled
                ? 'bg-success-soft text-success-text'
                : 'bg-surface-3 text-fg-subtle',
            )}
          >
            <Webhook className="size-[1.125rem]" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-mono text-sm leading-6 font-medium break-all">{endpoint.url}</h3>
            {endpoint.description && (
              <p className="text-sm text-fg-muted">{endpoint.description}</p>
            )}
          </div>
          <Menu>
            <MenuTrigger asChild>
              <IconButton
                label={t('webhooks.more', { url: endpoint.url })}
                size="sm"
                noTooltip
                loading={rotate.isPending || remove.isPending}
              >
                <Ellipsis aria-hidden="true" />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
                {t('webhooks.edit')}
              </MenuItem>
              <MenuItem icon={<KeyRound />} onSelect={() => void onRotate()}>
                {t('webhooks.rotate.action')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem tone="danger" icon={<Trash2 />} onSelect={() => void onRemove()}>
                {t('webhooks.remove.action')}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
          <ul className="flex flex-wrap gap-1.5" aria-label={t('webhooks.form.events')}>
            {subscribed.map((event) => (
              <li key={event}>
                <code className="rounded-xs bg-surface-3 px-1.5 py-0.5 font-mono text-xs">
                  {event}
                </code>
              </li>
            ))}
          </ul>
          <span className="text-fg-muted">
            {t('webhooks.secretPreview')}{' '}
            <code className="font-mono text-xs text-fg">••••{endpoint.secretPreview}</code>
          </span>
          <span className="text-fg-muted">
            {t('webhooks.created', { date: format.date(endpoint.createdAt) })}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <Switch
            checked={endpoint.enabled}
            disabled={toggle.isPending}
            onCheckedChange={(enabled) =>
              toggle.mutate({ params: { webhookId: endpoint.id }, body: { enabled } })
            }
            label={endpoint.enabled ? t('webhooks.enabled') : t('webhooks.disabled')}
            size="sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              leftIcon={<Send aria-hidden="true" />}
              loading={test.isPending}
              onClick={() => test.mutate({ params: { webhookId: endpoint.id } })}
            >
              {t('webhooks.test.action')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={expanded}
              aria-controls={panelId}
              rightIcon={
                <ChevronDown
                  aria-hidden="true"
                  className={cn('transition-transform duration-150', expanded && 'rotate-180')}
                />
              }
              onClick={() => setExpanded((value) => !value)}
            >
              {t('webhooks.deliveries.toggle')}
            </Button>
          </div>
        </div>
      </div>
      <div id={panelId} hidden={!expanded}>
        {expanded && <Deliveries endpoint={endpoint} />}
      </div>
      {editing && (
        <EndpointDialog
          open
          onOpenChange={setEditing}
          endpoint={endpoint}
          onCreated={() => undefined}
        />
      )}
    </li>
  );
}

/* ---------- section ---------- */

function Webhooks() {
  const { t } = useTranslation('settings');
  const session = useSession();
  const format = useFormat();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{
    created: WebhookEndpointCreated;
    rotated: boolean;
  } | null>(null);
  const endpoints = useApiQuery(api.webhooks.list);
  const items = endpoints.data?.items ?? [];
  const limit = session.plan.limits.maxWebhookEndpoints;
  const full = items.length >= limit;

  return (
    <>
      <SectionHeader
        title={t('sections.webhooks.title')}
        description={t('sections.webhooks.text')}
        actions={
          <Button
            variant="primary"
            leftIcon={<Plus aria-hidden="true" />}
            disabled={endpoints.isPending || full}
            onClick={() => setCreating(true)}
          >
            {t('webhooks.add')}
          </Button>
        }
      />
      <div className="flex flex-col gap-5">
        {endpoints.isSuccess && (
          <div className="rounded-lg border border-line bg-surface p-5 shadow-xs">
            <UsageMeter
              label={t('webhooks.usage.label', { plan: session.plan.name })}
              valueText={t('webhooks.usage.value', {
                used: format.number(items.length),
                limit: format.number(limit),
              })}
              percent={usagePercent(items.length, limit)}
              level={usageLevel(items.length, limit)}
            />
            {full && (
              <p className="mt-2.5 text-sm text-fg-muted">
                <span className="font-medium text-danger-text">{t('webhooks.usage.full')}</span>{' '}
                <Link
                  to={sectionPath('billing')}
                  className="font-medium text-accent-text underline-offset-4 hover:underline"
                >
                  {t('webhooks.usage.upgrade')}
                </Link>
              </p>
            )}
          </div>
        )}

        {endpoints.isPending ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : endpoints.isError ? (
          <div className="rounded-lg border border-line bg-surface">
            <ErrorState
              size="sm"
              error={endpoints.error}
              onRetry={() => void endpoints.refetch()}
              retrying={endpoints.isRefetching}
            />
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface">
            <EmptyState
              icon={<Webhook />}
              title={t('webhooks.empty.title')}
              description={t('webhooks.empty.text')}
              action={
                <Button variant="primary" onClick={() => setCreating(true)}>
                  {t('webhooks.add')}
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="flex flex-col gap-4" aria-label={t('webhooks.list')}>
            {items.map((endpoint) => (
              <EndpointCard
                key={endpoint.id}
                endpoint={endpoint}
                onSecret={(created, rotated) => setSecret({ created, rotated })}
              />
            ))}
          </ul>
        )}

        <Panel
          id="signature"
          title={t('webhooks.verify.title')}
          description={t('webhooks.verify.text')}
        >
          <dl className="mb-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="font-mono text-xs font-medium">Parlante-Event</dt>
            <dd className="text-fg-muted">{t('webhooks.verify.headers.event')}</dd>
            <dt className="font-mono text-xs font-medium">Parlante-Delivery</dt>
            <dd className="text-fg-muted">{t('webhooks.verify.headers.delivery')}</dd>
            <dt className="font-mono text-xs font-medium">Parlante-Signature</dt>
            <dd className="text-fg-muted">{t('webhooks.verify.headers.signature')}</dd>
          </dl>
          <pre
            tabIndex={0}
            aria-label={t('webhooks.verify.snippet')}
            className="overflow-x-auto rounded-md bg-media p-4 font-mono text-xs leading-5 text-on-media [--ring:var(--saffron)]"
          >
            <code>{VERIFY_SNIPPET}</code>
          </pre>
        </Panel>
      </div>

      {creating && (
        <EndpointDialog
          open
          onOpenChange={setCreating}
          onCreated={(created) => setSecret({ created, rotated: false })}
        />
      )}
      <SecretDialog
        created={secret?.created ?? null}
        rotated={secret?.rotated ?? false}
        onClose={() => setSecret(null)}
      />
    </>
  );
}

export default function WebhooksSection() {
  const { t } = useTranslation('settings');
  const session = useSession();
  if (!session.can('admin')) {
    return (
      <>
        <SectionHeader
          title={t('sections.webhooks.title')}
          description={t('sections.webhooks.text')}
        />
        <LockedSection min="admin" what={t('webhooks.locked')} />
      </>
    );
  }
  return <Webhooks />;
}
