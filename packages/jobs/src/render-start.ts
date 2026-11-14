import {
  and,
  assets,
  avatars,
  chargeCredits,
  eq,
  inArray,
  isNull,
  notInArray,
  refundCredits,
  renderJobs,
  sql,
  videos,
  workspaces,
} from '@parlante/db';
import {
  AppError,
  PLANS,
  applyVariables,
  collectAvatarIds,
  collectModerationTexts,
  collectVoiceIds,
  creditsForRender,
  estimateCompositionDurationMs,
  isAppError,
  isStockAvatarId,
  isStockPhotorealAvatarId,
  newId,
  resolutionAllowed,
  usesPhotorealAvatars,
} from '@parlante/shared';
import type { Composition, Providers, Resolution, StoredError } from '@parlante/shared';
import type { Db, RenderJobRow, VideoRow } from '@parlante/db';
import { getStockAvatarMeta } from '@parlante/renderer';
import { getStockPhotorealAvatar } from '@parlante/stock-assets';
import { enqueueOrCompensate } from './enqueue';
import type { QueueClient } from './queue-client';
import { resolveVoice } from './voices';

export interface StartRenderDeps {
  db: Db;
  queues: QueueClient;
  providers: Pick<Providers, 'moderation' | 'lipsync' | 'tts'>;
}

export interface StartRenderInput {
  workspaceId: string;
  videoId: string;
  resolution: Resolution;
  /** User who asked for the render; null for API-key requests. */
  createdBy: string | null;
  /**
   * Values for the `{{variables}}` of the composition (public API, batch rows). Missing names
   * fall back to the declared default, then to an empty string. The snapshot that is rendered
   * has them applied; the video's own composition is left untouched.
   */
  variables?: Record<string, string>;
  /** Batch fan-out only: do not apply `maxConcurrentRenders` (see PlanLimits). */
  skipConcurrencyLimit?: boolean;
}

export interface StartedRender {
  video: VideoRow;
  renderJob: RenderJobRow;
}

/**
 * START A RENDER — the one implementation behind `POST /api/videos/:id/render`,
 * `POST /v1/videos` and the batch fan-out job. Never re-implement any step elsewhere.
 *
 *  1. load video + workspace (workspace-scoped; 404 otherwise); reject while a render is active
 *  2. snapshot = composition with variables applied
 *  3. validate what the snapshot references: avatars exist and are ready, voices resolve,
 *     narration audio assets belong to the workspace                     → UNPROCESSABLE
 *  4. plan limits: scenes, resolution, estimated duration, concurrency   → PLAN_LIMIT_EXCEEDED
 *  5. moderation of every text (`collectModerationTexts`)                → CONTENT_BLOCKED
 *  6. photorealistic avatars need the engine's `animate` operation       → SERVICE_UNAVAILABLE
 *  7. in ONE transaction: charge the estimate (ledger ref `renderJob`, ×2 photoreal, ×2 1080p),
 *     insert `render_jobs` (snapshot, revision, watermark of the plan) and move the video to
 *     `queued` pointing at the job                                       → INSUFFICIENT_CREDITS
 *  8. enqueue with BullMQ jobId = renderJobId; if that fails the job is failed and refunded
 *
 * The worker later settles the charge to the real duration (`markRenderCompleted`) or refunds
 * it (`markRenderFailed` / cancel).
 */
export async function startRender(
  deps: StartRenderDeps,
  input: StartRenderInput,
): Promise<StartedRender> {
  const { db, queues, providers } = deps;
  const { workspaceId, videoId, resolution } = input;

  const [video] = await db
    .select()
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.workspaceId, workspaceId)));
  if (!video) throw AppError.notFound('Video');
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw AppError.notFound('Workspace');
  if (video.status === 'queued' || video.status === 'rendering') {
    throw AppError.invalidState('This video is already being rendered');
  }
  const plan = PLANS[workspace.plan];

  const composition = applyVariables(video.composition, input.variables ?? {});
  const audioDurations = await validateReferences(deps, workspaceId, composition);

  /* ---- plan limits ---- */
  const limit = (name: string, max: number, value: number): never => {
    throw new AppError('PLAN_LIMIT_EXCEEDED', `The ${plan.name} plan limit was reached`, {
      limit: name,
      max,
      value,
      plan: plan.id,
    });
  };
  if (composition.scenes.length > plan.limits.maxScenesPerVideo) {
    limit('maxScenesPerVideo', plan.limits.maxScenesPerVideo, composition.scenes.length);
  }
  if (!resolutionAllowed(plan.id, resolution)) {
    throw new AppError('PLAN_LIMIT_EXCEEDED', `The ${plan.name} plan cannot render ${resolution}`, {
      limit: 'maxResolution',
      max: plan.limits.maxResolution,
      value: resolution,
      plan: plan.id,
    });
  }
  const estimatedMs = estimateCompositionDurationMs(composition, audioDurations);
  if (estimatedMs > plan.limits.maxVideoDurationSec * 1000) {
    limit('maxVideoDurationSec', plan.limits.maxVideoDurationSec, Math.ceil(estimatedMs / 1000));
  }
  if (!input.skipConcurrencyLimit) {
    const [active] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(renderJobs)
      .innerJoin(videos, eq(videos.id, renderJobs.videoId))
      .where(
        and(
          eq(renderJobs.workspaceId, workspaceId),
          inArray(renderJobs.status, ['queued', 'running']),
          isNull(videos.batchJobId),
        ),
      );
    const running = active?.count ?? 0;
    if (running >= plan.limits.maxConcurrentRenders) {
      limit('maxConcurrentRenders', plan.limits.maxConcurrentRenders, running + 1);
    }
  }

  /* ---- moderation (master prompt §5: always before rendering) ---- */
  for (const entry of collectModerationTexts(composition)) {
    const verdict = await providers.moderation.check({
      text: entry.text,
      language: entry.language,
      context: 'script',
    });
    if (!verdict.allowed) {
      throw new AppError('CONTENT_BLOCKED', 'The content of this video was blocked by moderation', {
        sceneId: entry.sceneId,
        layerId: entry.layerId,
        kind: entry.kind,
        flags: verdict.flags,
      });
    }
  }

  /* ---- photorealistic avatars need the neural engine ---- */
  const photoreal = usesPhotorealAvatars(composition);
  if (photoreal) {
    const engine = await providers.lipsync.status().catch((err: unknown) => ({
      available: false,
      reason: err instanceof Error ? err.message : 'Avatar engine status check failed',
      operations: undefined,
    }));
    if (!(engine.operations?.animate ?? engine.available)) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        engine.reason ??
          'Photorealistic avatars cannot be rendered right now: the avatar engine is unavailable',
        { capability: 'lipsync', operation: 'animate' },
      );
    }
  }

  /* ---- charge + snapshot + queue state, atomically ---- */
  const renderJobId = newId('renderJob');
  const cost = creditsForRender(estimatedMs, resolution, { photoreal });
  const started = await db.transaction(async (tx) => {
    await chargeCredits(tx, {
      workspaceId,
      amount: cost,
      reason: 'render',
      refType: 'renderJob',
      refId: renderJobId,
      description: `Render "${video.title}" (${resolution})`,
      createdBy: input.createdBy,
    });
    const [renderJob] = await tx
      .insert(renderJobs)
      .values({
        id: renderJobId,
        workspaceId,
        videoId,
        status: 'queued',
        resolution,
        composition,
        revision: video.revision,
        watermark: plan.limits.watermark,
        creditsCharged: cost,
        createdBy: input.createdBy,
      })
      .returning();
    const [updated] = await tx
      .update(videos)
      .set({
        status: 'queued',
        progress: 0,
        error: null,
        currentRenderJobId: renderJobId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(videos.id, videoId),
          eq(videos.workspaceId, workspaceId),
          // Guards the race of two simultaneous render requests for the same video.
          notInArray(videos.status, ['queued', 'rendering']),
        ),
      )
      .returning();
    if (!renderJob || !updated) {
      throw AppError.invalidState('This video is already being rendered');
    }
    return { video: updated, renderJob };
  });

  const ref = { renderJobId, videoId, workspaceId };
  await enqueueOrCompensate(queues, 'render', ref, { jobId: renderJobId }, async (error) => {
    await failRenderJob(db, ref, error);
  });
  return started;
}

/**
 * Checks every reference of the snapshot and returns the durations of narration audio assets
 * (assetId → ms) needed for the estimate. Problems are UNPROCESSABLE with `details` naming
 * the offending id, so the Studio can point at the scene.
 */
async function validateReferences(
  deps: StartRenderDeps,
  workspaceId: string,
  composition: Composition,
): Promise<Record<string, number>> {
  const { db, providers } = deps;

  const avatarIds = collectAvatarIds(composition);
  const workspaceAvatarIds: string[] = [];
  for (const avatarId of avatarIds) {
    if (isStockAvatarId(avatarId)) {
      if (!getStockAvatarMeta(avatarId)) throw unknownAvatar(avatarId);
    } else if (isStockPhotorealAvatarId(avatarId)) {
      if (!getStockPhotorealAvatar(avatarId)) throw unknownAvatar(avatarId);
    } else {
      workspaceAvatarIds.push(avatarId);
    }
  }
  if (workspaceAvatarIds.length > 0) {
    const rows = await db
      .select({ id: avatars.id, status: avatars.status })
      .from(avatars)
      .where(and(eq(avatars.workspaceId, workspaceId), inArray(avatars.id, workspaceAvatarIds)));
    for (const avatarId of workspaceAvatarIds) {
      const row = rows.find((r) => r.id === avatarId);
      if (!row) throw unknownAvatar(avatarId);
      if (row.status !== 'ready') {
        throw new AppError('UNPROCESSABLE', 'An avatar used by this video is not ready yet', {
          avatarId,
          status: row.status,
        });
      }
    }
  }

  for (const voiceId of collectVoiceIds(composition)) {
    try {
      await resolveVoice(db, providers, workspaceId, voiceId);
    } catch (err) {
      if (isAppError(err) && (err.code === 'NOT_FOUND' || err.code === 'INVALID_STATE')) {
        throw new AppError('UNPROCESSABLE', 'A voice used by this video is not available', {
          voiceId,
          reason: err.message,
        });
      }
      throw err;
    }
  }

  const audioAssetIds = [
    ...new Set(
      composition.scenes.flatMap((scene) =>
        scene.script.kind === 'audio' ? [scene.script.assetId] : [],
      ),
    ),
  ];
  const durations: Record<string, number> = {};
  if (audioAssetIds.length > 0) {
    const rows = await db
      .select({ id: assets.id, kind: assets.kind, durationMs: assets.durationMs })
      .from(assets)
      .where(and(eq(assets.workspaceId, workspaceId), inArray(assets.id, audioAssetIds)));
    for (const assetId of audioAssetIds) {
      const row = rows.find((r) => r.id === assetId);
      if (!row || row.kind !== 'audio' || !row.durationMs) {
        throw new AppError(
          'UNPROCESSABLE',
          'The narration audio of a scene is missing or is not an audio file',
          { assetId },
        );
      }
      durations[assetId] = row.durationMs;
    }
  }
  return durations;
}

function unknownAvatar(avatarId: string): AppError {
  return new AppError('UNPROCESSABLE', 'This video uses an avatar that does not exist', {
    avatarId,
  });
}

export interface RenderRef {
  renderJobId: string;
  videoId: string;
  workspaceId: string;
}

/**
 * Terminal failure of a render job: stores the error on job and video and refunds everything
 * still charged for it. Only acts while the job is `queued` or `running` — a job that was
 * cancelled (already refunded by the API), completed or already failed is left alone — and
 * returns whether it changed anything, so callers fire webhooks exactly once.
 */
export async function failRenderJob(db: Db, ref: RenderRef, error: StoredError): Promise<boolean> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [job] = await tx
      .update(renderJobs)
      .set({ status: 'failed', etaSec: null, finishedAt: now, creditsCharged: 0, error })
      .where(
        and(
          eq(renderJobs.id, ref.renderJobId),
          eq(renderJobs.workspaceId, ref.workspaceId),
          inArray(renderJobs.status, ['queued', 'running']),
        ),
      )
      .returning({ id: renderJobs.id });
    if (!job) return false;
    await refundCredits(tx, {
      workspaceId: ref.workspaceId,
      refType: 'renderJob',
      refId: ref.renderJobId,
      description: 'Render failed — credits refunded',
    });
    await tx
      .update(videos)
      .set({ status: 'failed', error, updatedAt: now })
      .where(
        and(
          eq(videos.id, ref.videoId),
          eq(videos.workspaceId, ref.workspaceId),
          eq(videos.currentRenderJobId, ref.renderJobId),
        ),
      );
    return true;
  });
}
