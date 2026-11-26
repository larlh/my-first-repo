import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, newId } from '@parlante/shared';
import { assets } from '@parlante/db';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import templateModule from './index';

/**
 * Reference integration test — copy it with the module. Every module test must cover:
 * happy path, validation, authentication (401), role (403) and workspace isolation (404).
 */
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ modules: [templateModule] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

async function seedAsset(actor: TestActor, kind: 'image' | 'audio' = 'image') {
  const id = newId('asset');
  const storageKey = `ws/${actor.workspace.id}/assets/${id}/original.png`;
  await t.app.providers.storage.put(storageKey, Buffer.from('fake'), { contentType: 'image/png' });
  await t.db.insert(assets).values({
    id,
    workspaceId: actor.workspace.id,
    kind,
    name: 'logo.png',
    mimeType: kind === 'image' ? 'image/png' : 'audio/mpeg',
    sizeBytes: 4,
    storageKey,
  });
  return id;
}

describe('brand kits (reference module)', () => {
  it('creates, lists, reads, updates and deletes within the workspace', async () => {
    const alice = await t.signUp();
    const logoAssetId = await seedAsset(alice);

    const created = await t.call(api.brandKits.create, {
      as: alice,
      body: { name: 'Marca', logoAssetId, colors: { primary: '#ff0000' }, isDefault: true },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Marca',
      workspaceId: alice.workspace.id,
      logoAssetId,
      isDefault: true,
      colors: { primary: '#ff0000', accent: '#ffb547' },
      fonts: { heading: 'Poppins', body: 'Inter' },
    });
    expect(created.body.logoUrl).toContain(
      `/api/files/ws/${alice.workspace.id}/assets/${logoAssetId}/`,
    );
    const logo = new URL(created.body.logoUrl ?? '');
    expect((await t.inject({ method: 'GET', url: logo.pathname + logo.search })).statusCode).toBe(
      200,
    );

    const second = await t.call(api.brandKits.create, {
      as: alice,
      body: { name: 'Otra', isDefault: true },
    });
    const list = await t.call(api.brandKits.list, { as: alice });
    expect(list.body.items.map((k) => [k.name, k.isDefault])).toEqual([
      ['Otra', true],
      ['Marca', false],
    ]);

    const updated = await t.call(api.brandKits.update, {
      as: alice,
      params: { brandKitId: created.body.id },
      body: { name: 'Marca 2', colors: { accent: '#00ff00' }, logoAssetId: null },
    });
    expect(updated.body).toMatchObject({
      name: 'Marca 2',
      logoAssetId: null,
      logoUrl: null,
      colors: { primary: '#ff0000', accent: '#00ff00' },
    });

    expect(
      (await t.call(api.brandKits.remove, { as: alice, params: { brandKitId: second.body.id } }))
        .body,
    ).toEqual({ ok: true });
    expect(
      (await t.call(api.brandKits.get, { as: alice, params: { brandKitId: second.body.id } }))
        .status,
    ).toBe(404);
  });

  it('validates input', async () => {
    const alice = await t.signUp();
    const bad = await t.call(api.brandKits.create, {
      as: alice,
      body: { name: '', colors: { primary: 'red' } },
    });
    expect(bad.status).toBe(400);
    expect(bad.error.code).toBe('VALIDATION_ERROR');
    const audio = await seedAsset(alice, 'audio');
    const notImage = await t.call(api.brandKits.create, {
      as: alice,
      body: { name: 'x', logoAssetId: audio },
    });
    expect(notImage.status).toBe(400);
    const badId = await t.call(api.brandKits.get, { as: alice, params: { brandKitId: 'nope' } });
    expect(badId.status).toBe(400);
  });

  it('requires authentication and the editor role to write', async () => {
    const owner = await t.signUp();
    const viewer = await t.addMember(owner.workspace, 'viewer');
    expect((await t.call(api.brandKits.list)).status).toBe(401);
    expect((await t.call(api.brandKits.create, { as: viewer, body: { name: 'x' } })).status).toBe(
      403,
    );
    expect((await t.call(api.brandKits.list, { as: viewer })).status).toBe(200);
  });

  it('never exposes or mutates another workspace (404, not 403)', async () => {
    const alice = await t.signUp();
    const mallory = await t.signUp();
    const aliceLogo = await seedAsset(alice);
    const kit = await t.call(api.brandKits.create, {
      as: alice,
      body: { name: 'Privado', isDefault: true },
    });
    const params = { brandKitId: kit.body.id };

    expect((await t.call(api.brandKits.get, { as: mallory, params })).status).toBe(404);
    expect(
      (await t.call(api.brandKits.update, { as: mallory, params, body: { name: 'hacked' } }))
        .status,
    ).toBe(404);
    expect((await t.call(api.brandKits.remove, { as: mallory, params })).status).toBe(404);
    expect((await t.call(api.brandKits.list, { as: mallory })).body.items).toEqual([]);
    // Cannot reference another workspace's asset either.
    expect(
      (
        await t.call(api.brandKits.create, {
          as: mallory,
          body: { name: 'x', logoAssetId: aliceLogo },
        })
      ).status,
    ).toBe(400);
    // Mallory creating a default kit does not unset Alice's default.
    await t.call(api.brandKits.create, { as: mallory, body: { name: 'Mío', isDefault: true } });
    expect((await t.call(api.brandKits.get, { as: alice, params })).body).toMatchObject({
      name: 'Privado',
      isDefault: true,
    });
  });
});
