import { apiClient } from '@/lib/api';
import type { SessionActions } from '@/lib/session';

/**
 * After leaving or deleting the active workspace the server moves the session to another
 * membership. Re-read it and replace the cached session (which also drops every cached query
 * of the workspace that is gone).
 */
export async function reloadSession(session: Pick<SessionActions, 'setSession'>): Promise<void> {
  const info = await apiClient.auth.me();
  session.setSession(info);
}
