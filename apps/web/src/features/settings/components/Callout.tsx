import type { ReactNode } from 'react';
import { cn } from '@/ui';

const TONES = {
  neutral: 'border-line bg-surface-2 text-fg',
  info: 'border-transparent bg-info-soft text-info-text',
  saffron: 'border-transparent bg-saffron-soft text-saffron-text',
  warning: 'border-transparent bg-warning-soft text-warning-text',
  danger: 'border-transparent bg-danger-soft text-danger-text',
  success: 'border-transparent bg-success-soft text-success-text',
} as const;

export interface CalloutProps {
  tone?: keyof typeof TONES;
  icon?: ReactNode;
  title?: ReactNode;
  /** Buttons or links at the end of the row (wrap under the text on phones). */
  action?: ReactNode;
  /** `status` announces changes politely; `alert` interrupts. Omit for static notes. */
  role?: 'status' | 'alert' | 'note';
  className?: string;
  children?: ReactNode;
}

/** Inline notice attached to the content it explains (never a floating banner). */
export function Callout({
  tone = 'neutral',
  icon,
  title,
  action,
  role = 'note',
  className,
  children,
}: CalloutProps) {
  return (
    <div
      role={role}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-lg border px-4 py-3.5 text-sm sm:flex-row sm:items-center',
        TONES[tone],
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        {icon && (
          <span aria-hidden="true" className="mt-0.5 flex shrink-0 [&_svg]:size-[1.125rem]">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          {title && <p className="font-semibold">{title}</p>}
          {children && <div className={cn(title && 'mt-0.5', 'text-pretty')}>{children}</div>}
        </div>
      </div>
      {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </div>
  );
}
