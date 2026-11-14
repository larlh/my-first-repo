import { Popover as RadixPopover } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

/* Non-modal floating panel anchored to a trigger (pickers, filters, small forms). */

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

export function PopoverContent({
  className,
  sideOffset = 8,
  collisionPadding = 8,
  align = 'start',
  ...props
}: ComponentProps<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        align={align}
        className={cn(
          'z-[60] w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-line bg-surface p-4 text-fg shadow-lg outline-none',
          'data-[state=open]:animate-pop-in',
          className,
        )}
        {...props}
      />
    </RadixPopover.Portal>
  );
}
