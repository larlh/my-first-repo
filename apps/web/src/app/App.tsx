import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { RouterProvider } from 'react-router-dom';
import { isApiError } from '@/lib/api/errors';
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

/** Everything a page can rely on: data cache, theme, session, confirm dialogs, toasts. */
export function AppProviders({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <SessionProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
          <Toaster />
        </SessionProvider>
      </ThemeProvider>
    </QueryClientProvider>
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
    </AppProviders>
  );
}
