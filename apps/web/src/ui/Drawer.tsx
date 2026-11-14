import { X } from 'lucide-react';
import { Dialog as RadixDialog, VisuallyHidden } from 'radix-ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { IconButton } from './Button';
import { useReturnFocus } from './useReturnFocus';

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required accessible name; hidden visually with `hideTitle` (e.g. navigation drawers). */
  title: ReactNode;
  description?: ReactNode;
  hideTitle?: boolean;
  side?: 'left' | 'right';
  footer?: ReactNode;
  /** Tailwind width classes of the panel. */
  widthClassName?: string;
  /** Remove the default padding/scroll wrapper (the content manages its own layout). */
  bare?: boolean;
  className?: string;
  children?: ReactNode;
}

/** Side panel over the page: modal, focus-trapped, closes with Escape or the scrim. */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  hideTitle = false,
  side = 'right',
  footer,
  widthClassName = 'w-[min(26rem,100vw-3rem)]',
  bare = false,
  className,
  children,
}: DrawerProps) {
  const { t } = useTranslation('shell');
  const returnFocus = useReturnFocus(open);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-scrim data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <RadixDialog.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          onCloseAutoFocus={returnFocus}
          className={cn(
            'fixed inset-y-0 z-50 flex flex-col bg-surface text-fg shadow-lg outline-none',
            side === 'left'
              ? 'left-0 border-r border-line data-[state=closed]:animate-slide-out-left data-[state=open]:animate-slide-in-left'
              : 'right-0 border-l border-line data-[state=closed]:animate-slide-out-right data-[state=open]:animate-slide-in-right',
            widthClassName,
            className,
          )}
        >
          {hideTitle ? (
            <VisuallyHidden.Root asChild>
              <RadixDialog.Title>{title}</RadixDialog.Title>
            </VisuallyHidden.Root>
          ) : (
            <div className="flex items-start gap-4 border-b border-line px-5 py-4">
              <div className="min-w-0 flex-1">
                <RadixDialog.Title className="display text-lg">{title}</RadixDialog.Title>
                {description && (
                  <RadixDialog.Description className="mt-1 text-sm text-fg-muted">
                    {description}
                  </RadixDialog.Description>
                )}
              </div>
              <RadixDialog.Close asChild>
                <IconButton label={t('ui.close')} size="sm" noTooltip className="-mr-2">
                  <X aria-hidden="true" />
                </IconButton>
              </RadixDialog.Close>
            </div>
          )}
          {bare ? (
            children
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          )}
          {footer && (
            <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
