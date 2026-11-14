import type { Provenance, RenderStage, Resolution, StoredError } from '@parlante/shared';
import { and, eq, refundCredits, renderJobs, settleCredits, videos } from '@parlante/db';
import type { RenderJobRow } from '@parlante/db';
import { notifyVideoFinished } from '@parlante/jobs';
import type { WorkerContext } from '../context';

/* -------------------------------------------------------------------------------------------
 * State machine of a render, kept in step on `render_jobs` AND `videos` (clients poll the
 * video). The render job (owner: worker-render) drives it through these helpers:
 *
 *   loadRenderJob → markRenderStarted → reportRenderProgress* → markRenderCompleted
 *                                                            ↘ markRenderFailed
 *
 * Invariants handled here so the job cannot forget them: credits are settled to the real cost
 * on success and refunded on failure; `video.completed` / `video.failed` webhooks and batch
 * bookkeeping are triggered exactly when the terminal state is written.
 * ----------------------------------------------------------------------------------------- */

interface RenderRef {
  renderJobId: string;
  videoId: string;
  workspaceId: string;
}

const jobWhere = (ref: RenderRef) =>
  and(eq(renderJobs.id, ref.renderJobId), eq(renderJobs.workspaceId, ref.workspaceId));
const videoWhere = (ref: RenderRef) =>
  and(eq(videos.id, ref.videoId), eq(videos.workspaceId, ref.workspaceId));

/** The render job row (with its composition snapshot), or null when it does not exist. */
export async function loadRenderJob(
  ctx: WorkerContext,
  ref: RenderRef,
): Promise<RenderJobRow | null> {
  const [row] = await ctx.db.select().from(renderJobs).where(jobWhere(ref));
  return row && row.videoId === ref.videoId ? row : null;
}

/** True when the user cancelled the render (check between stages and stop quietly). */
export async function isRenderCanceled(ctx: WorkerContext, ref: RenderRef): Promise<boolean> {
  const [row] = await ctx.db
    .select({ status: renderJobs.status })
    .from(renderJobs)
    .where(jobWhere(ref));
  return !row || row.status === 'canceled';
}

export async function markRenderStarted(ctx: WorkerContext, ref: RenderRef): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(renderJobs)
      .set({ status: 'running', stage: 'prepare', progress: 0, startedAt: new Date(), error: null })
      .where(jobWhere(ref));
    await tx
      .update(videos)
      .set({ status: 'rendering', progress: 0, error: null, updatedAt: new Date() })
      .where(and(videoWhere(ref), eq(videos.currentRenderJobId, ref.renderJobId)));
  });
}

/**
 * Persist stage + overall percent (0..100) and, when known, the estimated seconds remaining
 * (required for the slow `avatars` stage: users must see a measured ETA).
 * Throttle calls with `throttled()` from ./progress.
 */
export async function reportRenderProgress(
  ctx: WorkerContext,
  ref: RenderRef,
  stage: RenderStage,
  percent: number,
  etaSec: number | null = null,
): Promise<void> {
  const progress = Math.min(99, Math.max(0, Math.round(percent)));
  await ctx.db
    .update(renderJobs)
    .set({ stage, progress, etaSec: etaSec === null ? null : Math.max(0, Math.round(etaSec)) })
    .where(and(jobWhere(ref), eq(renderJobs.status, 'running')));
  await ctx.db
    .update(videos)
    .set({ progress })
    .where(
      and(
        videoWhere(ref),
        eq(videos.currentRenderJobId, ref.renderJobId),
        eq(videos.status, 'rendering'),
      ),
    );
}

export interface RenderOutput {
  durationMs: number;
  resolution: Resolution;
  videoKey: string;
  thumbnailKey: string;
  srtKey: string;
  vttKey: string;
  providers: Provenance;
  /** Real cost in credits (`creditsForRender(durationMs, resolution)`). */
  actualCredits: number;
}

/**
 * Terminal success: stores outputs on the video (only if this is still its current render),
 * settles credits to the real cost, then fires webhooks / batch bookkeeping.
 */
export async function markRenderCompleted(
  ctx: WorkerContext,
  ref: RenderRef,
  output: RenderOutput,
): Promise<void> {
  const job = await loadRenderJob(ctx, ref);
  if (!job) return;
  const charged = await settleCredits(ctx.db, {
    workspaceId: ref.workspaceId,
    refType: 'renderJob',
    refId: ref.renderJobId,
    actualCost: output.actualCredits,
    description: 'Render cost adjustment',
  });
  const now = new Date();
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(renderJobs)
      .set({
        status: 'completed',
        stage: 'finalize',
        progress: 100,
        etaSec: null,
        finishedAt: now,
        creditsCharged: charged,
        error: null,
      })
      .where(jobWhere(ref));
    await tx
      .update(videos)
      .set({
        status: 'completed',
        progress: 100,
        durationMs: output.durationMs,
        resolution: output.resolution,
        videoKey: output.videoKey,
        thumbnailKey: output.thumbnailKey,
        srtKey: output.srtKey,
        vttKey: output.vttKey,
        providers: output.providers,
        renderedRevision: job.revision,
        renderedAt: now,
        error: null,
        updatedAt: now,
      })
      .where(and(videoWhere(ref), eq(videos.currentRenderJobId, ref.renderJobId)));
  });
  await notifyVideoFinished({ db: ctx.db, queues: ctx.queues, fileUrl: ctx.fileUrl, ...ref });
}

/**
 * Terminal failure: stores the error, refunds the credits reserved for the job, then fires
 * webhooks / batch bookkeeping. Call it only when the failure is final (see `finalFailure`).
 */
export async function markRenderFailed(
  ctx: WorkerContext,
  ref: RenderRef,
  error: StoredError,
): Promise<void> {
  await refundCredits(ctx.db, {
    workspaceId: ref.workspaceId,
    refType: 'renderJob',
    refId: ref.renderJobId,
    description: 'Render failed — credits refunded',
  });
  const now = new Date();
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(renderJobs)
      .set({ status: 'failed', etaSec: null, finishedAt: now, creditsCharged: 0, error })
      .where(jobWhere(ref));
    await tx
      .update(videos)
      .set({ status: 'failed', error, updatedAt: now })
      .where(and(videoWhere(ref), eq(videos.currentRenderJobId, ref.renderJobId)));
  });
  await notifyVideoFinished({ db: ctx.db, queues: ctx.queues, fileUrl: ctx.fileUrl, ...ref });
}
