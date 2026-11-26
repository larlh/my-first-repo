import { Check, Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, cn } from '@/ui';
import { copyText } from '../lib/clipboard';

export interface SecretFieldProps {
  label: ReactNode;
  value: string;
  /** Help under the field ("no se volverá a mostrar"). */
  hint?: ReactNode;
  /** Wrap long values (links, code) instead of scrolling on one line. */
  multiline?: boolean;
  /** Called after a successful copy. */
  onCopied?: () => void;
  className?: string;
}

/**
 * A value shown once (API key, signing secret, invitation link) with a copy button. The text
 * is selectable and selected on focus so it can also be copied by hand; the copy result is
 * announced to assistive tech.
 */
export function SecretField({
  label,
  value,
  hint,
  multiline = false,
  onCopied,
  className,
}: SecretFieldProps) {
  const { t } = useTranslation('settings');
  const id = useId();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    const ok = await copyText(value);
    setState(ok ? 'copied' : 'failed');
    if (ok) onCopied?.();
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2500);
  };

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-stretch">
        {multiline ? (
          <textarea
            id={id}
            readOnly
            data-secret=""
            rows={3}
            value={value}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            aria-describedby={hint ? `${id}-hint` : undefined}
            className="min-w-0 flex-1 resize-none rounded-md border border-line-control bg-bg-sunken px-3 py-2 font-mono text-xs leading-5 break-all text-fg"
          />
        ) : (
          <input
            id={id}
            readOnly
            data-secret=""
            value={value}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            aria-describedby={hint ? `${id}-hint` : undefined}
            className="h-10 min-w-0 flex-1 rounded-md border border-line-control bg-bg-sunken px-3 font-mono text-sm text-fg"
          />
        )}
        <Button
          variant={state === 'copied' ? 'secondary' : 'solid'}
          className="shrink-0 sm:self-start"
          leftIcon={state === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          onClick={() => void copy()}
        >
          {state === 'copied' ? t('copy.done') : t('copy.action')}
        </Button>
      </div>
      <p aria-live="polite" className="sr-only">
        {state === 'copied' ? t('copy.done') : state === 'failed' ? t('copy.failed') : ''}
      </p>
      {state === 'failed' ? (
        <p className="text-sm font-medium text-danger-text">{t('copy.failed')}</p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-sm text-fg-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
