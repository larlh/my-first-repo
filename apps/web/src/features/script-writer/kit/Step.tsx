import type { ReactNode } from 'react';
import { cn } from '@/ui';

export interface StepProps {
  /** Position in the flow ("01"). */
  number: string;
  title: ReactNode;
  description?: ReactNode;
  /** Right side of the heading row (a status badge, a counter). */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * One numbered step of a multi-step form (translation, batch): a card whose heading carries
 * the take number in mono, like the slate of a recording.
 */
export function Step({ number, title, description, aside, className, children }: StepProps) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-6',
        className,
      )}
    >
      <div className="mb-4 flex min-w-0 items-start gap-3">
        <span
          aria-hidden="true"
          className="nums mt-0.5 flex h-7 shrink-0 items-center rounded-md bg-inverse px-2 font-mono text-xs font-semibold text-inverse-fg"
        >
          {number}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg leading-7">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-pretty text-fg-muted">{description}</p>}
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>
      {children}
    </section>
  );
}
