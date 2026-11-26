import { AppError } from '@parlante/shared';
import { sha256Hex } from '@parlante/shared/node';
import { and, eq, invites, members, workspaces } from '@parlante/db';
import type { Db, DbOrTx, InviteRow, UserRow, WorkspaceRow } from '@parlante/db';
import { newId } from '@parlante/shared';
import { assertWithinLimit } from '../../lib/limits';
import { countMembers, findMembership, lockWorkspace } from '../workspaces/service';

/* -------------------------------------------------------------------------------------------
 * Invitations. The plain token only ever travels in the accept link (returned once to the
 * inviter); the database stores its SHA-256. An invitation is addressed to ONE e-mail: only
 * an account with that e-mail can accept it, so a leaked or forwarded link does not open the
 * workspace to anybody else.
 * ----------------------------------------------------------------------------------------- */

export const INVITE_TTL_DAYS = 7;
export const INVITE_TOKEN_LENGTH = 40;

export function hashInviteToken(token: string): string {
  return sha256Hex(token);
}

export function inviteExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 3600 * 1000);
}

export function isInviteExpired(invite: Pick<InviteRow, 'expiresAt'>, now = new Date()): boolean {
  return invite.expiresAt.getTime() <= now.getTime();
}

/** Link the inviter shares by hand (no e-mail is sent). The web app owns the `/invite/` page. */
export function inviteAcceptUrl(publicWebUrl: string, token: string): string {
  return `${publicWebUrl.replace(/\/+$/, '')}/invite/${token}`;
}

export async function findInviteByToken(
  db: DbOrTx,
  token: string,
): Promise<{ invite: InviteRow; workspace: WorkspaceRow } | null> {
  const [row] = await db
    .select({ invite: invites, workspace: workspaces })
    .from(invites)
    .innerJoin(workspaces, eq(invites.workspaceId, workspaces.id))
    .where(eq(invites.tokenHash, hashInviteToken(token)));
  return row ?? null;
}

/** Throw unless `email` may accept the invitation right now. */
export function assertInviteUsable(invite: InviteRow, email: string): void {
  if (invite.acceptedAt) throw AppError.invalidState('This invitation has already been used');
  if (isInviteExpired(invite)) throw AppError.invalidState('This invitation has expired');
  if (invite.email !== email.trim().toLowerCase()) {
    throw AppError.forbidden('This invitation was sent to a different e-mail address');
  }
}

/**
 * Check an invitation BEFORE creating the account that will use it (register with
 * `inviteToken`): unknown token → NOT_FOUND; used / expired → INVALID_STATE; other e-mail →
 * FORBIDDEN; workspace full → PLAN_LIMIT_EXCEEDED.
 */
export async function assertInviteAcceptable(db: Db, token: string, email: string): Promise<void> {
  const found = await findInviteByToken(db, token);
  if (!found) throw AppError.notFound('Invitation');
  assertInviteUsable(found.invite, email);
  assertWithinLimit(
    found.workspace,
    'maxMembers',
    (await countMembers(db, found.workspace.id)) + 1,
  );
}

/**
 * Join the inviting workspace with the invited role. Runs under the workspace lock, so the
 * member limit holds under concurrency and an invitation is consumed exactly once.
 * Returns the id of the workspace joined.
 */
export async function acceptInvite(
  db: Db,
  input: { token: string; user: Pick<UserRow, 'id' | 'email'> },
): Promise<string> {
  const found = await findInviteByToken(db, input.token);
  if (!found) throw AppError.notFound('Invitation');
  return db.transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, found.workspace.id);
    const [invite] = await tx
      .select()
      .from(invites)
      .where(and(eq(invites.id, found.invite.id), eq(invites.workspaceId, workspace.id)));
    if (!invite) throw AppError.notFound('Invitation'); // revoked meanwhile
    assertInviteUsable(invite, input.user.email);

    // Already inside (joined through another invitation): keep the current role.
    if (!(await findMembership(tx, workspace.id, input.user.id))) {
      assertWithinLimit(workspace, 'maxMembers', (await countMembers(tx, workspace.id)) + 1);
      await tx.insert(members).values({
        id: newId('member'),
        workspaceId: workspace.id,
        userId: input.user.id,
        role: invite.role,
      });
    }
    await tx
      .update(invites)
      .set({ acceptedAt: new Date() })
      .where(and(eq(invites.id, invite.id), eq(invites.workspaceId, workspace.id)));
    return workspace.id;
  });
}
