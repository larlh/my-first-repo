import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrandColorsSchema, BrandFontsSchema, api, newId } from '@parlante/shared';
import { brandKits, eq } from '@parlante/db';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import assetsModule from '../assets/index';
import { createMediaFixtures, pngBytes } from '../assets/test-fixtures';
import type { MediaFixtures } from '../assets/test-fixtures';
import brandKitsModule, { MAX_BRAND_KITS } from './index';

let t: TestApp;
let media: MediaFixtures;

beforeAll(async () => {
  // The real assets module too: logos are uploaded through the API, like a user would.
  t = await createTestApp({ modules: [assetsModule, brandKitsModule] });
  media = await createMediaFixtures();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

async function uploadAsset(
  actor: TestActor,
  file: { filename: string; data: Buffer },
  fields?: Record<string, string>,
): Promise<string> {
  const res = await t.call(api.assets.upload, {
    as: actor,
    multipart: { ...file, ...(fields ? { fields } : {}) },
  });
  if (res.status !== 201) throw new Error(`Upload failed: ${JSON.stringify(res.body)}`);
  return res.body.id;
}

const uploadLogo = (actor: TestActor) =>
  uploadAsset(actor, { filename: 'logo.png', data: pngBytes(256, 128, { transparent: true }) });

async function defaults(actor: TestActor): Promise<string[]> {
  const rows = await t.db
    .select()
    .from(brandKits)
    .where(eq(brandKits.workspaceId, actor.workspace.id));
  return rows.filter((row) => row.isDefault).map((row) => row.name);
}

describe('brand kits', () => {
  it('creates a kit with logo, colours and fonts, filling in the defaults', async () => {
    const alice = await t.signUp();
    const logoAssetId = await uploadLogo(alice);

    const minimal = await t.call(api.brandKits.create, { as: alice, body: { name: '  Básico  ' } });
    expect(minimal.status).toBe(201);
    expect(minimal.body).toMatchObject({
      workspaceId: alice.workspace.id,
      name: 'Básico',
      logoAssetId: null,
      logoUrl: null,
      colors: {
        primary: '#6d5efc',
        secondary: '#1b1f3b',
        accent: '#ffb547',
        background: '#0f1224',
        text: '#ffffff',
      },
      fonts: { heading: 'Poppins', body: 'Inter' },
      isDefault: false,
    });
    expect(minimal.body.id).toMatch(/^bk_/);
    expect(minimal.body.createdAt).toBe(minimal.body.updatedAt);

    const full = await t.call(api.brandKits.create, {
      as: alice,
      body: {
        name: 'Marca',
        logoAssetId,
        colors: { primary: '#ff0000', text: '#101010' },
        fonts: { heading: 'Inter' },
        isDefault: true,
      },
    });
    expect(full.status).toBe(201);
    expect(full.body).toMatchObject({
      name: 'Marca',
      logoAssetId,
      colors: { primary: '#ff0000', accent: '#ffb547', text: '#101010' },
      fonts: { heading: 'Inter', body: 'Inter' },
      isDefault: true,
    });
    // The logo is a signed URL of the asset file, and it serves the uploaded picture.
    const logo = new URL(full.body.logoUrl ?? '');
    expect(logo.pathname).toBe(
      `/api/files/ws/${alice.workspace.id}/assets/${logoAssetId}/original.png`,
    );
    const served = await t.inject({ method: 'GET', url: logo.pathname + logo.search });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');

    const read = await t.call(api.brandKits.get, {
      as: alice,
      params: { brandKitId: full.body.id },
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: full.body.id, name: 'Marca', logoAssetId });
    expect(read.body.logoUrl).toContain('/original.png?');
  });

  it('keeps at most one default kit per workspace', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const create = (actor: TestActor, name: string, isDefault?: boolean) =>
      t.call(api.brandKits.create, {
        as: actor,
        body: { name, ...(isDefault === undefined ? {} : { isDefault }) },
      });
    const first = await create(alice, 'Primero', true);
    await create(bob, 'De Bob', true);
    expect(await defaults(alice)).toEqual(['Primero']);

    // A new default takes over; a non-default kit changes nothing.
    const second = await create(alice, 'Segundo', true);
    expect(await defaults(alice)).toEqual(['Segundo']);
    await create(alice, 'Tercero');
    expect(await defaults(alice)).toEqual(['Segundo']);

    // The list shows the default first, then newest first.
    const list = await t.call(api.brandKits.list, { as: alice });
    expect(list.status).toBe(200);
    expect(list.body.items.map((k) => [k.name, k.isDefault])).toEqual([
      ['Segundo', true],
      ['Tercero', false],
      ['Primero', false],
    ]);

    // Marking another kit moves the flag; the old default reports the change.
    const moved = await t.call(api.brandKits.update, {
      as: alice,
      params: { brandKitId: first.body.id },
      body: { isDefault: true },
    });
    expect(moved.body.isDefault).toBe(true);
    expect(await defaults(alice)).toEqual(['Primero']);
    const old = await t.call(api.brandKits.get, {
      as: alice,
      params: { brandKitId: second.body.id },
    });
    expect(old.body.isDefault).toBe(false);

    // Unmarking leaves the workspace without a default; so does deleting the default.
    await t.call(api.brandKits.update, {
      as: alice,
      params: { brandKitId: first.body.id },
      body: { isDefault: false },
    });
    expect(await defaults(alice)).toEqual([]);
    await t.call(api.brandKits.update, {
      as: alice,
      params: { brandKitId: second.body.id },
      body: { isDefault: true },
    });
    await t.call(api.brandKits.remove, { as: alice, params: { brandKitId: second.body.id } });
    expect(await defaults(alice)).toEqual([]);

    // Concurrent "make me the default" requests still end with exactly one.
    const racers = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) => create(alice, `Carrera ${name}`, true)),
    );
    expect(racers.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(await defaults(alice)).toHaveLength(1);
    // None of this touched the other workspace.
    expect(await defaults(bob)).toEqual(['De Bob']);
  });

  it('updates name, logo, colours and fonts as partial patches', async () => {
    const alice = await t.signUp();
    const logoAssetId = await uploadLogo(alice);
    const otherLogo = await uploadLogo(alice);
    const created = await t.call(api.brandKits.create, {
      as: alice,
      body: { name: 'Marca', logoAssetId, colors: { primary: '#ff0000' }, isDefault: true },
    });
    const params = { brandKitId: created.body.id };
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = await t.call(api.brandKits.update, {
      as: alice,
      params,
      body: { name: 'Marca 2', colors: { accent: '#00ff00' }, fonts: { body: 'Poppins' } },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id: created.body.id,
      name: 'Marca 2',
      logoAssetId,
      // Colours and fonts that were not sent keep their value.
      colors: { primary: '#ff0000', accent: '#00ff00', secondary: '#1b1f3b' },
      fonts: { heading: 'Poppins', body: 'Poppins' },
      isDefault: true,
      createdAt: created.body.createdAt,
    });
    expect(Date.parse(updated.body.updatedAt)).toBeGreaterThan(Date.parse(created.body.updatedAt));

    const swapped = await t.call(api.brandKits.update, {
      as: alice,
      params,
      body: { logoAssetId: otherLogo },
    });
    expect(swapped.body.logoAssetId).toBe(otherLogo);
    expect(swapped.body.logoUrl).toContain(`/assets/${otherLogo}/`);
    const cleared = await t.call(api.brandKits.update, {
      as: alice,
      params,
      body: { logoAssetId: null },
    });
    expect(cleared.body).toMatchObject({ logoAssetId: null, logoUrl: null, name: 'Marca 2' });
    // An empty patch is a no-op that still answers with the kit.
    const same = await t.call(api.brandKits.update, { as: alice, params, body: {} });
    expect(same.body).toMatchObject({ name: 'Marca 2', isDefault: true });
  });

  it('follows the logo asset: deleting it clears the logo of the kit', async () => {
    const alice = await t.signUp();
    const logoAssetId = await uploadLogo(alice);
    const kit = await t.call(api.brandKits.create, {
      as: alice,
      body: { name: 'Marca', logoAssetId },
    });
    const removed = await t.call(api.assets.remove, {
      as: alice,
      params: { assetId: logoAssetId },
    });
    expect(removed.status).toBe(200);
    const read = await t.call(api.brandKits.get, {
      as: alice,
      params: { brandKitId: kit.body.id },
    });
    expect(read.body).toMatchObject({ logoAssetId: null, logoUrl: null, name: 'Marca' });
    expect((await t.call(api.brandKits.list, { as: alice })).body.items[0]?.logoUrl).toBeNull();
  });

  it('deletes a kit', async () => {
    const alice = await t.signUp();
    const kit = await t.call(api.brandKits.create, { as: alice, body: { name: 'Temporal' } });
    const params = { brandKitId: kit.body.id };
    expect((await t.call(api.brandKits.remove, { as: alice, params })).body).toEqual({ ok: true });
    expect((await t.call(api.brandKits.get, { as: alice, params })).status).toBe(404);
    expect((await t.call(api.brandKits.remove, { as: alice, params })).status).toBe(404);
    expect((await t.call(api.brandKits.list, { as: alice })).body.items).toEqual([]);
  });

  it('validates names, colours, fonts and the logo', async () => {
    const alice = await t.signUp();
    const logoAssetId = await uploadLogo(alice);
    const audio = await uploadAsset(alice, { filename: 'tono.wav', data: media.wav });
    const facePhoto = await uploadAsset(
      alice,
      { filename: 'cara.png', data: pngBytes() },
      { purpose: 'avatar_source' },
    );
    const kit = await t.call(api.brandKits.create, { as: alice, body: { name: 'Marca' } });
    const params = { brandKitId: kit.body.id };

    const invalid: Record<string, unknown>[] = [
      {},
      { name: '' },
      { name: '   ' },
      { name: 'n'.repeat(61) },
      { name: 'x', colors: { primary: 'red' } },
      { name: 'x', colors: { primary: '#12345' } },
      { name: 'x', fonts: { heading: 'Comic Sans MS' } },
      { name: 'x', logoAssetId: 'logo.png' },
      { name: 'x', isDefault: 'yes' },
      // The logo must be an image of the library: not audio, not somebody's source photo,
      // not an asset that does not exist.
      { name: 'x', logoAssetId: audio },
      { name: 'x', logoAssetId: facePhoto },
      { name: 'x', logoAssetId: newId('asset') },
    ];
    for (const body of invalid) {
      const res = await t.call(api.brandKits.create, { as: alice, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.error.code).toBe('VALIDATION_ERROR');
    }
    for (const body of invalid.slice(1)) {
      const { name: _name, ...rest } = body;
      const patch = 'name' in body && body.name !== 'x' ? body : rest;
      const res = await t.call(api.brandKits.update, { as: alice, params, body: patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
    }
    expect(
      (await t.call(api.brandKits.get, { as: alice, params: { brandKitId: 'nope' } })).status,
    ).toBe(400);
    expect(
      (await t.call(api.brandKits.get, { as: alice, params: { brandKitId: newId('brandKit') } }))
        .status,
    ).toBe(404);
    // Nothing changed.
    const list = await t.call(api.brandKits.list, { as: alice });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ name: 'Marca', logoAssetId: null });
    expect(logoAssetId).toMatch(/^ast_/);
  });

  it('requires a session to read and the editor role to write', async () => {
    const owner = await t.signUp();
    const editor = await t.addMember(owner.workspace, 'editor');
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const kit = await t.call(api.brandKits.create, { as: editor, body: { name: 'Equipo' } });
    expect(kit.status).toBe(201);
    const params = { brandKitId: kit.body.id };

    expect((await t.call(api.brandKits.list)).status).toBe(401);
    expect((await t.call(api.brandKits.get, { params })).status).toBe(401);
    expect((await t.call(api.brandKits.create, { body: { name: 'x' } })).status).toBe(401);

    expect((await t.call(api.brandKits.list, { as: viewer })).body.items).toHaveLength(1);
    expect((await t.call(api.brandKits.get, { as: viewer, params })).status).toBe(200);
    expect((await t.call(api.brandKits.create, { as: viewer, body: { name: 'x' } })).status).toBe(
      403,
    );
    expect(
      (await t.call(api.brandKits.update, { as: viewer, params, body: { name: 'x' } })).status,
    ).toBe(403);
    expect((await t.call(api.brandKits.remove, { as: viewer, params })).status).toBe(403);
    expect((await t.call(api.brandKits.get, { as: owner, params })).body.name).toBe('Equipo');
  });

  it('never exposes or mutates another workspace (404, not 403)', async () => {
    const alice = await t.signUp();
    const mallory = await t.signUp();
    const aliceLogo = await uploadLogo(alice);
    const kit = await t.call(api.brandKits.create, {
      as: alice,
      body: { name: 'Privado', logoAssetId: aliceLogo, isDefault: true },
    });
    const params = { brandKitId: kit.body.id };

    expect((await t.call(api.brandKits.get, { as: mallory, params })).status).toBe(404);
    expect(
      (await t.call(api.brandKits.update, { as: mallory, params, body: { name: 'hacked' } }))
        .status,
    ).toBe(404);
    expect((await t.call(api.brandKits.remove, { as: mallory, params })).status).toBe(404);
    expect((await t.call(api.brandKits.list, { as: mallory })).body.items).toEqual([]);

    // Another workspace's asset cannot become a logo, on create or on update.
    const stolen = await t.call(api.brandKits.create, {
      as: mallory,
      body: { name: 'x', logoAssetId: aliceLogo },
    });
    expect(stolen.status).toBe(400);
    const own = await t.call(api.brandKits.create, {
      as: mallory,
      body: { name: 'Mío', isDefault: true },
    });
    const patched = await t.call(api.brandKits.update, {
      as: mallory,
      params: { brandKitId: own.body.id },
      body: { logoAssetId: aliceLogo },
    });
    expect(patched.status).toBe(400);

    // Mallory's default did not unset Alice's, and her kit is intact.
    expect((await t.call(api.brandKits.get, { as: alice, params })).body).toMatchObject({
      name: 'Privado',
      isDefault: true,
      logoAssetId: aliceLogo,
    });
  });

  it('bounds the number of kits of a workspace', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    await t.db.insert(brandKits).values(
      Array.from({ length: MAX_BRAND_KITS }, (_, index) => ({
        id: newId('brandKit'),
        workspaceId: alice.workspace.id,
        name: `Kit ${index + 1}`,
        colors: BrandColorsSchema.parse({}),
        fonts: BrandFontsSchema.parse({}),
      })),
    );
    const res = await t.call(api.brandKits.create, { as: alice, body: { name: 'Uno más' } });
    expect(res.status).toBe(403);
    expect(res.error).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      details: { limit: 'maxBrandKits', max: MAX_BRAND_KITS },
    });
    expect((await t.call(api.brandKits.list, { as: alice })).body.items).toHaveLength(
      MAX_BRAND_KITS,
    );
    // The bound is per workspace.
    expect((await t.call(api.brandKits.create, { as: bob, body: { name: 'Mío' } })).status).toBe(
      201,
    );
  });
});
