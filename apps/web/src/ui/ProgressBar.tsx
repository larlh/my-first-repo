import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

const TONES = {
  accent: 'bg-accent',
  saffron: 'bg-saffron',
  success: 'bg-success',
  danger: 'bg-danger',
  neutral: 'bg-fg',
} as const;

export interface ProgressBarProps {
  /** 0..100. Omit (or pass null) for an indeterminate bar. */
  value?: number | null;
  /** Accessible name (required unless `aria-labelledby` points to a visible label). */
  label?: string;
  'aria-labelledby'?: string;
  /** Human text of the value for assistive tech ("42 %, quedan 2 min"). */
  valueText?: string;
  tone?: keyof typeof TONES;
  size?: 'sm' | 'md';
  /** Show `label` and the percentage above the bar. */
  showHeader?: boolean;
  /** Right side of the header instead of the percentage (ETA, counters). */
  aside?: ReactNode;
  className?: string;
}

export function ProgressBar({
  value,
  label,
  valueText,
  tone = 'accent',
  size = 'md',
  showHeader = false,
  aside,
  className,
  'aria-labelledby': labelledBy,
}: ProgressBarProps) {
  const indeterminate = value === undefined || value === null;
  const clamped = indeterminate ? 0 : Math.min(100, Math.max(0, value));
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {showHeader && (
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="min-w-0 truncate font-medium text-fg">{label}</span>
          <span className="nums shrink-0 text-fg-muted">
            {aside ?? (indeterminate ? null : `${Math.round(clamped)} %`)}
          </span>
        </div>
      )}
      <div
        role="progressbar"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
        aria-valuetext={valueText}
        className={cn(
          'relative w-full overflow-hidden rounded-full bg-surface-3',
          size === 'sm' ? 'h-1' : 'h-2',
        )}
      >
        {indeterminate ? (
          <span
            className={cn(
              'absolute inset-y-0 w-[45%] animate-indeterminate rounded-full',
              TONES[tone],
            )}
          />
        ) : (
          <span
            className={cn(
              'absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-standard',
              TONES[tone],
            )}
            style={{ width: `${clamped}%` }}
          />
        )}
      </div>
    </div>
  );
}
