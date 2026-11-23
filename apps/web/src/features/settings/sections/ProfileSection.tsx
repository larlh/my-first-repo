import { PasswordSchema } from '@parlante/shared';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, useApiMutation } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar, Button, Input, toast, useErrorText } from '@/ui';
import { Panel, SectionHeader } from '../components/SectionHeader';

const NAME_MAX = 80;

function IdentityForm() {
  const { t } = useTranslation('settings');
  const session = useSession();
  const format = useFormat();
  const errorText = useErrorText();
  const [name, setName] = useState(session.user.name);
  const [touched, setTouched] = useState(false);
  const update = useApiMutation(api.auth.updateProfile, {
    onSuccess: async () => {
      await session.refresh();
      toast.success(t('profile.saved'));
    },
    onError: (error) => toast.error(errorText(error).title, { description: error.message }),
  });

  const trimmed = name.trim();
  const problem = trimmed === '' ? t('profile.nameRequired') : null;
  const dirty = trimmed !== session.user.name;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem || !dirty) return;
    update.mutate({ body: { name: trimmed } });
  };

  return (
    <Panel
      id="identity"
      title={t('profile.identity.title')}
      description={t('profile.identity.text')}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <div className="flex items-center gap-4">
          <Avatar name={trimmed || session.user.name} size="lg" decorative />
          <div className="min-w-0">
            <p className="truncate font-semibold">{session.user.name}</p>
            <p className="text-sm text-fg-muted">
              {t('profile.identity.since', { date: format.date(session.user.createdAt) })}
            </p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label={t('profile.name')}
            name="name"
            autoComplete="name"
            maxLength={NAME_MAX}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => setTouched(true)}
            error={touched && problem ? problem : undefined}
          />
          <Input
            label={t('profile.email')}
            name="email"
            type="email"
            value={session.user.email}
            readOnly
            disabled
            hint={t('profile.emailHint')}
          />
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={update.isPending} disabled={!dirty}>
            {t('profile.save')}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

interface PasswordErrors {
  current?: string;
  next?: string;
  repeat?: string;
}

function PasswordForm() {
  const { t } = useTranslation('settings');
  const errorText = useErrorText();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<PasswordErrors>({});
  const change = useApiMutation(api.auth.changePassword, {
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setRepeat('');
      setErrors({});
      toast.success(t('profile.password.changed'), {
        description: t('profile.password.changedText'),
      });
    },
    onError: (error) => {
      if (error.is('INVALID_CREDENTIALS')) {
        setErrors({ current: t('profile.password.wrongCurrent') });
      } else toast.error(errorText(error).title, { description: error.message });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: PasswordErrors = {};
    if (current === '') found.current = t('profile.password.currentRequired');
    if (!PasswordSchema.safeParse(next).success) found.next = t('profile.password.tooShort');
    else if (next === current) found.next = t('profile.password.same');
    if (repeat !== next) found.repeat = t('profile.password.mismatch');
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    change.mutate({ body: { currentPassword: current, newPassword: next } });
  };

  return (
    <Panel
      id="password"
      title={t('profile.password.title')}
      description={t('profile.password.text')}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Input
          label={t('profile.password.current')}
          name="current-password"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          error={errors.current}
          wrapperClassName="sm:max-w-sm"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label={t('profile.password.next')}
            name="new-password"
            type="password"
            autoComplete="new-password"
            required
            value={next}
            onChange={(event) => setNext(event.target.value)}
            error={errors.next}
            hint={t('profile.password.rule')}
          />
          <Input
            label={t('profile.password.repeat')}
            name="repeat-password"
            type="password"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            error={errors.repeat}
          />
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={change.isPending}>
            {t('profile.password.action')}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

export default function ProfileSection() {
  const { t } = useTranslation('settings');
  return (
    <>
      <SectionHeader title={t('sections.profile.title')} description={t('sections.profile.text')} />
      <div className="flex flex-col gap-5">
        <IdentityForm />
        <PasswordForm />
      </div>
    </>
  );
}
