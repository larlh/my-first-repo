import { PLANS, roleAtLeast } from '@parlante/shared';
import type { Plan, Role, SessionInfo, UiLocale, User, WorkspaceWithRole } from '@parlante/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { isApiError } from '../api/errors';
import type { ApiError } from '../api/errors';
import { apiClient, apiRequester } from '../api/instance';
import { changeLocale, currentLocale, hasStoredLocale } from '../i18n';

/* -------------------------------------------------------------------------------------------
 * Session / workspace context. One query (`GET /api/auth/me`) feeds everything the shell and
 * the features need: user, workspaces, the active workspace with the caller role, its plan and
 * credit balance.
 *
 *   const { user, workspace, role, plan, credits, can } = useSession();   // inside guarded routes
 *   const session = useSessionState();                                     // anywhere (may be anonymous)
 *
 * Feature code that logs in / registers calls `setSession(info)` with the API answer.
 * ----------------------------------------------------------------------------------------- */

export const SESSION_QUERY_KEY = ['session'] as const;

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

export interface SessionActions {
  /** Store the answer of login / register / accept-invite (or null to drop the session). */
  setSession: (info: SessionInfo | null) => void;
  /** Re-read the session (credits, plan, workspaces) from the API. */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  /** Make another workspace the active one; every workspace-scoped query is dropped. */
  switchWorkspace: (workspaceId: string) => Promise<void>;
  /** Change the UI language and store it on the profile. */
  setLocale: (locale: UiLocale) => Promise<void>;
}

export interface SessionState extends SessionActions {
  status: SessionStatus;
  info: SessionInfo | null;
  /** Why the session could not be read (API down…). Only with status `error`. */
  error: ApiError | null;
  user: User | null;
  workspaces: WorkspaceWithRole[];
  /** Active workspace with the caller role. */
  workspace: WorkspaceWithRole | null;
  role: Role | null;
  plan: Plan | null;
  credits: number;
  /** True when the caller role in the active workspace is at least `min`. */
  can: (min: Role) => boolean;
}

/** `useSession()` inside guarded routes: nothing is nullable. */
export interface AuthenticatedSession extends SessionActions {
  status: 'authenticated';
  info: SessionInfo;
  user: User;
  workspaces: WorkspaceWithRole[];
  workspace: WorkspaceWithRole;
  role: Role;
  plan: Plan;
  credits: number;
  can: (min: Role) => boolean;
}

const SessionContext = createContext<SessionState | null>(null);

async function fetchSession(): Promise<SessionInfo | null> {
  try {
    return await apiClient.auth.me(undefined, { skipAuthRedirect: true });
  } catch (err) {
    if (isApiError(err) && err.status === 401) return null;
    throw err;
  }
}

/** Drop everything cached for the previous workspace / user. */
function dropApiQueries(client: QueryClient): void {
  client.removeQueries({ predicate: (query) => query.queryKey[0] === 'api' });
}

export function currentWorkspaceOf(info: SessionInfo | null): WorkspaceWithRole | null {
  if (!info) return null;
  return (
    info.workspaces.find((w) => w.id === info.currentWorkspaceId) ?? info.workspaces[0] ?? null
  );
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery<SessionInfo | null, ApiError>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSession,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: (failures, error) => error.code === 'NETWORK_ERROR' && failures < 2,
  });

  // A 401 on any session route means the session is gone: guards redirect to the login page.
  useEffect(() => {
    apiRequester.configure({
      onUnauthenticated: () => client.setQueryData(SESSION_QUERY_KEY, null),
    });
    return () => apiRequester.configure({ onUnauthenticated: undefined });
  }, [client]);

  const info = query.data ?? null;

  // Follow the profile language unless this device has an explicit choice.
  const profileLocale = info?.user.locale;
  useEffect(() => {
    if (profileLocale && !hasStoredLocale() && profileLocale !== currentLocale()) {
      void changeLocale(profileLocale, { persist: false });
    }
  }, [profileLocale]);

  const setSession = useCallback(
    (next: SessionInfo | null) => {
      dropApiQueries(client);
      client.setQueryData(SESSION_QUERY_KEY, next);
    },
    [client],
  );

  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  }, [client]);

  const logout = useCallback(async () => {
    try {
      await apiClient.auth.logout(undefined, { skipAuthRedirect: true });
    } catch (err) {
      // Already logged out server side is fine; anything else still clears the local session.
      if (!isApiError(err)) throw err;
    }
    client.setQueryData(SESSION_QUERY_KEY, null);
    dropApiQueries(client);
  }, [client]);

  const switchWorkspace = useCallback(
    async (workspaceId: string) => {
      const next = await apiClient.auth.switchWorkspace({ body: { workspaceId } });
      dropApiQueries(client);
      client.setQueryData(SESSION_QUERY_KEY, next);
    },
    [client],
  );

  const setLocale = useCallback(
    async (locale: UiLocale) => {
      await changeLocale(locale);
      const current = client.getQueryData<SessionInfo | null>(SESSION_QUERY_KEY);
      if (!current || current.user.locale === locale) return;
      const user = await apiClient.auth.updateProfile({ body: { locale } });
      client.setQueryData<SessionInfo | null>(SESSION_QUERY_KEY, (prev) =>
        prev ? { ...prev, user } : prev,
      );
    },
    [client],
  );

  const value = useMemo<SessionState>(() => {
    const workspace = currentWorkspaceOf(info);
    const role = workspace?.role ?? null;
    const status: SessionStatus = query.isPending
      ? 'loading'
      : info
        ? 'authenticated'
        : query.isError
          ? 'error'
          : 'anonymous';
    return {
      status,
      info,
      error: status === 'error' ? query.error : null,
      user: info?.user ?? null,
      workspaces: info?.workspaces ?? [],
      workspace,
      role,
      plan: workspace ? PLANS[workspace.plan] : null,
      credits: workspace?.credits ?? 0,
      can: (min) => role !== null && roleAtLeast(role, min),
      setSession,
      refresh,
      logout,
      switchWorkspace,
      setLocale,
    };
  }, [
    info,
    query.isPending,
    query.isError,
    query.error,
    setSession,
    refresh,
    logout,
    switchWorkspace,
    setLocale,
  ]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Session state anywhere under the provider (public pages included). */
export function useSessionState(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSessionState must be used inside <SessionProvider>');
  return value;
}

/** Session inside routes guarded by the shell (`layout: 'app' | 'fullscreen'`). */
export function useSession(): AuthenticatedSession {
  const value = useSessionState();
  if (value.status !== 'authenticated' || !value.info || !value.user || !value.workspace) {
    throw new Error('useSession() needs an authenticated session: use it under a guarded route');
  }
  return value as unknown as AuthenticatedSession;
}

/** Session state, or null when no provider is mounted (isolated component tests). */
export function useOptionalSessionState(): SessionState | null {
  return useContext(SessionContext);
}
