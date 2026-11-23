import type { LanguageCode } from '@parlante/shared';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/ui';
import { languageLabel, useUiLocale } from '@/features/script-writer/kit';
import { targetChoices, toggleTarget } from '../lib/translate';

export interface TargetLanguagesProps {
  source: LanguageCode;
  value: readonly LanguageCode[];
  onChange: (targets: LanguageCode[]) => void;
  /** Plan limit of target languages per job. */
  max: number;
  error?: string;
}

/** Multi-choice of target languages, capped by the plan. Native checkboxes: Space toggles. */
export function TargetLanguages({ source, value, onChange, max, error }: TargetLanguagesProps) {
  const { t } = useTranslation('translate');
  const locale = useUiLocale();
  const full = value.length >= max;
  return (
    <fieldset className="min-w-0" aria-describedby="translate-targets-hint">
      <legend className="mb-1.5 flex w-full items-baseline justify-between gap-3 text-sm font-semibold">
        {t('targets.label')}
        <span className="nums font-mono text-xs font-normal text-fg-muted">
          {t('targets.count', { selected: value.length, max })}
        </span>
      </legend>
      <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
        {targetChoices(source).map((code) => {
          const checked = value.includes(code);
          const disabled = !checked && full;
          return (
            <label
              key={code}
              className={cn('relative min-w-0', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}
            >
              <input
                type="checkbox"
                value={code}
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(toggleTarget(value, code, max))}
                className="peer sr-only"
              />
              <span
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm transition-colors duration-150',
                  'hover:bg-surface-2 peer-checked:border-fg peer-checked:bg-surface-2 peer-checked:font-semibold peer-checked:shadow-[inset_0_0_0_1px_var(--fg)]',
                  'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
                  'peer-disabled:opacity-50 peer-disabled:hover:bg-surface',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-xs border',
                    checked ? 'border-accent bg-accent text-accent-fg' : 'border-line-control',
                  )}
                >
                  {checked && <Check className="size-3" strokeWidth={3} />}
                </span>
                <span className="min-w-0 truncate">{languageLabel(code, locale)}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p
        id="translate-targets-hint"
        role={error ? 'alert' : undefined}
        className={cn('mt-2 text-sm', error ? 'text-danger-text' : 'text-fg-muted')}
      >
        {error ?? (full ? t('targets.full', { count: max }) : t('targets.hint', { count: max }))}
      </p>
    </fieldset>
  );
}
