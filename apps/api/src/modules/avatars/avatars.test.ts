import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, localizeCatalogEntry, newId } from '@parlante/shared';
import type { PhotoAvatarRig, RouteQueryInput } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { avatars, consentRecords, eq, users } from '@parlante/db';
import { listStockAvatars } from '@parlante/renderer';
import { listStockPhotorealAvatars } from '@parlante/stock-assets';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import { pngBytes } from '../assets/test-fixtures';
import avatarsModule from './index';

let t: TestApp;
const instant = listStockAvatars();
const photoreal = listStockPhotorealAvatars();

beforeAll(async () => {
  // A port nothing listens on: the engine is deterministically "not running" in these tests
  // (the status of a running engine is exercised with the provider spies below).
  t = await createTestApp({
    modules: [avatarsModule],
    env: { AVATAR_ENGINE_URL: 'http://127.0.0.1:9' },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await t.reset();
});

const RIG: PhotoAvatarRig = {
  imageWidth: 512,
  imageHeight: 512,
  landmarks: {
    leftEye: { x: 0.4, y: 0.4 },
    rightEye: { x: 0.6, y: 0.4 },
    mouthLeft: { x: 0.44, y: 0.62 },
    mouthRight: { x: 0.56, y: 0.62 },
    chin: { x: 0.5, y: 0.78 },
  },
  landmarksSource: 'detected',
};

/** A finished workspace avatar with its four images in storage. */
async function seedReadyAvatar(
  actor: TestActor,
  values: Partial<typeof avatars.$inferInsert> = {},
): Promise<string> {
  const id = newId('avatar');
  const ws = actor.workspace.id;
  const { storage } = t.app.providers;
  const keys = {
    imageKey: storageKeys.avatarFile(ws, id, 'image.png'),
    maskKey: storageKeys.avatarFile(ws, id, 'mask.png'),
    cutoutKey: storageKeys.avatarFile(ws, id, 'cutout.png'),
    thumbnailKey: storageKeys.avatarFile(ws, id, 'thumb.jpg'),
  };
  for (const key of Object.values(keys)) {
    await storage.put(key, pngBytes(32, 32), { contentType: 'image/png' });
  }
  await t.db.insert(avatars).values({
    id,
    workspaceId: ws,
    name: 'Presentadora sintética',
    gender: 'female',
    status: 'ready',
    progress: 100,
    origin: 'generated',
    prompt: 'A 30 year old woman with short red hair, studio light',
    seed: 4242,
    model: 'test-model-v1',
    rig: RIG,
    ...keys,
    ...values,
  });
  return id;
}

async function seedPhotoAvatar(
  actor: TestActor,
  values: Partial<typeof avatars.$inferInsert> = {},
): Promise<string> {
  const consentId = newId('consent');
  await t.db.insert(consentRecords).values({
    id: consentId,
    workspaceId: actor.workspace.id,
    userId: actor.user.id,
    kind: 'photo_avatar',
    subjectName: 'Ana García',
    relationship: 'self',
    statementVersion: '2026-01',
    statement: 'I consent',
    locale: 'es',
    ip: '203.0.113.9',
  });
  const id = newId('avatar');
  await t.db.insert(avatars).values({
    id,
    workspaceId: actor.workspace.id,
    name: 'Ana',
    origin: 'photo',
    consentId,
    ...values,
  });
  return id;
}

describe('avatar catalogue', () => {
  it('lists instant stock, photorealistic stock and workspace avatars as one catalogue', async () => {
    const alice = await t.signUp();
    expect(instant.length).toBeGreaterThanOrEqual(8);
    expect(photoreal.length).toBeGreaterThanOrEqual(8);

    const empty = await t.call(api.avatars.list, { as: alice });
    expect(empty.status).toBe(200);
    expect(empty.body.items.map((a) => a.id)).toEqual([
      ...instant.map((a) => a.id),
      ...photoreal.map((a) => a.id),
    ]);

    const lucia = empty.body.items.find((a) => a.id === 'stock_lucia');
    const meta = instant.find((a) => a.id === 'stock_lucia');
    expect(lucia).toEqual({
      id: 'stock_lucia',
      kind: 'stock',
      rendering: 'instant',
      name: meta?.name,
      gender: meta?.gender,
      ageGroup: meta?.ageGroup,
      style: meta?.style,
      description: meta?.description,
      tags: meta?.tags,
      traits: meta?.traits,
      status: 'ready',
      progress: 100,
      etaSec: null,
      // Drawn by the renderer rig: there is no image to link.
      thumbnailUrl: null,
      imageUrl: null,
      maskUrl: null,
      cutoutUrl: null,
      rig: null,
      prompt: null,
      seed: null,
      model: null,
      provider: { id: 'canvas2d', name: 'Parlante 2D (Canvas)', quality: 'basic', local: true },
      workspaceId: null,
      consentId: null,
      error: null,
      createdAt: null,
    });

    const realMeta = photoreal[0];
    if (!realMeta) throw new Error('No photorealistic stock avatars');
    const real = empty.body.items.find((a) => a.id === realMeta.id);
    const base = `${t.config.PUBLIC_API_URL}/api/stock-avatars/${realMeta.id}`;
    expect(real).toMatchObject({
      kind: 'stock',
      rendering: 'photoreal',
      name: realMeta.name,
      status: 'ready',
      thumbnailUrl: `${base}/thumb`,
      imageUrl: `${base}/portrait`,
      maskUrl: realMeta.maskFile ? `${base}/mask` : null,
      cutoutUrl: `${base}/cutout`,
      rig: realMeta.rig,
      prompt: realMeta.prompt,
      seed: realMeta.seed,
      model: realMeta.model,
      provider: t.app.providers.portrait.info,
      workspaceId: null,
    });
    expect(real?.provider.local).toBe(true);
  });

  it('includes the avatars of the workspace with their state, newest first', async () => {
    const alice = await t.signUp();
    const now = Date.now();
    const ready = await seedReadyAvatar(alice, { createdAt: new Date(now - 3 * 60_000) });
    const processing = await seedPhotoAvatar(alice, {
      status: 'processing',
      progress: 40,
      etaSec: 12,
      // A job may have written files already: they are not exposed until it is ready.
      imageKey: storageKeys.avatarFile(alice.workspace.id, 'avt_placeholder00', 'image.png'),
      createdAt: new Date(now - 2 * 60_000),
    });
    const failed = await seedPhotoAvatar(alice, {
      name: 'Foto borrosa',
      status: 'failed',
      progress: 55,
      etaSec: 3,
      error: { code: 'UNPROCESSABLE', message: 'No usable face was found in the photo' },
      createdAt: new Date(now - 60_000),
    });

    const list = await t.call(api.avatars.list, { as: alice });
    const mine = list.body.items.filter((a) => a.workspaceId === alice.workspace.id);
    expect(mine.map((a) => a.id)).toEqual([failed, processing, ready]);
    // Stock avatars come first, in catalogue order.
    expect(list.body.items.slice(0, instant.length + photoreal.length).map((a) => a.kind)).toEqual(
      Array.from({ length: instant.length + photoreal.length }, () => 'stock'),
    );

    const readyDto = mine.find((a) => a.id === ready);
    expect(readyDto).toMatchObject({
      kind: 'generated',
      rendering: 'photoreal',
      name: 'Presentadora sintética',
      gender: 'female',
      ageGroup: null,
      style: null,
      status: 'ready',
      progress: 100,
      etaSec: null,
      rig: RIG,
      prompt: 'A 30 year old woman with short red hair, studio light',
      seed: 4242,
      model: 'test-model-v1',
      // No provider on the row yet: the engine that would do the work.
      provider: t.app.providers.portrait.info,
      consentId: null,
      error: null,
    });
    // Signed storage URLs that really serve the files.
    for (const [url, file] of [
      [readyDto?.imageUrl, 'image.png'],
      [readyDto?.maskUrl, 'mask.png'],
      [readyDto?.cutoutUrl, 'cutout.png'],
      [readyDto?.thumbnailUrl, 'thumb.jpg'],
    ] as const) {
      const parsed = new URL(url ?? '');
      expect(parsed.pathname).toBe(`/api/files/ws/${alice.workspace.id}/avatars/${ready}/${file}`);
      const res = await t.inject({ method: 'GET', url: parsed.pathname + parsed.search });
      expect(res.statusCode).toBe(200);
    }

    expect(mine.find((a) => a.id === processing)).toMatchObject({
      kind: 'photo',
      status: 'processing',
      progress: 40,
      etaSec: 12,
      imageUrl: null,
      maskUrl: null,
      cutoutUrl: null,
      thumbnailUrl: null,
      rig: null,
    });
    expect(mine.find((a) => a.id === processing)?.consentId).toMatch(/^cns_/);
    expect(mine.find((a) => a.id === failed)).toMatchObject({
      status: 'failed',
      etaSec: null,
      imageUrl: null,
      error: { code: 'UNPROCESSABLE', message: 'No usable face was found in the photo' },
    });
  });

  it('filters by kind, rendering, gender, age group and style', async () => {
    const alice = await t.signUp();
    const generated = await seedReadyAvatar(alice);
    const photo = await seedPhotoAvatar(alice, { gender: 'male' });
    const ids = async (options: { query: RouteQueryInput<typeof api.avatars.list> }) =>
      (await t.call(api.avatars.list, { as: alice, ...options })).body.items.map((a) => a.id);

    expect(await ids({ query: { rendering: 'instant' } })).toEqual(instant.map((a) => a.id));
    expect(await ids({ query: { rendering: 'photoreal' } })).toEqual([
      ...photoreal.map((a) => a.id),
      photo,
      generated,
    ]);
    expect(await ids({ query: { kind: 'stock' } })).toEqual([
      ...instant.map((a) => a.id),
      ...photoreal.map((a) => a.id),
    ]);
    expect(await ids({ query: { kind: 'generated' } })).toEqual([generated]);
    expect(await ids({ query: { kind: 'photo' } })).toEqual([photo]);
    expect(await ids({ query: { kind: 'photo', rendering: 'instant' } })).toEqual([]);

    expect(await ids({ query: { gender: 'male' } })).toEqual([
      ...instant.filter((a) => a.gender === 'male').map((a) => a.id),
      ...photoreal.filter((a) => a.gender === 'male').map((a) => a.id),
      photo,
    ]);
    // Workspace avatars have no age group or style: those filters only match stock ones.
    expect(await ids({ query: { ageGroup: 'senior' } })).toEqual([
      ...instant.filter((a) => a.ageGroup === 'senior').map((a) => a.id),
      ...photoreal.filter((a) => a.ageGroup === 'senior').map((a) => a.id),
    ]);
    expect(
      await ids({ query: { style: 'casual', gender: 'female', rendering: 'instant' } }),
    ).toEqual(
      instant.filter((a) => a.style === 'casual' && a.gender === 'female').map((a) => a.id),
    );
    expect(instant.some((a) => a.style === 'casual' && a.gender === 'female')).toBe(true);

    const invalid: Record<string, string>[] = [
      { rendering: 'hologram' },
      { gender: 'robot' },
      { kind: 'mine' },
      { q: 'x'.repeat(101) },
    ];
    for (const query of invalid) {
      const bad = await t.inject({
        method: 'GET',
        url: '/api/avatars',
        query,
        headers: { cookie: alice.cookie },
      });
      expect(bad.statusCode).toBe(400);
    }
  });

  it('searches names, descriptions, tags and prompts without caring about case or accents', async () => {
    const alice = await t.signUp();
    const generated = await seedReadyAvatar(alice);
    const search = async (q: string) =>
      (await t.call(api.avatars.list, { as: alice, query: { q } })).body.items.map((a) => a.id);

    // "lucia" finds "Lucía" in both stock catalogues.
    const lucias = await search('LUCIA');
    expect(lucias).toContain('stock_lucia');
    expect(lucias).toContain('real_lucia');
    expect(lucias).not.toContain('stock_mateo');

    const tag = instant[0]?.tags[0];
    if (!tag) throw new Error('The first stock avatar has no tags');
    expect(await search(tag)).toEqual(expect.arrayContaining([instant[0]?.id]));
    // Every word must match.
    expect(await search(`${tag} zzzz-no-existe`)).toEqual([]);

    // Generated avatars are found by their name and by the description they were made from.
    expect(await search('sintetica')).toEqual([generated]);
    expect(await search('red hair')).toEqual([generated]);
    expect(await search('   ')).toHaveLength(instant.length + photoreal.length + 1);
  });

  it('uses the English texts of the catalogue for English-speaking users', async () => {
    const alice = await t.signUp();
    await t.db.update(users).set({ locale: 'en' }).where(eq(users.id, alice.user.id));
    const list = await t.call(api.avatars.list, { as: alice });
    for (const meta of [...instant, ...photoreal]) {
      const expected = localizeCatalogEntry(meta, 'en');
      expect(list.body.items.find((a) => a.id === meta.id)).toMatchObject(expected);
    }
    // Searching works in both languages whatever the UI language.
    const withEnglish = [...instant, ...photoreal].find((a) => a.en?.tags?.[0]);
    if (withEnglish?.en?.tags?.[0]) {
      const found = await t.call(api.avatars.list, {
        as: alice,
        query: { q: withEnglish.en.tags[0] },
      });
      expect(found.body.items.map((a) => a.id)).toContain(withEnglish.id);
    }
    const spanish = await t.call(api.avatars.list, { as: alice, query: { q: 'presentadora' } });
    expect(spanish.body.items.map((a) => a.id)).toContain('stock_lucia');
  });

  it('reports the state of the photorealistic engine with the catalogue', async () => {
    const alice = await t.signUp();

    // Nothing listens on the configured engine URL: unavailable, with the reason.
    const down = await t.call(api.avatars.list, { as: alice });
    expect(down.status).toBe(200);
    expect(down.body.engine).toMatchObject({
      available: false,
      device: null,
      secondsPerVideoSecond: null,
      operations: { generate: false, prepare: false, animate: false },
    });
    expect(down.body.engine?.reason).toEqual(expect.any(String));
    expect(down.body.engine?.reason).not.toBe('');
    // The catalogue itself does not depend on the engine.
    expect(down.body.items.length).toBe(instant.length + photoreal.length);

    // A running engine: what its providers report reaches the client untouched.
    const model = {
      id: 'animator-nc',
      role: 'animation' as const,
      downloaded: true,
      license: 'CC BY-NC 4.0',
      commercialUse: false,
    };
    vi.spyOn(t.app.providers.lipsync, 'status').mockResolvedValue({
      available: true,
      reason: null,
      device: 'cpu',
      secondsPerVideoSecond: 14.5,
      operations: { generate: false, prepare: false, animate: true },
      models: [model],
    });
    vi.spyOn(t.app.providers.portrait, 'status').mockResolvedValue({
      available: true,
      reason: 'Portrait generation weights are not downloaded',
      device: 'cpu',
      secondsPerVideoSecond: null,
      operations: { generate: false, prepare: true, animate: false },
      secondsPerPortrait: 95,
    });
    const up = await t.call(api.avatars.list, { as: alice, query: { rendering: 'photoreal' } });
    expect(up.body.engine).toEqual({
      available: true,
      reason: 'Portrait generation weights are not downloaded',
      device: 'cpu',
      secondsPerVideoSecond: 14.5,
      operations: { generate: false, prepare: true, animate: true },
      models: [model],
      nonCommercial: true,
      secondsPerPortrait: 95,
    });

    // A provider whose status check blows up is "unavailable", never a failed listing.
    vi.spyOn(t.app.providers.lipsync, 'status').mockRejectedValue(new Error('boom'));
    vi.spyOn(t.app.providers.portrait, 'status').mockRejectedValue(new Error('boom'));
    const broken = await t.call(api.avatars.list, { as: alice });
    expect(broken.status).toBe(200);
    expect(broken.body.engine).toMatchObject({ available: false, reason: 'boom' });
  });

  it('reads one avatar of any origin', async () => {
    const alice = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const mine = await seedReadyAvatar(alice);
    const realId = photoreal[0]?.id ?? '';

    const stock = await t.call(api.avatars.get, { as: alice, params: { avatarId: 'stock_lucia' } });
    expect(stock.status).toBe(200);
    expect(stock.body).toMatchObject({ id: 'stock_lucia', rendering: 'instant', kind: 'stock' });
    const real = await t.call(api.avatars.get, { as: viewer, params: { avatarId: realId } });
    expect(real.body).toMatchObject({ id: realId, rendering: 'photoreal', kind: 'stock' });
    expect(real.body.cutoutUrl).toBe(
      `${t.config.PUBLIC_API_URL}/api/stock-avatars/${realId}/cutout`,
    );
    const own = await t.call(api.avatars.get, { as: viewer, params: { avatarId: mine } });
    expect(own.body).toMatchObject({ id: mine, kind: 'generated', status: 'ready' });
    expect(own.body.imageUrl).toContain(`/avatars/${mine}/image.png?`);

    for (const avatarId of ['stock_nadie', 'real_nadie', 'avt_0000000000000000']) {
      const missing = await t.call(api.avatars.get, { as: alice, params: { avatarId } });
      expect(missing.status).toBe(404);
      expect(missing.error.code).toBe('NOT_FOUND');
    }
    for (const avatarId of ['lucia', 'avt_x', 'stock_Lucia', 'vcl_0000000000000000']) {
      expect((await t.call(api.avatars.get, { as: alice, params: { avatarId } })).status).toBe(400);
    }
  });

  it('requires a session and never shows the avatars of another workspace', async () => {
    const alice = await t.signUp();
    const mallory = await t.signUp();
    const generated = await seedReadyAvatar(alice);
    const photo = await seedPhotoAvatar(alice, { name: 'Ana privada' });

    expect((await t.call(api.avatars.list)).status).toBe(401);
    expect((await t.call(api.avatars.get, { params: { avatarId: 'stock_lucia' } })).status).toBe(
      401,
    );

    const theirs = await t.call(api.avatars.list, { as: mallory });
    expect(theirs.body.items.every((a) => a.workspaceId === null)).toBe(true);
    expect(theirs.body.items).toHaveLength(instant.length + photoreal.length);
    expect(
      (await t.call(api.avatars.list, { as: mallory, query: { q: 'privada' } })).body.items,
    ).toEqual([]);
    expect(
      (await t.call(api.avatars.list, { as: mallory, query: { kind: 'photo' } })).body.items,
    ).toEqual([]);
    for (const avatarId of [generated, photo]) {
      const res = await t.call(api.avatars.get, { as: mallory, params: { avatarId } });
      expect(res.status).toBe(404);
    }
    // Stock avatars are for everyone.
    expect(
      (await t.call(api.avatars.get, { as: mallory, params: { avatarId: 'stock_lucia' } })).status,
    ).toBe(200);
  });
});

describe('photorealistic stock avatar files', () => {
  it('serves portrait, matte, cut-out and thumbnail publicly and cacheable', async () => {
    const meta = photoreal.find((a) => a.maskFile);
    if (!meta) throw new Error('No photorealistic stock avatar with a matte');
    const get = (file: 'portrait' | 'mask' | 'cutout' | 'thumb') =>
      t.call(api.avatars.stockFile, { params: { avatarId: meta.id, file } });
    const magic = (bytes: Buffer) => bytes.subarray(0, 4).toString('hex');
    const PNG = '89504e47';

    const portrait = await get('portrait');
    expect(portrait.status).toBe(200);
    expect(portrait.headers['content-type']).toMatch(/^image\/(jpeg|png)$/);
    expect(portrait.headers['cache-control']).toBe('public, max-age=86400');
    expect(portrait.headers['x-content-type-options']).toBe('nosniff');
    expect(portrait.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(portrait.raw.rawPayload.byteLength).toBeGreaterThan(5000);

    const mask = await get('mask');
    expect(mask.status).toBe(200);
    expect(mask.headers['content-type']).toBe('image/png');
    expect(magic(mask.raw.rawPayload)).toBe(PNG);

    const cutout = await get('cutout');
    expect(cutout.status).toBe(200);
    expect(cutout.headers['content-type']).toBe('image/png');
    expect(magic(cutout.raw.rawPayload)).toBe(PNG);
    // Same pixel size as the rig says (IHDR), with an alpha channel (colour type 6).
    expect(cutout.raw.rawPayload.readUInt32BE(16)).toBe(meta.rig.imageWidth);
    expect(cutout.raw.rawPayload.readUInt32BE(20)).toBe(meta.rig.imageHeight);
    expect(cutout.raw.rawPayload.readUInt8(25)).toBe(6);

    const thumb = await get('thumb');
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/jpeg');
    expect(thumb.raw.rawPayload.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(thumb.raw.rawPayload.byteLength).toBeLessThan(portrait.raw.rawPayload.byteLength);
  });

  it('answers 404 for unknown avatars and 400 for anything that is not a catalogue file', async () => {
    const missing = await t.call(api.avatars.stockFile, {
      params: { avatarId: 'real_nadie', file: 'portrait' },
    });
    expect(missing.status).toBe(404);
    expect(missing.error.code).toBe('NOT_FOUND');

    const realId = photoreal[0]?.id ?? '';
    for (const url of [
      `/api/stock-avatars/${realId}/source`,
      `/api/stock-avatars/${realId}/..%2Fmanifest.json`,
      '/api/stock-avatars/stock_lucia/thumb',
      '/api/stock-avatars/real_..%2F..%2Fx/portrait',
      '/api/stock-avatars/avt_0000000000000000/portrait',
    ]) {
      const res = await t.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(400);
    }
  });
});
