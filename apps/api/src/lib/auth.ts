import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, PLANS, newId, roleAtLeast } from '@parlante/shared';
import type { Role, SessionInfo, UiLocale } from '@parlante/shared';
import {
  generateApiKey,
  generateSessionToken,
  hashApiKey,
  hashPassword,
  hashSessionToken,
  looksLikeApiKey,
  verifyPassword,
} from '@parlante/shared/node';
import {
  and,
  apiKeys,
  asc,
  createUserWithWorkspace,
  createWorkspace,
  defaultWorkspaceName,
  eq,
  gt,
  isNull,
  lt,
  members,
  ne,
  sessions,
  users,
  workspaces,
} from '@parlante/db';
import type { ApiKeyRow, Db, MemberRow, SessionRow, UserRow, WorkspaceRow } from '@parlante/db';
import { cookieSecure } from '../config';
import type { ApiConfig } from '../config';
import type { ApiKeyAuth, AuthContext, SessionAuth } from '../types';
import { toSessionInfoDto } from './dto';

/* -------------------------------------------------------------------------------------------
 * Authentication library (complete). The `auth` module only wires these functions to routes.
 *
 *  - Passwords: scrypt (node:crypto) — `hashPassword` / `verifyPassword`.
 *  - Sessions: random token in an httpOnly SameSite=Lax cookie; only its SHA-256 is stored.
 *  - API keys: `plk_<prefix>_<secret>`; only the SHA-256 is stored.
 *  - Every authenticated request resolves ONE workspace: the session's active workspace
 *    (must still be a membership) or the API key's workspace.
 * ----------------------------------------------------------------------------------------- */

const SESSION_REFRESH_MS = 5 * 60 * 1000;
const API_KEY_TOUCH_MS = 60 * 1000;

/* ---------- cookies ---------- */

export function setSessionCookie(reply: FastifyReply, config: ApiConfig, token: string): void {
  void reply.setCookie(config.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(config),
    path: '/',
    maxAge: config.SESSION_TTL_DAYS * 24 * 3600,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: ApiConfig): void {
  void reply.clearCookie(config.SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(config),
    path: '/',
  });
}

export function clientIp(request: FastifyRequest): string {
  return request.ip;
}

/* ---------- sessions ---------- */

export async function listMemberships(
  db: Db,
  userId: string,
): Promise<{ workspace: WorkspaceRow; member: MemberRow; role: Role }[]> {
  const rows = await db
    .select({ workspace: workspaces, member: members })
    .from(members)
    .innerJoin(workspaces, eq(members.workspaceId, workspaces.id))
    .where(eq(members.userId, userId))
    .orderBy(asc(members.createdAt), asc(members.id));
  return rows.map((r) => ({ ...r, role: r.member.role }));
}

/** Create a session row and return the cookie token (shown to the client once). */
export async function createSession(
  db: Db,
  config: ApiConfig,
  input: {
    userId: string;
    workspaceId: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<{ session: SessionRow; token: string }> {
  const token = generateSessionToken();
  const [session] = await db
    .insert(sessions)
    .values({
      id: newId('session'),
      userId: input.userId,
      tokenHash: hashSessionToken(token),
      activeWorkspaceId: input.workspaceId,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      expiresAt: new Date(Date.now() + config.SESSION_TTL_DAYS * 24 * 3600 * 1000),
    })
    .returning();
  if (!session) throw new Error('Failed to create session');
  return { session, token };
}

export async function destroySession(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Revoke every session of a user except (optionally) the current one. */
export async function destroyOtherSessions(
  db: Db,
  userId: string,
  keepSessionId?: string,
): Promise<void> {
  await db
    .delete(sessions)
    .where(
      keepSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId))
        : eq(sessions.userId, userId),
    );
}

export async function deleteExpiredSessions(db: Db): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

/**
 * Resolve a cookie token to a full session context, or null. Guarantees the returned
 * workspace is one the user still belongs to (falls back to the first membership; creates a
 * personal workspace when the user has none left).
 */
export async function resolveSession(db: Db, token: string): Promise<SessionAuth | null> {
  if (token.length < 20 || token.length > 200) return null;
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(eq(sessions.tokenHash, hashSessionToken(token)), gt(sessions.expiresAt, new Date())),
    );
  if (!row) return null;
  let { session } = row;
  const { user } = row;

  let memberships = await listMemberships(db, user.id);
  if (memberships.length === 0) {
    await createWorkspace(db, {
      name: defaultWorkspaceName(user.name, user.locale),
      ownerId: user.id,
    });
    memberships = await listMemberships(db, user.id);
  }
  const active =
    memberships.find((m) => m.workspace.id === session.activeWorkspaceId) ?? memberships[0];
  if (!active) return null;

  const now = Date.now();
  if (
    active.workspace.id !== session.activeWorkspaceId ||
    now - session.lastSeenAt.getTime() > SESSION_REFRESH_MS
  ) {
    const [updated] = await db
      .update(sessions)
      .set({ activeWorkspaceId: active.workspace.id, lastSeenAt: new Date(now) })
      .where(eq(sessions.id, session.id))
      .returning();
    if (updated) session = updated;
  }
  return {
    kind: 'session',
    workspaceId: active.workspace.id,
    workspace: active.workspace,
    role: active.role,
    userId: user.id,
    user,
    session,
    member: active.member,
    apiKey: null,
  };
}

/** Change the active workspace of a session. Throws NOT_FOUND when the user is not a member. */
export async function switchWorkspace(
  db: Db,
  auth: SessionAuth,
  workspaceId: string,
): Promise<void> {
  const memberships = await listMemberships(db, auth.userId);
  if (!memberships.some((m) => m.workspace.id === workspaceId))
    throw AppError.notFound('Workspace');
  await db
    .update(sessions)
    .set({ activeWorkspaceId: workspaceId })
    .where(eq(sessions.id, auth.session.id));
}

/** The `SessionInfo` DTO for a session (re-reads memberships so it is always fresh). */
export async function buildSessionInfo(
  db: Db,
  input: { user: UserRow; session: SessionRow; currentWorkspaceId: string },
): Promise<SessionInfo> {
  const memberships = await listMemberships(db, input.user.id);
  const current =
    memberships.find((m) => m.workspace.id === input.currentWorkspaceId) ?? memberships[0];
  if (!current) throw new AppError('INVALID_STATE', 'The user does not belong to any workspace');
  return toSessionInfoDto({
    user: input.user,
    session: input.session,
    workspaces: memberships.map((m) => ({ workspace: m.workspace, role: m.role })),
    currentWorkspaceId: current.workspace.id,
  });
}

/* ---------- accounts ---------- */

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
  return user ?? null;
}

/** Register: user + personal workspace + signup credits. Throws EMAIL_TAKEN. */
export async function registerAccount(
  db: Db,
  input: { email: string; password: string; name: string; locale?: UiLocale },
): Promise<{ user: UserRow; workspace: WorkspaceRow }> {
  if (await findUserByEmail(db, input.email)) {
    throw new AppError('EMAIL_TAKEN', 'An account with this e-mail already exists');
  }
  try {
    const { user, workspace } = await createUserWithWorkspace(db, {
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
      locale: input.locale,
    });
    return { user, workspace };
  } catch (err) {
    // Unique violation from a concurrent registration with the same e-mail.
    if (
      (err as { code?: string }).code === '23505' ||
      (err as { cause?: { code?: string } }).cause?.code === '23505'
    ) {
      throw new AppError('EMAIL_TAKEN', 'An account with this e-mail already exists');
    }
    throw err;
  }
}

// Verified against when the e-mail is unknown, so both paths take the same time.
let dummyHash: Promise<string> | null = null;

/** Check credentials. Throws INVALID_CREDENTIALS (same error for unknown e-mail / bad password). */
export async function authenticate(db: Db, email: string, password: string): Promise<UserRow> {
  const user = await findUserByEmail(db, email);
  dummyHash ??= hashPassword('parlante-dummy-password');
  const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
  if (!user || !ok) throw new AppError('INVALID_CREDENTIALS', 'Incorrect e-mail or password');
  return user;
}

export async function changePassword(
  db: Db,
  user: UserRow,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AppError('INVALID_CREDENTIALS', 'The current password is not correct');
  }
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
    .where(eq(users.id, user.id));
}

/* ---------- API keys ---------- */

/** Create an API key for a workspace. `key` is the plain key — return it once, never store it. */
export async function createApiKey(
  db: Db,
  input: { workspaceId: string; name: string; createdBy: string | null },
): Promise<{ row: ApiKeyRow; key: string }> {
  const generated = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      id: newId('apiKey'),
      workspaceId: input.workspaceId,
      name: input.name,
      prefix: generated.prefix,
      keyHash: generated.hash,
      createdBy: input.createdBy,
    })
    .returning();
  if (!row) throw new Error('Failed to create API key');
  return { row, key: generated.key };
}

/** Resolve `Authorization: Bearer <key>` to an API-key context, or null. */
export async function resolveApiKey(
  db: Db,
  authorization: string | undefined,
): Promise<ApiKeyAuth | null> {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  const key = match?.[1];
  if (!key || !looksLikeApiKey(key)) return null;
  const [row] = await db
    .select({ apiKey: apiKeys, workspace: workspaces })
    .from(apiKeys)
    .innerJoin(workspaces, eq(apiKeys.workspaceId, workspaces.id))
    .where(and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt)));
  if (!row) return null;
  if (!row.apiKey.lastUsedAt || Date.now() - row.apiKey.lastUsedAt.getTime() > API_KEY_TOUCH_MS) {
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.apiKey.id));
  }
  return {
    kind: 'apiKey',
    workspaceId: row.workspace.id,
    workspace: row.workspace,
    role: 'editor',
    userId: null,
    user: null,
    session: null,
    member: null,
    apiKey: row.apiKey,
  };
}

/* ---------- request helpers ---------- */

/** Authenticate a request by session cookie. Throws UNAUTHENTICATED. */
export async function requireSession(request: FastifyRequest): Promise<SessionAuth> {
  const app = request.server;
  const token = request.cookies[app.config.SESSION_COOKIE_NAME];
  const auth = token ? await resolveSession(app.db, token) : null;
  if (!auth) throw AppError.unauthenticated('You need to sign in');
  request.auth = auth;
  return auth;
}

/** Authenticate a request by API key. Throws INVALID_API_KEY / PLAN_LIMIT_EXCEEDED. */
export async function requireApiKey(request: FastifyRequest): Promise<ApiKeyAuth> {
  const auth = await resolveApiKey(request.server.db, request.headers.authorization);
  if (!auth) {
    throw new AppError(
      'INVALID_API_KEY',
      'Missing or invalid API key (use "Authorization: Bearer <key>")',
    );
  }
  if (!PLANS[auth.workspace.plan].limits.apiAccess) {
    throw new AppError('PLAN_LIMIT_EXCEEDED', 'The current plan does not include API access');
  }
  request.auth = auth;
  return auth;
}

/** Throw FORBIDDEN unless the caller's role in the workspace is at least `min`. */
export function requireRole(auth: AuthContext, min: Role): void {
  if (!roleAtLeast(auth.role, min)) {
    throw AppError.forbidden(`This action requires the "${min}" role in the workspace`);
  }
}

/** Narrow to a session context (routes that need a user, not an API key). */
export function requireUser(auth: AuthContext | null): SessionAuth {
  if (!auth || auth.kind !== 'session') throw AppError.unauthenticated('You need to sign in');
  return auth;
}
