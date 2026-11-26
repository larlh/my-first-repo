import { zodResolver } from '@hookform/resolvers/zod';
import { CircleCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, toApiError, useApiMutation } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useSessionState } from '@/lib/session';
import { AuthShell, PATHS, useNextPath } from '@/shell';
import { Button, Input } from '@/ui';
import { FormAlert } from './FormAlert';
import { PasswordInput } from './PasswordInput';
import { useFieldMessage } from './useFieldMessage';
import { formErrorsFromApi, loginSchema } from './validation';
import type { LoginValues } from './validation';

const LINK = 'font-semibold text-accent-text underline-offset-4 hover:underline rounded-xs';

/** `/login` — e-mail + password. On success the session is stored and we go back to `?next=`. */
export default function LoginPage() {
  const { t } = useTranslation('auth');
  const session = useSessionState();
  const navigate = useNavigate();
  const location = useLocation();
  const next = useNextPath();
  const fieldMessage = useFieldMessage();
  const [formError, setFormError] = useState<ApiError | null>(null);
  const login = useApiMutation(api.auth.login);

  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
    // Validate on submit, then live while fixing. Validating on blur would insert an error
    // under the auto-focused field as soon as the visitor reaches for a link below it, and
    // the layout shift makes that click miss.
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const info = await login.mutateAsync({ body: values });
      session.setSession(info);
      await navigate(next, { replace: true });
    } catch (err) {
      const mapped = formErrorsFromApi(toApiError(err), ['email', 'password'] as const);
      for (const [field, error] of Object.entries(mapped.fields)) {
        setError(field as keyof LoginValues, { message: error?.key ?? error?.message });
      }
      setFormError(mapped.form);
      // Wrong credentials: the password is what gets retyped.
      if (mapped.form?.is('INVALID_CREDENTIALS')) setFocus('password', { shouldSelect: true });
    }
  });

  // Was the visitor sent here by a guard? Then say why they are seeing a login form.
  const redirected = next !== PATHS.home;
  const signedOut =
    (location.state as { signedOut?: boolean } | null)?.signedOut === true && !formError;

  return (
    <AuthShell
      title={t('login.title')}
      description={redirected ? t('login.descriptionRedirected') : t('login.description')}
      footer={
        <>
          {t('login.noAccount')}{' '}
          <Link to={{ pathname: PATHS.register, search: location.search }} className={LINK}>
            {t('login.toRegister')}
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)} noValidate>
        <FormAlert error={formError} />
        {signedOut && (
          <p
            role="status"
            className="flex items-center gap-2.5 rounded-md bg-success-soft p-3.5 text-sm font-medium text-success-text"
          >
            <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
            {t('login.signedOut')}
          </p>
        )}
        <Input
          label={t('fields.email')}
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={t('fields.emailPlaceholder')}
          autoFocus
          required
          size="lg"
          error={fieldMessage(errors.email)}
          {...register('email')}
        />
        <PasswordInput
          label={t('fields.password')}
          autoComplete="current-password"
          required
          size="lg"
          error={fieldMessage(errors.password)}
          {...register('password')}
        />
        <Button variant="primary" size="lg" type="submit" block loading={isSubmitting}>
          {t('login.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
