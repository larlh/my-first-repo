import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { RouterProvider } from 'react-router-dom';
import { isApiError } from '@/lib/api/errors';
import { DictationRuntime } from '@/lib/dictation/runtime';
import { SessionProvider } from '@/lib/session';
import { ThemeProvider } from '@/lib/theme';
import { ConfirmProvider } from '@/ui/ConfirmDialog';
import { Toaster } from '@/ui/Toast';
import { RegistryProvider } from './RegistryContext';
import { registry } from './registry';
import { createAppRouter } from './router';

/** Query defaults: no retry on answers the server gave on purpose (4xx), short freshness. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: (failures, error) => {
          if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
          if (isApiError(error) && error.code === 'ABORTED') return false;
          return failures < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

/** Everything a page can rely on: data cache, theme, session, confirm dialogs, toasts, dictation. */
export function AppProviders({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <SessionProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
          <Toaster />
          <DictationRuntime />
        </SessionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

/**
 * Development only: features that could not be mounted (see `registry.ts`). The rest of the
 * application keeps working; this says why a page or a menu entry is missing. Developer
 * diagnostics, so the text is not translated.
 */
export function FeatureProblems({ problems }: { problems: readonly string[] }) {
  const [open, setOpen] = useState(true);
  if (!open || problems.length === 0) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-3 bottom-3 z-[95] mx-auto max-w-3xl rounded-lg border border-danger bg-danger-soft p-4 text-sm text-danger-text shadow-lg"
    >
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 font-semibold">
          {problems.length} feature problem(s) — the rest of the app is still running
        </p>
        <button type="button" className="shrink-0 underline" onClick={() => setOpen(false)}>
          Dismiss
        </button>
      </div>
      <ul className="mt-2 max-h-40 list-disc overflow-y-auto pl-5 font-mono text-xs break-words">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </div>
  );
}

export function App() {
  const [client] = useState(createQueryClient);
  const [router] = useState(() => createAppRouter(registry));
  return (
    <AppProviders client={client}>
      <RegistryProvider registry={registry}>
        <RouterProvider router={router} />
      </RegistryProvider>
      {import.meta.env.DEV && <FeatureProblems problems={registry.problems} />}
    </AppProviders>
  );
}
