import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, CREDIT_COSTS, api, newId } from '@parlante/shared';
import type { EngineStatus, PhotoLandmarks, PortraitProvider, ProviderRef } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { assets, avatars, consentRecords, eq } from '@parlante/db';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import consentModule from '../consent/index';
import {
  balanceOf,
  breakQueue,
  ledgerOf,
  recordConsent,
  seedAsset,
} from '../interactive/test-doubles';
import photoAvatarsModule from './index';

/* The local engine is replaced by a double that only reports its status (the API never runs
 * it: the worker does). Everything else is the real app, moderation provider included. */

const ENGINE_INFO: ProviderRef = {
  id: 'local-neural',
  name: 'Motor neuronal local',
  quality: 'premium',
  local: true,
};
const ENGINE_UP: EngineStatus = {
  available: true,
  reason: null,
  device: 'cpu',
  secondsPerVideoSecond: 40.8,
  operations: { generate: true, prepare: true, animate: true },
  secondsPerPortrait: 65.7,
};

let t: TestApp;
let engineStatus: () => Promise<EngineStatus>;

beforeAll(async () => {
  t = await createTestApp({
    modules: [photoAvatarsModule, consentModule],
    env: { MODERATION_EXTRA_BLOCKLIST: 'zzprohibido' },
  });
  const portrait: PortraitProvider = {
    info: ENGINE_INFO,
    status: () => engineStatus(),
    generate: () => Promise.reject(new AppError('NOT_IMPLEMENTED', 'not used by the API')),
    prepare: () => Promise.reject(new AppError('NOT_IMPLEMENTED', 'not used by the API')),
  };
  t.app.providers.portrait = portrait;
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  engineStatus = () => Promise.resolve(ENGINE_UP);
});

const LANDMARKS: PhotoLandmarks = {
  leftEye: { x: 0.4, y: 0.35 },
  rightEye: { x: 0.6, y: 0.35 },
  mouthLeft: { x: 0.43, y: 0.6 },
  mouthRight: { x: 0.57, y: 0.6 },
  chin: { x: 0.5, y: 0.75 },
};

async function prepared(actor: TestActor) {
  const photo = await seedAsset(t, actor, { kind: 'image' });
  const consentId = await recordConsent(t, actor, 'photo_avatar');
  return { photo, consentId };
}

async function avatarRows(actor: TestActor) {
  return t.db.select().from(avatars).where(eq(avatars.workspaceId, actor.workspace.id));
}

const PROMPT = 'mujer de 35 años, pelo castaño rizado, chaqueta azul marino y gafas';

describe('POST /api/photo-avatars (from a photo of a real person)', () => {
  it('consumes the consent, charges, stores the avatar as processing and queues the job', async () => {
    const alice = await t.signUp();
    const { photo, consentId } = await prepared(alice);
    const before = await balanceOf(t, alice);

    const res = await t.call(api.photoAvatars.create, {
      as: alice,
      body: {
        name: 'Ana',
        imageAssetId: photo.id,
        consentId,
        gender: 'female',
        landmarks: LANDMARKS,
      },
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      kind: 'photo',
      rendering: 'photoreal',
      name: 'Ana',
      gender: 'female',
      status: 'processing',
      progress: 0,
      etaSec: null,
      imageUrl: null,
      maskUrl: null,
      cutoutUrl: null,
      thumbnailUrl: null,
      rig: null,
      prompt: null,
      provider: ENGINE_INFO,
      workspaceId: alice.workspace.id,
      consentId,
      error: null,
    });
    expect(res.body.id).toMatch(/^avt_/);

    expect(await balanceOf(t, alice)).toBe(before - CREDIT_COSTS.photoAvatar);
    expect(
      (await ledgerOf(t, alice)).find((entry) => entry.reason === 'photo_avatar'),
    ).toMatchObject({
      delta: -CREDIT_COSTS.photoAvatar,
      refType: 'avatar',
      refId: res.body.id,
    });
    expect(t.queues.jobs('photoAvatar')).toEqual([
      { avatarId: res.body.id, workspaceId: alice.workspace.id },
    ]);
    expect(t.queues.jobIds('photoAvatar')).toEqual([res.body.id]);

    const [row] = await avatarRows(alice);
    expect(row).toMatchObject({
      origin: 'photo',
      sourceAssetId: photo.id,
      requestedLandmarks: LANDMARKS,
      consentId,
      createdBy: alice.user.id,
    });
    const [consent] = await t.db
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.id, consentId));
    expect(consent?.resourceId).toBe(res.body.id);
    const [asset] = await t.db.select().from(assets).where(eq(assets.id, photo.id));
    expect(asset?.purpose).toBe('avatar_source');
  });

  it('REJECTS the operation without a valid consent record (nothing created or charged)', async () => {
    const alice = await t.signUp({ credits: 200, plan: 'creator' });
    const colleague = await t.addMember(alice.workspace, 'editor');
    const mallory = await t.signUp();
    const photo = await seedAsset(t, alice, { kind: 'image' });
    const before = await balanceOf(t, alice);

    const attempt = async (consentId: string) => {
      const res = await t.call(api.photoAvatars.create, {
        as: alice,
        body: { name: 'Ana', imageAssetId: photo.id, consentId },
      });
      expect(res.status, consentId).toBe(403);
      expect(res.error.code).toBe('CONSENT_REQUIRED');
      expect(res.error.details).toMatchObject({ kind: 'photo_avatar' });
    };
    await attempt(newId('consent')); // does not exist
    await attempt(await recordConsent(t, alice, 'voice_clone')); // wrong kind
    await attempt(await recordConsent(t, colleague, 'photo_avatar')); // another user
    await attempt(await recordConsent(t, mallory, 'photo_avatar')); // another workspace
    const revoked = await recordConsent(t, alice, 'photo_avatar');
    await t.call(api.consents.revoke, { as: alice, params: { consentId: revoked } });
    await attempt(revoked); // revoked
    const missing = await t.call(api.photoAvatars.create, {
      as: alice,
      body: { name: 'Ana', imageAssetId: photo.id },
    });
    expect(missing.status).toBe(400);

    expect(await avatarRows(alice)).toEqual([]);
    expect(await balanceOf(t, alice)).toBe(before);
    expect(t.queues.size).toBe(0);
    const [asset] = await t.db.select().from(assets).where(eq(assets.id, photo.id));
    expect(asset?.purpose).toBe('library');

    // One consent, one avatar.
    const consentId = await recordConsent(t, alice, 'photo_avatar');
    expect(
      (
        await t.call(api.photoAvatars.create, {
          as: alice,
          body: { name: 'Ana', imageAssetId: photo.id, consentId },
        })
      ).status,
    ).toBe(202);
    const other = await seedAsset(t, alice, { kind: 'image' });
    const reused = await t.call(api.photoAvatars.create, {
      as: alice,
      body: { name: 'Otra', imageAssetId: other.id, consentId },
    });
    expect(reused.status).toBe(403);
    expect(reused.error.code).toBe('CONSENT_REQUIRED');
    expect(await avatarRows(alice)).toHaveLength(1);
  });

  it('checks the engine BEFORE charging and reports its reason', async () => {
    const alice = await t.signUp();
    const { photo, consentId } = await prepared(alice);
    const before = await balanceOf(t, alice);
    const body = { name: 'Ana', imageAssetId: photo.id, consentId };

    engineStatus = () =>
      Promise.resolve({
        available: false,
        reason: 'El motor de avatares no está en marcha (pnpm avatar-engine)',
        device: null,
        secondsPerVideoSecond: null,
      });
    const down = await t.call(api.photoAvatars.create, { as: alice, body });
    expect(down.status).toBe(503);
    expect(down.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'El motor de avatares no está en marcha (pnpm avatar-engine)',
      details: { capability: 'portrait', operation: 'prepare' },
    });

    // Weights of the matting model missing: `prepare` is off although the engine answers.
    engineStatus = () =>
      Promise.resolve({
        ...ENGINE_UP,
        reason: 'Faltan pesos: matting',
        operations: { generate: true, prepare: false, animate: true },
      });
    expect((await t.call(api.photoAvatars.create, { as: alice, body })).error.message).toBe(
      'Faltan pesos: matting',
    );

    engineStatus = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8090'));
    const unreachable = await t.call(api.photoAvatars.create, { as: alice, body });
    expect(unreachable.status).toBe(503);
    expect(unreachable.error.code).toBe('SERVICE_UNAVAILABLE');

    engineStatus = () =>
      Promise.reject(new AppError('PROVIDER_NOT_CONFIGURED', 'No portrait provider is configured'));
    const notConfigured = await t.call(api.photoAvatars.create, { as: alice, body });
    expect(notConfigured.status).toBe(503);
    expect(notConfigured.error.code).toBe('PROVIDER_NOT_CONFIGURED');

    // Without a valid consent the answer is CONSENT_REQUIRED whatever the engine says.
    const noConsent = await t.call(api.photoAvatars.create, {
      as: alice,
      body: { ...body, consentId: newId('consent') },
    });
    expect(noConsent.status).toBe(403);
    expect(noConsent.error.code).toBe('CONSENT_REQUIRED');

    expect(await avatarRows(alice)).toEqual([]);
    expect(await balanceOf(t, alice)).toBe(before);
    expect(t.queues.size).toBe(0);
    // The consent is intact: the same request works once the engine is back.
    engineStatus = () => Promise.resolve(ENGINE_UP);
    expect((await t.call(api.photoAvatars.create, { as: alice, body })).status).toBe(202);
  });

  it('validates photo, landmarks and name', async () => {
    const alice = await t.signUp({ credits: 100, plan: 'creator' });
    const consentId = await recordConsent(t, alice, 'photo_avatar');
    const audio = await seedAsset(t, alice, { kind: 'audio' });
    const photo = await seedAsset(t, alice, { kind: 'image' });
    const base = { name: 'Ana', imageAssetId: photo.id, consentId };

    const notImage = await t.call(api.photoAvatars.create, {
      as: alice,
      body: { ...base, imageAssetId: audio.id },
    });
    expect(notImage.status).toBe(400);
    expect(notImage.error.code).toBe('VALIDATION_ERROR');
    expect(
      (
        await t.call(api.photoAvatars.create, {
          as: alice,
          body: { ...base, imageAssetId: newId('asset') },
        })
      ).status,
    ).toBe(404);
    const crossed = await t.call(api.photoAvatars.create, {
      as: alice,
      body: {
        ...base,
        landmarks: { ...LANDMARKS, leftEye: LANDMARKS.rightEye, rightEye: LANDMARKS.leftEye },
      },
    });
    expect(crossed.status).toBe(400);
    const outOfRange = await t.call(api.photoAvatars.create, {
      as: alice,
      body: { ...base, landmarks: { ...LANDMARKS, chin: { x: 0.5, y: 1.4 } } },
    });
    expect(outOfRange.status).toBe(400);
    const blocked = await t.call(api.photoAvatars.create, {
      as: alice,
      body: { ...base, name: 'zzprohibido' },
    });
    expect(blocked.status).toBe(422);
    expect(blocked.error.code).toBe('CONTENT_BLOCKED');
    expect(
      (await t.call(api.photoAvatars.create, { as: alice, body: { ...base, name: '' } })).status,
    ).toBe(400);
    expect(await avatarRows(alice)).toEqual([]);

    const ok = await t.call(api.photoAvatars.create, { as: alice, body: base });
    expect(ok.status).toBe(202);
    const again = await t.call(api.photoAvatars.create, {
      as: alice,
      body: { ...base, consentId: await recordConsent(t, alice, 'photo_avatar') },
    });
    expect(again.status).toBe(409);
    expect(again.error.details).toMatchObject({ usedBy: [{ type: 'avatar', id: ok.body.id }] });
  });

  it('applies the plan limit and the credit balance; refunds when the queue is down', async () => {
    const alice = await t.signUp({ credits: 100 }); // free plan: 1 avatar
    const one = await prepared(alice);
    expect(
      (
        await t.call(api.photoAvatars.create, {
          as: alice,
          body: { name: 'Uno', imageAssetId: one.photo.id, consentId: one.consentId },
        })
      ).status,
    ).toBe(202);
    const two = await prepared(alice);
    const overLimit = await t.call(api.photoAvatars.create, {
      as: alice,
      body: { name: 'Dos', imageAssetId: two.photo.id, consentId: two.consentId },
    });
    expect(overLimit.status).toBe(403);
    expect(overLimit.error.details).toMatchObject({ limit: 'maxPhotoAvatars', max: 1, value: 2 });
    // Generated avatars share the same allowance.
    const generated = await t.call(api.photoAvatars.generate, {
      as: alice,
      body: { name: 'Sintética', prompt: PROMPT },
    });
    expect(generated.status).toBe(403);
    expect(generated.error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(await balanceOf(t, alice)).toBe(100 - CREDIT_COSTS.photoAvatar);

    const poor = await t.signUp({ credits: CREDIT_COSTS.photoAvatar - 1 });
    const mine = await prepared(poor);
    const body = { name: 'Yo', imageAssetId: mine.photo.id, consentId: mine.consentId };
    const noCredits = await t.call(api.photoAvatars.create, { as: poor, body });
    expect(noCredits.status).toBe(402);
    expect(noCredits.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(await avatarRows(poor)).toEqual([]);

    const bob = await t.signUp();
    const his = await prepared(bob);
    const before = await balanceOf(t, bob);
    const restore = breakQueue(t);
    const res = await t.call(api.photoAvatars.create, {
      as: bob,
      body: { name: 'Bob', imageAssetId: his.photo.id, consentId: his.consentId },
    });
    restore();
    expect(res.status).toBe(503);
    expect(await balanceOf(t, bob)).toBe(before);
    expect((await avatarRows(bob))[0]).toMatchObject({
      status: 'failed',
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
  });
});

describe('POST /api/photo-avatars/generate (synthetic person from text)', () => {
  it('charges, stores prompt and seed and queues the job — no consent involved', async () => {
    const alice = await t.signUp();
    const before = await balanceOf(t, alice);
    const res = await t.call(api.photoAvatars.generate, {
      as: alice,
      body: { name: 'Presentadora', prompt: PROMPT, gender: 'female', seed: 1234 },
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      kind: 'generated',
      rendering: 'photoreal',
      name: 'Presentadora',
      status: 'processing',
      progress: 0,
      // First ETA = the engine's measured seconds per portrait.
      etaSec: 66,
      prompt: PROMPT,
      seed: 1234,
      consentId: null,
      provider: ENGINE_INFO,
    });
    expect(await balanceOf(t, alice)).toBe(before - CREDIT_COSTS.generatedAvatar);
    expect(
      (await ledgerOf(t, alice)).find((entry) => entry.reason === 'generated_avatar'),
    ).toMatchObject({ delta: -8, refType: 'avatar', refId: res.body.id });
    expect(t.queues.jobs('photoAvatar')).toEqual([
      { avatarId: res.body.id, workspaceId: alice.workspace.id },
    ]);
    const [row] = await avatarRows(alice);
    expect(row).toMatchObject({ origin: 'generated', sourceAssetId: null, consentId: null });
  });

  it('picks a random seed when none is given', async () => {
    const alice = await t.signUp({ credits: 100, plan: 'creator' });
    const seeds = new Set<number>();
    for (let i = 0; i < 3; i += 1) {
      const res = await t.call(api.photoAvatars.generate, {
        as: alice,
        body: { name: `Persona ${i}`, prompt: PROMPT },
      });
      expect(res.status).toBe(202);
      expect(Number.isInteger(res.body.seed)).toBe(true);
      seeds.add(res.body.seed ?? -1);
    }
    expect(seeds.size).toBe(3);
  });

  it('moderates the prompt with the avatar_prompt rules (real people, minors)', async () => {
    const alice = await t.signUp();
    const before = await balanceOf(t, alice);
    const cases: [string, string][] = [
      ['a woman who looks like Taylor Swift', 'real_person'],
      ['un hombre parecido a Pedro Sánchez con traje', 'real_person'],
      ['niña de 8 años con coletas', 'minor'],
    ];
    for (const [prompt, category] of cases) {
      const res = await t.call(api.photoAvatars.generate, {
        as: alice,
        body: { name: 'Prueba', prompt },
      });
      expect(res.status, prompt).toBe(422);
      expect(res.error.code).toBe('CONTENT_BLOCKED');
      const details = res.error.details as { field: string; flags: { category: string }[] };
      expect(details.field).toBe('prompt');
      expect(details.flags.map((flag) => flag.category)).toContain(category);
      // The reason never echoes the prompt.
      expect(JSON.stringify(res.error)).not.toContain('Taylor');
    }
    const badName = await t.call(api.photoAvatars.generate, {
      as: alice,
      body: { name: 'zzprohibido', prompt: PROMPT },
    });
    expect(badName.error.details).toMatchObject({ field: 'name' });
    expect(
      (await t.call(api.photoAvatars.generate, { as: alice, body: { name: 'x', prompt: 'corto' } }))
        .status,
    ).toBe(400);
    expect(await avatarRows(alice)).toEqual([]);
    expect(await balanceOf(t, alice)).toBe(before);
    expect(t.queues.size).toBe(0);
  });

  it('needs the engine to generate AND prepare; needs credits', async () => {
    const alice = await t.signUp();
    const body = { name: 'Presentadora', prompt: PROMPT };
    engineStatus = () =>
      Promise.resolve({
        ...ENGINE_UP,
        reason: 'Faltan pesos: portrait-generation',
        operations: { generate: false, prepare: true, animate: true },
      });
    const res = await t.call(api.photoAvatars.generate, { as: alice, body });
    expect(res.status).toBe(503);
    expect(res.error).toMatchObject({
      message: 'Faltan pesos: portrait-generation',
      details: { operation: 'generate' },
    });
    expect(await avatarRows(alice)).toEqual([]);

    engineStatus = () => Promise.resolve(ENGINE_UP);
    const poor = await t.signUp({ credits: CREDIT_COSTS.generatedAvatar - 1 });
    const noCredits = await t.call(api.photoAvatars.generate, { as: poor, body });
    expect(noCredits.status).toBe(402);
    expect(await avatarRows(poor)).toEqual([]);
  });
});

describe('PATCH and DELETE /api/photo-avatars/:avatarId, roles and isolation', () => {
  async function photoAvatar(actor: TestActor) {
    const { photo, consentId } = await prepared(actor);
    const res = await t.call(api.photoAvatars.create, {
      as: actor,
      body: { name: 'Ana', imageAssetId: photo.id, consentId },
    });
    expect(res.status).toBe(202);
    return { avatarId: res.body.id, photo };
  }

  it('requires authentication and the editor role on every route', async () => {
    const owner = await t.signUp();
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const { photo, consentId } = await prepared(owner);
    const createBody = { name: 'Ana', imageAssetId: photo.id, consentId };
    const generateBody = { name: 'Ana', prompt: PROMPT };
    const params = { avatarId: newId('avatar') };

    expect((await t.call(api.photoAvatars.create, { body: createBody })).status).toBe(401);
    expect((await t.call(api.photoAvatars.generate, { body: generateBody })).status).toBe(401);
    expect((await t.call(api.photoAvatars.update, { params, body: {} })).status).toBe(401);
    expect((await t.call(api.photoAvatars.remove, { params })).status).toBe(401);
    expect((await t.call(api.photoAvatars.create, { as: viewer, body: createBody })).status).toBe(
      403,
    );
    expect(
      (await t.call(api.photoAvatars.generate, { as: viewer, body: generateBody })).status,
    ).toBe(403);
    expect((await t.call(api.photoAvatars.update, { as: viewer, params, body: {} })).status).toBe(
      403,
    );
    expect((await t.call(api.photoAvatars.remove, { as: viewer, params })).status).toBe(403);
    expect(t.queues.size).toBe(0);
  });

  it('renames, and adjusts landmarks only once the avatar is ready', async () => {
    const alice = await t.signUp();
    const mallory = await t.signUp();
    const { avatarId } = await photoAvatar(alice);
    const params = { avatarId };

    const renamed = await t.call(api.photoAvatars.update, {
      as: alice,
      params,
      body: { name: 'Ana Presentadora' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Ana Presentadora', status: 'processing' });

    const tooSoon = await t.call(api.photoAvatars.update, {
      as: alice,
      params,
      body: { landmarks: LANDMARKS },
    });
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.error.code).toBe('INVALID_STATE');

    // What the worker job leaves behind when it finishes.
    const key = (file: 'image.png' | 'mask.png' | 'cutout.png' | 'thumb.jpg') =>
      storageKeys.avatarFile(alice.workspace.id, avatarId, file);
    for (const file of ['image.png', 'mask.png', 'cutout.png', 'thumb.jpg'] as const) {
      await t.app.providers.storage.put(key(file), Buffer.from(file), { contentType: 'image/png' });
    }
    await t.db
      .update(avatars)
      .set({
        status: 'ready',
        progress: 100,
        imageKey: key('image.png'),
        maskKey: key('mask.png'),
        cutoutKey: key('cutout.png'),
        thumbnailKey: key('thumb.jpg'),
        rig: {
          imageWidth: 752,
          imageHeight: 752,
          landmarksSource: 'detected',
          landmarks: { ...LANDMARKS, chin: { x: 0.5, y: 0.8 } },
        },
      })
      .where(eq(avatars.id, avatarId));

    const adjusted = await t.call(api.photoAvatars.update, {
      as: alice,
      params,
      body: { landmarks: LANDMARKS },
    });
    expect(adjusted.status).toBe(200);
    expect(adjusted.body).toMatchObject({
      status: 'ready',
      progress: 100,
      rig: { imageWidth: 752, imageHeight: 752, landmarksSource: 'user', landmarks: LANDMARKS },
    });
    expect(adjusted.body.cutoutUrl).toContain(
      `/api/files/ws/${alice.workspace.id}/avatars/${avatarId}/cutout.png`,
    );
    const cutout = new URL(adjusted.body.cutoutUrl ?? '');
    expect(
      (await t.inject({ method: 'GET', url: cutout.pathname + cutout.search })).statusCode,
    ).toBe(200);

    expect(
      (await t.call(api.photoAvatars.update, { as: mallory, params, body: { name: 'hacked' } }))
        .status,
    ).toBe(404);
    expect(
      (await t.call(api.photoAvatars.update, { as: alice, params, body: { name: 'zzprohibido' } }))
        .status,
    ).toBe(422);
    expect(
      (
        await t.call(api.photoAvatars.update, {
          as: alice,
          params: { avatarId: 'stock_lucia' },
          body: { name: 'x' },
        })
      ).status,
    ).toBe(400);
    const [row] = await avatarRows(alice);
    expect(row?.name).toBe('Ana Presentadora');
  });

  it('deletes in cascade: row, storage prefix with cached clips, source photo, pending job', async () => {
    const alice = await t.signUp();
    const mallory = await t.signUp();
    const before = await balanceOf(t, alice);
    const { avatarId, photo } = await photoAvatar(alice);
    const params = { avatarId };
    const storage = t.app.providers.storage;
    const image = storageKeys.avatarFile(alice.workspace.id, avatarId, 'image.png');
    const clip = storageKeys.avatarClipCache(
      { workspaceId: alice.workspace.id, avatarId },
      'a'.repeat(64),
      'clip.mp4',
    );
    await storage.put(image, Buffer.from('png'), { contentType: 'image/png' });
    await storage.put(clip, Buffer.from('mp4'), { contentType: 'video/mp4' });

    expect((await t.call(api.photoAvatars.remove, { as: mallory, params })).status).toBe(404);
    expect(await storage.exists(image)).toBe(true);
    expect(await avatarRows(alice)).toHaveLength(1);

    const res = await t.call(api.photoAvatars.remove, { as: alice, params });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await avatarRows(alice)).toEqual([]);
    expect(await storage.exists(image)).toBe(false);
    expect(await storage.exists(clip)).toBe(false);
    expect(await storage.exists(photo.storageKey)).toBe(false);
    expect(await t.db.select().from(assets).where(eq(assets.id, photo.id))).toEqual([]);
    expect(t.queues.jobs('photoAvatar')).toEqual([]);
    // Deleted while still processing: the reservation goes back.
    expect(await balanceOf(t, alice)).toBe(before);
    expect((await t.call(api.photoAvatars.remove, { as: alice, params })).status).toBe(404);

    // A ready avatar keeps its charge when deleted.
    const generated = await t.call(api.photoAvatars.generate, {
      as: alice,
      body: { name: 'Sintética', prompt: PROMPT },
    });
    await t.db.update(avatars).set({ status: 'ready' }).where(eq(avatars.id, generated.body.id));
    expect(
      (
        await t.call(api.photoAvatars.remove, {
          as: alice,
          params: { avatarId: generated.body.id },
        })
      ).status,
    ).toBe(200);
    expect(await balanceOf(t, alice)).toBe(before - CREDIT_COSTS.generatedAvatar);
  });
});
