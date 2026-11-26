import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api } from '@parlante/shared';
import { sha256Hex } from '@parlante/shared/node';
import { eq, invites, members } from '@parlante/db';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import membersModule from './index';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ modules: [membersModule] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

const memberId = (actor: TestActor) => ({ memberId: actor.member.id });

async function roleOf(actor: TestActor): Promise<string | undefined> {
  const [row] = await t.db.select().from(members).where(eq(members.id, actor.member.id));
  return row?.role;
}

describe('members', () => {
  it('lists the members of the active workspace only', async () => {
    const owner = await t.signUp({ name: 'Olga' });
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const stranger = await t.signUp();

    const list = await t.call(api.members.list, { as: viewer });
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        id: owner.member.id,
        userId: owner.user.id,
        name: 'Olga',
        email: owner.user.email,
        role: 'owner',
        workspaceId: owner.workspace.id,
      }),
      expect.objectContaining({ id: viewer.member.id, role: 'viewer' }),
    ]);
    expect(list.raw.body).not.toMatch(/password|scrypt/i);
    expect((await t.call(api.members.list, { as: stranger })).body.items).toHaveLength(1);
    expect((await t.call(api.members.list)).status).toBe(401);
  });

  it('changes roles: admins manage editors and viewers, only owners touch owner/admin', async () => {
    const owner = await t.signUp({ plan: 'team' });
    const admin = await t.addMember(owner.workspace, 'admin');
    const admin2 = await t.addMember(owner.workspace, 'admin');
    const editor = await t.addMember(owner.workspace, 'editor');
    const viewer = await t.addMember(owner.workspace, 'viewer');

    // Admin: editor ↔ viewer.
    const promoted = await t.call(api.members.updateRole, {
      as: admin,
      params: memberId(viewer),
      body: { role: 'editor' },
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ id: viewer.member.id, role: 'editor' });

    // Admin cannot grant admin/owner, nor demote another admin or the owner, nor itself.
    for (const [target, role] of [
      [editor, 'admin'],
      [editor, 'owner'],
      [admin2, 'viewer'],
      [owner, 'editor'],
      [admin, 'editor'],
    ] as const) {
      const res = await t.call(api.members.updateRole, {
        as: admin,
        params: memberId(target),
        body: { role },
      });
      expect(res.status).toBe(403);
    }
    expect(await roleOf(editor)).toBe('editor');
    expect(await roleOf(admin2)).toBe('admin');

    // Editors and viewers cannot change roles at all.
    const byEditor = await t.call(api.members.updateRole, {
      as: editor,
      params: memberId(viewer),
      body: { role: 'viewer' },
    });
    expect(byEditor.status).toBe(403);

    // Owner can do all of it.
    const toAdmin = await t.call(api.members.updateRole, {
      as: owner,
      params: memberId(editor),
      body: { role: 'admin' },
    });
    expect(toAdmin.body.role).toBe('admin');
    const demoted = await t.call(api.members.updateRole, {
      as: owner,
      params: memberId(admin2),
      body: { role: 'viewer' },
    });
    expect(demoted.body.role).toBe('viewer');

    const invalid = await t.call(api.members.updateRole, {
      as: owner,
      params: memberId(viewer),
      body: { role: 'superuser' },
    });
    expect(invalid.status).toBe(400);
    expect(
      (
        await t.call(api.members.updateRole, {
          as: owner,
          params: { memberId: 'nope' },
          body: { role: 'viewer' },
        })
      ).status,
    ).toBe(400);
  });

  it('always keeps one owner', async () => {
    const owner = await t.signUp({ plan: 'team' });
    const admin = await t.addMember(owner.workspace, 'admin');

    const self = await t.call(api.members.updateRole, {
      as: owner,
      params: memberId(owner),
      body: { role: 'admin' },
    });
    expect(self.status).toBe(409);
    expect(self.error.code).toBe('INVALID_STATE');
    const leave = await t.call(api.members.remove, { as: owner, params: memberId(owner) });
    expect(leave.status).toBe(409);
    expect(leave.error.code).toBe('INVALID_STATE');
    expect(await roleOf(owner)).toBe('owner');

    // With a second owner, the first one can step down and then leave.
    const co = await t.call(api.members.updateRole, {
      as: owner,
      params: memberId(admin),
      body: { role: 'owner' },
    });
    expect(co.body.role).toBe('owner');
    const stepDown = await t.call(api.members.updateRole, {
      as: owner,
      params: memberId(owner),
      body: { role: 'editor' },
    });
    expect(stepDown.body.role).toBe('editor');
    // …and the remaining owner is protected again, even from concurrent demotions.
    const results = await Promise.all([
      t.call(api.members.updateRole, {
        as: admin,
        params: memberId(admin),
        body: { role: 'viewer' },
      }),
      t.call(api.members.remove, { as: admin, params: memberId(admin) }),
    ]);
    expect(results.map((r) => r.status)).toEqual([409, 409]);
    expect(await roleOf(admin)).toBe('owner');
  });

  it('removes members by role and lets anyone leave', async () => {
    const owner = await t.signUp({ plan: 'team' });
    const admin = await t.addMember(owner.workspace, 'admin');
    const admin2 = await t.addMember(owner.workspace, 'admin');
    const editor = await t.addMember(owner.workspace, 'editor');
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const viewer2 = await t.addMember(owner.workspace, 'viewer');

    // Viewers and editors cannot remove other people.
    expect(
      (await t.call(api.members.remove, { as: viewer, params: memberId(viewer2) })).status,
    ).toBe(403);
    expect(
      (await t.call(api.members.remove, { as: editor, params: memberId(viewer2) })).status,
    ).toBe(403);
    // Admins remove editors/viewers but not admins or owners.
    expect((await t.call(api.members.remove, { as: admin, params: memberId(admin2) })).status).toBe(
      403,
    );
    expect((await t.call(api.members.remove, { as: admin, params: memberId(owner) })).status).toBe(
      403,
    );
    expect(
      (await t.call(api.members.remove, { as: admin, params: memberId(viewer2) })).body,
    ).toEqual({ ok: true });
    // Anyone can leave.
    expect(
      (await t.call(api.members.remove, { as: viewer, params: memberId(viewer) })).status,
    ).toBe(200);
    // Owners remove admins.
    expect((await t.call(api.members.remove, { as: owner, params: memberId(admin2) })).status).toBe(
      200,
    );

    const left = await t.call(api.members.list, { as: owner });
    expect(left.body.items.map((m) => m.role)).toEqual(['owner', 'admin', 'editor']);

    // The viewer who left no longer acts on the workspace: the session moved to a new
    // personal workspace of their own.
    const after = await t.call(api.members.list, { as: viewer });
    expect(after.body.items).toHaveLength(1);
    expect(after.body.items[0]?.workspaceId).not.toBe(owner.workspace.id);
    // Gone is gone.
    expect(
      (await t.call(api.members.remove, { as: owner, params: memberId(viewer2) })).status,
    ).toBe(404);
  });

  it('never reaches members of another workspace', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const bobViewer = await t.addMember(bob.workspace, 'viewer');

    const update = await t.call(api.members.updateRole, {
      as: alice,
      params: memberId(bobViewer),
      body: { role: 'admin' },
    });
    expect(update.status).toBe(404);
    const remove = await t.call(api.members.remove, { as: alice, params: memberId(bobViewer) });
    expect(remove.status).toBe(404);
    expect(await roleOf(bobViewer)).toBe('viewer');
  });
});

describe('invitations', () => {
  it('invites by e-mail, returning the token once and storing only its hash', async () => {
    const owner = await t.signUp({ name: 'Olga' });
    const created = await t.call(api.members.createInvite, {
      as: owner,
      body: { email: 'New.Person@Example.test' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      email: 'new.person@example.test',
      role: 'editor',
      workspaceId: owner.workspace.id,
      invitedBy: { id: owner.user.id, name: 'Olga' },
      acceptedAt: null,
    });
    expect(created.body.token).toHaveLength(40);
    expect(created.body.acceptUrl).toBe(`http://web.test/invite/${created.body.token}`);
    const days = (Date.parse(created.body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);

    const [row] = await t.db.select().from(invites);
    expect(row?.tokenHash).toBe(sha256Hex(created.body.token));
    expect(JSON.stringify(row)).not.toContain(created.body.token);

    const list = await t.call(api.members.listInvites, { as: owner });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: created.body.id });
    expect(list.raw.body).not.toContain(created.body.token);
    expect(list.raw.body).not.toContain('tokenHash');

    // Public lookup by token (accept page).
    const lookup = await t.call(api.members.lookupInvite, {
      params: { token: created.body.token },
    });
    expect(lookup.body).toEqual({
      workspaceName: owner.workspace.name,
      email: 'new.person@example.test',
      role: 'editor',
      expired: false,
      accepted: false,
    });
    const unknown = await t.call(api.members.lookupInvite, { params: { token: 'x'.repeat(40) } });
    expect(unknown.status).toBe(404);
  });

  it('enforces roles, duplicates and the member limit of the plan', async () => {
    const owner = await t.signUp({ plan: 'creator' }); // 5 members
    const admin = await t.addMember(owner.workspace, 'admin');
    const editor = await t.addMember(owner.workspace, 'editor');
    const invite = (as: TestActor, email: string, role?: string) =>
      t.call(api.members.createInvite, { as, body: role ? { email, role } : { email } });

    expect((await invite(editor, 'a@example.test')).status).toBe(403);
    expect((await t.call(api.members.listInvites, { as: editor })).status).toBe(403);
    expect((await invite(owner, 'not-an-email')).status).toBe(400);
    expect((await invite(owner, 'a@example.test', 'owner')).status).toBe(400);
    expect((await invite(admin, 'a@example.test', 'admin')).status).toBe(403);

    // Already a member / already invited.
    const member = await invite(owner, editor.user.email);
    expect(member.status).toBe(409);
    expect(member.error.code).toBe('CONFLICT');
    expect((await invite(admin, 'a@example.test', 'viewer')).status).toBe(201);
    expect((await invite(owner, 'A@example.test')).status).toBe(409);

    // 3 members + 1 pending = 4 seats; one more fits, the next does not.
    expect((await invite(owner, 'b@example.test', 'admin')).status).toBe(201);
    const over = await invite(owner, 'c@example.test');
    expect(over.status).toBe(403);
    expect(over.error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(over.error.details).toMatchObject({ limit: 'maxMembers', max: 5 });

    // An expired invitation frees its seat and can be replaced.
    await t.db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.email, 'a@example.test'));
    expect((await invite(owner, 'c@example.test')).status).toBe(201);
    const stillListed = await t.call(api.members.listInvites, { as: admin });
    expect(stillListed.body.items.map((i) => i.email).sort()).toEqual([
      'a@example.test',
      'b@example.test',
      'c@example.test',
    ]);
  });

  it('revokes a pending invitation of this workspace only', async () => {
    const owner = await t.signUp();
    const other = await t.signUp();
    const created = await t.call(api.members.createInvite, {
      as: owner,
      body: { email: 'x@example.test' },
    });
    const params = { inviteId: created.body.id };
    expect((await t.call(api.members.revokeInvite, { as: other, params })).status).toBe(404);
    expect((await t.call(api.members.revokeInvite, { as: owner, params })).body).toEqual({
      ok: true,
    });
    expect((await t.call(api.members.revokeInvite, { as: owner, params })).status).toBe(404);
    const lookup = await t.call(api.members.lookupInvite, {
      params: { token: created.body.token },
    });
    expect(lookup.status).toBe(404);
  });

  it('accepts an invitation: joins with the invited role and switches workspace', async () => {
    const owner = await t.signUp();
    const guest = await t.signUp({ email: 'guest@example.test' });
    const intruder = await t.signUp();
    const created = await t.call(api.members.createInvite, {
      as: owner,
      body: { email: 'guest@example.test', role: 'viewer' },
    });
    const body = { token: created.body.token };

    // A leaked link is useless to another account.
    const stolen = await t.call(api.members.acceptInvite, { as: intruder, body });
    expect(stolen.status).toBe(403);
    expect((await t.call(api.members.acceptInvite, { body })).status).toBe(401);
    expect(
      (await t.call(api.members.acceptInvite, { as: guest, body: { token: 'y'.repeat(40) } }))
        .status,
    ).toBe(404);

    const accepted = await t.call(api.members.acceptInvite, { as: guest, body });
    expect(accepted.status).toBe(200);
    expect(accepted.body.currentWorkspaceId).toBe(owner.workspace.id);
    expect(accepted.body.workspaces.find((w) => w.id === owner.workspace.id)?.role).toBe('viewer');
    const list = await t.call(api.members.list, { as: guest });
    expect(list.body.items.map((m) => m.role)).toEqual(['owner', 'viewer']);

    // Single use.
    const again = await t.call(api.members.acceptInvite, { as: guest, body });
    expect(again.status).toBe(409);
    expect(again.error.code).toBe('INVALID_STATE');
    const lookup = await t.call(api.members.lookupInvite, { params: body });
    expect(lookup.body.accepted).toBe(true);
    expect((await t.call(api.members.listInvites, { as: owner })).body.items).toHaveLength(0);
  });

  it('refuses expired invitations and full workspaces', async () => {
    const owner = await t.signUp(); // free: 2 members
    const guest = await t.signUp({ email: 'guest@example.test' });
    const late = await t.signUp({ email: 'late@example.test' });
    const forGuest = await t.call(api.members.createInvite, {
      as: owner,
      body: { email: 'guest@example.test' },
    });

    await t.db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await t.call(api.members.acceptInvite, {
      as: guest,
      body: { token: forGuest.body.token },
    });
    expect(expired.status).toBe(409);
    const lookup = await t.call(api.members.lookupInvite, {
      params: { token: forGuest.body.token },
    });
    expect(lookup.body.expired).toBe(true);

    // The seat was taken by someone else while the invitation was pending.
    await t.db.update(invites).set({ expiresAt: new Date(Date.now() + 60_000) });
    await t.addMember(owner.workspace, 'viewer');
    const full = await t.call(api.members.acceptInvite, {
      as: guest,
      body: { token: forGuest.body.token },
    });
    expect(full.status).toBe(403);
    expect(full.error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(await t.db.$count(members, eq(members.workspaceId, owner.workspace.id))).toBe(2);
    expect(
      (await t.call(api.members.createInvite, { as: owner, body: { email: late.user.email } }))
        .status,
    ).toBe(403);
  });
});
