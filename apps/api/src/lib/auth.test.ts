import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SIGNUP_CREDITS, SessionInfoSchema } from '@parlante/shared';
import { apiKeys, eq, members, sessions } from '@parlante/db';
import { createTestApp } from '../testing/index';
import type { TestApp } from '../testing/index';
import {
  authenticate,
  buildSessionInfo,
  changePassword,
  createApiKey,
  createSession,
  destroyOtherSessions,
  destroySession,
  registerAccount,
  resolveApiKey,
  resolveSession,
  switchWorkspace,
} from './auth';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ modules: [] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

describe('accounts', () => {
  it('registers with a hashed password, a personal workspace and signup credits', async () => {
    const { user, workspace } = await registerAccount(t.db, {
      email: 'Ana@Example.test',
      password: 'correct horse battery',
      name: 'Ana',
      locale: 'en',
    });
    expect(user.email).toBe('ana@example.test');
    expect(user.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(user.passwordHash).not.toContain('correct horse');
    expect(workspace).toMatchObject({
      name: "Ana's workspace",
      plan: 'free',
      credits: SIGNUP_CREDITS,
    });
    await expect(
      registerAccount(t.db, {
        email: 'ana@example.test',
        password: 'another password',
        name: 'Ana 2',
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN', status: 409 });
  });

  it('authenticates with the right password only, with one error for both failures', async () => {
    await registerAccount(t.db, {
      email: 'ana@example.test',
      password: 'correct horse battery',
      name: 'Ana',
    });
    expect((await authenticate(t.db, ' ANA@example.test ', 'correct horse battery')).email).toBe(
      'ana@example.test',
    );
    const wrongPassword = await authenticate(t.db, 'ana@example.test', 'wrong').catch(
      (e: unknown) => e,
    );
    const unknownUser = await authenticate(t.db, 'nobody@example.test', 'wrong').catch(
      (e: unknown) => e,
    );
    expect(wrongPassword).toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
    expect((unknownUser as Error).message).toBe((wrongPassword as Error).message);
  });

  it('changes the password after verifying the current one', async () => {
    const { user } = await registerAccount(t.db, {
      email: 'ana@example.test',
      password: 'old password 1',
      name: 'Ana',
    });
    await expect(changePassword(t.db, user, 'nope', 'new password 2')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await changePassword(t.db, user, 'old password 1', 'new password 2');
    await expect(authenticate(t.db, 'ana@example.test', 'old password 1')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect((await authenticate(t.db, 'ana@example.test', 'new password 2')).id).toBe(user.id);
  });
});

describe('sessions', () => {
  it('stores only a hash of the token and resolves the active workspace and role', async () => {
    const alice = await t.signUp();
    const { session, token } = await createSession(t.db, t.config, {
      userId: alice.user.id,
      workspaceId: alice.workspace.id,
      ip: '203.0.113.5',
      userAgent: 'vitest',
    });
    expect(session.tokenHash).not.toBe(token);
    expect(session.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    const auth = await resolveSession(t.db, token);
    expect(auth).toMatchObject({
      kind: 'session',
      workspaceId: alice.workspace.id,
      role: 'owner',
      userId: alice.user.id,
    });
    expect(await resolveSession(t.db, `${token}x`)).toBeNull();
    expect(await resolveSession(t.db, '')).toBeNull();
    await destroySession(t.db, session.id);
    expect(await resolveSession(t.db, token)).toBeNull();
  });

  it('switches workspace only among memberships and builds SessionInfo', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    await t.db.insert(members).values({
      id: 'mem_aaaaaaaaaaaaaaaa',
      workspaceId: bob.workspace.id,
      userId: alice.user.id,
      role: 'editor',
    });
    const { token } = await createSession(t.db, t.config, {
      userId: alice.user.id,
      workspaceId: alice.workspace.id,
    });
    const auth = await resolveSession(t.db, token);
    if (!auth) throw new Error('no session');

    await switchWorkspace(t.db, auth, bob.workspace.id);
    const switched = await resolveSession(t.db, token);
    expect(switched).toMatchObject({ workspaceId: bob.workspace.id, role: 'editor' });

    const carol = await t.signUp();
    await expect(switchWorkspace(t.db, auth, carol.workspace.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    if (!switched) throw new Error('no session');
    const info = await buildSessionInfo(t.db, {
      user: switched.user,
      session: switched.session,
      currentWorkspaceId: switched.workspaceId,
    });
    expect(SessionInfoSchema.parse(info)).toEqual(info);
    expect(info.currentWorkspaceId).toBe(bob.workspace.id);
    expect(info.workspaces.map((w) => [w.id, w.role])).toEqual([
      [alice.workspace.id, 'owner'],
      [bob.workspace.id, 'editor'],
    ]);
  });

  it('falls back to another membership when removed from the active workspace', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const [membership] = await t.db
      .insert(members)
      .values({
        id: 'mem_bbbbbbbbbbbbbbbb',
        workspaceId: bob.workspace.id,
        userId: alice.user.id,
        role: 'viewer',
      })
      .returning();
    const { token, session } = await createSession(t.db, t.config, {
      userId: alice.user.id,
      workspaceId: bob.workspace.id,
    });
    expect((await resolveSession(t.db, token))?.workspaceId).toBe(bob.workspace.id);
    await t.db.delete(members).where(eq(members.id, membership?.id ?? ''));
    expect((await resolveSession(t.db, token))?.workspaceId).toBe(alice.workspace.id);
    const [stored] = await t.db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(stored?.activeWorkspaceId).toBe(alice.workspace.id);
  });

  it('revokes other sessions', async () => {
    const alice = await t.signUp();
    const a = await createSession(t.db, t.config, {
      userId: alice.user.id,
      workspaceId: alice.workspace.id,
    });
    const b = await createSession(t.db, t.config, {
      userId: alice.user.id,
      workspaceId: alice.workspace.id,
    });
    await destroyOtherSessions(t.db, alice.user.id, a.session.id);
    expect(await resolveSession(t.db, a.token)).not.toBeNull();
    expect(await resolveSession(t.db, b.token)).toBeNull();
  });
});

describe('API keys', () => {
  it('stores a hash, resolves the workspace and stops working once revoked', async () => {
    const alice = await t.signUp();
    const { row, key } = await createApiKey(t.db, {
      workspaceId: alice.workspace.id,
      name: 'ci',
      createdBy: alice.user.id,
    });
    expect(key.startsWith(`${row.prefix}_`)).toBe(true);
    expect(row.keyHash).not.toContain(key);
    const auth = await resolveApiKey(t.db, `Bearer ${key}`);
    expect(auth).toMatchObject({
      kind: 'apiKey',
      workspaceId: alice.workspace.id,
      role: 'editor',
      userId: null,
    });
    const [touched] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, row.id));
    expect(touched?.lastUsedAt).toBeInstanceOf(Date);

    expect(await resolveApiKey(t.db, undefined)).toBeNull();
    expect(await resolveApiKey(t.db, key)).toBeNull();
    expect(await resolveApiKey(t.db, `Bearer ${key.slice(0, -1)}x`)).toBeNull();
    await t.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, row.id));
    expect(await resolveApiKey(t.db, `Bearer ${key}`)).toBeNull();
  });
});
