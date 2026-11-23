import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANS, TranslationOptionsSchema, api, newId } from '@parlante/shared';
import type { Asset } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import {
  assets,
  avatars,
  brandKits,
  consentRecords,
  eq,
  translationJobs,
  users,
  voices,
} from '@parlante/db';
import { listStockAssets } from '@parlante/stock-assets';
import type * as Uploads from '../../lib/uploads';
import { receiveUpload } from '../../lib/uploads';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import assetsModule from './index';
import { ASSET_THUMB_MAX_SIDE, MAX_IMAGE_SIDE } from './media';
import { createMediaFixtures, jpegBytes, pngBytes } from './test-fixtures';
import type { MediaFixtures } from './test-fixtures';

// Observe (without changing) what the route asks of `receiveUpload`, to check the plan limit.
vi.mock('../../lib/uploads', async (importOriginal) => {
  const original = await importOriginal<typeof Uploads>();
  return { ...original, receiveUpload: vi.fn(original.receiveUpload) };
});

let t: TestApp;
let media: MediaFixtures;

beforeAll(async () => {
  t = await createTestApp({ modules: [assetsModule] });
  media = await createMediaFixtures();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

function upload(
  actor: TestActor | undefined,
  file: { filename: string; data: Buffer; contentType?: string },
  fields?: Record<string, string>,
) {
  return t.call(api.assets.upload, {
    ...(actor ? { as: actor } : {}),
    multipart: { ...file, ...(fields ? { fields } : {}) },
  });
}

/** GET a signed file URL of a DTO through the app (no network). */
async function fetchFile(url: string | null) {
  const parsed = new URL(url ?? '');
  return t.inject({ method: 'GET', url: parsed.pathname + parsed.search });
}

/** Insert an asset row without a file (listing / reference tests). */
async function seedAssetRow(
  actor: TestActor,
  values: Partial<typeof assets.$inferInsert> = {},
): Promise<string> {
  const id = newId('asset');
  await t.db.insert(assets).values({
    id,
    workspaceId: actor.workspace.id,
    kind: 'image',
    name: 'seed.png',
    mimeType: 'image/png',
    sizeBytes: 100,
    storageKey: storageKeys.asset(actor.workspace.id, id, 'png'),
    ...values,
  });
  return id;
}

async function seedConsent(actor: TestActor, kind: 'photo_avatar' | 'voice_clone') {
  const id = newId('consent');
  await t.db.insert(consentRecords).values({
    id,
    workspaceId: actor.workspace.id,
    userId: actor.user.id,
    kind,
    subjectName: 'Ana García',
    relationship: 'self',
    statementVersion: '2026-01',
    statement: 'I consent',
    locale: 'es',
    ip: '203.0.113.9',
  });
  return id;
}

describe('uploading assets', () => {
  it('stores a PNG with its real size, a preview and signed URLs', async () => {
    const alice = await t.signUp({ name: 'Alice' });
    const data = pngBytes(640, 360);

    const res = await upload(alice, { filename: 'Logo de marca.png', data });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      workspaceId: alice.workspace.id,
      kind: 'image',
      purpose: 'library',
      name: 'Logo de marca.png',
      mimeType: 'image/png',
      sizeBytes: data.byteLength,
      width: 640,
      height: 360,
      durationMs: null,
      createdBy: { id: alice.user.id, name: 'Alice' },
    });
    // Files live under the asset prefix of the workspace and are only reachable when signed.
    const prefix = `/api/files/ws/${alice.workspace.id}/assets/${res.body.id}/`;
    expect(res.body.url).toContain(`${prefix}original.png?`);
    expect(res.body.thumbnailUrl).toContain(`${prefix}thumb.jpg?`);

    const original = await fetchFile(res.body.url);
    expect(original.statusCode).toBe(200);
    expect(original.headers['content-type']).toBe('image/png');
    expect(original.rawPayload.equals(data)).toBe(true);
    const thumb = await fetchFile(res.body.thumbnailUrl);
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/jpeg');
    expect(thumb.rawPayload.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    const unsigned = await t.inject({ method: 'GET', url: `${prefix}original.png` });
    expect(unsigned.statusCode).toBeGreaterThanOrEqual(400);

    // The upload temp file is gone.
    expect(await fs.readdir(path.join(t.storageDir, '_uploads'))).toEqual([]);

    const read = await t.call(api.assets.get, { as: alice, params: { assetId: res.body.id } });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: res.body.id, name: 'Logo de marca.png', width: 640 });
  });

  it('reads video, audio and animated pictures with ffprobe and makes video previews', async () => {
    const alice = await t.signUp();

    const video = await upload(alice, { filename: 'clip.mp4', data: media.mp4 });
    expect(video.status).toBe(201);
    expect(video.body).toMatchObject({
      kind: 'video',
      mimeType: 'video/mp4',
      width: 320,
      height: 240,
    });
    expect(video.body.durationMs).toBeGreaterThan(1100);
    expect(video.body.durationMs).toBeLessThan(1400);
    const poster = await fetchFile(video.body.thumbnailUrl);
    expect(poster.statusCode).toBe(200);
    expect(poster.rawPayload.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    // Served with Range support so the browser can seek in it.
    const parsed = new URL(video.body.url);
    const ranged = await t.inject({
      method: 'GET',
      url: parsed.pathname + parsed.search,
      headers: { range: 'bytes=0-99' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.byteLength).toBe(100);

    const webm = await upload(alice, { filename: 'clip.webm', data: media.webm });
    expect(webm.body).toMatchObject({
      kind: 'video',
      mimeType: 'video/webm',
      width: 160,
      height: 120,
    });
    expect(webm.body.thumbnailUrl).not.toBeNull();

    const wav = await upload(alice, { filename: 'tone.wav', data: media.wav });
    expect(wav.status).toBe(201);
    expect(wav.body).toMatchObject({ kind: 'audio', width: null, height: null });
    expect(wav.body.mimeType).toMatch(/^audio\/(wav|x-wav|vnd\.wave)$/);
    expect(wav.body.durationMs).toBeGreaterThan(700);
    expect(wav.body.durationMs).toBeLessThan(900);
    expect(wav.body.thumbnailUrl).toBeNull();

    const mp3 = await upload(alice, { filename: 'tone.mp3', data: media.mp3 });
    expect(mp3.body).toMatchObject({ kind: 'audio', mimeType: 'audio/mpeg' });
    expect(mp3.body.durationMs).toBeGreaterThan(900);

    // An MP4 that only carries sound is audio, whatever its container says.
    const audioMp4 = await upload(alice, { filename: 'voz.mp4', data: media.audioOnlyMp4 });
    expect(audioMp4.status).toBe(201);
    expect(audioMp4.body).toMatchObject({ kind: 'audio', mimeType: 'audio/mp4', width: null });
    expect(audioMp4.body.thumbnailUrl).toBeNull();

    const gif = await upload(alice, { filename: 'anim.gif', data: media.gif });
    expect(gif.body).toMatchObject({ kind: 'image', mimeType: 'image/gif', width: 48, height: 32 });
    expect(gif.body.thumbnailUrl).not.toBeNull();

    const jpeg = await upload(alice, { filename: 'foto.jpg', data: jpegBytes(1200, 800) });
    expect(jpeg.body).toMatchObject({ kind: 'image', mimeType: 'image/jpeg', width: 1200 });
    // Previews are bounded, never the original.
    const preview = await fetchFile(jpeg.body.thumbnailUrl);
    expect(preview.rawPayload.byteLength).toBeLessThan(jpegBytes(1200, 800).byteLength);
    expect(ASSET_THUMB_MAX_SIDE).toBeLessThan(1200);
  });

  it('takes the name and purpose from the form and keeps non-library uploads out of the library', async () => {
    const alice = await t.signUp();
    const photo = await upload(
      alice,
      { filename: 'IMG_0001.png', data: pngBytes() },
      { name: '  Retrato de Ana  ', purpose: 'avatar_source' },
    );
    expect(photo.status).toBe(201);
    expect(photo.body).toMatchObject({ name: 'Retrato de Ana', purpose: 'avatar_source' });
    const sample = await upload(
      alice,
      { filename: 'voz.wav', data: media.wav },
      { purpose: 'voice_sample' },
    );
    expect(sample.body).toMatchObject({ kind: 'audio', purpose: 'voice_sample' });
    const source = await upload(
      alice,
      { filename: 'v.mp4', data: media.mp4 },
      { purpose: 'translation_source' },
    );
    expect(source.body).toMatchObject({ kind: 'video', purpose: 'translation_source' });
    const library = await upload(alice, { filename: 'fondo.png', data: pngBytes() });

    const listed = await t.call(api.assets.list, { as: alice });
    expect(listed.body.items.map((a) => a.id)).toEqual([library.body.id]);
    const photos = await t.call(api.assets.list, {
      as: alice,
      query: { purpose: 'avatar_source' },
    });
    expect(photos.body.items.map((a) => a.id)).toEqual([photo.body.id]);

    // A purpose needs its kind of file: a picture is not a voice sample, and so on.
    for (const [purpose, file] of [
      ['voice_sample', { filename: 'a.png', data: pngBytes() }],
      ['avatar_source', { filename: 'a.wav', data: media.wav }],
      ['translation_source', { filename: 'a.mp3', data: media.mp3 }],
      ['translation_source', { filename: 'a.mp4', data: media.audioOnlyMp4 }],
    ] as const) {
      const wrong = await upload(alice, file, { purpose });
      expect(wrong.status).toBe(415);
      expect(wrong.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(wrong.error.details).toMatchObject({ purpose });
    }
    expect(await t.db.$count(assets)).toBe(4);
  });

  it('trusts the bytes, not the file name or the declared type', async () => {
    const alice = await t.signUp();
    // A PNG that claims to be a text file is still a PNG…
    const disguised = await upload(alice, {
      filename: 'notas.txt',
      contentType: 'text/plain',
      data: pngBytes(),
    });
    expect(disguised.status).toBe(201);
    expect(disguised.body).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(disguised.body.url).toContain('/original.png?');

    // …and a script, a PDF or an executable that claims to be a picture is rejected.
    const fakes: Buffer[] = [
      Buffer.from('<script>alert(1)</script>'),
      Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'),
      Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    ];
    for (const data of fakes) {
      const res = await upload(alice, { filename: 'foto.png', contentType: 'image/png', data });
      expect(res.status).toBe(415);
      expect(res.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }

    // Right signature, broken content: the file must really decode.
    const png = pngBytes(200, 200);
    const truncatedPng = Buffer.concat([png.subarray(0, 60), Buffer.alloc(300, 7)]);
    const brokenImage = await upload(alice, { filename: 'rota.png', data: truncatedPng });
    expect(brokenImage.status).toBe(415);
    expect(brokenImage.error.details).toMatchObject({ detected: 'image/png' });
    const brokenVideo = await upload(alice, {
      filename: 'roto.mp4',
      data: Buffer.concat([media.mp4.subarray(0, 40), Buffer.alloc(2000, 1)]),
    });
    expect(brokenVideo.status).toBe(415);

    // Nothing of the rejected uploads was kept.
    expect(await t.db.$count(assets)).toBe(1);
  });

  it('refuses pictures beyond the pixel budget before decoding them', async () => {
    const alice = await t.signUp();
    // A valid PNG header announcing 30000 × 30000 px (3.6 GB once decoded).
    const png = pngBytes(8, 8);
    const bomb = Buffer.from(png);
    bomb.writeUInt32BE(30_000, 16);
    bomb.writeUInt32BE(30_000, 20);
    expect(30_000).toBeGreaterThan(MAX_IMAGE_SIDE);
    const res = await upload(alice, { filename: 'enorme.png', data: bomb });
    expect(res.status).toBe(400);
    expect(res.error.code).toBe('VALIDATION_ERROR');
    expect(await t.db.$count(assets)).toBe(0);
  });

  it('validates the form', async () => {
    const alice = await t.signUp();
    const noFile = await t.call(api.assets.upload, { as: alice, body: { name: 'x' } });
    expect(noFile.status).toBe(400);
    const empty = await upload(alice, { filename: 'vacio.png', data: Buffer.alloc(0) });
    expect(empty.status).toBe(400);
    expect(empty.error.code).toBe('VALIDATION_ERROR');
    const wrongField = await t.call(api.assets.upload, {
      as: alice,
      multipart: { field: 'attachment', filename: 'a.png', data: pngBytes() },
    });
    expect(wrongField.status).toBe(400);
    const badPurpose = await upload(
      alice,
      { filename: 'a.png', data: pngBytes() },
      { purpose: 'secret' },
    );
    expect(badPurpose.status).toBe(400);
    expect(badPurpose.error.code).toBe('VALIDATION_ERROR');
    const longName = await upload(
      alice,
      { filename: 'a.png', data: pngBytes() },
      { name: 'n'.repeat(121) },
    );
    expect(longName.status).toBe(400);
    expect(await t.db.$count(assets)).toBe(0);
  });

  it('applies the upload size of the plan and the server cap while streaming', async () => {
    const free = await t.signUp({ plan: 'free' });
    const team = await t.signUp({ plan: 'team' });
    await upload(free, { filename: 'a.png', data: pngBytes() });
    expect(vi.mocked(receiveUpload).mock.lastCall?.[1]).toEqual({
      maxBytes: PLANS.free.limits.maxUploadBytes,
    });
    await upload(team, { filename: 'a.png', data: pngBytes() });
    expect(vi.mocked(receiveUpload).mock.lastCall?.[1]).toEqual({
      maxBytes: PLANS.team.limits.maxUploadBytes,
    });
    expect(PLANS.team.limits.maxUploadBytes).toBeGreaterThan(PLANS.free.limits.maxUploadBytes);

    // The limit really cuts the stream: a server capped at 1 MB refuses a 1.5 MB file.
    const small = await createTestApp({ modules: [assetsModule], env: { MAX_UPLOAD_MB: '1' } });
    try {
      const actor = await small.signUp();
      const big = Buffer.concat([pngBytes(), Buffer.alloc(1_500_000, 1)]);
      const res = await small.call(api.assets.upload, {
        as: actor,
        multipart: { filename: 'grande.png', data: big },
      });
      expect(res.status).toBe(413);
      expect(res.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(res.error.details).toMatchObject({ maxBytes: 1024 * 1024 });
      expect(await small.db.$count(assets, eq(assets.workspaceId, actor.workspace.id))).toBe(0);
    } finally {
      await small.close();
    }
  });

  it('enforces the storage quota of the plan per workspace and leaves no files behind', async () => {
    const alice = await t.signUp({ plan: 'free' });
    const bob = await t.signUp({ plan: 'free' });
    const data = pngBytes(320, 200);
    const max = PLANS.free.limits.maxStorageBytes;
    // Alice already stores all but 50 bytes of her quota.
    await seedAssetRow(alice, { sizeBytes: max - 50 });

    const res = await upload(alice, { filename: 'uno-mas.png', data });
    expect(res.status).toBe(403);
    expect(res.error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(res.error.details).toMatchObject({
      limit: 'maxStorageBytes',
      max,
      value: max - 50 + data.byteLength,
      plan: 'free',
    });
    expect(await t.db.$count(assets, eq(assets.workspaceId, alice.workspace.id))).toBe(1);

    // Exactly filling the quota is allowed; the quota of another workspace is its own.
    await t.db.update(assets).set({ sizeBytes: max - data.byteLength });
    expect((await upload(alice, { filename: 'justo.png', data })).status).toBe(201);
    expect((await upload(alice, { filename: 'ya-no.png', data })).status).toBe(403);
    expect((await upload(bob, { filename: 'mio.png', data })).status).toBe(201);

    // Only the two accepted uploads have files in storage.
    const rows = await t.db.select().from(assets);
    const stored = await Promise.all(
      rows.map((row) => t.app.providers.storage.exists(row.storageKey)),
    );
    expect(stored.filter(Boolean)).toHaveLength(2);
  });

  it('requires a session and the editor role', async () => {
    const owner = await t.signUp();
    const editor = await t.addMember(owner.workspace, 'editor');
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const file = { filename: 'a.png', data: pngBytes() };

    expect((await upload(undefined, file)).status).toBe(401);
    expect((await upload(viewer, file)).status).toBe(403);
    const created = await upload(editor, file);
    expect(created.status).toBe(201);
    expect(created.body.createdBy?.id).toBe(editor.user.id);
    const params = { assetId: created.body.id };

    expect((await t.call(api.assets.list)).status).toBe(401);
    expect((await t.call(api.assets.get, { params })).status).toBe(401);
    // Viewers read, but neither rename nor delete.
    expect((await t.call(api.assets.list, { as: viewer })).body.items).toHaveLength(1);
    expect((await t.call(api.assets.get, { as: viewer, params })).status).toBe(200);
    expect(
      (await t.call(api.assets.update, { as: viewer, params, body: { name: 'x' } })).status,
    ).toBe(403);
    expect((await t.call(api.assets.remove, { as: viewer, params })).status).toBe(403);
    expect(await t.db.$count(assets)).toBe(1);
  });
});

describe('asset library', () => {
  it('lists newest first with filters, search and cursor pagination', async () => {
    const alice = await t.signUp();
    const now = Date.now();
    const seeded: string[] = [];
    const entries: [string, 'image' | 'video' | 'audio'][] = [
      ['Fondo oficina.png', 'image'],
      ['Intro 100%.mp4', 'video'],
      ['Música_alegre.mp3', 'audio'],
      ['fondo playa.jpg', 'image'],
      ['Logo.png', 'image'],
    ];
    for (const [index, [name, kind]] of entries.entries()) {
      seeded.push(
        await seedAssetRow(alice, { name, kind, createdAt: new Date(now - index * 60_000) }),
      );
    }

    const all = await t.call(api.assets.list, { as: alice });
    expect(all.status).toBe(200);
    expect(all.body.items.map((a) => a.id)).toEqual(seeded);
    expect(all.body.nextCursor).toBeNull();

    const images = await t.call(api.assets.list, { as: alice, query: { kind: 'image' } });
    expect(images.body.items.map((a) => a.name)).toEqual([
      'Fondo oficina.png',
      'fondo playa.jpg',
      'Logo.png',
    ]);
    const search = await t.call(api.assets.list, { as: alice, query: { q: 'FONDO' } });
    expect(search.body.items).toHaveLength(2);
    // `%` and `_` are searched literally, not as wildcards.
    const percent = await t.call(api.assets.list, { as: alice, query: { q: '100%' } });
    expect(percent.body.items.map((a) => a.name)).toEqual(['Intro 100%.mp4']);
    const underscore = await t.call(api.assets.list, { as: alice, query: { q: 'a_a' } });
    expect(underscore.body.items.map((a) => a.name)).toEqual(['Música_alegre.mp3']);
    const combined = await t.call(api.assets.list, {
      as: alice,
      query: { q: 'fondo', kind: 'video' },
    });
    expect(combined.body.items).toEqual([]);

    // Pages of two: every asset exactly once, in order.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const res = await t.call(api.assets.list, {
        as: alice,
        query: { limit: 2, ...(cursor ? { cursor } : {}) },
      });
      seen.push(...res.body.items.map((a) => a.id));
      cursor = res.body.nextCursor ?? undefined;
      expect(res.body.items.length).toBe(page < 2 ? 2 : 1);
    }
    expect(seen).toEqual(seeded);
    expect(cursor).toBeUndefined();

    expect((await t.call(api.assets.list, { as: alice, query: { limit: 0 } })).status).toBe(400);
    expect((await t.call(api.assets.list, { as: alice, query: { limit: 101 } })).status).toBe(400);
    expect((await t.call(api.assets.list, { as: alice, query: { cursor: 'zzz' } })).status).toBe(
      400,
    );
    const badKind = await t.call(api.assets.list, {
      as: alice,
      query: { kind: 'document' as Asset['kind'] },
    });
    expect(badKind.status).toBe(400);
  });

  it('renames an asset', async () => {
    const alice = await t.signUp({ name: 'Alice' });
    const created = await upload(alice, { filename: 'a.png', data: pngBytes() });
    const params = { assetId: created.body.id };

    const renamed = await t.call(api.assets.update, {
      as: alice,
      params,
      body: { name: '  Cabecera 2026  ' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      id: created.body.id,
      name: 'Cabecera 2026',
      createdBy: { name: 'Alice' },
    });
    // The file itself is untouched.
    expect((await fetchFile(renamed.body.url)).statusCode).toBe(200);

    for (const name of ['', '   ', 'n'.repeat(121)]) {
      const bad = await t.call(api.assets.update, { as: alice, params, body: { name } });
      expect(bad.status).toBe(400);
    }
    expect((await t.call(api.assets.update, { as: alice, params, body: {} })).status).toBe(400);
    expect(
      (
        await t.call(api.assets.update, {
          as: alice,
          params: { assetId: 'nope' },
          body: { name: 'x' },
        })
      ).status,
    ).toBe(400);
  });

  it('deletes an asset together with every file under its prefix', async () => {
    const alice = await t.signUp();
    const kept = await upload(alice, { filename: 'kept.png', data: pngBytes() });
    const created = await upload(alice, { filename: 'clip.mp4', data: media.mp4 });
    const { storage } = t.app.providers;
    const original = storageKeys.asset(alice.workspace.id, created.body.id, 'mp4');
    const thumb = storageKeys.assetThumb(alice.workspace.id, created.body.id);
    expect(await storage.exists(original)).toBe(true);
    expect(await storage.exists(thumb)).toBe(true);
    // A brand kit that uses it as logo does not block: the reference is simply cleared.
    const kitId = newId('brandKit');
    await t.db.insert(brandKits).values({
      id: kitId,
      workspaceId: alice.workspace.id,
      name: 'Marca',
      logoAssetId: kept.body.id,
      colors: {
        primary: '#000000',
        secondary: '#000000',
        accent: '#000000',
        background: '#000000',
        text: '#ffffff',
      },
      fonts: { heading: 'Poppins', body: 'Inter' },
    });

    const params = { assetId: created.body.id };
    expect((await t.call(api.assets.remove, { as: alice, params })).body).toEqual({ ok: true });
    expect(await storage.exists(original)).toBe(false);
    expect(await storage.exists(thumb)).toBe(false);
    expect((await t.call(api.assets.get, { as: alice, params })).status).toBe(404);
    expect((await t.call(api.assets.remove, { as: alice, params })).status).toBe(404);
    // The old signed link no longer serves anything.
    expect((await fetchFile(created.body.url)).statusCode).toBe(404);

    expect(
      (await t.call(api.assets.remove, { as: alice, params: { assetId: kept.body.id } })).status,
    ).toBe(200);
    const [kit] = await t.db.select().from(brandKits).where(eq(brandKits.id, kitId));
    expect(kit?.logoAssetId).toBeNull();
    expect(await t.db.$count(assets)).toBe(0);
  });

  it('answers 409 while a translation, avatar or cloned voice uses the asset as its source', async () => {
    const alice = await t.signUp();
    const video = await upload(
      alice,
      { filename: 'v.mp4', data: media.mp4 },
      { purpose: 'translation_source' },
    );
    const photo = await upload(
      alice,
      { filename: 'p.png', data: pngBytes() },
      { purpose: 'avatar_source' },
    );
    const sample = await upload(
      alice,
      { filename: 's.wav', data: media.wav },
      { purpose: 'voice_sample' },
    );
    const jobId = newId('translationJob');
    await t.db.insert(translationJobs).values({
      id: jobId,
      workspaceId: alice.workspace.id,
      name: 'Doblaje',
      sourceAssetId: video.body.id,
      sourceLanguage: 'es',
      targetLanguages: ['en'],
      transcriptSource: 'user',
      options: TranslationOptionsSchema.parse({}),
    });
    const avatarId = newId('avatar');
    await t.db.insert(avatars).values({
      id: avatarId,
      workspaceId: alice.workspace.id,
      name: 'Ana',
      origin: 'photo',
      sourceAssetId: photo.body.id,
      consentId: await seedConsent(alice, 'photo_avatar'),
    });
    const voiceId = newId('voice');
    await t.db.insert(voices).values({
      id: voiceId,
      workspaceId: alice.workspace.id,
      name: 'Voz de Ana',
      language: 'es',
      sampleAssetId: sample.body.id,
      consentId: await seedConsent(alice, 'voice_clone'),
    });

    for (const [assetId, usedBy] of [
      [video.body.id, [{ type: 'translationJob', id: jobId }]],
      [photo.body.id, [{ type: 'avatar', id: avatarId }]],
      [sample.body.id, [{ type: 'voice', id: voiceId }]],
    ] as const) {
      const res = await t.call(api.assets.remove, { as: alice, params: { assetId } });
      expect(res.status).toBe(409);
      expect(res.error.code).toBe('CONFLICT');
      expect(res.error.details).toEqual({ usedBy });
    }
    // Nothing was removed: rows and files are intact.
    expect(await t.db.$count(assets)).toBe(3);
    expect((await fetchFile(video.body.url)).statusCode).toBe(200);
    expect((await fetchFile(photo.body.url)).statusCode).toBe(200);

    // Once the translation job is gone, its source can be deleted.
    await t.db.delete(translationJobs).where(eq(translationJobs.id, jobId));
    expect(
      (await t.call(api.assets.remove, { as: alice, params: { assetId: video.body.id } })).status,
    ).toBe(200);
  });

  it('never exposes or mutates the assets of another workspace (404, not 403)', async () => {
    const alice = await t.signUp();
    const mallory = await t.signUp();
    const created = await upload(alice, { filename: 'privado.png', data: pngBytes() });
    const params = { assetId: created.body.id };

    expect((await t.call(api.assets.get, { as: mallory, params })).status).toBe(404);
    expect(
      (await t.call(api.assets.update, { as: mallory, params, body: { name: 'hacked' } })).status,
    ).toBe(404);
    expect((await t.call(api.assets.remove, { as: mallory, params })).status).toBe(404);
    expect((await t.call(api.assets.list, { as: mallory })).body.items).toEqual([]);
    expect(
      (await t.call(api.assets.list, { as: mallory, query: { q: 'privado' } })).body.items,
    ).toEqual([]);

    const still = await t.call(api.assets.get, { as: alice, params });
    expect(still.body.name).toBe('privado.png');
    expect((await fetchFile(still.body.url)).statusCode).toBe(200);
  });
});

describe('stock assets', () => {
  it('lists the built-in backgrounds and music in the language of the user', async () => {
    const alice = await t.signUp();
    const catalogue = listStockAssets();

    const all = await t.call(api.assets.listStock, { as: alice });
    expect(all.status).toBe(200);
    expect(all.body.items.map((a) => a.id)).toEqual(catalogue.map((a) => a.id));
    expect(all.body.items.length).toBeGreaterThanOrEqual(8);
    const first = catalogue[0];
    expect(all.body.items[0]).toMatchObject({
      id: first?.id,
      name: first?.name,
      url: `${t.config.PUBLIC_API_URL}/api/stock-assets/${first?.id}/file`,
    });

    const music = await t.call(api.assets.listStock, { as: alice, query: { kind: 'audio' } });
    expect(music.body.items.length).toBeGreaterThan(0);
    expect(music.body.items.every((a) => a.kind === 'audio' && a.category === 'music')).toBe(true);
    expect(music.body.items.every((a) => (a.durationMs ?? 0) > 0)).toBe(true);
    const backgrounds = await t.call(api.assets.listStock, {
      as: alice,
      query: { category: 'background' },
    });
    expect(backgrounds.body.items.every((a) => a.kind === 'image')).toBe(true);
    expect(backgrounds.body.items.length + music.body.items.length).toBe(catalogue.length);

    // English UI → English names where the catalogue has them.
    await t.db.update(users).set({ locale: 'en' }).where(eq(users.id, alice.user.id));
    const english = await t.call(api.assets.listStock, { as: alice });
    const translated = catalogue.find((a) => a.en?.name && a.en.name !== a.name);
    expect(translated).toBeDefined();
    expect(english.body.items.find((a) => a.id === translated?.id)?.name).toBe(
      translated?.en?.name,
    );

    expect((await t.call(api.assets.listStock)).status).toBe(401);
    expect(
      (await t.call(api.assets.listStock, { as: alice, query: { kind: 'pdf' as 'image' } })).status,
    ).toBe(400);
  });

  it('serves stock files publicly, cacheable and locked down', async () => {
    const catalogue = listStockAssets();
    const background = catalogue.find((a) => a.category === 'background');
    const track = catalogue.find((a) => a.category === 'music');
    if (!background || !track) throw new Error('The stock catalogue is empty');

    const image = await t.call(api.assets.stockFile, { params: { stockId: background.id } });
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe(background.mimeType);
    expect(image.headers['cache-control']).toContain('public');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.raw.rawPayload.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(image.raw.rawPayload.byteLength).toBeGreaterThan(10_000);

    const audio = await t.call(api.assets.stockFile, { params: { stockId: track.id } });
    expect(audio.status).toBe(200);
    expect(audio.headers['content-type']).toBe(track.mimeType);
    expect(Number(audio.headers['content-length'])).toBe(audio.raw.rawPayload.byteLength);

    const unknown = await t.call(api.assets.stockFile, { params: { stockId: 'bg-nope' } });
    expect(unknown.status).toBe(404);
    expect(unknown.error.code).toBe('NOT_FOUND');
    const traversal = await t.inject({ method: 'GET', url: '/api/stock-assets/..%2F..%2Fx/file' });
    expect(traversal.statusCode).toBe(400);
  });
});
