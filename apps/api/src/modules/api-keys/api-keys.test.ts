import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLANS, api } from '@parlante/shared';
import { hashApiKey, looksLikeApiKey } from '@parlante/shared/node';
import { apiKeys, eq } from '@parlante/db';
import { resolveApiKey } from '../../lib/auth';
import { createTestApp } from '../../testing/index';
import type { TestApp } from '../../testing/index';
import apiKeysModule from './index';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ modules: [apiKeysModule] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

describe('API keys', () => {
  it('creates a key shown once, stores only its hash and lists prefix and last use', async () => {
    const owner = await t.signUp({ name: 'Olga' });
    const created = await t.call(api.apiKeys.create, { as: owner, body: { name: ' CI ' } });
    expect(created.status).toBe(201);
    expect(looksLikeApiKey(created.body.key)).toBe(true);
    expect(created.body).toMatchObject({
      name: 'CI',
      workspaceId: owner.workspace.id,
      createdBy: { id: owner.user.id, name: 'Olga' },
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(created.body.key.startsWith(`${created.body.prefix}_`)).toBe(true);

    const [row] = await t.db.select().from(apiKeys);
    expect(row?.keyHash).toBe(hashApiKey(created.body.key));
    expect(JSON.stringify(row)).not.toContain(created.body.key);

    // The key authenticates, which records its last use.
    const auth = await resolveApiKey(t.db, `Bearer ${created.body.key}`);
    expect(auth?.workspaceId).toBe(owner.workspace.id);

    const list = await t.call(api.apiKeys.list, { as: owner });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: created.body.id, prefix: created.body.prefix });
    expect(list.body.items[0]?.lastUsedAt).not.toBeNull();
    // Neither the key, its secret part nor its hash are ever listed.
    const secret = created.body.key.slice(created.body.prefix.length + 1);
    expect(list.raw.body).not.toContain(secret);
    expect(list.raw.body).not.toContain(row?.keyHash);
    expect(list.raw.body).not.toMatch(/keyHash|"key"/);
  });

  it('revokes a key: it stops authenticating and stays listed as revoked', async () => {
    const owner = await t.signUp();
    const created = await t.call(api.apiKeys.create, { as: owner, body: { name: 'old' } });
    const params = { apiKeyId: created.body.id };

    const revoked = await t.call(api.apiKeys.revoke, { as: owner, params });
    expect(revoked.body).toEqual({ ok: true });
    expect(await resolveApiKey(t.db, `Bearer ${created.body.key}`)).toBeNull();
    const [first] = await t.db.select().from(apiKeys);
    expect(first?.revokedAt).toBeInstanceOf(Date);

    // Idempotent, and the first revocation date is kept.
    expect((await t.call(api.apiKeys.revoke, { as: owner, params })).status).toBe(200);
    const [second] = await t.db.select().from(apiKeys);
    expect(second?.revokedAt?.getTime()).toBe(first?.revokedAt?.getTime());
    const list = await t.call(api.apiKeys.list, { as: owner });
    expect(list.body.items[0]?.revokedAt).not.toBeNull();
  });

  it('applies the plan limit to active keys only', async () => {
    const owner = await t.signUp(); // free
    const max = PLANS.free.limits.maxApiKeys;
    const ids: string[] = [];
    for (let i = 0; i < max; i += 1) {
      const res = await t.call(api.apiKeys.create, { as: owner, body: { name: `k${i}` } });
      expect(res.status).toBe(201);
      ids.push(res.body.id);
    }
    const over = await t.call(api.apiKeys.create, { as: owner, body: { name: 'extra' } });
    expect(over.status).toBe(403);
    expect(over.error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(over.error.details).toMatchObject({ limit: 'maxApiKeys', max });

    // Revoking one frees its slot; two concurrent requests still cannot both take it.
    await t.call(api.apiKeys.revoke, { as: owner, params: { apiKeyId: ids[0] ?? '' } });
    const race = await Promise.all([
      t.call(api.apiKeys.create, { as: owner, body: { name: 'a' } }),
      t.call(api.apiKeys.create, { as: owner, body: { name: 'b' } }),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 403]);
    expect(await t.db.$count(apiKeys, eq(apiKeys.workspaceId, owner.workspace.id))).toBe(max + 1);
  });

  it('is for admins and owners, validated, and scoped to the workspace', async () => {
    const owner = await t.signUp();
    const admin = await t.addMember(owner.workspace, 'admin');
    const editor = await t.addMember(owner.workspace, 'editor');
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const other = await t.signUp();

    const created = await t.call(api.apiKeys.create, { as: admin, body: { name: 'mine' } });
    expect(created.status).toBe(201);
    const params = { apiKeyId: created.body.id };

    expect((await t.call(api.apiKeys.list)).status).toBe(401);
    for (const actor of [editor, viewer]) {
      expect((await t.call(api.apiKeys.list, { as: actor })).status).toBe(403);
      expect((await t.call(api.apiKeys.create, { as: actor, body: { name: 'x' } })).status).toBe(
        403,
      );
      expect((await t.call(api.apiKeys.revoke, { as: actor, params })).status).toBe(403);
    }
    expect((await t.call(api.apiKeys.create, { as: owner, body: { name: '' } })).status).toBe(400);
    expect((await t.call(api.apiKeys.create, { as: owner, body: {} })).status).toBe(400);
    expect(
      (await t.call(api.apiKeys.revoke, { as: owner, params: { apiKeyId: 'nope' } })).status,
    ).toBe(400);

    // Another workspace neither sees nor revokes it.
    expect((await t.call(api.apiKeys.list, { as: other })).body.items).toHaveLength(0);
    expect((await t.call(api.apiKeys.revoke, { as: other, params })).status).toBe(404);
    expect(await resolveApiKey(t.db, `Bearer ${created.body.key}`)).not.toBeNull();
  });
});
