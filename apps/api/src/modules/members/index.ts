import { AppError, OK, api, newId, roleAtLeast } from '@parlante/shared';
import type { Invite, Member, Role } from '@parlante/shared';
import { randomToken } from '@parlante/shared/node';
import { and, asc, count, desc, eq, gt, invites, isNull, lte, members, users } from '@parlante/db';
import type { DbOrTx, InviteRow, MemberRow } from '@parlante/db';
import { buildSessionInfo, switchWorkspace } from '../../lib/auth';
import { defineRoute } from '../../lib/define-route';
import { iso, isoOrNull, toUserRef } from '../../lib/dto';
import { assertWithinLimit } from '../../lib/limits';
import { defineModule } from '../../lib/modules';
import { countMembers, countOwners, lockWorkspace } from '../workspaces/service';
import {
  INVITE_TOKEN_LENGTH,
  acceptInvite,
  findInviteByToken,
  hashInviteToken,
  inviteAcceptUrl,
  inviteExpiry,
  isInviteExpired,
} from './invites';

function toMemberDto(row: MemberRow, user: { name: string; email: string }): Member {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    name: user.name,
    email: user.email,
    role: row.role,
    createdAt: iso(row.createdAt),
  };
}

function toInviteDto(row: InviteRow, inviter: { id: string; name: string } | null): Invite {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    role: row.role,
    invitedBy: toUserRef(inviter),
    expiresAt: iso(row.expiresAt),
    acceptedAt: isoOrNull(row.acceptedAt),
    createdAt: iso(row.createdAt),
  };
}

/** Owner and admin are the roles only an owner may hand out or take away. */
const isPrivileged = (role: Role): boolean => role === 'owner' || role === 'admin';

/** A member of THIS workspace with its user, or 404 (a foreign id looks like a missing one). */
async function findMember(db: DbOrTx, workspaceId: string, memberId: string) {
  const [row] = await db
    .select({ member: members, user: { name: users.name, email: users.email } })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(and(eq(members.id, memberId), eq(members.workspaceId, workspaceId)));
  if (!row) throw AppError.notFound('Member');
  return row;
}

/**
 * The caller's membership re-read INSIDE the transaction (after the workspace lock): the role
 * checked by the route guard may have been changed by a concurrent request.
 */
async function currentActor(tx: DbOrTx, workspaceId: string, userId: string): Promise<MemberRow> {
  const [actor] = await tx
    .select()
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
  if (!actor) throw AppError.forbidden('You are no longer a member of this workspace');
  return actor;
}

export default defineModule({
  name: 'members',
  register(app) {
    defineRoute(app, api.members.list, async ({ auth, app: { db } }) => {
      const rows = await db
        .select({ member: members, user: { name: users.name, email: users.email } })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .where(eq(members.workspaceId, auth.workspaceId))
        .orderBy(asc(members.createdAt), asc(members.id));
      return { items: rows.map((row) => toMemberDto(row.member, row.user)) };
    });

    defineRoute(app, api.members.updateRole, async ({ auth, params, body, app: { db } }) => {
      return db.transaction(async (tx) => {
        await lockWorkspace(tx, auth.workspaceId);
        const target = await findMember(tx, auth.workspaceId, params.memberId);
        const actor = await currentActor(tx, auth.workspaceId, auth.userId);
        if (!roleAtLeast(actor.role, 'admin')) {
          throw AppError.forbidden('This action requires the "admin" role in the workspace');
        }
        if (target.member.role === body.role) return toMemberDto(target.member, target.user);
        if (
          (isPrivileged(target.member.role) || isPrivileged(body.role)) &&
          actor.role !== 'owner'
        ) {
          throw AppError.forbidden('Only owners can grant or revoke the owner and admin roles');
        }
        if (target.member.role === 'owner' && (await countOwners(tx, auth.workspaceId)) <= 1) {
          throw AppError.invalidState(
            'The workspace must keep at least one owner. Make another member an owner first',
          );
        }
        const [updated] = await tx
          .update(members)
          .set({ role: body.role })
          .where(and(eq(members.id, target.member.id), eq(members.workspaceId, auth.workspaceId)))
          .returning();
        if (!updated) throw AppError.notFound('Member');
        return toMemberDto(updated, target.user);
      });
    });

    defineRoute(app, api.members.remove, async ({ auth, params, app: { db } }) => {
      await db.transaction(async (tx) => {
        await lockWorkspace(tx, auth.workspaceId);
        const target = await findMember(tx, auth.workspaceId, params.memberId);
        const actor = await currentActor(tx, auth.workspaceId, auth.userId);
        const leaving = target.member.userId === auth.userId;
        if (!leaving) {
          if (!roleAtLeast(actor.role, 'admin')) {
            throw AppError.forbidden('Only admins and owners can remove other members');
          }
          if (isPrivileged(target.member.role) && actor.role !== 'owner') {
            throw AppError.forbidden('Only owners can remove owners and admins');
          }
        }
        if (target.member.role === 'owner' && (await countOwners(tx, auth.workspaceId)) <= 1) {
          throw AppError.invalidState(
            leaving
              ? 'You are the only owner. Make another member an owner or delete the workspace'
              : 'The workspace must keep at least one owner',
          );
        }
        await tx
          .delete(members)
          .where(and(eq(members.id, target.member.id), eq(members.workspaceId, auth.workspaceId)));
      });
      // Sessions of the removed user that had this workspace active move to another
      // membership on their next request (`resolveSession`).
      return OK;
    });

    defineRoute(app, api.members.listInvites, async ({ auth, app: { db } }) => {
      const rows = await db
        .select({ invite: invites, inviter: { id: users.id, name: users.name } })
        .from(invites)
        .leftJoin(users, eq(invites.invitedBy, users.id))
        .where(and(eq(invites.workspaceId, auth.workspaceId), isNull(invites.acceptedAt)))
        .orderBy(desc(invites.createdAt), desc(invites.id));
      // Expired invitations stay listed (with their `expiresAt`) until revoked or re-sent.
      return { items: rows.map((row) => toInviteDto(row.invite, row.inviter)) };
    });

    defineRoute(app, api.members.createInvite, async ({ auth, body, app: { db, config } }) => {
      if (body.role === 'owner') {
        throw AppError.validation('Ownership cannot be granted through an invitation', [
          { path: 'role', message: 'Invite as admin and make the member an owner afterwards' },
        ]);
      }
      const token = randomToken(INVITE_TOKEN_LENGTH);
      const row = await db.transaction(async (tx) => {
        const workspace = await lockWorkspace(tx, auth.workspaceId);
        const actor = await currentActor(tx, auth.workspaceId, auth.userId);
        if (!roleAtLeast(actor.role, 'admin')) {
          throw AppError.forbidden('This action requires the "admin" role in the workspace');
        }
        if (isPrivileged(body.role) && actor.role !== 'owner') {
          throw AppError.forbidden('Only owners can invite admins');
        }
        const [alreadyMember] = await tx
          .select({ id: members.id })
          .from(members)
          .innerJoin(users, eq(members.userId, users.id))
          .where(and(eq(members.workspaceId, auth.workspaceId), eq(users.email, body.email)));
        if (alreadyMember) throw AppError.conflict('This person is already a member');

        const now = new Date();
        const pendingForEmail = await tx
          .select()
          .from(invites)
          .where(
            and(
              eq(invites.workspaceId, auth.workspaceId),
              eq(invites.email, body.email),
              isNull(invites.acceptedAt),
            ),
          );
        if (pendingForEmail.some((invite) => !isInviteExpired(invite, now))) {
          throw AppError.conflict('There is already a pending invitation for this e-mail');
        }
        // An expired invitation for the same person is replaced by the new one.
        await tx
          .delete(invites)
          .where(
            and(
              eq(invites.workspaceId, auth.workspaceId),
              eq(invites.email, body.email),
              isNull(invites.acceptedAt),
              lte(invites.expiresAt, now),
            ),
          );

        // Seats = members + invitations that can still be accepted.
        const [pending] = await tx
          .select({ n: count() })
          .from(invites)
          .where(
            and(
              eq(invites.workspaceId, auth.workspaceId),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, now),
            ),
          );
        const seats = (await countMembers(tx, auth.workspaceId)) + (pending?.n ?? 0);
        assertWithinLimit(workspace, 'maxMembers', seats + 1);

        const [created] = await tx
          .insert(invites)
          .values({
            id: newId('invite'),
            workspaceId: auth.workspaceId,
            email: body.email,
            role: body.role,
            tokenHash: hashInviteToken(token),
            invitedBy: auth.userId,
            expiresAt: inviteExpiry(now),
          })
          .returning();
        if (!created) throw new Error('Insert returned no row');
        return created;
      });
      return {
        ...toInviteDto(row, auth.user),
        token,
        acceptUrl: inviteAcceptUrl(config.PUBLIC_WEB_URL, token),
      };
    });

    defineRoute(app, api.members.revokeInvite, async ({ auth, params, app: { db } }) => {
      const deleted = await db
        .delete(invites)
        .where(
          and(
            eq(invites.id, params.inviteId),
            eq(invites.workspaceId, auth.workspaceId),
            isNull(invites.acceptedAt),
          ),
        )
        .returning({ id: invites.id });
      if (deleted.length === 0) throw AppError.notFound('Invitation');
      return OK;
    });

    defineRoute(app, api.members.lookupInvite, async ({ params, app: { db } }) => {
      const found = await findInviteByToken(db, params.token);
      if (!found) throw AppError.notFound('Invitation');
      return {
        workspaceName: found.workspace.name,
        email: found.invite.email,
        role: found.invite.role,
        expired: isInviteExpired(found.invite),
        accepted: found.invite.acceptedAt !== null,
      };
    });

    defineRoute(app, api.members.acceptInvite, async ({ auth, body, app: { db } }) => {
      const workspaceId = await acceptInvite(db, { token: body.token, user: auth.user });
      await switchWorkspace(db, auth, workspaceId);
      return buildSessionInfo(db, {
        user: auth.user,
        session: auth.session,
        currentWorkspaceId: workspaceId,
      });
    });
  },
});
