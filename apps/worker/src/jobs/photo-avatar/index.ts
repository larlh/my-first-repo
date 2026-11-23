import fs from 'node:fs/promises';
import { AppError, PhotoAvatarRigSchema, toStoredError } from '@parlante/shared';
import type { EngineProgress, PhotoAvatarRig, ProviderRef } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { and, assets, avatars, eq } from '@parlante/db';
import type { AvatarRow } from '@parlante/db';
import {
  canvasToPng,
  createNodeCanvas,
  cutoutPng,
  loadNodeImage,
  thumbnailJpeg,
} from '@parlante/renderer/node';
import type { WorkerContext } from '../../context';
import { markAvatarFailed, reportAvatarProgress } from '../../lib/avatar-status';
import { finalFailure } from '../../lib/errors';
import { defineJob } from '../../lib/job';
import type { JobHandle } from '../../lib/job';
import { scale, throttled } from '../../lib/progress';
import { withTempDir } from '../../lib/tmp';
import type { TempDir } from '../../lib/tmp';

/* -------------------------------------------------------------------------------------------
 * Photorealistic workspace avatars (feature 14, §2b). The API validated the request (consent
 * for photos of real people, moderation of the prompt, engine availability), charged the
 * credits (ledger ref `avatar`) and inserted the `avatars` row as `processing`. This job:
 *
 *   origin `photo`      uploaded photo ───────────────────────────┐
 *   origin `generated`  portrait.generate(prompt, seed) → source.png ─┴→ portrait.prepare
 *                                                   (face detection, crop, background matte)
 *   → image.png (prepared portrait) · mask.png (matte) · cutout.png (portrait with the matte
 *     applied: the image of the Canvas stand-in) · thumb.jpg, all under `storageKeys.avatarFile`
 *   → rig { imageWidth, imageHeight, landmarks, landmarksSource } → status `ready`
 *
 * Progress and the MEASURED time remaining are persisted on the row with
 * `reportAvatarProgress` (generating a portrait on CPU takes minutes; the user sees a real
 * bar). A final failure goes through `markAvatarFailed` (stores the error, refunds).
 *
 * Privacy: an avatar deleted while the job runs (delete, or consent revoked) must leave no
 * image of the person behind — the job re-checks the row before and after writing files and
 * removes the whole prefix when the avatar is gone.
 * ----------------------------------------------------------------------------------------- */

interface AvatarRef {
  avatarId: string;
  workspaceId: string;
}

type Job = JobHandle<'photoAvatar'>;

/** Share of the progress bar of each stage, per origin. */
const STAGES = {
  photo: { generate: [0, 0], prepare: [3, 85], files: [85, 99] },
  generated: { generate: [2, 68], prepare: [68, 90], files: [90, 99] },
} as const;

/** Seconds the stages after the current one usually take (shown as part of the ETA). */
const PREPARE_TAIL_SEC = 20;
const FILES_TAIL_SEC = 2;
const THUMB_MAX_SIDE = 256;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const avatarWhere = (ref: AvatarRef) =>
  and(eq(avatars.id, ref.avatarId), eq(avatars.workspaceId, ref.workspaceId));

/** PNG bytes of an image file, re-encoded only when the file is not a PNG already. */
async function pngBytes(filePath: string): Promise<Buffer> {
  const bytes = await fs.readFile(filePath);
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return bytes;
  const image = await loadNodeImage(bytes);
  const { canvas, ctx } = createNodeCanvas(image.width, image.height);
  ctx.drawImage(image.source, 0, 0, image.width, image.height);
  return canvasToPng(canvas);
}

async function stillProcessing(ctx: Pick<WorkerContext, 'db'>, ref: AvatarRef): Promise<boolean> {
  const [row] = await ctx.db
    .select({ status: avatars.status })
    .from(avatars)
    .where(avatarWhere(ref));
  return row?.status === 'processing';
}

/** The avatar disappeared (or reached a terminal state) under the job: stop without retrying. */
function goneError(): AppError {
  return new AppError('NOT_FOUND', 'The avatar was deleted while it was being created');
}

interface Reporter {
  /** `fraction` 0..1 inside `[from, to]` percent; `etaSec` = seconds remaining overall. */
  (range: readonly [number, number], fraction: number, etaSec: number | null): void;
  flush(): Promise<void>;
}

function createReporter(ctx: WorkerContext, job: Job, ref: AvatarRef): Reporter {
  const persist = throttled(
    (percent: number, etaSec: number | null) => reportAvatarProgress(ctx, ref, percent, etaSec),
    1000,
  );
  const report = ((range, fraction, etaSec) => {
    const percent = scale(fraction, range[0], range[1]);
    void persist(percent, etaSec);
    void job
      .progress({
        percent,
        ...(etaSec === null ? {} : { etaSec: Math.max(0, Math.round(etaSec)) }),
      })
      .catch(() => undefined);
  }) as Reporter;
  report.flush = () => persist.flush();
  return report;
}

/** ETA of a stage = what the engine reports for it + the stages still to come. */
function eta(progress: EngineProgress, tailSec: number): number | null {
  return typeof progress.etaSec === 'number' && Number.isFinite(progress.etaSec)
    ? Math.max(0, progress.etaSec) + tailSec
    : null;
}

interface SourceImage {
  path: string;
  /** Provider / model / seed of a generated portrait (null for uploaded photos). */
  generated: { provider: ProviderRef; model: string | null; seed: number | null } | null;
}

/** Origin `photo`: the uploaded picture, copied to the temp dir. */
async function uploadedPhoto(
  ctx: WorkerContext,
  avatar: AvatarRow,
  tmp: TempDir,
): Promise<SourceImage> {
  const [photo] = avatar.sourceAssetId
    ? await ctx.db
        .select()
        .from(assets)
        .where(and(eq(assets.id, avatar.sourceAssetId), eq(assets.workspaceId, avatar.workspaceId)))
    : [];
  if (!photo) throw new AppError('UNPROCESSABLE', 'The photo of this avatar is missing');
  if (photo.kind !== 'image') {
    throw new AppError('UNPROCESSABLE', 'The source of a photo avatar must be an image');
  }
  await ctx.providers.storage.downloadTo(photo.storageKey, tmp.file('source.img'));
  return { path: tmp.file('source.img'), generated: null };
}

/**
 * Origin `generated`: text → portrait of a synthetic person. The raw portrait is stored as
 * `source.png` as soon as it exists, so a retry (after a crash, or a failed preparation) does
 * not spend minutes generating the same picture again.
 */
async function generatedPortrait(
  ctx: WorkerContext,
  job: Job,
  avatar: AvatarRow,
  tmp: TempDir,
  report: Reporter,
): Promise<SourceImage> {
  const { storage, portrait } = ctx.providers;
  const sourceKey = storageKeys.avatarFile(avatar.workspaceId, avatar.id, 'source.png');
  if (await storage.exists(sourceKey)) {
    await storage.downloadTo(sourceKey, tmp.file('source.png'));
    report(STAGES.generated.generate, 1, PREPARE_TAIL_SEC);
    // Provider, model and seed were persisted with the file by the attempt that generated it.
    return { path: tmp.file('source.png'), generated: null };
  }
  if (!avatar.prompt) {
    throw new AppError('UNPROCESSABLE', 'This avatar has no description to generate from');
  }
  const outputDir = tmp.file('generate');
  await fs.mkdir(outputDir, { recursive: true });
  const result = await portrait.generate({
    prompt: avatar.prompt,
    seed: avatar.seed ?? 0,
    gender: avatar.gender,
    outputDir,
    clientRef: `${avatar.id}:generate`,
    onProgress: (p) => report(STAGES.generated.generate, p.fraction, eta(p, PREPARE_TAIL_SEC)),
    signal: job.signal,
  });
  await fs.writeFile(tmp.file('source.png'), await pngBytes(result.imagePath));
  const generated = {
    provider: result.provider,
    model: result.model ?? null,
    seed: result.seed ?? avatar.seed,
  };
  if (!(await stillProcessing(ctx, refOf(avatar)))) throw goneError();
  await storage.put(sourceKey, { filePath: tmp.file('source.png') }, { contentType: 'image/png' });
  await ctx.db
    .update(avatars)
    .set({
      provider: generated.provider,
      model: generated.model,
      seed: generated.seed,
      updatedAt: new Date(),
    })
    .where(and(avatarWhere(refOf(avatar)), eq(avatars.status, 'processing')));
  return { path: tmp.file('source.png'), generated };
}

function refOf(avatar: Pick<AvatarRow, 'id' | 'workspaceId'>): AvatarRef {
  return { avatarId: avatar.id, workspaceId: avatar.workspaceId };
}

export default defineJob({
  queue: 'photoAvatar',
  async handler(ctx, job) {
    const ref = job.payload;
    const [avatar] = await ctx.db.select().from(avatars).where(avatarWhere(ref));
    if (!avatar) throw new AppError('NOT_FOUND', 'Avatar not found');
    // Idempotency: the job may run again after a crash or a duplicate delivery.
    if (avatar.status === 'ready' && avatar.rig) {
      return { avatarId: avatar.id, landmarksSource: avatar.rig.landmarksSource };
    }
    if (avatar.status !== 'processing') {
      throw new AppError('INVALID_STATE', 'This avatar already failed; create it again');
    }

    const { storage, portrait } = ctx.providers;
    const stages = STAGES[avatar.origin];
    const report = createReporter(ctx, job, ref);
    const key = (file: 'image.png' | 'mask.png' | 'cutout.png' | 'thumb.jpg') =>
      storageKeys.avatarFile(ref.workspaceId, ref.avatarId, file);

    try {
      const landmarksSource = await withTempDir(ctx, 'photo-avatar', async (tmp) => {
        /* ---- 1. source image ---- */
        const source =
          avatar.origin === 'generated'
            ? await generatedPortrait(ctx, job, avatar, tmp, report)
            : await uploadedPhoto(ctx, avatar, tmp);

        /* ---- 2. preparation: face detection, crop, matte ---- */
        const outputDir = tmp.file('prepare');
        await fs.mkdir(outputDir, { recursive: true });
        report(stages.prepare, 0, avatar.origin === 'generated' ? PREPARE_TAIL_SEC : null);
        const prepared = await portrait.prepare({
          imagePath: source.path,
          // Landmarks marked by the user on the uploaded photo skip face detection.
          ...(avatar.requestedLandmarks ? { landmarks: avatar.requestedLandmarks } : {}),
          outputDir,
          clientRef: `${avatar.id}:prepare`,
          onProgress: (p) => report(stages.prepare, p.fraction, eta(p, FILES_TAIL_SEC)),
          signal: job.signal,
        });

        /* ---- 3. files: portrait, matte, cut-out, thumbnail ---- */
        report(stages.files, 0, FILES_TAIL_SEC);
        const image = await pngBytes(prepared.portraitPath);
        const mask = prepared.maskPath ? await pngBytes(prepared.maskPath) : null;
        const size = await loadNodeImage(image);
        if (mask) {
          const matte = await loadNodeImage(mask);
          if (matte.width !== size.width || matte.height !== size.height) {
            throw new AppError(
              'PROVIDER_ERROR',
              'The portrait engine returned a matte that does not match the portrait',
              { portrait: [size.width, size.height], matte: [matte.width, matte.height] },
            );
          }
        }
        const rigParse = PhotoAvatarRigSchema.safeParse({
          imageWidth: size.width,
          imageHeight: size.height,
          landmarks: prepared.landmarks,
          landmarksSource: prepared.landmarksSource,
        } satisfies PhotoAvatarRig);
        if (!rigParse.success) {
          throw new AppError('PROVIDER_ERROR', 'The portrait engine returned invalid landmarks');
        }
        const cutout = await cutoutPng(image, mask);
        const thumb = await thumbnailJpeg(image, THUMB_MAX_SIDE);
        report(stages.files, 0.5, 1);

        // Nothing of a person is written for an avatar that no longer exists.
        if (!(await stillProcessing(ctx, ref))) throw goneError();
        await storage.put(key('image.png'), image, { contentType: 'image/png' });
        if (mask) await storage.put(key('mask.png'), mask, { contentType: 'image/png' });
        await storage.put(key('cutout.png'), cutout, { contentType: 'image/png' });
        await storage.put(key('thumb.jpg'), thumb, { contentType: 'image/jpeg' });
        await report.flush();

        /* ---- 4. result on the row (clients poll the REST resource) ---- */
        const [updated] = await ctx.db
          .update(avatars)
          .set({
            status: 'ready',
            progress: 100,
            etaSec: null,
            imageKey: key('image.png'),
            maskKey: mask ? key('mask.png') : null,
            cutoutKey: key('cutout.png'),
            thumbnailKey: key('thumb.jpg'),
            rig: rigParse.data,
            // Honesty rule: generated avatars keep the provider that DREW the person (set
            // when `source.png` was stored); photo avatars the one that prepared the photo.
            ...(avatar.origin === 'photo' ? { provider: prepared.provider } : {}),
            ...(source.generated
              ? { model: source.generated.model, seed: source.generated.seed }
              : {}),
            error: null,
            updatedAt: new Date(),
          })
          .where(and(avatarWhere(ref), eq(avatars.status, 'processing')))
          .returning({ id: avatars.id });
        if (!updated) throw goneError();
        return rigParse.data.landmarksSource;
      });
      await job.progress({ percent: 100 });
      return { avatarId: avatar.id, landmarksSource };
    } catch (err) {
      await report.flush().catch(() => undefined);
      const [current] = await ctx.db
        .select({ status: avatars.status })
        .from(avatars)
        .where(avatarWhere(ref));
      if (!current) {
        // Deleted under the job: remove whatever this run (or an earlier attempt) stored.
        await storage
          .deletePrefix(storageKeys.avatarPrefix(ref.workspaceId, ref.avatarId))
          .catch((cleanupError: unknown) =>
            job.log.warn({ err: cleanupError }, 'could not delete the files of a deleted avatar'),
          );
      } else if (finalFailure(err, job)) {
        await markAvatarFailed(ctx, ref, toStoredError(err));
      }
      throw err;
    }
  },
  // Safety net for a worker that died mid-job (the handler never reached its catch).
  onFinalFailure: async (ctx, payload, error) => {
    await markAvatarFailed(ctx, payload, error);
  },
});
