import { creditsForRender, usesPhotorealAvatars } from '@parlante/shared';
import type { Provenance, RenderStage, Resolution, StoredError } from '@parlante/shared';
import { and, eq, inArray, renderJobs, settleCredits, videos } from '@parlante/db';
import type { RenderJobRow } from '@parlante/db';
import { failRenderJob, notifyVideoFinished } from '@parlante/jobs';
import type { RenderRef } from '@parlante/jobs';
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
 *
 * CANCELLATION. The API's cancel sets the job `canceled`, refunds it and resets the video.
 * The handler checks `isRenderCanceled` between stages; when true it cleans up and RETURNS
 * `{ canceled: true, videoId }` (RenderJobCanceledResultSchema) — no throw, no mark* call.
 * Even if a cancel lands during encode/finalize, both terminal helpers only act on a job that
 * is still `running` (`queued` too for failures): a cancelled job is never flipped to
 * `completed`/`failed`, never charged again and fires no webhook. They return whether they
 * changed anything.
 * ----------------------------------------------------------------------------------------- */

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

/**
 * Move a queued job to `running`. Returns false (and changes nothing) when the job is not
 * `queued` any more — cancelled before the worker picked it up, or already finished: the
 * handler must then return `{ canceled: true, videoId }` without doing any work.
 */
export async function markRenderStarted(ctx: WorkerContext, ref: RenderRef): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [job] = await tx
      .update(renderJobs)
      .set({ status: 'running', stage: 'prepare', progress: 0, startedAt: new Date(), error: null })
      // `running` is accepted so a retried / re-delivered job can start over.
      .where(and(jobWhere(ref), inArray(renderJobs.status, ['queued', 'running'])))
      .returning({ id: renderJobs.id });
    if (!job) return false;
    await tx
      .update(videos)
      .set({ status: 'rendering', progress: 0, error: null, updatedAt: new Date() })
      .where(and(videoWhere(ref), eq(videos.currentRenderJobId, ref.renderJobId)));
    return true;
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
}

/**
 * Real cost of a finished render — the SAME formula `startRender` reserved with, including the
 * photorealistic multiplier (derived from the job's own snapshot, so API and worker cannot
 * disagree about it).
 */
export function actualRenderCredits(
  job: Pick<RenderJobRow, 'composition'>,
  output: Pick<RenderOutput, 'durationMs' | 'resolution'>,
): number {
  return creditsForRender(output.durationMs, output.resolution, {
    photoreal: usesPhotorealAvatars(job.composition),
  });
}

/**
 * Terminal success: stores outputs on the video (only if this is still its current render),
 * settles credits to the real cost (computed here, see `actualRenderCredits`), then fires
 * webhooks / batch bookkeeping. No-op returning false unless the job is still `running`.
 */
export async function markRenderCompleted(
  ctx: WorkerContext,
  ref: RenderRef,
  output: RenderOutput,
): Promise<boolean> {
  const now = new Date();
  const completed = await ctx.db.transaction(async (tx) => {
    // Claim the terminal state first: a concurrent cancel either happened before (no row
    // matches → nothing is settled) or waits for this transaction and then finds `completed`.
    const [job] = await tx
      .update(renderJobs)
      .set({
        status: 'completed',
        stage: 'finalize',
        progress: 100,
        etaSec: null,
        finishedAt: now,
        error: null,
      })
      .where(and(jobWhere(ref), eq(renderJobs.status, 'running')))
      .returning();
    if (!job || job.videoId !== ref.videoId) return false;
    const charged = await settleCredits(tx, {
      workspaceId: ref.workspaceId,
      refType: 'renderJob',
      refId: ref.renderJobId,
      actualCost: actualRenderCredits(job, output),
      description: 'Render cost adjustment',
    });
    await tx.update(renderJobs).set({ creditsCharged: charged }).where(jobWhere(ref));
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
    return true;
  });
  if (completed) {
    await notifyVideoFinished({ db: ctx.db, queues: ctx.queues, fileUrl: ctx.fileUrl, ...ref });
  }
  return completed;
}

/**
 * Terminal failure: stores the error, refunds the credits reserved for the job, then fires
 * webhooks / batch bookkeeping. Call it only when the failure is final (see `finalFailure`);
 * the render job also wires it as its `onFinalFailure`, which covers a worker that died
 * mid-render (stalled job). Idempotent: acts only while the job is `queued` or `running`
 * (`failRenderJob` in @parlante/jobs) and returns whether it changed anything.
 */
export async function markRenderFailed(
  ctx: WorkerContext,
  ref: RenderRef,
  error: StoredError,
): Promise<boolean> {
  const failed = await failRenderJob(ctx.db, ref, error);
  if (failed) {
    await notifyVideoFinished({ db: ctx.db, queues: ctx.queues, fileUrl: ctx.fileUrl, ...ref });
  }
  return failed;
}
