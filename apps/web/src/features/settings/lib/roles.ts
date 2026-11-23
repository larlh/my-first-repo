import { roleAtLeast } from '@parlante/shared';
import type { Invite, Member, Role } from '@parlante/shared';

/* Who may do what to whom in the members screen. This mirrors the rules the API enforces in
 * `PATCH/DELETE /api/members/:id` and `POST /api/invites` so the UI can disable an action and
 * say why BEFORE the request; the server stays the authority. */

export interface Actor {
  userId: string;
  role: Role;
}

/** Why an action is not offered (i18n key suffix under `members.denied`). */
export type Denial = 'needsAdmin' | 'needsOwner' | 'lastOwner' | 'self';

export interface RoleOptions {
  /** Roles the actor may give to the member (includes the current one when any is allowed). */
  roles: Role[];
  denial: Denial | null;
}

export function isPrivileged(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}

export function countOwners(members: readonly Pick<Member, 'role'>[]): number {
  return members.filter((member) => member.role === 'owner').length;
}

/** Roles `actor` may assign to `target`. Empty list + `denial` when the role is fixed. */
export function assignableRoles(
  actor: Actor,
  target: Pick<Member, 'userId' | 'role'>,
  ownerCount: number,
): RoleOptions {
  if (!roleAtLeast(actor.role, 'admin')) return { roles: [], denial: 'needsAdmin' };
  if (target.role === 'owner' && ownerCount <= 1) return { roles: [], denial: 'lastOwner' };
  if (actor.role !== 'owner') {
    // Admins manage editors and viewers only: owner/admin are granted and revoked by owners.
    if (isPrivileged(target.role)) return { roles: [], denial: 'needsOwner' };
    return { roles: ['editor', 'viewer'], denial: null };
  }
  return { roles: ['owner', 'admin', 'editor', 'viewer'], denial: null };
}

export interface RemovalCheck {
  allowed: boolean;
  /** True when the row is the caller: the action is "leave", not "remove". */
  leaving: boolean;
  denial: Denial | null;
}

export function removalCheck(
  actor: Actor,
  target: Pick<Member, 'userId' | 'role'>,
  ownerCount: number,
): RemovalCheck {
  const leaving = target.userId === actor.userId;
  if (target.role === 'owner' && ownerCount <= 1) {
    return { allowed: false, leaving, denial: 'lastOwner' };
  }
  if (leaving) return { allowed: true, leaving, denial: null };
  if (!roleAtLeast(actor.role, 'admin')) return { allowed: false, leaving, denial: 'needsAdmin' };
  if (isPrivileged(target.role) && actor.role !== 'owner') {
    return { allowed: false, leaving, denial: 'needsOwner' };
  }
  return { allowed: true, leaving, denial: null };
}

/** Roles that can be offered in an invitation (ownership is never granted by invitation). */
export function invitableRoles(actorRole: Role): Role[] {
  if (actorRole === 'owner') return ['admin', 'editor', 'viewer'];
  if (actorRole === 'admin') return ['editor', 'viewer'];
  return [];
}

export function isInvitePending(
  invite: Pick<Invite, 'acceptedAt' | 'expiresAt'>,
  now: Date,
): boolean {
  return invite.acceptedAt === null && new Date(invite.expiresAt).getTime() > now.getTime();
}

export interface Seats {
  used: number;
  limit: number;
  left: number;
  full: boolean;
}

/** Seats = members + invitations that can still be accepted (the way the API counts them). */
export function seatUsage(
  memberCount: number,
  invites: readonly Pick<Invite, 'acceptedAt' | 'expiresAt'>[],
  maxMembers: number,
  now: Date,
): Seats {
  const used = memberCount + invites.filter((invite) => isInvitePending(invite, now)).length;
  const left = Math.max(0, maxMembers - used);
  return { used, limit: maxMembers, left, full: left === 0 };
}
