import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, OK, api, isAppError } from '@parlante/shared';
import type { SessionInfo } from '@parlante/shared';
import { hashSessionToken } from '@parlante/shared/node';
import { eq, sessions, users } from '@parlante/db';
import type { UserRow } from '@parlante/db';
import {
  authenticate,
  buildSessionInfo,
  changePassword,
  clearSessionCookie,
  clientIp,
  createSession,
  deleteExpiredSessions,
  destroyOtherSessions,
  destroySession,
  listMemberships,
  registerAccount,
  resolveSession,
  setSessionCookie,
  switchWorkspace,
} from '../../lib/auth';
import { defineRoute } from '../../lib/define-route';
import { toUserDto } from '../../lib/dto';
import { defineModule } from '../../lib/modules';
import { applyMonthlyRenewal } from '../billing/renewal';
import { acceptInvite, assertInviteAcceptable } from '../members/invites';
import { AttemptThrottle, longestWaitMs } from './attempt-throttle';
import type { AttemptLimit } from './attempt-throttle';

/* -------------------------------------------------------------------------------------------
 * Accounts and sessions. The primitives (scrypt, session tokens, cookies) live in
 * `lib/auth.ts`; this module wires them to the routes and adds the request-level defences:
 *
 *  - Failed-attempt limit: 5 wrong passwords per e-mail + IP in 15 minutes (plus wider
 *    per-e-mail and per-IP caps) → 429 RATE_LIMITED, identical for unknown e-mails.
 *  - No user enumeration at login: one error and one code path (same scrypt cost) whether the
 *    e-mail exists or not. Registration necessarily tells that an e-mail is taken
 *    (EMAIL_TAKEN is part of the contract); the route rate limit bounds that probe.
 *  - No session fixation: a session token is ALWAYS minted by the server at login / register
 *    / password change, and the session the browser presented before is destroyed.
 *  - Responses are built with `toUserDto` / `buildSessionInfo`: no hash or token ever leaves.
 * ----------------------------------------------------------------------------------------- */

export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_EMAIL_AND_IP = 5;
/** Backstops against attempts spread over many addresses / many accounts. */
export const MAX_FAILURES_PER_EMAIL = 25;
export const MAX_FAILURES_PER_IP = 40;
export const MAX_FAILURES_PER_PASSWORD_CHANGE = 5;

function loginLimits(email: string, ip: string): AttemptLimit[] {
  return [
    { key: `login:${email}|${ip}`, max: MAX_FAILURES_PER_EMAIL_AND_IP },
    { key: `login-email:${email}`, max: MAX_FAILURES_PER_EMAIL },
    { key: `login-ip:${ip}`, max: MAX_FAILURES_PER_IP },
  ];
}

/** Reject with 429 + Retry-After while any of the limits is exhausted. */
function assertNotThrottled(
  throttle: AttemptThrottle,
  limits: AttemptLimit[],
  reply: FastifyReply,
): void {
  const waitMs = longestWaitMs(throttle, limits);
  if (waitMs <= 0) return;
  const retryAfterSec = Math.ceil(waitMs / 1000);
  void reply.header('retry-after', String(retryAfterSec));
  throw new AppError('RATE_LIMITED', 'Too many failed attempts. Try again later', {
    retryAfterSec,
  });
}

/**
 * Start a fresh session for `user` and set its cookie. Whatever session cookie the request
 * carried is invalidated first, so a token planted in the browser before authentication can
 * never become an authenticated session.
 */
async function startSession(
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRow,
  workspaceId: string | null,
): Promise<SessionInfo> {
  const { db, config } = request.server;
  const presented = request.cookies[config.SESSION_COOKIE_NAME];
  if (presented) {
    await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(presented)));
  }
  const { token } = await createSession(db, config, {
    userId: user.id,
    workspaceId,
    ip: clientIp(request),
    userAgent: request.headers['user-agent'] ?? null,
  });
  // Resolving it guarantees an active workspace the user really belongs to.
  const auth = await resolveSession(db, token);
  if (!auth) throw new Error('A session that was just created could not be resolved');
  setSessionCookie(reply, config, token);
  return buildSessionInfo(db, {
    user: auth.user,
    session: auth.session,
    currentWorkspaceId: auth.workspaceId,
  });
}

export default defineModule({
  name: 'auth',
  register(app) {
    const throttle = new AttemptThrottle({ windowMs: ATTEMPT_WINDOW_MS });

    defineRoute(app, api.auth.register, async ({ body, request, reply, app: { db } }) => {
      // An invitation is checked BEFORE the account exists, so a bad link fails cleanly.
      if (body.inviteToken) await assertInviteAcceptable(db, body.inviteToken, body.email);
      const { user, workspace } = await registerAccount(db, {
        email: body.email,
        password: body.password,
        name: body.name,
        locale: body.locale,
      });
      let activeWorkspaceId = workspace.id;
      if (body.inviteToken) {
        try {
          activeWorkspaceId = await acceptInvite(db, { token: body.inviteToken, user });
        } catch (err) {
          // Lost a race (revoked or filled up since the check). The account is valid and
          // keeps its personal workspace; accepting again reports the precise reason.
          if (!isAppError(err)) throw err;
          request.log.warn({ err, userId: user.id }, 'invitation could not be accepted');
        }
      }
      return startSession(request, reply, user, activeWorkspaceId);
    });

    defineRoute(app, api.auth.login, async ({ body, request, reply, app: { db } }) => {
      const limits = loginLimits(body.email, clientIp(request));
      assertNotThrottled(throttle, limits, reply);
      let user: UserRow;
      try {
        user = await authenticate(db, body.email, body.password);
      } catch (err) {
        if (isAppError(err) && err.code === 'INVALID_CREDENTIALS') {
          for (const limit of limits) throttle.recordFailure(limit.key);
        }
        throw err;
      }
      const [pair] = limits;
      if (pair) throttle.reset(pair.key);
      await deleteExpiredSessions(db);
      const [first] = await listMemberships(db, user.id);
      return startSession(request, reply, user, first?.workspace.id ?? null);
    });

    defineRoute(app, api.auth.logout, async ({ auth, reply, app: { db, config } }) => {
      await destroySession(db, auth.session.id);
      clearSessionCookie(reply, config);
      return OK;
    });

    defineRoute(app, api.auth.me, async ({ auth, app: { db } }) => {
      // The web shell calls this on every load: the natural place to notice that a
      // (simulated) billing cycle ended and the plan credits are due.
      await applyMonthlyRenewal(db, auth.workspace);
      return buildSessionInfo(db, {
        user: auth.user,
        session: auth.session,
        currentWorkspaceId: auth.workspaceId,
      });
    });

    defineRoute(app, api.auth.updateProfile, async ({ auth, body, app: { db } }) => {
      if (body.name === undefined && body.locale === undefined) return toUserDto(auth.user);
      const [updated] = await db
        .update(users)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.locale !== undefined ? { locale: body.locale } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, auth.userId))
        .returning();
      if (!updated) throw AppError.unauthenticated('You need to sign in');
      return toUserDto(updated);
    });

    defineRoute(app, api.auth.changePassword, async ({ auth, body, request, reply, app }) => {
      const { db, config } = app;
      const limit = { key: `password:${auth.userId}`, max: MAX_FAILURES_PER_PASSWORD_CHANGE };
      assertNotThrottled(throttle, [limit], reply);
      if (body.newPassword === body.currentPassword) {
        throw AppError.validation('The new password must be different from the current one', [
          { path: 'body.newPassword', message: 'Must differ from the current password' },
        ]);
      }
      try {
        await changePassword(db, auth.user, body.currentPassword, body.newPassword);
      } catch (err) {
        if (isAppError(err) && err.code === 'INVALID_CREDENTIALS') {
          throttle.recordFailure(limit.key);
        }
        throw err;
      }
      throttle.reset(limit.key);
      // Every session that knew the old password dies — including this one, which is
      // replaced by a new token so the caller stays signed in.
      const { session, token } = await createSession(db, config, {
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });
      await destroyOtherSessions(db, auth.userId, session.id);
      setSessionCookie(reply, config, token);
      return OK;
    });

    defineRoute(app, api.auth.switchWorkspace, async ({ auth, body, app: { db } }) => {
      await switchWorkspace(db, auth, body.workspaceId); // NOT_FOUND unless a member
      return buildSessionInfo(db, {
        user: auth.user,
        session: auth.session,
        currentWorkspaceId: body.workspaceId,
      });
    });
  },
});
