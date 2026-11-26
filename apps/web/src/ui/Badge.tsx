import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BadgeTone =
  'neutral' | 'accent' | 'saffron' | 'success' | 'warning' | 'danger' | 'info';

const SOFT: Record<BadgeTone, string> = {
  neutral: 'bg-surface-3 text-fg-muted',
  accent: 'bg-accent-soft text-accent-text',
  saffron: 'bg-saffron-soft text-saffron-text',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
  info: 'bg-info-soft text-info-text',
};

const SOLID: Record<BadgeTone, string> = {
  neutral: 'bg-inverse text-inverse-fg',
  accent: 'bg-accent text-accent-fg',
  saffron: 'bg-saffron text-saffron-fg',
  success: 'bg-success-soft text-success-text ring-1 ring-inset ring-success',
  warning: 'bg-warning-soft text-warning-text ring-1 ring-inset ring-warning',
  danger: 'bg-danger text-danger-fg',
  info: 'bg-info-soft text-info-text ring-1 ring-inset ring-info',
};

const DOT: Record<BadgeTone, string> = {
  neutral: 'bg-fg-subtle',
  accent: 'bg-accent',
  saffron: 'bg-saffron',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

export interface BadgeProps extends ComponentProps<'span'> {
  tone?: BadgeTone;
  variant?: 'soft' | 'solid' | 'outline';
  size?: 'sm' | 'md';
  /** Leading status dot. `pulse` animates it (live / in progress). */
  dot?: boolean;
  pulse?: boolean;
  icon?: ReactNode;
}

/** Compact status / category label. Never the only carrier of meaning: always has text. */
export function Badge({
  tone = 'neutral',
  variant = 'soft',
  size = 'md',
  dot = false,
  pulse = false,
  icon,
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full font-semibold whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0',
        size === 'sm' ? 'h-5 px-2 text-2xs' : 'h-6 px-2.5 text-xs',
        variant === 'soft' && SOFT[tone],
        variant === 'solid' && SOLID[tone],
        variant === 'outline' && 'border border-line-strong text-fg-muted',
        className,
      )}
      {...props}
    >
      {dot && (
        <span className="relative flex size-1.5">
          {pulse && (
            <span
              className={cn(
                'absolute inline-flex size-full animate-ping rounded-full opacity-70',
                DOT[tone],
              )}
            />
          )}
          <span className={cn('relative inline-flex size-1.5 rounded-full', DOT[tone])} />
        </span>
      )}
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}
