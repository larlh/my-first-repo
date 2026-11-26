import { SIGNUP_CREDITS } from '@parlante/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Coins } from 'lucide-react';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, toApiError, useApiMutation } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { currentLocale } from '@/lib/i18n';
import { useSessionState } from '@/lib/session';
import { AuthShell, PATHS, useNextPath } from '@/shell';
import { Button, Input, cn } from '@/ui';
import { FormAlert } from './FormAlert';
import { PasswordInput } from './PasswordInput';
import { useFieldMessage } from './useFieldMessage';
import { PASSWORD_MIN, formErrorsFromApi, passwordStrength, registerSchema } from './validation';
import type { RegisterValues } from './validation';

const LINK = 'font-semibold text-accent-text underline-offset-4 hover:underline rounded-xs';
const STRENGTH_TONE = ['bg-line-strong', 'bg-danger', 'bg-warning', 'bg-saffron', 'bg-success'];

function StrengthMeter({ password }: { password: string }) {
  const { t } = useTranslation('auth');
  const score = passwordStrength(password);
  return (
    <div className="flex items-center gap-3" aria-hidden={score === 0}>
      <div className="flex flex-1 gap-1">
        {[1, 2, 3, 4].map((step) => (
          <span
            key={step}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors duration-200',
              step <= score ? STRENGTH_TONE[score] : 'bg-surface-3',
            )}
          />
        ))}
      </div>
      <span className="w-24 text-right text-xs text-fg-muted" aria-live="polite">
        {score > 0 ? t(`password.strength.${score}`) : ''}
      </span>
    </div>
  );
}

/**
 * `/register` — name, e-mail and password. The API creates the account with a personal
 * workspace and starts the session. `?invite=<token>` (from an invitation link) is passed
 * through so the new user also joins the inviting workspace.
 */
export default function RegisterPage() {
  const { t } = useTranslation('auth');
  const session = useSessionState();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const next = useNextPath();
  const fieldMessage = useFieldMessage();
  const [formError, setFormError] = useState<ApiError | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const signUp = useApiMutation(api.auth.register);
  const inviteToken = params.get('invite');

  const {
    register,
    control,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', password: '' },
    // Validate on submit, then live while fixing. Validating on blur would insert an error
    // under the auto-focused field as soon as the visitor reaches for a link below it, and
    // the layout shift makes that click miss.
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });
  const password = useWatch({ control, name: 'password' });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setEmailTaken(false);
    try {
      const info = await signUp.mutateAsync({
        body: {
          ...values,
          locale: currentLocale(),
          ...(inviteToken && inviteToken.length <= 100 ? { inviteToken } : {}),
        },
      });
      session.setSession(info);
      await navigate(next, { replace: true });
    } catch (err) {
      const apiError = toApiError(err);
      const mapped = formErrorsFromApi(apiError, ['name', 'email', 'password'] as const);
      const fields = Object.entries(mapped.fields);
      for (const [field, error] of fields) {
        setError(field as keyof RegisterValues, { message: error?.key ?? error?.message });
      }
      setEmailTaken(apiError.is('EMAIL_TAKEN'));
      setFormError(mapped.form);
      const first = fields[0]?.[0] as keyof RegisterValues | undefined;
      if (first) setFocus(first, { shouldSelect: true });
    }
  });

  const loginLink = { pathname: PATHS.login, search: location.search };

  return (
    <AuthShell
      title={t('register.title')}
      description={t('register.description')}
      footer={
        <>
          {t('register.haveAccount')}{' '}
          <Link to={loginLink} className={LINK}>
            {t('register.toLogin')}
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)} noValidate>
        <FormAlert error={formError} />
        <Input
          label={t('fields.name')}
          autoComplete="name"
          placeholder={t('fields.namePlaceholder')}
          autoFocus
          required
          size="lg"
          error={fieldMessage(errors.name)}
          {...register('name')}
        />
        <Input
          label={t('fields.email')}
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={t('fields.emailPlaceholder')}
          required
          size="lg"
          error={
            emailTaken && errors.email ? (
              <>
                {fieldMessage(errors.email)}{' '}
                <Link to={loginLink} className="underline underline-offset-2">
                  {t('register.toLogin')}
                </Link>
              </>
            ) : (
              fieldMessage(errors.email)
            )
          }
          {...register('email', { onChange: () => setEmailTaken(false) })}
        />
        <div className="flex flex-col gap-2">
          <PasswordInput
            label={t('fields.password')}
            autoComplete="new-password"
            required
            size="lg"
            hint={t('password.hint', { min: PASSWORD_MIN })}
            error={fieldMessage(errors.password)}
            {...register('password')}
          />
          <StrengthMeter password={password ?? ''} />
        </div>
        <Button variant="primary" size="lg" type="submit" block loading={isSubmitting}>
          {t('register.submit')}
        </Button>
        <p className="flex items-start gap-2.5 rounded-md bg-saffron-soft p-3 text-sm text-saffron-text">
          <Coins className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t('register.welcomeCredits', { count: SIGNUP_CREDITS })}
        </p>
      </form>
    </AuthShell>
  );
}
