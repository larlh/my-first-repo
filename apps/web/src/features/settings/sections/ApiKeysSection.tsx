import type { ApiKey, ApiKeyCreated } from '@parlante/shared';
import { KeyRound, Plus, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, useApiMutation, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  Skeleton,
  cn,
  toast,
  useConfirm,
  useErrorText,
} from '@/ui';
import { ApiDocsPanel } from '../components/ApiDocsPanel';
import { Callout } from '../components/Callout';
import { LockedSection } from '../components/RoleGate';
import { SecretField } from '../components/SecretField';
import { SectionHeader } from '../components/SectionHeader';
import { UsageMeter } from '../components/UsageMeter';
import { usageLevel, usagePercent } from '../lib/billing';
import { curlExample } from '../lib/urls';
import { sectionPath } from '../sections';

const NAME_MAX = 60;

function CreateKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const errorText = useErrorText();
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);

  const create = useApiMutation(api.apiKeys.create, {
    invalidates: [api.apiKeys.list, api.billing.overview],
    onSuccess: (key) => setCreated(key),
    onError: (error) =>
      setFormError(
        error.is('PLAN_LIMIT_EXCEEDED') ? t('apiKeys.create.full') : errorText(error).title,
      ),
  });

  const close = (next: boolean) => {
    if (create.isPending) return;
    onOpenChange(next);
    if (!next) {
      setName('');
      setFieldError(null);
      setFormError(null);
      setCreated(null);
      create.reset();
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const trimmed = name.trim();
    if (trimmed === '') {
      setFieldError(t('apiKeys.create.nameRequired'));
      return;
    }
    setFieldError(null);
    create.mutate({ body: { name: trimmed } });
  };

  if (created) {
    // The plain key exists only in this response: closing by accident would lose it.
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        dismissible={false}
        size="lg"
        title={t('apiKeys.created.title', { name: created.name })}
        description={t('apiKeys.created.text')}
        footer={
          <Button variant="primary" onClick={() => close(false)}>
            {t('apiKeys.created.done')}
          </Button>
        }
      >
        <div className="flex flex-col gap-5">
          <Callout tone="warning" icon={<ShieldAlert />} title={t('apiKeys.created.onceTitle')}>
            {t('apiKeys.created.onceText')}
          </Callout>
          <SecretField label={t('apiKeys.created.key')} value={created.key} />
          <SecretField
            label={t('apiKeys.created.try')}
            value={curlExample(created.key)}
            multiline
            hint={t('apiKeys.created.tryHint')}
          />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      dismissible={!create.isPending}
      title={t('apiKeys.create.title')}
      description={t('apiKeys.create.text')}
      footer={
        <>
          <Button onClick={() => close(false)} disabled={create.isPending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="api-key-form" variant="primary" loading={create.isPending}>
            {t('apiKeys.create.action')}
          </Button>
        </>
      }
    >
      <form id="api-key-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Input
          label={t('apiKeys.create.name')}
          name="api-key-name"
          placeholder={t('apiKeys.create.namePlaceholder')}
          hint={t('apiKeys.create.nameHint')}
          maxLength={NAME_MAX}
          autoComplete="off"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={fieldError ?? undefined}
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

function KeyRow({ apiKey }: { apiKey: ApiKey }) {
  const { t } = useTranslation('settings');
  const format = useFormat();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const revoked = apiKey.revokedAt !== null;
  const revoke = useApiMutation(api.apiKeys.revoke, {
    invalidates: [api.apiKeys.list, api.billing.overview],
    onSuccess: () => toast.success(t('apiKeys.revoked', { name: apiKey.name })),
    onError: (error) =>
      toast.error(errorText(error).title, { description: errorText(error).message }),
  });
  const onRevoke = async () => {
    const ok = await confirm({
      title: t('apiKeys.revoke.title', { name: apiKey.name }),
      description: t('apiKeys.revoke.text'),
      confirmLabel: t('apiKeys.revoke.action'),
      tone: 'danger',
    });
    if (ok) revoke.mutate({ params: { apiKeyId: apiKey.id } });
  };
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className={cn('truncate font-semibold', revoked && 'text-fg-muted line-through')}>
            {apiKey.name}
          </span>
          <code className="rounded-xs bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-fg-muted">
            {apiKey.prefix}…
          </code>
        </p>
        <p className="mt-0.5 text-sm text-fg-muted">
          {apiKey.createdBy
            ? t('apiKeys.createdBy', {
                name: apiKey.createdBy.name,
                date: format.date(apiKey.createdAt),
              })
            : t('apiKeys.createdOn', { date: format.date(apiKey.createdAt) })}
          {' · '}
          {apiKey.lastUsedAt
            ? t('apiKeys.lastUsed', { when: format.relative(apiKey.lastUsedAt) })
            : t('apiKeys.neverUsed')}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {revoked ? (
          <Badge tone="neutral" variant="outline">
            {t('apiKeys.status.revoked', { date: format.date(apiKey.revokedAt ?? '') })}
          </Badge>
        ) : (
          <>
            <Badge tone="success" dot>
              {t('apiKeys.status.active')}
            </Badge>
            <Button size="sm" loading={revoke.isPending} onClick={() => void onRevoke()}>
              {t('apiKeys.revoke.action')}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

function ApiKeys() {
  const { t } = useTranslation('settings');
  const session = useSession();
  const format = useFormat();
  const [creating, setCreating] = useState(false);
  const keys = useApiQuery(api.apiKeys.list);

  const items = keys.data?.items ?? [];
  const active = items.filter((key) => key.revokedAt === null);
  const revoked = items.filter((key) => key.revokedAt !== null);
  const limit = session.plan.limits.maxApiKeys;
  const full = active.length >= limit;

  return (
    <>
      <SectionHeader
        title={t('sections.apiKeys.title')}
        description={t('sections.apiKeys.text')}
        actions={
          <Button
            variant="primary"
            leftIcon={<Plus aria-hidden="true" />}
            disabled={keys.isPending || full}
            onClick={() => setCreating(true)}
          >
            {t('apiKeys.create.open')}
          </Button>
        }
      />
      <div className="flex flex-col gap-5">
        {keys.isSuccess && (
          <div className="rounded-lg border border-line bg-surface p-5 shadow-xs">
            <UsageMeter
              label={t('apiKeys.usage.label', { plan: session.plan.name })}
              valueText={t('apiKeys.usage.value', {
                used: format.number(active.length),
                limit: format.number(limit),
              })}
              percent={usagePercent(active.length, limit)}
              level={usageLevel(active.length, limit)}
            />
            {full && (
              <p className="mt-2.5 text-sm text-fg-muted">
                <span className="font-medium text-danger-text">{t('apiKeys.usage.full')}</span>{' '}
                <Link
                  to={sectionPath('billing')}
                  className="font-medium text-accent-text underline-offset-4 hover:underline"
                >
                  {t('apiKeys.usage.upgrade')}
                </Link>
              </p>
            )}
          </div>
        )}

        <section
          aria-labelledby="keys-title"
          className="rounded-lg border border-line bg-surface shadow-xs"
        >
          <h2 id="keys-title" className="px-5 pt-5 pb-3 text-lg leading-6">
            {t('apiKeys.list.title')}
          </h2>
          {keys.isPending ? (
            <div className="flex flex-col gap-3 border-t border-line px-5 py-4" aria-hidden="true">
              <Skeleton className="w-56 max-w-full" />
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
          ) : keys.isError ? (
            <ErrorState
              size="sm"
              error={keys.error}
              onRetry={() => void keys.refetch()}
              retrying={keys.isRefetching}
            />
          ) : items.length === 0 ? (
            <div className="border-t border-line">
              <EmptyState
                size="sm"
                icon={<KeyRound />}
                title={t('apiKeys.empty.title')}
                description={t('apiKeys.empty.text')}
                action={
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    {t('apiKeys.create.open')}
                  </Button>
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {[...active, ...revoked].map((key) => (
                <KeyRow key={key.id} apiKey={key} />
              ))}
            </ul>
          )}
        </section>

        <ApiDocsPanel />
      </div>
      <CreateKeyDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

export default function ApiKeysSection() {
  const { t } = useTranslation('settings');
  const session = useSession();
  if (!session.can('admin')) {
    return (
      <>
        <SectionHeader
          title={t('sections.apiKeys.title')}
          description={t('sections.apiKeys.text')}
        />
        <div className="flex flex-col gap-5">
          <LockedSection min="admin" what={t('apiKeys.locked')} />
          <ApiDocsPanel />
        </div>
      </>
    );
  }
  return <ApiKeys />;
}
