import type { ConsentKind, UiLocale } from '@parlante/shared';
import { ShieldCheck } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Checkbox, Input, SegmentedControl, cn } from '@/ui';
import { CONSENT_NAME_MAX, consentStatement } from './consent';
import type { ConsentDraft, ConsentProblems } from './consent';
import { LIB_ROUTES, useAvailableRoutes } from './routes';

export interface ConsentFormProps {
  kind: ConsentKind;
  value: ConsentDraft;
  onChange: (next: ConsentDraft) => void;
  /** Problems to show (pass them only after a submit attempt). */
  problems?: ConsentProblems;
  disabled?: boolean;
  className?: string;
}

/**
 * The mandatory consent declaration of master prompt §5: the exact versioned statement, who
 * consents (name) and the checkbox. Nothing is sent from here — the page records the
 * declaration with `POST /api/consents` right before creating the avatar or the voice.
 */
export function ConsentForm({
  kind,
  value,
  onChange,
  problems = {},
  disabled = false,
  className,
}: ConsentFormProps) {
  const { t, i18n } = useTranslation('avatars');
  const available = useAvailableRoutes();
  const headingId = useId();
  const locale: UiLocale = i18n.language.startsWith('en') ? 'en' : 'es';

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'rounded-xl border border-line-strong bg-surface-2 p-4 sm:p-5',
        (problems.accepted || problems.subjectName) && 'border-danger',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-md bg-inverse text-inverse-fg"
        >
          <ShieldCheck className="size-5" />
        </span>
        <div className="min-w-0">
          <h3 id={headingId} className="text-lg">
            {t('kit.consent.title')}
          </h3>
          <p className="mt-0.5 text-sm text-fg-muted">{t(`kit.consent.why.${kind}`)}</p>
        </div>
      </div>

      <blockquote
        lang={locale}
        className="mt-4 rounded-lg border-l-4 border-accent bg-surface px-4 py-3 text-sm leading-relaxed text-pretty"
      >
        {consentStatement(kind, locale)}
      </blockquote>

      <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <Input
          label={t('kit.consent.name')}
          hint={t('kit.consent.nameHint')}
          error={
            problems.subjectName ? t(`kit.consent.problem.${problems.subjectName}`) : undefined
          }
          name="consentSubjectName"
          autoComplete="name"
          maxLength={CONSENT_NAME_MAX}
          required
          disabled={disabled}
          value={value.subjectName}
          onChange={(event) => onChange({ ...value, subjectName: event.target.value })}
        />
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm font-semibold">{t('kit.consent.relationship')}</span>
          <SegmentedControl
            aria-label={t('kit.consent.relationship')}
            value={value.relationship}
            onValueChange={(relationship) => onChange({ ...value, relationship })}
            disabled={disabled}
            options={[
              { value: 'self', label: t(`kit.consent.self.${kind}`) },
              { value: 'authorized', label: t('kit.consent.authorized') },
            ]}
          />
        </div>
      </div>

      <Checkbox
        className="mt-4"
        name="consentAccepted"
        checked={value.accepted}
        onCheckedChange={(accepted) => onChange({ ...value, accepted })}
        disabled={disabled}
        required
        label={t('kit.consent.accept')}
        description={t('kit.consent.acceptHint')}
        error={problems.accepted ? t('kit.consent.problem.notAccepted') : undefined}
      />

      <p className="mt-4 border-t border-line pt-3 text-xs text-fg-muted">
        {t(`kit.consent.stored.${kind}`)}{' '}
        {available.consents && (
          <Link to={LIB_ROUTES.consents} className="font-semibold text-fg underline">
            {t('kit.consent.manage')}
          </Link>
        )}
      </p>
    </section>
  );
}
