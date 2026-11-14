import { AlertDialog } from 'radix-ui';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { Button } from './Button';
import { useReturnFocus } from './useReturnFocus';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  /** `danger` for destructive actions (delete, revoke…). */
  tone?: 'default' | 'danger';
  /** May return a promise: the dialog shows a spinner and stays open until it settles. */
  onConfirm: () => void | Promise<void>;
  children?: ReactNode;
}

/**
 * Confirmation prompt (alertdialog role: focus starts on Cancel, outside clicks do not
 * dismiss). For one-off confirmations prefer the imperative `useConfirm()`.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const { t } = useTranslation('shell');
  const [busy, setBusy] = useState(false);
  const returnFocus = useReturnFocus(open);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // The caller reports the failure (toast, inline error); keep the dialog open to retry.
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[55] bg-scrim data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <AlertDialog.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          onCloseAutoFocus={returnFocus}
          className={cn(
            'fixed top-1/2 left-1/2 z-[55] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line',
            'bg-surface p-5 text-fg shadow-lg outline-none data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in sm:p-6',
          )}
        >
          <AlertDialog.Title className="display text-xl">{title}</AlertDialog.Title>
          {description && (
            <AlertDialog.Description className="mt-2 text-sm text-fg-muted">
              {description}
            </AlertDialog.Description>
          )}
          {children && <div className="mt-4">{children}</div>}
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" disabled={busy}>
                {cancelLabel ?? t('ui.cancel')}
              </Button>
            </AlertDialog.Cancel>
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              loading={busy}
              onClick={() => void confirm()}
            >
              {confirmLabel ?? t('ui.confirm')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  tone?: 'default' | 'danger';
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Mounted once by the shell; provides `useConfirm()`. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((next) => {
    resolver.current?.(false);
    setOptions(next);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOpen(false);
  };

  const value = useMemo(() => confirm, [confirm]);
  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {options && (
        <ConfirmDialog
          open={open}
          onOpenChange={(next) => {
            if (!next) settle(false);
          }}
          onConfirm={() => settle(true)}
          {...options}
        />
      )}
    </ConfirmContext.Provider>
  );
}

/**
 * Ask before a destructive or irreversible action:
 *   const confirm = useConfirm();
 *   if (await confirm({ title: t('delete.title'), tone: 'danger' })) remove.mutate(…);
 */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return confirm;
}
