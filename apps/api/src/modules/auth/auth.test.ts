import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLANS, api, newId } from '@parlante/shared';
import { hashSessionToken, randomToken, sha256Hex } from '@parlante/shared/node';
import { creditLedger, eq, invites, members, sessions, users, workspaces } from '@parlante/db';
import { createTestApp } from '../../testing/index';
import type { CallResult, TestActor, TestApp } from '../../testing/index';
import type { RouteDef } from '@parlante/shared';
import authModule, { MAX_FAILURES_PER_EMAIL_AND_IP } from './index';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ modules: [authModule] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

const COOKIE = 'parlante_session';

/** `Set-Cookie` of the session cookie in a response (raw header line), or null. */
function sessionSetCookie(res: CallResult<RouteDef>): string | null {
  const header = res.headers['set-cookie'];
  const lines = Array.isArray(header) ? header : header ? [header] : [];
  return lines.find((line) => line.startsWith(`${COOKIE}=`)) ?? null;
}
/** `Cookie` request header value for the session a response started. */
function cookieOf(res: CallResult<RouteDef>): string {
  const line = sessionSetCookie(res);
  if (!line) throw new Error('The response did not set a session cookie');
  return line.split(';')[0] ?? '';
}
const tokenOf = (cookie: string) => cookie.slice(COOKIE.length + 1);
const as = (cookie: string) => ({ cookie }) as TestActor;

let ipCounter = 0;
/** A fresh client address per test, so failed-attempt counters never leak between tests. */
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

async function login(email: string, password: string, ip: string, cookie?: string) {
  const raw = await t.inject({
    method: 'POST',
    url: api.auth.login.path,
    payload: { email, password },
    remoteAddress: ip,
    headers: cookie ? { cookie } : {},
  });
  return { status: raw.statusCode, body: raw.json(), headers: raw.headers, raw };
}

const account = { email: 'Ana@Example.test', password: 'correct horse 42', name: 'Ana García' };

describe('register', () => {
  it('creates the user, a free personal workspace with its credits and a session', async () => {
    const res = await t.call(api.auth.register, { body: account });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'ana@example.test', name: 'Ana García' });
    expect(res.body.user.locale).toBe('es');
    expect(res.body.workspaces).toHaveLength(1);
    expect(res.body.workspaces[0]).toMatchObject({
      name: 'Espacio de Ana',
      plan: 'free',
      role: 'owner',
      credits: PLANS.free.monthlyCredits,
    });
    expect(res.body.currentWorkspaceId).toBe(res.body.workspaces[0]?.id);

    // Cookie: httpOnly, SameSite, whole site; only a hash of the token is stored.
    const setCookie = sessionSetCookie(res) ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    const token = tokenOf(cookieOf(res));
    const [session] = await t.db.select().from(sessions);
    expect(session?.tokenHash).toBe(hashSessionToken(token));
    expect(JSON.stringify(session)).not.toContain(token);

    // Password: scrypt, never returned.
    const [user] = await t.db.select().from(users);
    expect(user?.passwordHash).toMatch(/^scrypt\$/);
    expect(res.raw.body).not.toContain('scrypt');
    expect(res.raw.body).not.toMatch(/password/i);
    expect(res.raw.body).not.toContain(token);

    const ledger = await t.db.select().from(creditLedger);
    expect(ledger.map((e) => [e.reason, e.delta])).toEqual([['signup_grant', 30]]);

    const me = await t.call(api.auth.me, { as: as(cookieOf(res)) });
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(res.body.user.id);
  });

  it('validates the input and rejects an e-mail that is already registered', async () => {
    const short = await t.call(api.auth.register, { body: { ...account, password: 'short' } });
    expect(short.status).toBe(400);
    expect(short.error.code).toBe('VALIDATION_ERROR');
    const bad = await t.call(api.auth.register, { body: { ...account, email: 'not-an-email' } });
    expect(bad.status).toBe(400);
    const noName = await t.call(api.auth.register, { body: { ...account, name: '   ' } });
    expect(noName.status).toBe(400);
    expect(await t.db.select().from(users)).toHaveLength(0);

    expect((await t.call(api.auth.register, { body: account })).status).toBe(201);
    const again = await t.call(api.auth.register, {
      body: { ...account, email: 'ANA@example.test' },
    });
    expect(again.status).toBe(409);
    expect(again.error.code).toBe('EMAIL_TAKEN');
    expect(sessionSetCookie(again)).toBeNull();
    expect(await t.db.select().from(users)).toHaveLength(1);
  });

  async function seedInvite(
    owner: TestActor,
    email: string,
    overrides: { expired?: boolean } = {},
  ) {
    const token = randomToken(40);
    await t.db.insert(invites).values({
      id: newId('invite'),
      workspaceId: owner.workspace.id,
      email,
      role: 'editor',
      tokenHash: sha256Hex(token),
      invitedBy: owner.user.id,
      expiresAt: new Date(Date.now() + (overrides.expired ? -1000 : 3_600_000)),
    });
    return token;
  }

  it('joins the inviting workspace when registering with an invitation', async () => {
    const owner = await t.signUp();
    const inviteToken = await seedInvite(owner, 'ana@example.test');
    const res = await t.call(api.auth.register, { body: { ...account, inviteToken } });
    expect(res.status).toBe(201);
    expect(res.body.currentWorkspaceId).toBe(owner.workspace.id);
    expect(res.body.workspaces.map((w) => [w.id === owner.workspace.id, w.role])).toEqual([
      [false, 'owner'],
      [true, 'editor'],
    ]);
    const [invite] = await t.db.select().from(invites);
    expect(invite?.acceptedAt).toBeInstanceOf(Date);
  });

  it('creates no account when the invitation cannot be used', async () => {
    const owner = await t.signUp();
    const unknown = await t.call(api.auth.register, {
      body: { ...account, inviteToken: randomToken(40) },
    });
    expect(unknown.status).toBe(404);

    const other = await seedInvite(owner, 'someone-else@example.test');
    const mismatch = await t.call(api.auth.register, { body: { ...account, inviteToken: other } });
    expect(mismatch.status).toBe(403);

    const expired = await seedInvite(owner, 'ana@example.test', { expired: true });
    const late = await t.call(api.auth.register, { body: { ...account, inviteToken: expired } });
    expect(late.status).toBe(409);
    expect(late.error.code).toBe('INVALID_STATE');

    // Workspace full (free plan: 2 members).
    await t.addMember(owner.workspace, 'viewer');
    const full = await seedInvite(owner, 'full@example.test');
    const blocked = await t.call(api.auth.register, {
      body: { ...account, email: 'full@example.test', inviteToken: full },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.error.code).toBe('PLAN_LIMIT_EXCEEDED');

    const emails = (await t.db.select({ email: users.email }).from(users)).map((u) => u.email);
    expect(emails).not.toContain('ana@example.test');
    expect(emails).not.toContain('full@example.test');
  });
});

describe('login', () => {
  it('starts a session with the right password', async () => {
    await t.call(api.auth.register, { body: account });
    const res = await login('ANA@example.test', account.password, freshIp());
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('ana@example.test');
    expect(res.raw.body).not.toContain('scrypt');
    const cookie = cookieOf(res as unknown as CallResult<RouteDef>);
    expect((await t.call(api.auth.me, { as: as(cookie) })).status).toBe(200);
    const [session] = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(tokenOf(cookie))));
    expect(session?.ip).toMatch(/^198\.51\.100\./);
  });

  it('answers exactly the same for a wrong password and for an unknown e-mail', async () => {
    await t.call(api.auth.register, { body: account });
    const ip = freshIp();
    const wrong = await login(account.email, 'not the password', ip);
    const unknown = await login('nobody@example.test', 'not the password', ip);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.headers['set-cookie']).toBeUndefined();
    const invalid = await login('not-an-email', 'x', ip);
    expect(invalid.status).toBe(400);
  });

  it('never adopts a session token presented by the client (session fixation)', async () => {
    await t.call(api.auth.register, { body: account });
    const ip = freshIp();

    // A token the attacker planted in the victim's browser before the login.
    const planted = `${COOKIE}=${'a'.repeat(43)}`;
    const first = await login(account.email, account.password, ip, planted);
    const firstCookie = cookieOf(first as unknown as CallResult<RouteDef>);
    expect(firstCookie).not.toBe(planted);
    expect((await t.call(api.auth.me, { as: as(planted) })).status).toBe(401);

    // Logging in again from the same browser replaces the session instead of reusing it.
    const second = await login(account.email, account.password, ip, firstCookie);
    const secondCookie = cookieOf(second as unknown as CallResult<RouteDef>);
    expect(secondCookie).not.toBe(firstCookie);
    expect((await t.call(api.auth.me, { as: as(firstCookie) })).status).toBe(401);
    expect((await t.call(api.auth.me, { as: as(secondCookie) })).status).toBe(200);

    // Another user's live session presented at login is ended, never taken over.
    const mallory = await t.signUp();
    const third = await login(account.email, account.password, ip, mallory.cookie);
    expect(third.body.user.email).toBe('ana@example.test');
    expect((await t.call(api.auth.me, { as: mallory })).status).toBe(401);
  });

  it('limits failed attempts per e-mail and address, the same for unknown e-mails', async () => {
    await t.call(api.auth.register, { body: account });
    const ip = freshIp();
    for (const email of [account.email, 'ghost@example.test']) {
      for (let i = 0; i < MAX_FAILURES_PER_EMAIL_AND_IP; i += 1) {
        expect((await login(email, 'wrong-password', ip)).status).toBe(401);
      }
      const blocked = await login(email, 'wrong-password', ip);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      expect(blocked.body.error.details.retryAfterSec).toBeGreaterThan(0);
      expect(Number(blocked.headers['retry-after'])).toBe(blocked.body.error.details.retryAfterSec);
    }
    // Even the right password waits while the pair is blocked…
    expect((await login(account.email, account.password, ip)).status).toBe(429);
    // …but the owner signing in from another address is not locked out by the attacker.
    expect((await login(account.email, account.password, freshIp())).status).toBe(200);
  });

  it('forgets earlier failures after a successful login', async () => {
    await t.call(api.auth.register, { body: account });
    const ip = freshIp();
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL_AND_IP - 1; i += 1) {
      expect((await login(account.email, 'wrong-password', ip)).status).toBe(401);
    }
    expect((await login(account.email, account.password, ip)).status).toBe(200);
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL_AND_IP - 1; i += 1) {
      expect((await login(account.email, 'wrong-password', ip)).status).toBe(401);
    }
    expect((await login(account.email, account.password, ip)).status).toBe(200);
  });

  it('gives a user without any workspace a new personal one', async () => {
    const res = await t.call(api.auth.register, { body: account });
    await t.db.delete(members).where(eq(members.userId, res.body.user.id));
    const again = await login(account.email, account.password, freshIp());
    expect(again.status).toBe(200);
    expect(again.body.workspaces).toHaveLength(1);
    expect(again.body.workspaces[0].id).not.toBe(res.body.currentWorkspaceId);
    expect(again.body.workspaces[0].role).toBe('owner');
  });
});

describe('session', () => {
  it('requires a session and ends it on logout', async () => {
    expect((await t.call(api.auth.me)).status).toBe(401);
    expect((await t.call(api.auth.logout)).status).toBe(401);
    expect((await t.call(api.auth.me, { as: as(`${COOKIE}=${'x'.repeat(43)}`) })).status).toBe(401);

    const alice = await t.signUp();
    const out = await t.call(api.auth.logout, { as: alice });
    expect(out.body).toEqual({ ok: true });
    expect(sessionSetCookie(out)).toMatch(new RegExp(`^${COOKIE}=;`));
    expect((await t.call(api.auth.me, { as: alice })).status).toBe(401);
    expect(await t.db.select().from(sessions)).toHaveLength(0);
  });

  it('rejects state-changing requests from an unknown origin (CSRF)', async () => {
    const alice = await t.signUp();
    const foreign = await t.call(api.auth.logout, {
      as: alice,
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    expect((await t.call(api.auth.me, { as: alice })).status).toBe(200);
    const own = await t.call(api.auth.logout, {
      as: alice,
      headers: { origin: 'http://web.test' },
    });
    expect(own.status).toBe(200);
  });

  it('expires sessions', async () => {
    const alice = await t.signUp();
    await t.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await t.call(api.auth.me, { as: alice })).status).toBe(401);
  });

  it('updates the profile of the caller only', async () => {
    const alice = await t.signUp({ name: 'Alice' });
    const bob = await t.signUp({ name: 'Bob' });
    const res = await t.call(api.auth.updateProfile, {
      as: alice,
      body: { name: '  Alicia  ', locale: 'en' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: alice.user.id, name: 'Alicia', locale: 'en' });
    expect(Object.keys(res.body).sort()).toEqual(['createdAt', 'email', 'id', 'locale', 'name']);
    expect((await t.call(api.auth.me, { as: bob })).body.user).toMatchObject({
      name: 'Bob',
      locale: 'es',
    });
    const noop = await t.call(api.auth.updateProfile, { as: alice, body: {} });
    expect(noop.body.name).toBe('Alicia');
    const bad = await t.call(api.auth.updateProfile, { as: alice, body: { locale: 'xx' } });
    expect(bad.status).toBe(400);
    expect((await t.call(api.auth.updateProfile, { body: { name: 'x' } })).status).toBe(401);
  });

  it('switches only to workspaces the user belongs to', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const editor = await t.addMember(bob.workspace, 'editor');
    // `editor` only belongs to Bob's workspace; give them a second one.
    await t.db.insert(members).values({
      id: newId('member'),
      workspaceId: alice.workspace.id,
      userId: editor.user.id,
      role: 'viewer',
    });
    const switched = await t.call(api.auth.switchWorkspace, {
      as: editor,
      body: { workspaceId: alice.workspace.id },
    });
    expect(switched.status).toBe(200);
    expect(switched.body.currentWorkspaceId).toBe(alice.workspace.id);
    expect((await t.call(api.auth.me, { as: editor })).body.currentWorkspaceId).toBe(
      alice.workspace.id,
    );

    const foreign = await t.call(api.auth.switchWorkspace, {
      as: alice,
      body: { workspaceId: bob.workspace.id },
    });
    expect(foreign.status).toBe(404);
    expect((await t.call(api.auth.me, { as: alice })).body.currentWorkspaceId).toBe(
      alice.workspace.id,
    );
    const invalid = await t.call(api.auth.switchWorkspace, {
      as: alice,
      body: { workspaceId: 'nope' },
    });
    expect(invalid.status).toBe(400);
  });
});

describe('change password', () => {
  it('verifies the current password, rotates this session and revokes the others', async () => {
    const registered = await t.call(api.auth.register, { body: account });
    const cookie = cookieOf(registered);
    const other = cookieOf(
      (await login(account.email, account.password, freshIp())) as unknown as CallResult<RouteDef>,
    );

    const wrong = await t.call(api.auth.changePassword, {
      as: as(cookie),
      body: { currentPassword: 'not it', newPassword: 'a brand new secret' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.error.code).toBe('INVALID_CREDENTIALS');
    const same = await t.call(api.auth.changePassword, {
      as: as(cookie),
      body: { currentPassword: account.password, newPassword: account.password },
    });
    expect(same.status).toBe(400);
    const weak = await t.call(api.auth.changePassword, {
      as: as(cookie),
      body: { currentPassword: account.password, newPassword: 'short' },
    });
    expect(weak.status).toBe(400);

    const changed = await t.call(api.auth.changePassword, {
      as: as(cookie),
      body: { currentPassword: account.password, newPassword: 'a brand new secret' },
    });
    expect(changed.body).toEqual({ ok: true });
    const rotated = cookieOf(changed);
    expect(rotated).not.toBe(cookie);
    expect((await t.call(api.auth.me, { as: as(cookie) })).status).toBe(401);
    expect((await t.call(api.auth.me, { as: as(other) })).status).toBe(401);
    expect((await t.call(api.auth.me, { as: as(rotated) })).status).toBe(200);
    expect(await t.db.select().from(sessions)).toHaveLength(1);

    const ip = freshIp();
    expect((await login(account.email, account.password, ip)).status).toBe(401);
    expect((await login(account.email, 'a brand new secret', ip)).status).toBe(200);
  });

  it('limits wrong guesses of the current password', async () => {
    const alice = await t.signUp();
    const body = { currentPassword: 'guess', newPassword: 'a brand new secret' };
    for (let i = 0; i < 5; i += 1) {
      expect((await t.call(api.auth.changePassword, { as: alice, body })).status).toBe(401);
    }
    const blocked = await t.call(api.auth.changePassword, {
      as: alice,
      body: { currentPassword: alice.password, newPassword: 'a brand new secret' },
    });
    expect(blocked.status).toBe(429);
    expect((await t.call(api.auth.changePassword, { body })).status).toBe(401);
  });
});

describe('monthly credits', () => {
  it('grants the plan credits once when a billing cycle has ended', async () => {
    const alice = await t.signUp({ plan: 'creator' });
    const before = (await t.call(api.auth.me, { as: alice })).body.workspaces[0]?.credits;
    expect(before).toBe(PLANS.creator.monthlyCredits);
    expect(await t.db.select().from(creditLedger)).toHaveLength(1);

    // 31 days later.
    await t.db
      .update(creditLedger)
      .set({ createdAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) });
    const [first, second] = await Promise.all([
      t.call(api.auth.me, { as: alice }),
      t.call(api.auth.me, { as: alice }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const after = (await t.call(api.auth.me, { as: alice })).body.workspaces[0]?.credits;
    expect(after).toBe(2 * PLANS.creator.monthlyCredits);
    const ledger = await t.db.select().from(creditLedger);
    expect(ledger.map((e) => e.reason)).toEqual(['plan_grant', 'plan_grant']);
    expect(ledger.some((e) => /simulated/.test(e.description))).toBe(true);
    const [workspace] = await t.db.select().from(workspaces);
    expect(workspace?.credits).toBe(after);
  });
});
