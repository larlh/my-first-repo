import { describe, expect, it } from 'vitest';
import {
  assignableRoles,
  countOwners,
  invitableRoles,
  isInvitePending,
  removalCheck,
  seatUsage,
} from './roles';

const owner = { userId: 'usr_owner', role: 'owner' } as const;
const admin = { userId: 'usr_admin', role: 'admin' } as const;
const editor = { userId: 'usr_editor', role: 'editor' } as const;
const member = (userId: string, role: 'owner' | 'admin' | 'editor' | 'viewer') => ({
  userId,
  role,
});

describe('assignableRoles', () => {
  it('lets an owner give any role when another owner remains', () => {
    expect(assignableRoles(owner, member('usr_x', 'editor'), 1)).toEqual({
      roles: ['owner', 'admin', 'editor', 'viewer'],
      denial: null,
    });
    expect(assignableRoles(owner, member('usr_other', 'owner'), 2).denial).toBeNull();
  });

  it('never lets the last owner be demoted, not even by themselves', () => {
    expect(assignableRoles(owner, member('usr_owner', 'owner'), 1)).toEqual({
      roles: [],
      denial: 'lastOwner',
    });
  });

  it('limits admins to editors and viewers', () => {
    expect(assignableRoles(admin, member('usr_x', 'viewer'), 1)).toEqual({
      roles: ['editor', 'viewer'],
      denial: null,
    });
    expect(assignableRoles(admin, member('usr_y', 'admin'), 1).denial).toBe('needsOwner');
    expect(assignableRoles(admin, member('usr_z', 'owner'), 2).denial).toBe('needsOwner');
  });

  it('gives nothing to editors and viewers', () => {
    expect(assignableRoles(editor, member('usr_x', 'viewer'), 1)).toEqual({
      roles: [],
      denial: 'needsAdmin',
    });
  });
});

describe('removalCheck', () => {
  it('lets anyone leave, except the only owner', () => {
    expect(removalCheck(editor, member('usr_editor', 'editor'), 1)).toEqual({
      allowed: true,
      leaving: true,
      denial: null,
    });
    expect(removalCheck(owner, member('usr_owner', 'owner'), 1)).toEqual({
      allowed: false,
      leaving: true,
      denial: 'lastOwner',
    });
    expect(removalCheck(owner, member('usr_owner', 'owner'), 2).allowed).toBe(true);
  });

  it('needs an admin to remove others and an owner to remove admins', () => {
    expect(removalCheck(editor, member('usr_x', 'viewer'), 1).denial).toBe('needsAdmin');
    expect(removalCheck(admin, member('usr_x', 'viewer'), 1).allowed).toBe(true);
    expect(removalCheck(admin, member('usr_y', 'admin'), 1).denial).toBe('needsOwner');
    expect(removalCheck(owner, member('usr_y', 'admin'), 1).allowed).toBe(true);
  });
});

describe('invitations and seats', () => {
  const now = new Date('2026-11-20T10:00:00.000Z');
  const pending = { acceptedAt: null, expiresAt: '2026-11-27T10:00:00.000Z' };
  const expired = { acceptedAt: null, expiresAt: '2026-11-19T10:00:00.000Z' };
  const accepted = {
    acceptedAt: '2026-11-18T10:00:00.000Z',
    expiresAt: '2026-11-27T10:00:00.000Z',
  };

  it('never offers ownership by invitation and reserves admin for owners', () => {
    expect(invitableRoles('owner')).toEqual(['admin', 'editor', 'viewer']);
    expect(invitableRoles('admin')).toEqual(['editor', 'viewer']);
    expect(invitableRoles('editor')).toEqual([]);
    expect(invitableRoles('viewer')).toEqual([]);
  });

  it('counts only invitations that can still be accepted', () => {
    expect(isInvitePending(pending, now)).toBe(true);
    expect(isInvitePending(expired, now)).toBe(false);
    expect(isInvitePending(accepted, now)).toBe(false);
    expect(seatUsage(3, [pending, expired, accepted], 5, now)).toEqual({
      used: 4,
      limit: 5,
      left: 1,
      full: false,
    });
    expect(seatUsage(4, [pending], 5, now).full).toBe(true);
    expect(seatUsage(6, [], 5, now)).toMatchObject({ left: 0, full: true });
  });

  it('counts owners', () => {
    expect(countOwners([member('a', 'owner'), member('b', 'admin'), member('c', 'owner')])).toBe(2);
  });
});
