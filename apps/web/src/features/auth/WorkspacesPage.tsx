import { PLANS } from '@parlante/shared';
import type { WorkspaceWithRole } from '@parlante/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Coins, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, toApiError, useApiMutation, useApiQuery } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import { PATHS } from '@/shell';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Skeleton,
  cn,
  toast,
  useErrorText,
} from '@/ui';
import { FormAlert } from './FormAlert';
import { useFieldMessage } from './useFieldMessage';
import { WORKSPACE_NAME_MAX, formErrorsFromApi, workspaceSchema } from './validation';
import type { WorkspaceValues } from './validation';

const GRID = 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3';

function WorkspaceCard({
  workspace,
  current,
  busy,
  disabled,
  onSwitch,
}: {
  workspace: WorkspaceWithRole;
  current: boolean;
  busy: boolean;
  disabled: boolean;
  onSwitch: () => void;
}) {
  const { t } = useTranslation('auth');
  const { t: tShell } = useTranslation('shell');
  const format = useFormat();
  return (
    <li
      className={cn(
        'flex min-w-0 flex-col gap-4 rounded-lg border bg-surface p-5 shadow-xs',
        current ? 'border-fg shadow-[inset_0_0_0_1px_var(--fg)]' : 'border-line',
      )}
    >
      <div className="flex items-start gap-3.5">
        <Avatar name={workspace.name} shape="rounded" size="lg" decorative />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg leading-6">{workspace.name}</h2>
          <p className="mt-0.5 text-sm text-fg-muted">
            {t('workspaces.planRole', {
              plan: PLANS[workspace.plan].name,
              role: tShell(`roles.${workspace.role}`),
            })}
          </p>
        </div>
        {current && (
          <Badge tone="accent" icon={<Check aria-hidden="true" />}>
            {t('workspaces.current')}
          </Badge>
        )}
      </div>
      <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">{tShell('credits.title')}</dt>
          <Coins className="size-4 text-saffron-text" aria-hidden="true" />
          <dd className="nums font-semibold">
            {tShell('credits.count', { count: workspace.credits })}
          </dd>
        </div>
        <div className="flex items-center gap-1.5 text-fg-muted">
          <dt>{t('workspaces.since')}</dt>
          <dd>{format.date(workspace.createdAt)}</dd>
        </div>
      </dl>
      <div className="mt-auto">
        {current ? (
          <p className="text-sm text-fg-muted">{t('workspaces.currentHint')}</p>
        ) : (
          <Button block loading={busy} disabled={disabled} onClick={onSwitch}>
            {t('workspaces.switch')}
          </Button>
        )}
      </div>
    </li>
  );
}

/** `/workspaces` — pick the workspace to work in, or create a new one. */
export default function WorkspacesPage() {
  const { t } = useTranslation('auth');
  const session = useSession();
  const navigate = useNavigate();
  const describe = useErrorText();
  const fieldMessage = useFieldMessage();
  const list = useApiQuery(api.workspaces.list);

  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const switchTo = async (workspace: WorkspaceWithRole) => {
    setSwitchingId(workspace.id);
    try {
      await session.switchWorkspace(workspace.id);
      toast.success(t('workspaces.switched', { name: workspace.name }));
      await navigate(PATHS.home);
    } catch (error) {
      toast.error(t('workspaces.switchFailed'), { description: describe(error).title });
      setSwitchingId(null);
    }
  };

  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);
  const create = useApiMutation(api.workspaces.create);
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<WorkspaceValues>({
    resolver: zodResolver(workspaceSchema),
    defaultValues: { name: '' },
  });

  const onCreate = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const workspace = await create.mutateAsync({ body: { name: values.name.trim() } });
      await session.switchWorkspace(workspace.id);
      toast.success(t('workspaces.created', { name: workspace.name }));
      setCreating(false);
      await navigate(PATHS.home);
    } catch (err) {
      const mapped = formErrorsFromApi(toApiError(err), ['name'] as const);
      if (mapped.fields.name) {
        setError('name', { message: mapped.fields.name.key ?? mapped.fields.name.message });
      }
      setFormError(mapped.form);
    }
  });

  // Start typing right away: without this the dialog opens with focus on its close button.
  useEffect(() => {
    if (!creating) return;
    const id = window.setTimeout(() => setFocus('name'), 0);
    return () => window.clearTimeout(id);
  }, [creating, setFocus]);

  const openCreate = () => {
    reset({ name: '' });
    setFormError(null);
    setCreating(true);
  };

  // The session already knows the workspaces: show them while the fresh list loads.
  const workspaces = list.data?.items ?? (list.isError ? null : session.workspaces);

  return (
    <>
      <PageHeader
        title={t('workspaces.title')}
        description={t('workspaces.description')}
        actions={
          <Button variant="primary" leftIcon={<Plus aria-hidden="true" />} onClick={openCreate}>
            {t('workspaces.create')}
          </Button>
        }
      />

      {workspaces === null ? (
        <ErrorState
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isRefetching}
        />
      ) : workspaces.length === 0 ? (
        list.isPending ? (
          <div className={GRID}>
            <Skeleton className="h-44 rounded-lg" />
            <Skeleton className="h-44 rounded-lg" />
          </div>
        ) : (
          <EmptyState
            title={t('workspaces.emptyTitle')}
            description={t('workspaces.emptyText')}
            action={
              <Button variant="primary" onClick={openCreate}>
                {t('workspaces.create')}
              </Button>
            }
          />
        )
      ) : (
        <ul className={GRID}>
          {workspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.id}
              workspace={workspace}
              current={workspace.id === session.workspace.id}
              busy={switchingId === workspace.id}
              disabled={switchingId !== null}
              onSwitch={() => void switchTo(workspace)}
            />
          ))}
        </ul>
      )}

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title={t('workspaces.createTitle')}
        description={t('workspaces.createText')}
        size="sm"
        dismissible={!isSubmitting}
        footer={
          <>
            <Button onClick={() => setCreating(false)} disabled={isSubmitting}>
              {t('workspaces.cancel')}
            </Button>
            <Button variant="primary" type="submit" form="new-workspace" loading={isSubmitting}>
              {t('workspaces.createAction')}
            </Button>
          </>
        }
      >
        <form
          id="new-workspace"
          className="flex flex-col gap-4"
          onSubmit={(event) => void onCreate(event)}
          noValidate
        >
          <FormAlert error={formError} />
          <Input
            label={t('workspaces.name')}
            placeholder={t('workspaces.namePlaceholder')}
            maxLength={WORKSPACE_NAME_MAX}
            required
            error={fieldMessage(errors.name)}
            {...register('name')}
          />
        </form>
      </Dialog>
    </>
  );
}
