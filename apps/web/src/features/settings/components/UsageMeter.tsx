import { cn } from '@/ui';

const BAR = { ok: 'bg-fg', high: 'bg-warning', full: 'bg-danger' } as const;

export interface UsageMeterProps {
  label: string;
  /** Human text of the value: "3 de 5", "1,2 GB de 20 GB". */
  valueText: string;
  /** 0..100 */
  percent: number;
  level?: keyof typeof BAR;
  className?: string;
}

/** How much of a plan limit is used: label, value and a thin bar (role="meter"). */
export function UsageMeter({
  label,
  valueText,
  percent,
  level = 'ok',
  className,
}: UsageMeterProps) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-fg-muted">{label}</span>
        <span className={cn('nums shrink-0 font-medium', level === 'full' && 'text-danger-text')}>
          {valueText}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={valueText}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3"
      >
        <span
          className={cn('block h-full rounded-full transition-[width] duration-500', BAR[level])}
          style={{ width: `${Math.max(percent, percent > 0 ? 2 : 0)}%` }}
        />
      </div>
    </div>
  );
}
