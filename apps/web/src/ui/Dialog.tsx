import { X } from 'lucide-react';
import { Dialog as RadixDialog, VisuallyHidden } from 'radix-ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { IconButton } from './Button';
import { useReturnFocus } from './useReturnFocus';

const WIDTHS = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
} as const;

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required: names the dialog for assistive tech. Hide it visually with `hideTitle`. */
  title: ReactNode;
  description?: ReactNode;
  hideTitle?: boolean;
  /** Button row; rendered right-aligned (stacked on mobile). */
  footer?: ReactNode;
  size?: keyof typeof WIDTHS;
  /** Block closing by Escape / outside click (while a request is in flight). */
  dismissible?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * Modal dialog: focus is trapped and restored, Escape closes, the page behind is inert.
 * On phones it docks to the bottom edge as a sheet.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  hideTitle = false,
  footer,
  size = 'md',
  dismissible = true,
  className,
  children,
}: DialogProps) {
  const { t } = useTranslation('shell');
  const returnFocus = useReturnFocus(open);
  const block = (event: Event) => {
    if (!dismissible) event.preventDefault();
  };
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-scrim data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <RadixDialog.Content
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          onInteractOutside={block}
          onCloseAutoFocus={returnFocus}
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cn(
            'fixed z-50 flex max-h-[92dvh] w-full flex-col border border-line bg-surface text-fg shadow-lg outline-none',
            'inset-x-0 bottom-0 rounded-t-xl data-[state=closed]:animate-fade-out data-[state=open]:animate-slide-in-bottom',
            'sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:max-h-[85dvh] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
            'sm:data-[state=closed]:animate-pop-out sm:data-[state=open]:animate-pop-in',
            WIDTHS[size],
            className,
          )}
        >
          <div className="flex items-start gap-4 px-5 pt-5 pb-1 sm:px-6">
            <div className="min-w-0 flex-1">
              {hideTitle ? (
                <VisuallyHidden.Root asChild>
                  <RadixDialog.Title>{title}</RadixDialog.Title>
                </VisuallyHidden.Root>
              ) : (
                <RadixDialog.Title className="display text-xl">{title}</RadixDialog.Title>
              )}
              {description && (
                <RadixDialog.Description className="mt-1.5 text-sm text-fg-muted">
                  {description}
                </RadixDialog.Description>
              )}
            </div>
            {dismissible && (
              <RadixDialog.Close asChild>
                <IconButton label={t('ui.close')} size="sm" noTooltip className="-mt-1 -mr-2">
                  <X aria-hidden="true" />
                </IconButton>
              </RadixDialog.Close>
            )}
          </div>
          {children !== undefined && children !== null && (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">{children}</div>
          )}
          {footer && (
            <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
