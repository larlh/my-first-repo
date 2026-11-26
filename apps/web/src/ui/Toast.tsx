import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { Toast as RadixToast } from 'radix-ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { cn } from '@/lib/cn';

/* Toasts: transient, non-blocking feedback. Imperative API usable anywhere (no hook needed):
 *
 *   toast.success('Vídeo duplicado');
 *   toast.error(t('errors.generic'), { description: error.message });
 *   toast.info('Render en cola', { action: { label: 'Ver', onClick: () => navigate(…) } });
 *
 * `<Toaster />` is mounted once by the shell. */

export type ToastTone = 'neutral' | 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  description?: ReactNode;
  /** Milliseconds before auto-dismiss (default 5000; errors 8000). */
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** Reuse an id to replace a toast instead of stacking (progress → result). */
  id?: string;
}

interface ToastItem extends ToastOptions {
  id: string;
  tone: ToastTone;
  title: ReactNode;
  open: boolean;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (item: Omit<ToastItem, 'open'>) => void;
  close: (id: string) => void;
  remove: (id: string) => void;
}

const MAX_VISIBLE = 4;
let counter = 0;

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (item) =>
    set((state) => {
      const rest = state.toasts.filter((t) => t.id !== item.id);
      return { toasts: [...rest, { ...item, open: true }].slice(-MAX_VISIBLE) };
    }),
  close: (id) =>
    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, open: false } : t)),
    })),
  remove: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

function show(tone: ToastTone, title: ReactNode, options: ToastOptions = {}): string {
  counter += 1;
  const id = options.id ?? `toast-${counter}`;
  useToastStore.getState().push({ ...options, id, tone, title });
  return id;
}

export const toast = Object.assign(
  (title: ReactNode, options?: ToastOptions) => show('neutral', title, options),
  {
    success: (title: ReactNode, options?: ToastOptions) => show('success', title, options),
    error: (title: ReactNode, options?: ToastOptions) => show('error', title, options),
    warning: (title: ReactNode, options?: ToastOptions) => show('warning', title, options),
    info: (title: ReactNode, options?: ToastOptions) => show('info', title, options),
    dismiss: (id: string) => useToastStore.getState().close(id),
    /** Remove everything at once (tests, route changes). */
    clear: () => useToastStore.setState({ toasts: [] }),
  },
);

const ICONS: Record<ToastTone, ReactNode> = {
  neutral: null,
  success: <CircleCheck className="size-5 text-success" aria-hidden="true" />,
  error: <CircleAlert className="size-5 text-danger-text" aria-hidden="true" />,
  warning: <TriangleAlert className="size-5 text-warning-text" aria-hidden="true" />,
  info: <Info className="size-5 text-info-text" aria-hidden="true" />,
};

/** Viewport + renderer. Mount once near the root. */
export function Toaster() {
  const { t } = useTranslation('shell');
  const toasts = useToastStore((state) => state.toasts);
  const close = useToastStore((state) => state.close);
  const remove = useToastStore((state) => state.remove);
  return (
    <RadixToast.Provider swipeDirection="right" label={t('ui.notifications')}>
      {toasts.map((item) => (
        <RadixToast.Root
          key={item.id}
          open={item.open}
          type={item.tone === 'error' ? 'foreground' : 'background'}
          duration={item.duration ?? (item.tone === 'error' ? 8000 : 5000)}
          onOpenChange={(open) => {
            if (open) return;
            close(item.id);
            window.setTimeout(() => remove(item.id), 200);
          }}
          className={cn(
            'pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-line bg-surface p-3.5 pr-2.5 text-fg shadow-lg',
            'data-[state=closed]:animate-fade-out data-[state=open]:animate-rise-in',
            'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=end]:animate-fade-out',
          )}
        >
          {ICONS[item.tone] && <span className="mt-px flex shrink-0">{ICONS[item.tone]}</span>}
          <div className="min-w-0 flex-1">
            <RadixToast.Title className="text-sm font-semibold break-words">
              {item.title}
            </RadixToast.Title>
            {item.description && (
              <RadixToast.Description className="mt-0.5 text-sm break-words text-fg-muted">
                {item.description}
              </RadixToast.Description>
            )}
            {item.action && (
              <RadixToast.Action
                altText={item.action.label}
                onClick={item.action.onClick}
                className="mt-2 rounded-xs text-sm font-semibold text-accent-text underline-offset-4 hover:underline"
              >
                {item.action.label}
              </RadixToast.Action>
            )}
          </div>
          <RadixToast.Close
            aria-label={t('ui.close')}
            className="flex size-7 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:bg-fg/8 hover:text-fg"
          >
            <X className="size-4" aria-hidden="true" />
          </RadixToast.Close>
        </RadixToast.Root>
      ))}
      <RadixToast.Viewport className="pointer-events-none fixed right-0 bottom-0 z-[80] flex w-full max-w-sm flex-col gap-2 p-4 outline-none sm:right-2 sm:bottom-2" />
    </RadixToast.Provider>
  );
}
