import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TooltipProps {
  /** Tooltip text. When empty the child is rendered untouched. */
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  delayMs?: number;
  className?: string;
}

/** Hover / focus hint. The child must be focusable (button, link…). */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  delayMs = 350,
  className,
}: TooltipProps) {
  if (content === null || content === undefined || content === '') return <>{children}</>;
  return (
    <RadixTooltip.Provider delayDuration={delayMs} skipDelayDuration={200}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              'z-[70] max-w-64 rounded-sm bg-inverse px-2 py-1 text-xs font-medium text-inverse-fg shadow-md',
              'data-[state=delayed-open]:animate-fade-in data-[state=instant-open]:animate-fade-in',
              className,
            )}
          >
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
