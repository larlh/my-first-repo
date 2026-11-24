import { WorkspaceNameSchema } from '@parlante/shared';
import { Cpu, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ProviderBadge } from '@/components/ProviderBadge';
import { api, useApiMutation, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import { PATHS } from '@/shell';
import { Badge, Button, Dialog, ErrorState, Input, Skeleton, toast, useErrorText } from '@/ui';
import { Callout } from '../components/Callout';
import { RoleNote } from '../components/RoleGate';
import { Panel, SectionHeader } from '../components/SectionHeader';
import { reloadSession } from '../lib/session';
import { sectionPath } from '../sections';

const NAME_MAX = 60;

function GeneralPanel() {
  const { t } = useTranslation('settings');
  const { t: tShell } = useTranslation('shell');
  const session = useSession();
  const format = useFormat();
  const errorText = useErrorText();
  const canEdit = session.can('admin');
  const [name, setName] = useState(session.workspace.name);
  const [error, setError] = useState<string | null>(null);
  const rename = useApiMutation(api.workspaces.update, {
    invalidates: [api.workspaces.list, api.workspaces.current],
    onSuccess: async () => {
      await session.refresh();
      toast.success(t('workspace.renamed'));
    },
    onError: (err) => toast.error(errorText(err).title, { description: err.message }),
  });

  const trimmed = name.trim();
  const dirty = trimmed !== session.workspace.name;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!WorkspaceNameSchema.safeParse(name).success) {
      setError(t('workspace.nameRequired'));
      return;
    }
    setError(null);
    if (dirty) rename.mutate({ body: { name: trimmed } });
  };

  return (
    <Panel
      id="general"
      title={t('workspace.general.title')}
      description={t('workspace.general.text')}
    >
      <RoleNote min="admin">{t('workspace.general.adminOnly')}</RoleNote>
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <Input
          label={t('workspace.name')}
          name="workspace-name"
          maxLength={NAME_MAX}
          required
          value={name}
          disabled={!canEdit}
          onChange={(event) => setName(event.target.value)}
          error={error ?? undefined}
          wrapperClassName="sm:max-w-md"
        />
        <dl className="grid gap-x-8 gap-y-3 border-t border-line pt-4 text-sm sm:grid-cols-2">
          <div className="flex items-baseline justify-between gap-3 sm:block">
            <dt className="text-fg-muted">{t('workspace.plan')}</dt>
            <dd className="font-medium">
              {session.plan.name}{' '}
              <Link
                to={sectionPath('billing')}
                className="ml-1 font-medium text-accent-text underline-offset-4 hover:underline"
              >
                {t('workspace.seePlan')}
              </Link>
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 sm:block">
            <dt className="text-fg-muted">{t('workspace.yourRole')}</dt>
            <dd className="font-medium">{tShell(`roles.${session.role}`)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 sm:block">
            <dt className="text-fg-muted">{t('workspace.created')}</dt>
            <dd className="font-medium">{format.date(session.workspace.createdAt)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 sm:block">
            <dt className="text-fg-muted">{t('workspace.id')}</dt>
            <dd className="font-mono text-xs break-all">{session.workspace.id}</dd>
          </div>
        </dl>
        {canEdit && (
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={rename.isPending} disabled={!dirty}>
              {t('workspace.save')}
            </Button>
          </div>
        )}
      </form>
    </Panel>
  );
}

/** Which engine serves each AI capability on this server (honesty rule: basic vs premium). */
function EnginesPanel() {
  const { t } = useTranslation('settings');
  const capabilities = useApiQuery(api.system.capabilities);
  const entries = capabilities.data ? Object.entries(capabilities.data.active) : [];
  const basic = entries.filter(([, provider]) => provider.quality === 'basic').length;
  return (
    <Panel
      id="engines"
      title={t('workspace.engines.title')}
      description={t('workspace.engines.text')}
      aside={
        capabilities.data && (
          <Badge
            tone={basic === entries.length ? 'neutral' : 'saffron'}
            icon={<Cpu aria-hidden="true" />}
          >
            {t('workspace.engines.summary', { basic, total: entries.length })}
          </Badge>
        )
      }
    >
      {capabilities.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-9" />
          ))}
        </div>
      ) : capabilities.isError ? (
        <ErrorState
          size="sm"
          error={capabilities.error}
          onRetry={() => void capabilities.refetch()}
          retrying={capabilities.isRefetching}
        />
      ) : (
        <>
          <ul className="grid gap-x-8 sm:grid-cols-2">
            {entries.map(([capability, provider]) => (
              <li
                key={capability}
                // The capability is never cut: a long provider name drops to its own line instead.
                className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-line py-2.5"
              >
                <span className="text-sm font-medium">
                  {t(`workspace.engines.capability.${capability}`)}
                </span>
                <ProviderBadge provider={provider} size="sm" />
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-fg-muted">
            {capabilities.data.avatarEngine.available
              ? t('workspace.engines.neuralOn', {
                  device: capabilities.data.avatarEngine.device === 'gpu' ? 'GPU' : 'CPU',
                })
              : t('workspace.engines.neuralOff')}
          </p>
        </>
      )}
    </Panel>
  );
}

function DangerPanel() {
  const { t } = useTranslation('settings');
  const session = useSession();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const isOwner = session.can('owner');
  const onlyOne = session.workspaces.length <= 1;
  const name = session.workspace.name;

  const remove = useApiMutation(api.workspaces.remove, {
    onSuccess: async () => {
      setOpen(false);
      toast.success(t('workspace.danger.deleted', { name }));
      await reloadSession(session);
      navigate(PATHS.home);
    },
    onError: (error) =>
      setFailure(
        error.is('INVALID_STATE') ? t('workspace.danger.lastOne') : errorText(error).title,
      ),
  });

  const close = (next: boolean) => {
    if (remove.isPending) return;
    setOpen(next);
    if (!next) {
      setTyped('');
      setFailure(null);
    }
  };

  return (
    <Panel
      id="danger"
      tone="danger"
      title={t('workspace.danger.title')}
      description={t('workspace.danger.text')}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-sm text-fg-muted">
          {!isOwner
            ? t('workspace.danger.ownerOnly')
            : onlyOne
              ? t('workspace.danger.lastOne')
              : t('workspace.danger.hint')}
        </p>
        <Button
          variant="danger"
          className="shrink-0"
          leftIcon={<Trash2 aria-hidden="true" />}
          disabled={!isOwner || onlyOne}
          onClick={() => setOpen(true)}
        >
          {t('workspace.danger.action')}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={close}
        size="md"
        dismissible={!remove.isPending}
        title={t('workspace.danger.confirmTitle', { name })}
        description={t('workspace.danger.confirmText')}
        footer={
          <>
            <Button onClick={() => close(false)} disabled={remove.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              disabled={typed.trim() !== name}
              onClick={() => remove.mutate()}
            >
              {t('workspace.danger.confirmAction')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
            <li>{t('workspace.danger.loses.videos')}</li>
            <li>{t('workspace.danger.loses.people')}</li>
            <li>{t('workspace.danger.loses.credits')}</li>
          </ul>
          <Input
            label={t('workspace.danger.typeName', { name })}
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
          {failure && (
            <Callout tone="danger" role="alert">
              {failure}
            </Callout>
          )}
        </div>
      </Dialog>
    </Panel>
  );
}

export default function WorkspaceSection() {
  const { t } = useTranslation('settings');
  return (
    <>
      <SectionHeader
        title={t('sections.workspace.title')}
        description={t('sections.workspace.text')}
      />
      <div className="flex flex-col gap-5">
        <GeneralPanel />
        <EnginesPanel />
        <DangerPanel />
      </div>
    </>
  );
}
