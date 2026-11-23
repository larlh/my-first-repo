import { EmailSchema } from '@parlante/shared';
import type { Invite, InviteCreated, Member, Role } from '@parlante/shared';
import { Clock, LogOut, MailPlus, Trash2, UserMinus } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { api, useApiMutation, useApiQuery } from '@/lib/api';
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
  IconButton,
  Input,
  Select,
  Skeleton,
  toast,
  useConfirm,
  useErrorText,
} from '@/ui';
import { Callout } from '../components/Callout';
import { DeniedHint } from '../components/DeniedHint';
import { SecretField } from '../components/SecretField';
import { Panel, SectionHeader } from '../components/SectionHeader';
import { UsageMeter } from '../components/UsageMeter';
import { usageLevel, usagePercent } from '../lib/billing';
import {
  assignableRoles,
  countOwners,
  invitableRoles,
  isInvitePending,
  removalCheck,
  seatUsage,
} from '../lib/roles';
import type { Actor } from '../lib/roles';
import { reloadSession } from '../lib/session';
import { sectionPath } from '../sections';

const ROLE_ORDER: Role[] = ['owner', 'admin', 'editor', 'viewer'];

/* ---------- invite dialog ---------- */

function InviteDialog({
  open,
  onOpenChange,
  roles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: Role[];
}) {
  const { t } = useTranslation('settings');
  const { t: tShell } = useTranslation('shell');
  const errorText = useErrorText();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<InviteCreated | null>(null);

  const invite = useApiMutation(api.members.createInvite, {
    invalidates: [api.members.listInvites, api.billing.overview],
    onSuccess: (result) => setCreated(result),
    onError: (error: ApiError) => {
      if (error.is('CONFLICT')) setFieldError(t('members.invite.conflict'));
      else if (error.is('PLAN_LIMIT_EXCEEDED')) setFormError(t('members.invite.full'));
      else if (error.is('VALIDATION_ERROR')) setFieldError(t('members.invite.emailInvalid'));
      else setFormError(errorText(error).title);
    },
  });

  const close = (next: boolean) => {
    if (invite.isPending) return;
    onOpenChange(next);
    if (!next) {
      setEmail('');
      setRole('editor');
      setFieldError(null);
      setFormError(null);
      setCreated(null);
      invite.reset();
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const parsed = EmailSchema.safeParse(email.trim());
    if (!parsed.success) {
      setFieldError(t('members.invite.emailInvalid'));
      return;
    }
    setFieldError(null);
    invite.mutate({ body: { email: parsed.data, role } });
  };

  if (created) {
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        title={t('members.invite.createdTitle')}
        description={t('members.invite.createdText', { email: created.email })}
        footer={
          <Button variant="primary" onClick={() => close(false)}>
            {t('common.done')}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <SecretField
            label={t('members.invite.link')}
            value={created.acceptUrl}
            multiline
            hint={t('members.invite.linkHint', {
              role: tShell(`roles.${created.role}`),
            })}
          />
          <Callout icon={<Clock />}>{t('members.invite.noEmail')}</Callout>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      dismissible={!invite.isPending}
      title={t('members.invite.title')}
      description={t('members.invite.text')}
      footer={
        <>
          <Button onClick={() => close(false)} disabled={invite.isPending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="invite-form" variant="primary" loading={invite.isPending}>
            {t('members.invite.action')}
          </Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Input
          label={t('members.invite.email')}
          name="invite-email"
          type="email"
          autoComplete="off"
          placeholder={t('members.invite.emailPlaceholder')}
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={fieldError ?? undefined}
        />
        <Select
          label={t('members.invite.role')}
          value={role}
          onValueChange={setRole}
          options={roles.map((option) => ({
            value: option,
            label: tShell(`roles.${option}`),
            description: t(`members.roles.${option}`),
          }))}
          hint={roles.includes('admin') ? undefined : t('members.invite.adminHint')}
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

/* ---------- member row ---------- */

function MemberRow({
  member,
  actor,
  ownerCount,
  canManage,
}: {
  member: Member;
  actor: Actor;
  ownerCount: number;
  canManage: boolean;
}) {
  const { t } = useTranslation('settings');
  const { t: tShell } = useTranslation('shell');
  const session = useSession();
  const format = useFormat();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const isSelf = member.userId === actor.userId;
  const roleOptions = assignableRoles(actor, member, ownerCount);
  const removal = removalCheck(actor, member, ownerCount);

  const updateRole = useApiMutation(api.members.updateRole, {
    invalidates: [api.members.list],
    onSuccess: async (updated) => {
      toast.success(
        t('members.roleChanged', { name: updated.name, role: tShell(`roles.${updated.role}`) }),
      );
      // Changing your own role changes what this session may do.
      if (isSelf) await session.refresh();
    },
    onError: (error) => toast.error(errorText(error).title, { description: error.message }),
  });
  const remove = useApiMutation(api.members.remove, {
    invalidates: [api.members.list, api.billing.overview],
    onError: (error) => toast.error(errorText(error).title, { description: error.message }),
  });

  const onRemove = async () => {
    const ok = await confirm(
      removal.leaving
        ? {
            title: t('members.leave.title', { workspace: session.workspace.name }),
            description: t('members.leave.text'),
            confirmLabel: t('members.leave.action'),
            tone: 'danger',
          }
        : {
            title: t('members.remove.title', { name: member.name }),
            description: t('members.remove.text', { workspace: session.workspace.name }),
            confirmLabel: t('members.remove.action'),
            tone: 'danger',
          },
    );
    if (!ok) return;
    try {
      await remove.mutateAsync({ params: { memberId: member.id } });
    } catch {
      return; // reported by onError
    }
    if (removal.leaving) {
      toast.success(t('members.leave.done', { workspace: session.workspace.name }));
      await reloadSession(session);
      navigate(PATHS.home);
    } else {
      toast.success(t('members.remove.done', { name: member.name }));
    }
  };

  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={member.name} decorative />
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold">{member.name}</span>
            {isSelf && (
              <Badge size="sm" tone="saffron">
                {t('members.you')}
              </Badge>
            )}
          </p>
          <p className="truncate text-sm text-fg-muted">{member.email}</p>
        </div>
      </div>
      <p className="hidden shrink-0 text-sm text-fg-muted xl:block">
        {t('members.since', { date: format.date(member.createdAt) })}
      </p>
      <div className="flex shrink-0 items-center gap-2 pl-13 sm:pl-0">
        {roleOptions.roles.length > 0 ? (
          <Select
            size="sm"
            aria-label={t('members.roleOf', { name: member.name })}
            value={member.role}
            disabled={updateRole.isPending}
            onValueChange={(role) => {
              if (role !== member.role) {
                updateRole.mutate({ params: { memberId: member.id }, body: { role } });
              }
            }}
            options={ROLE_ORDER.filter(
              (role) => roleOptions.roles.includes(role) || role === member.role,
            ).map((role) => ({ value: role, label: tShell(`roles.${role}`) }))}
            className="w-40"
          />
        ) : (
          <>
            <Badge tone={member.role === 'owner' ? 'accent' : 'neutral'}>
              {tShell(`roles.${member.role}`)}
            </Badge>
            {/* The last owner gets ONE padlock (next to it) that explains both limits. */}
            {canManage && roleOptions.denial && roleOptions.denial !== 'lastOwner' && (
              <DeniedHint reason={t(`members.denied.role.${roleOptions.denial}`)} />
            )}
          </>
        )}
        {removal.allowed ? (
          <IconButton
            label={
              removal.leaving
                ? t('members.leave.action')
                : t('members.remove.label', { name: member.name })
            }
            size="sm"
            loading={remove.isPending}
            onClick={() => void onRemove()}
          >
            {removal.leaving ? <LogOut aria-hidden="true" /> : <UserMinus aria-hidden="true" />}
          </IconButton>
        ) : (
          (canManage || isSelf) &&
          removal.denial && (
            <DeniedHint
              reason={t(
                `members.denied.remove.${isSelf && removal.denial === 'lastOwner' ? 'selfLastOwner' : removal.denial}`,
              )}
            />
          )
        )}
      </div>
    </li>
  );
}

/* ---------- invitations ---------- */

function InviteRow({ invite, now }: { invite: Invite; now: Date }) {
  const { t } = useTranslation('settings');
  const { t: tShell } = useTranslation('shell');
  const format = useFormat();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const pending = isInvitePending(invite, now);
  const revoke = useApiMutation(api.members.revokeInvite, {
    invalidates: [api.members.listInvites],
    onSuccess: () => toast.success(t('members.invites.revoked', { email: invite.email })),
    onError: (error) => toast.error(errorText(error).title, { description: error.message }),
  });
  const onRevoke = async () => {
    const ok = await confirm({
      title: t('members.invites.revokeTitle', { email: invite.email }),
      description: t('members.invites.revokeText'),
      confirmLabel: t('members.invites.revoke'),
      tone: 'danger',
    });
    if (ok) revoke.mutate({ params: { inviteId: invite.id } });
  };
  return (
    <li className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{invite.email}</p>
        <p className="text-sm text-fg-muted">
          {invite.invitedBy
            ? t('members.invites.by', {
                name: invite.invitedBy.name,
                date: format.date(invite.createdAt),
              })
            : t('members.invites.sent', { date: format.date(invite.createdAt) })}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge tone="neutral" variant="outline">
          {tShell(`roles.${invite.role}`)}
        </Badge>
        <Badge tone={pending ? 'info' : 'warning'} dot>
          {pending
            ? t('members.invites.expires', { when: format.relative(invite.expiresAt, now) })
            : t('members.invites.expired')}
        </Badge>
        <IconButton
          label={t('members.invites.revokeLabel', { email: invite.email })}
          size="sm"
          loading={revoke.isPending}
          onClick={() => void onRevoke()}
        >
          <Trash2 aria-hidden="true" />
        </IconButton>
      </div>
    </li>
  );
}

/* ---------- section ---------- */

export default function MembersSection() {
  const { t } = useTranslation('settings');
  const { t: tShell } = useTranslation('shell');
  const session = useSession();
  const format = useFormat();
  const canManage = session.can('admin');
  const [inviting, setInviting] = useState(false);
  const now = useMemo(() => new Date(), []);

  const members = useApiQuery(api.members.list);
  const invites = useApiQuery(api.members.listInvites, undefined, { enabled: canManage });

  const actor: Actor = { userId: session.user.id, role: session.role };
  const list = members.data?.items ?? [];
  const openInvites = (invites.data?.items ?? []).filter((invite) => invite.acceptedAt === null);
  const ownerCount = countOwners(list);
  const seats = seatUsage(list.length, openInvites, session.plan.limits.maxMembers, now);
  const roles = invitableRoles(session.role);

  return (
    <>
      <SectionHeader
        title={t('sections.members.title')}
        description={t('sections.members.text')}
        actions={
          canManage && (
            <Button
              variant="primary"
              leftIcon={<MailPlus aria-hidden="true" />}
              disabled={members.isPending || seats.full}
              onClick={() => setInviting(true)}
            >
              {t('members.invite.open')}
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-5">
        {!canManage && (
          <Callout>{t('members.readOnly', { role: tShell(`roles.${session.role}`) })}</Callout>
        )}

        {members.isSuccess && (
          <div className="rounded-lg border border-line bg-surface p-5 shadow-xs">
            <UsageMeter
              label={t('members.seats.label', { plan: session.plan.name })}
              valueText={t('members.seats.value', {
                used: format.number(seats.used),
                limit: format.number(seats.limit),
              })}
              percent={usagePercent(seats.used, seats.limit)}
              level={usageLevel(seats.used, seats.limit)}
            />
            <p className="mt-2.5 text-sm text-fg-muted">
              {canManage && openInvites.length > 0
                ? t('members.seats.breakdown', {
                    members: list.length,
                    invites: seats.used - list.length,
                  })
                : t('members.seats.hint')}{' '}
              {seats.full && (
                <>
                  <span className="font-medium text-danger-text">{t('members.seats.full')}</span>{' '}
                  <Link
                    to={sectionPath('billing')}
                    className="font-medium text-accent-text underline-offset-4 hover:underline"
                  >
                    {t('members.seats.upgrade')}
                  </Link>
                </>
              )}
            </p>
          </div>
        )}

        <section
          aria-labelledby="members-title"
          className="rounded-lg border border-line bg-surface shadow-xs"
        >
          <h2 id="members-title" className="px-5 pt-5 pb-3 text-lg leading-6">
            {t('members.list.title')}
            {members.isSuccess && (
              <span className="nums ml-2 text-base font-normal text-fg-subtle">{list.length}</span>
            )}
          </h2>
          {members.isPending ? (
            <ul className="divide-y divide-line border-t border-line" aria-hidden="true">
              {Array.from({ length: 3 }, (_, index) => (
                <li key={index} className="flex items-center gap-3 px-5 py-4">
                  <Skeleton className="size-10 rounded-full" />
                  <div className="flex-1">
                    <Skeleton className="mb-2 w-40 max-w-full" />
                    <Skeleton className="h-3 w-56 max-w-full" />
                  </div>
                  <Skeleton className="h-8 w-28" />
                </li>
              ))}
            </ul>
          ) : members.isError ? (
            <ErrorState
              size="sm"
              error={members.error}
              onRetry={() => void members.refetch()}
              retrying={members.isRefetching}
            />
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {list.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  actor={actor}
                  ownerCount={ownerCount}
                  canManage={canManage}
                />
              ))}
            </ul>
          )}
        </section>

        {canManage && (
          <section
            aria-labelledby="invites-title"
            className="rounded-lg border border-line bg-surface shadow-xs"
          >
            <div className="px-5 pt-5 pb-3">
              <h2 id="invites-title" className="text-lg leading-6">
                {t('members.invites.title')}
              </h2>
              <p className="mt-1 text-sm text-fg-muted">{t('members.invites.text')}</p>
            </div>
            {invites.isPending ? (
              <div className="border-t border-line px-5 py-4" aria-hidden="true">
                <Skeleton className="w-64 max-w-full" />
              </div>
            ) : invites.isError ? (
              <ErrorState
                size="sm"
                error={invites.error}
                onRetry={() => void invites.refetch()}
                retrying={invites.isRefetching}
              />
            ) : openInvites.length === 0 ? (
              <div className="border-t border-line">
                <EmptyState
                  size="sm"
                  icon={<MailPlus />}
                  title={t('members.invites.empty')}
                  description={t('members.invites.emptyText')}
                />
              </div>
            ) : (
              <ul className="divide-y divide-line border-t border-line">
                {openInvites.map((invite) => (
                  <InviteRow key={invite.id} invite={invite} now={now} />
                ))}
              </ul>
            )}
          </section>
        )}

        <Panel id="roles" title={t('members.roles.title')} description={t('members.roles.text')}>
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {ROLE_ORDER.map((role) => (
              <div key={role} className="min-w-0">
                <dt className="flex items-center gap-2 text-sm font-semibold">
                  {tShell(`roles.${role}`)}
                  {role === session.role && (
                    <Badge size="sm" tone="saffron">
                      {t('members.yourRole')}
                    </Badge>
                  )}
                </dt>
                <dd className="mt-0.5 text-sm text-fg-muted">{t(`members.roles.${role}`)}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      {canManage && <InviteDialog open={inviting} onOpenChange={setInviting} roles={roles} />}
    </>
  );
}
