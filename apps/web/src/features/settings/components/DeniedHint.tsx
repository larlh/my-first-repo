import { Lock } from 'lucide-react';
import { Tooltip, cn } from '@/ui';

/**
 * Stands where an action would be when the caller may not perform it: a focusable padlock
 * whose tooltip (and accessible name) says why. Disabled buttons cannot explain themselves.
 */
export function DeniedHint({ reason, className }: { reason: string; className?: string }) {
  return (
    <Tooltip content={reason}>
      <span
        tabIndex={0}
        role="img"
        aria-label={reason}
        className={cn(
          'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-subtle',
          className,
        )}
      >
        <Lock aria-hidden="true" className="size-4" />
      </span>
    </Tooltip>
  );
}
