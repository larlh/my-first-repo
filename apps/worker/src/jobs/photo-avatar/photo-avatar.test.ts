import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, CREDIT_COSTS, newId } from '@parlante/shared';
import type {
  EngineStatus,
  PhotoLandmarks,
  PortraitGenerationRequest,
  PortraitPreparationRequest,
  PortraitProvider,
  PreparedPortrait,
  ProviderRef,
} from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import {
  assets,
  avatars,
  chargeCredits,
  consentRecords,
  eq,
  getCreditBalance,
  netCharged,
} from '@parlante/db';
import { seedAccount } from '@parlante/db/testing';
import { canvasToPng, createNodeCanvas, loadNodeImage } from '@parlante/renderer/node';
import { createTestWorker } from '../../testing/index';
import type { TestWorker } from '../../testing/index';
import job from './index';

let t: TestWorker;

beforeAll(async () => {
  t = await createTestWorker();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

const FAKE: ProviderRef = { id: 'fake-engine', name: 'Fake engine', quality: 'basic', local: true };
const LANDMARKS: PhotoLandmarks = {
  leftEye: { x: 0.38, y: 0.4 },
  rightEye: { x: 0.62, y: 0.4 },
  mouthLeft: { x: 0.42, y: 0.66 },
  mouthRight: { x: 0.58, y: 0.66 },
  chin: { x: 0.5, y: 0.84 },
};
const STATUS: EngineStatus = {
  available: true,
  reason: null,
  device: 'cpu',
  secondsPerVideoSecond: 40,
};

/** A picture with a "person" (dark disc) on a light background. */
function picture(width: number, height: number, background = '#9fd3ff'): Buffer {
  const { canvas, ctx } = createNodeCanvas(width, height);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#5b3a29';
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.3, 0, Math.PI * 2);
  ctx.fill();
  return canvasToPng(canvas);
}

/** Greyscale matte: white disc (the person) on black. */
function matte(width: number, height: number): Buffer {
  const { canvas, ctx } = createNodeCanvas(width, height);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.3, 0, Math.PI * 2);
  ctx.fill();
  return canvasToPng(canvas);
}

interface FakeOptions {
  generate?: (request: PortraitGenerationRequest) => Promise<void>;
  prepare?: (request: PortraitPreparationRequest) => Promise<void>;
  /** Return a portrait without matte. */
  noMatte?: boolean;
  matteSize?: [number, number];
}

/** Portrait provider double that writes real image files, like the engine does. */
function fakePortrait(options: FakeOptions = {}) {
  const calls = {
    generate: [] as PortraitGenerationRequest[],
    prepare: [] as PortraitPreparationRequest[],
  };
  const provider: PortraitProvider = {
    info: FAKE,
    status: async () => STATUS,
    async generate(request) {
      calls.generate.push(request);
      request.onProgress?.({ fraction: 0.25, etaSec: 90 });
      await options.generate?.(request);
      const imagePath = path.join(request.outputDir, 'generated.png');
      await fs.writeFile(imagePath, picture(320, 400, '#d8c7a8'));
      request.onProgress?.({ fraction: 1, etaSec: 0 });
      return { imagePath, provider: FAKE, model: 'fake-diffusion-1', seed: request.seed + 1000 };
    },
    async prepare(request): Promise<PreparedPortrait> {
      calls.prepare.push(request);
      // The source must be a readable image.
      await loadNodeImage(await fs.readFile(request.imagePath));
      request.onProgress?.({ fraction: 0.5, etaSec: 12 });
      await options.prepare?.(request);
      const portraitPath = path.join(request.outputDir, 'portrait.png');
      await fs.writeFile(portraitPath, picture(240, 300));
      let maskPath: string | null = null;
      if (!options.noMatte) {
        maskPath = path.join(request.outputDir, 'mask.png');
        const [w, h] = options.matteSize ?? [240, 300];
        await fs.writeFile(maskPath, matte(w, h));
      }
      return {
        portraitPath,
        maskPath,
        width: 240,
        height: 300,
        landmarks: LANDMARKS,
        landmarksSource: request.landmarks ? 'user' : 'detected',
        provider: FAKE,
      };
    },
  };
  t.ctx.providers.portrait = provider;
  return calls;
}

interface SeedOptions {
  origin: 'photo' | 'generated';
  requestedLandmarks?: PhotoLandmarks;
  sourceBytes?: Uint8Array;
  sourceKind?: 'image' | 'audio';
}

/** An avatar exactly as `POST /api/photo-avatars[/generate]` leaves it. */
async function seedAvatar(options: SeedOptions) {
  const account = await seedAccount(t.ctx.db, { credits: 50 });
  const workspaceId = account.workspace.id;
  const avatarId = newId('avatar');
  const cost = options.origin === 'photo' ? CREDIT_COSTS.photoAvatar : CREDIT_COSTS.generatedAvatar;
  let consentId: string | null = null;
  let sourceAssetId: string | null = null;
  if (options.origin === 'photo') {
    consentId = newId('consent');
    await t.ctx.db.insert(consentRecords).values({
      id: consentId,
      workspaceId,
      userId: account.user.id,
      kind: 'photo_avatar',
      subjectName: 'Ada Example',
      relationship: 'self',
      statementVersion: 'test',
      statement: 'I consent',
      locale: 'es',
      ip: '203.0.113.9',
    });
    sourceAssetId = newId('asset');
    const bytes = options.sourceBytes ?? picture(640, 480);
    const storageKey = storageKeys.asset(workspaceId, sourceAssetId, 'png');
    await t.ctx.providers.storage.put(storageKey, bytes, { contentType: 'image/png' });
    await t.ctx.db.insert(assets).values({
      id: sourceAssetId,
      workspaceId,
      kind: options.sourceKind ?? 'image',
      purpose: 'avatar_source',
      name: 'me.png',
      mimeType: 'image/png',
      sizeBytes: bytes.length,
      storageKey,
    });
  }
  await t.ctx.db.transaction(async (tx) => {
    await chargeCredits(tx, {
      workspaceId,
      amount: cost,
      reason: options.origin === 'photo' ? 'photo_avatar' : 'generated_avatar',
      refType: 'avatar',
      refId: avatarId,
    });
    await tx.insert(avatars).values({
      id: avatarId,
      workspaceId,
      name: 'Ada',
      gender: 'female',
      status: 'processing',
      progress: 0,
      origin: options.origin,
      prompt: options.origin === 'generated' ? 'a woman in her thirties, grey blazer' : null,
      seed: options.origin === 'generated' ? 41 : null,
      sourceAssetId,
      requestedLandmarks: options.requestedLandmarks ?? null,
      provider: { id: 'local-neural', name: 'Local', quality: 'basic', local: true },
      consentId,
    });
  });
  return { workspaceId, avatarId, cost, payload: { avatarId, workspaceId } };
}

async function avatarRow(avatarId: string) {
  const [row] = await t.ctx.db.select().from(avatars).where(eq(avatars.id, avatarId));
  return row;
}

const charged = async (workspaceId: string, avatarId: string) =>
  (await netCharged(t.ctx.db, workspaceId, { refType: 'avatar', refId: avatarId })) + 0;

const fileKey = (
  seeded: { workspaceId: string; avatarId: string },
  file: 'image.png' | 'mask.png' | 'cutout.png' | 'thumb.jpg' | 'source.png',
) => storageKeys.avatarFile(seeded.workspaceId, seeded.avatarId, file);

async function storedFiles(seeded: { workspaceId: string; avatarId: string }) {
  const { storage } = t.ctx.providers;
  const names = ['image.png', 'mask.png', 'cutout.png', 'thumb.jpg', 'source.png'] as const;
  const present: string[] = [];
  for (const name of names) if (await storage.exists(fileKey(seeded, name))) present.push(name);
  return present;
}

/** RGBA of one pixel of a stored image. */
async function pixel(key: string, x: number, y: number): Promise<number[]> {
  const image = await loadNodeImage(await t.ctx.providers.storage.get(key));
  const { ctx } = createNodeCanvas(image.width, image.height);
  ctx.drawImage(image.source, 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data];
}

describe('photo-avatar job', () => {
  it('prepares an avatar from a photo: portrait, matte, cut-out, thumbnail and rig', async () => {
    const seeded = await seedAvatar({ origin: 'photo' });
    let during: Awaited<ReturnType<typeof avatarRow>>;
    const calls = fakePortrait({
      prepare: async () => {
        // Progress and the measured time remaining are on the ROW while the engine works.
        await new Promise((resolve) => setTimeout(resolve, 60));
        during = await avatarRow(seeded.avatarId);
      },
    });
    const { result, progress } = await t.run(job, seeded.payload);

    expect(result).toEqual({ avatarId: seeded.avatarId, landmarksSource: 'detected' });
    expect(calls.generate).toHaveLength(0);
    expect(calls.prepare).toHaveLength(1);
    expect(calls.prepare[0]?.landmarks).toBeUndefined();
    expect(calls.prepare[0]?.clientRef).toBe(`${seeded.avatarId}:prepare`);
    expect(during?.status).toBe('processing');
    expect(during?.progress).toBeGreaterThan(0);
    expect(during?.progress).toBeLessThan(100);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.percent >= 0 && p.percent <= 100)).toBe(true);

    const row = await avatarRow(seeded.avatarId);
    expect(row).toMatchObject({
      status: 'ready',
      progress: 100,
      etaSec: null,
      error: null,
      imageKey: fileKey(seeded, 'image.png'),
      maskKey: fileKey(seeded, 'mask.png'),
      cutoutKey: fileKey(seeded, 'cutout.png'),
      thumbnailKey: fileKey(seeded, 'thumb.jpg'),
      provider: FAKE,
      rig: { imageWidth: 240, imageHeight: 300, landmarks: LANDMARKS, landmarksSource: 'detected' },
    });
    expect(await storedFiles(seeded)).toEqual(['image.png', 'mask.png', 'cutout.png', 'thumb.jpg']);

    // The cut-out has the matte applied: transparent background, opaque person, same size.
    const cutout = await loadNodeImage(
      await t.ctx.providers.storage.get(fileKey(seeded, 'cutout.png')),
    );
    expect([cutout.width, cutout.height]).toEqual([240, 300]);
    expect((await pixel(fileKey(seeded, 'cutout.png'), 4, 4))[3]).toBe(0);
    expect((await pixel(fileKey(seeded, 'cutout.png'), 120, 150))[3]).toBe(255);
    // The portrait keeps its original background.
    expect((await pixel(fileKey(seeded, 'image.png'), 4, 4))[3]).toBe(255);
    const thumb = await t.ctx.providers.storage.get(fileKey(seeded, 'thumb.jpg'));
    expect(Buffer.from(thumb.subarray(0, 3)).toString('hex')).toBe('ffd8ff');
    const thumbImage = await loadNodeImage(thumb);
    expect(Math.max(thumbImage.width, thumbImage.height)).toBe(256);

    expect(await charged(seeded.workspaceId, seeded.avatarId)).toBe(CREDIT_COSTS.photoAvatar);
  });

  it('passes the landmarks marked by the user and works without a matte', async () => {
    const seeded = await seedAvatar({ origin: 'photo', requestedLandmarks: LANDMARKS });
    const calls = fakePortrait({ noMatte: true });
    const { result } = await t.run(job, seeded.payload);

    expect(result.landmarksSource).toBe('user');
    expect(calls.prepare[0]?.landmarks).toEqual(LANDMARKS);
    const row = await avatarRow(seeded.avatarId);
    expect(row?.maskKey).toBeNull();
    expect(row?.rig?.landmarksSource).toBe('user');
    expect(await storedFiles(seeded)).toEqual(['image.png', 'cutout.png', 'thumb.jpg']);
    // Without a matte the cut-out is the whole portrait.
    expect((await pixel(fileKey(seeded, 'cutout.png'), 4, 4))[3]).toBe(255);
  });

  it('generates a synthetic person from text and then prepares it, persisting the ETA', async () => {
    const seeded = await seedAvatar({ origin: 'generated' });
    let during: Awaited<ReturnType<typeof avatarRow>>;
    const calls = fakePortrait({
      generate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        during = await avatarRow(seeded.avatarId);
      },
    });
    const { result } = await t.run(job, seeded.payload);

    expect(result).toEqual({ avatarId: seeded.avatarId, landmarksSource: 'detected' });
    expect(calls.generate).toHaveLength(1);
    expect(calls.generate[0]).toMatchObject({
      prompt: 'a woman in her thirties, grey blazer',
      seed: 41,
      gender: 'female',
      clientRef: `${seeded.avatarId}:generate`,
    });
    // The engine said 90 s for the portrait; the job adds what preparing it still takes.
    expect(during?.status).toBe('processing');
    expect(during?.progress).toBeGreaterThan(0);
    expect(during?.etaSec).toBeGreaterThan(90);
    // The portrait handed to `prepare` is the generated one.
    expect(calls.prepare).toHaveLength(1);

    const row = await avatarRow(seeded.avatarId);
    expect(row).toMatchObject({
      status: 'ready',
      progress: 100,
      etaSec: null,
      model: 'fake-diffusion-1',
      seed: 1041, // the seed the engine actually kept
      provider: FAKE,
    });
    expect(await storedFiles(seeded)).toEqual([
      'image.png',
      'mask.png',
      'cutout.png',
      'thumb.jpg',
      'source.png',
    ]);
    const source = await loadNodeImage(
      await t.ctx.providers.storage.get(fileKey(seeded, 'source.png')),
    );
    expect([source.width, source.height]).toEqual([320, 400]);
    expect(await charged(seeded.workspaceId, seeded.avatarId)).toBe(CREDIT_COSTS.generatedAvatar);
  });

  it('a retry does not generate the portrait again', async () => {
    const seeded = await seedAvatar({ origin: 'generated' });
    let failPrepare = true;
    const calls = fakePortrait({
      prepare: async () => {
        if (failPrepare) throw new AppError('SERVICE_UNAVAILABLE', 'The engine is restarting');
      },
    });

    // Attempt 1 of 2: generated, then the engine went away. Nothing is decided yet.
    await expect(t.run(job, seeded.payload)).rejects.toThrow('The engine is restarting');
    expect((await avatarRow(seeded.avatarId))?.status).toBe('processing');
    expect(await charged(seeded.workspaceId, seeded.avatarId)).toBe(CREDIT_COSTS.generatedAvatar);
    expect(await storedFiles(seeded)).toEqual(['source.png']);

    failPrepare = false;
    const { result } = await t.run(job, seeded.payload, { attemptsMade: 1 });
    expect(result.landmarksSource).toBe('detected');
    expect(calls.generate).toHaveLength(1); // minutes of CPU not spent twice
    expect(calls.prepare).toHaveLength(2);
    expect(await avatarRow(seeded.avatarId)).toMatchObject({
      status: 'ready',
      model: 'fake-diffusion-1',
      seed: 1041,
    });

    // Idempotent: a ready avatar is returned as is.
    const again = await t.run(job, seeded.payload);
    expect(again.result).toEqual(result);
    expect(calls.prepare).toHaveLength(2);
  });

  it('fails for good and refunds when no face is found', async () => {
    const seeded = await seedAvatar({ origin: 'photo' });
    fakePortrait({
      prepare: async () => {
        throw new AppError('UNPROCESSABLE', 'No single, clearly visible face was found');
      },
    });
    await expect(t.run(job, seeded.payload)).rejects.toThrow(/UNPROCESSABLE/);

    expect(await avatarRow(seeded.avatarId)).toMatchObject({
      status: 'failed',
      etaSec: null,
      imageKey: null,
      error: { code: 'UNPROCESSABLE', message: 'No single, clearly visible face was found' },
    });
    expect(await charged(seeded.workspaceId, seeded.avatarId)).toBe(0);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(50);
    expect(await storedFiles(seeded)).toEqual([]);

    // A failed avatar is not processed (or charged) again.
    await expect(t.run(job, seeded.payload)).rejects.toThrow(/INVALID_STATE/);
  });

  it('fails and refunds when the engine is still down on the last attempt', async () => {
    const seeded = await seedAvatar({ origin: 'generated' });
    fakePortrait({
      generate: async () => {
        throw new AppError('SERVICE_UNAVAILABLE', 'The avatar engine is not running');
      },
    });
    await expect(t.run(job, seeded.payload)).rejects.toThrow('The avatar engine is not running');
    expect((await avatarRow(seeded.avatarId))?.status).toBe('processing');
    await expect(t.run(job, seeded.payload, { attemptsMade: 1 })).rejects.toThrow(
      'The avatar engine is not running',
    );
    expect(await avatarRow(seeded.avatarId)).toMatchObject({
      status: 'failed',
      error: { code: 'SERVICE_UNAVAILABLE', message: 'The avatar engine is not running' },
    });
    expect(await charged(seeded.workspaceId, seeded.avatarId)).toBe(0);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(50);
  });

  it('rejects a source that is not an image and a matte that does not match the portrait', async () => {
    const notImage = await seedAvatar({ origin: 'photo', sourceKind: 'audio' });
    const calls = fakePortrait();
    await expect(t.run(job, notImage.payload)).rejects.toThrow(/UNPROCESSABLE/);
    expect(calls.prepare).toHaveLength(0);
    expect((await avatarRow(notImage.avatarId))?.status).toBe('failed');

    const mismatch = await seedAvatar({ origin: 'photo' });
    fakePortrait({ matteSize: [120, 150] });
    await expect(t.run(job, mismatch.payload, { attemptsMade: 1 })).rejects.toThrow(
      'The portrait engine returned a matte that does not match the portrait',
    );
    expect(await avatarRow(mismatch.avatarId)).toMatchObject({ status: 'failed', imageKey: null });
    expect(await storedFiles(mismatch)).toEqual([]);
  });

  it('leaves no image behind when the avatar is deleted while it is prepared', async () => {
    const seeded = await seedAvatar({ origin: 'generated' });
    fakePortrait({
      prepare: async () => {
        // Deleting the avatar (or revoking a consent) removes the row and its files.
        await t.ctx.db.delete(avatars).where(eq(avatars.id, seeded.avatarId));
      },
    });
    await expect(t.run(job, seeded.payload)).rejects.toThrow(/NOT_FOUND/);
    expect(await avatarRow(seeded.avatarId)).toBeUndefined();
    expect(await storedFiles(seeded)).toEqual([]); // not even the generated source.png
  });

  it('never loads an avatar through another workspace', async () => {
    const seeded = await seedAvatar({ origin: 'photo' });
    const other = await seedAccount(t.ctx.db);
    const calls = fakePortrait();
    await expect(
      t.run(job, { avatarId: seeded.avatarId, workspaceId: other.workspace.id }),
    ).rejects.toThrow(/NOT_FOUND/);
    expect(calls.prepare).toHaveLength(0);
    expect((await avatarRow(seeded.avatarId))?.status).toBe('processing');
    expect(await charged(seeded.workspaceId, seeded.avatarId)).toBe(CREDIT_COSTS.photoAvatar);
  });

  it('onFinalFailure fails and refunds an avatar whose worker died, exactly once', async () => {
    const seeded = await seedAvatar({ origin: 'photo' });
    const error = { code: 'SERVICE_UNAVAILABLE' as const, message: 'The worker stopped' };
    await job.onFinalFailure?.(t.ctx, seeded.payload, error);
    await job.onFinalFailure?.(t.ctx, seeded.payload, error);
    expect(await avatarRow(seeded.avatarId)).toMatchObject({ status: 'failed', error });
    expect(await charged(seeded.workspaceId, seeded.avatarId)).toBe(0);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(50);
  });
});
