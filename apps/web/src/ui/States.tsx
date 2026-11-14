import { RotateCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { isApiError } from '@/lib/api/errors';
import { Button } from './Button';
import { VoiceBars } from './Spinner';

export interface EmptyStateProps {
  /** Icon element (lucide) shown in the badge; defaults to the resting voice bars. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Primary call to action (a `<Button variant="primary">`). */
  action?: ReactNode;
  secondaryAction?: ReactNode;
  /** `sm` inside cards/panels, `md` for a whole page section. */
  size?: 'sm' | 'md';
  className?: string;
}

/** "Nothing here yet" — always says what the place is for and offers the next step. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  size = 'md',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'sm' ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-14',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          'booth-grid mb-1 flex items-center justify-center rounded-xl border border-line bg-surface-2 text-fg-muted',
          size === 'sm' ? 'size-12 [&_svg]:size-5' : 'size-16 [&_svg]:size-7',
        )}
      >
        {icon ?? <VoiceBars active={false} size={size === 'sm' ? 'sm' : 'md'} label={null} />}
      </div>
      <h3 className={size === 'sm' ? 'text-base' : 'text-xl'}>{title}</h3>
      {description && <p className="max-w-md text-sm text-balance text-fg-muted">{description}</p>}
      {(action || secondaryAction) && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

/** Translation key suffix + raw message for any thrown value. */
export function useErrorText(): (error: unknown) => {
  title: string;
  message: string;
  code: string | null;
} {
  const { t, i18n } = useTranslation('shell');
  return (error) => {
    if (isApiError(error)) {
      const key = `errors.${error.code}`;
      const known = i18n.exists(key, { ns: 'shell' });
      return {
        title: known ? t(key) : t('errors.generic'),
        // Validation and domain errors carry a useful server message; show it as detail.
        message: known && error.status >= 500 ? '' : error.message,
        code: error.code,
      };
    }
    return {
      title: t('errors.generic'),
      message: error instanceof Error ? error.message : '',
      code: null,
    };
  };
}

export interface ErrorStateProps {
  /** Anything thrown: ApiError codes are translated, other errors show a generic title. */
  error?: unknown;
  /** Overrides the derived title / description. */
  title?: ReactNode;
  description?: ReactNode;
  /** Shows a "retry" button. */
  onRetry?: () => void;
  retrying?: boolean;
  action?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}

/** "This failed" — what happened in plain words, the error code, and a way forward. */
export function ErrorState({
  error,
  title,
  description,
  onRetry,
  retrying,
  action,
  size = 'md',
  className,
}: ErrorStateProps) {
  const { t } = useTranslation('shell');
  const describe = useErrorText();
  const derived = error !== undefined ? describe(error) : null;
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'sm' ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-14',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          'mb-1 flex items-center justify-center rounded-xl bg-danger-soft text-danger-text',
          size === 'sm' ? 'size-12 [&_svg]:size-5' : 'size-16 [&_svg]:size-7',
        )}
      >
        <TriangleAlert />
      </div>
      <h3 className={size === 'sm' ? 'text-base' : 'text-xl'}>
        {title ?? derived?.title ?? t('errors.generic')}
      </h3>
      {(description ?? derived?.message) && (
        <p className="max-w-md text-sm text-balance break-words text-fg-muted">
          {description ?? derived?.message}
        </p>
      )}
      {derived?.code && (
        <code className="rounded-xs bg-surface-3 px-1.5 py-0.5 font-mono text-2xs text-fg-muted">
          {derived.code}
        </code>
      )}
      {(onRetry || action) && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <Button onClick={onRetry} loading={retrying} leftIcon={<RotateCw aria-hidden="true" />}>
              {t('ui.retry')}
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
