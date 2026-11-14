import type { Providers } from '@parlante/shared';
import type { Db, MemberRow, SessionRow, UserRow, WorkspaceRow, ApiKeyRow } from '@parlante/db';
import type { FileUrlBuilder, QueueClient } from '@parlante/jobs';
import type { Role } from '@parlante/shared';
import type { ApiConfig } from './config';

/** Authenticated context of a request. `workspaceId` scopes EVERY query of the handler. */
export interface SessionAuth {
  kind: 'session';
  workspaceId: string;
  workspace: WorkspaceRow;
  role: Role;
  userId: string;
  user: UserRow;
  session: SessionRow;
  member: MemberRow;
  apiKey: null;
}

export interface ApiKeyAuth {
  kind: 'apiKey';
  workspaceId: string;
  workspace: WorkspaceRow;
  /** API keys act with editor permissions. */
  role: 'editor';
  /** API-key requests have no user: use `userId ?? null` for `created_by` columns. */
  userId: null;
  user: null;
  session: null;
  member: null;
  apiKey: ApiKeyRow;
}

export type AuthContext = SessionAuth | ApiKeyAuth;

declare module 'fastify' {
  interface FastifyInstance {
    config: ApiConfig;
    db: Db;
    queues: QueueClient;
    providers: Providers;
    /** Storage key → absolute, signed URL (null in → null out). */
    fileUrl: FileUrlBuilder;
  }
  interface FastifyRequest {
    /** Set by the auth pre-handler of routes declared with `auth: 'session' | 'apiKey'`. */
    auth: AuthContext | null;
  }
}
