import { AppError, isAppError, toStoredError } from '@parlante/shared';
import type { QueueResult } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { and, eq, videos } from '@parlante/db';
import type { RenderRef } from '@parlante/jobs';
import type { WorkerContext } from '../../context';
import { finalFailure } from '../../lib/errors';
import { defineJob } from '../../lib/job';
import {
  isRenderCanceled,
  loadRenderJob,
  markRenderCompleted,
  markRenderFailed,
  markRenderStarted,
} from '../../lib/render-status';
import { withTempDir } from '../../lib/tmp';
import { deleteOutputs, outputKeys } from './outputs';
import type { OutputKeys } from './outputs';
import { renderVideo } from './pipeline';
import { RenderCanceledError } from './run';

/* -------------------------------------------------------------------------------------------
 * Queue `render` — turns the composition snapshot of a `render_jobs` row into a finished MP4
 * (owner: worker-render). The pipeline lives in ./pipeline; this file is the job contract:
 *
 *  - rows are loaded by the payload ids AND the workspace
 *  - idempotent: a job that is delivered again starts over (outputs are keyed by the render
 *    job, so they are overwritten); one that already completed just reports its result; one
 *    that was cancelled / failed does nothing
 *  - progress, stage and measured ETA are persisted on the row all along
 *  - cancellation ends quietly with `{ canceled: true, videoId }`
 *  - terminal states are written ONLY through lib/render-status: credits are settled to the
 *    real cost on success and refunded on failure, and `notifyVideoFinished` fires there
 *  - temp files are always removed
 * ----------------------------------------------------------------------------------------- */

type RenderResult = QueueResult<'render'>;

/** Result of a render that had already completed (re-delivered job), or null. */
async function completedResult(ctx: WorkerContext, ref: RenderRef): Promise<RenderResult | null> {
  const [video] = await ctx.db
    .select()
    .from(videos)
    .where(and(eq(videos.id, ref.videoId), eq(videos.workspaceId, ref.workspaceId)));
  if (
    !video ||
    video.currentRenderJobId !== ref.renderJobId ||
    video.status !== 'completed' ||
    !video.videoKey ||
    !video.thumbnailKey ||
    !video.srtKey ||
    !video.vttKey ||
    !video.durationMs ||
    !video.resolution
  ) {
    return null;
  }
  return {
    videoId: video.id,
    durationMs: video.durationMs,
    resolution: video.resolution,
    videoKey: video.videoKey,
    thumbnailKey: video.thumbnailKey,
    srtKey: video.srtKey,
    vttKey: video.vttKey,
    providers: video.providers ?? {},
  };
}

/** Output files of the render this one replaces (deleted once the new ones are live). */
async function previousOutputs(ctx: WorkerContext, ref: RenderRef): Promise<Partial<OutputKeys>> {
  const [video] = await ctx.db
    .select({
      videoKey: videos.videoKey,
      thumbnailKey: videos.thumbnailKey,
      srtKey: videos.srtKey,
      vttKey: videos.vttKey,
    })
    .from(videos)
    .where(and(eq(videos.id, ref.videoId), eq(videos.workspaceId, ref.workspaceId)));
  if (!video) return {};
  // Only files of OTHER render jobs of this video (never a draft poster, never our own).
  const own = new Set(Object.values(outputKeys(ref)));
  const prefix = storageKeys.videoPrefix(ref.workspaceId, ref.videoId);
  const old = (key: string | null) =>
    key && !own.has(key) && key.startsWith(prefix) && key.slice(prefix.length).includes('/')
      ? key
      : undefined;
  return {
    videoKey: old(video.videoKey),
    thumbnailKey: old(video.thumbnailKey),
    srtKey: old(video.srtKey),
    vttKey: old(video.vttKey),
  };
}

/** What is stored on the row and shown to the user: never raw process output or file paths. */
function userFacing(err: unknown, workerStopping: boolean): AppError {
  if (workerStopping) {
    return new AppError(
      'SERVICE_UNAVAILABLE',
      'The worker stopped while rendering this video. Nothing was charged; try again.',
      undefined,
      { cause: err },
    );
  }
  if (isAppError(err)) return err;
  return new AppError(
    'INTERNAL',
    'The video could not be rendered because of an internal error. Nothing was charged.',
    undefined,
    { cause: err },
  );
}

export default defineJob({
  queue: 'render',
  async handler(ctx, job) {
    const ref = job.payload; // { renderJobId, videoId, workspaceId } — already validated
    const canceled = { canceled: true as const, videoId: ref.videoId };

    // 1. The row, always scoped to the workspace. A row that is gone (video deleted while
    //    queued) is treated like a cancellation: there is nothing to render or to charge.
    const row = await loadRenderJob(ctx, ref);
    if (!row) return canceled;
    // 2. Idempotency.
    if (row.status === 'completed') return (await completedResult(ctx, ref)) ?? canceled;
    if (!(await markRenderStarted(ctx, ref))) return canceled;

    try {
      return await withTempDir(ctx, 'render', async (tmp) => {
        const { output, stats } = await renderVideo(ctx, job, row, tmp);
        const replaced = await previousOutputs(ctx, ref);
        // 3. Terminal success: outputs on the video, credits settled to the real cost,
        //    webhooks and batch bookkeeping. False = the user cancelled meanwhile.
        if (!(await markRenderCompleted(ctx, ref, output))) {
          await deleteOutputs(ctx, output);
          return canceled;
        }
        await deleteOutputs(ctx, replaced);
        await job.progress({ stage: 'finalize', percent: 100 });
        job.log.info(
          {
            ...stats,
            totalSec: Number(stats.totalSec.toFixed(2)),
            exportSec: Number(stats.exportSec.toFixed(2)),
            realtime: Number(stats.realtime.toFixed(2)),
            resolution: output.resolution,
          },
          'render completed',
        );
        return { videoId: ref.videoId, ...output };
      });
    } catch (err) {
      // 4. Cancelled: the API already refunded and reset the video — end quietly.
      if (err instanceof RenderCanceledError) return canceled;
      if (await isRenderCanceled(ctx, ref).catch(() => false)) return canceled;
      // 5. Failure: when it is final, store the error and refund BEFORE rethrowing.
      if (!isAppError(err)) job.log.error({ err }, 'render failed');
      const failure = userFacing(err, job.signal.aborted);
      if (finalFailure(failure, job)) await markRenderFailed(ctx, ref, toStoredError(failure));
      throw failure;
    }
  },
  // 6. Safety net for a worker that died mid-render (the handler never reached its catch).
  onFinalFailure: async (ctx, payload, error) => {
    await markRenderFailed(ctx, payload, error);
  },
});
