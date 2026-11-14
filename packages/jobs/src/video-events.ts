import { and, batchItems, batchJobs, eq, renderJobs, sql, videos } from '@parlante/db';
import type { AsyncJobStatus } from '@parlante/shared';
import type { Db, VideoRow } from '@parlante/db';
import { WEBHOOK_URL_TTL_SEC } from './file-urls';
import type { FileUrlBuilder } from './file-urls';
import type { QueueClient } from './queue-client';
import { toPublicVideo } from './video';
import { dispatchWebhookEvent } from './webhooks';

export interface VideoFinishedInput {
  db: Db;
  queues: QueueClient;
  fileUrl: FileUrlBuilder;
  workspaceId: string;
  videoId: string;
}

/**
 * Side effects of a video reaching a terminal state (`completed` or `failed`). The render job
 * calls this ONCE after it has persisted the final status on the `videos` row:
 *   1. batch bookkeeping — the batch item and the batch counters/status follow the video
 *   2. webhooks — `video.completed` / `video.failed` to every subscribed endpoint
 * Safe to call again (batch counters are recomputed, not incremented).
 */
export async function notifyVideoFinished(input: VideoFinishedInput): Promise<void> {
  const { db, queues, fileUrl, workspaceId, videoId } = input;
  const [video] = await db
    .select()
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.workspaceId, workspaceId)));
  if (!video || (video.status !== 'completed' && video.status !== 'failed')) return;

  if (video.batchJobId) await syncBatchAfterVideo(db, video);

  await dispatchWebhookEvent({
    db,
    queues,
    workspaceId,
    type: video.status === 'completed' ? 'video.completed' : 'video.failed',
    data: { video: await toPublicVideo(video, fileUrl, { expiresInSec: WEBHOOK_URL_TTL_SEC }) },
  });
}

async function syncBatchAfterVideo(db: Db, video: VideoRow): Promise<void> {
  const batchJobId = video.batchJobId;
  if (!batchJobId) return;
  await db.transaction(async (tx) => {
    await tx
      .update(batchItems)
      .set({
        status: video.status === 'completed' ? 'completed' : 'failed',
        error: video.error,
        updatedAt: new Date(),
      })
      .where(and(eq(batchItems.batchJobId, batchJobId), eq(batchItems.videoId, video.id)));
    await recomputeBatchStatus(tx, video.workspaceId, batchJobId);
  });
}

/**
 * Recompute `completed` / `failed` counters, `credits_charged` and the status of a batch from
 * its items and the render jobs of its videos (a batch is never charged itself: the sum of its
 * renders is its cost). Also used by the batch job (after fan-out) and by "cancel batch".
 */
export async function recomputeBatchStatus(
  db: Pick<Db, 'select' | 'update'>,
  workspaceId: string,
  batchJobId: string,
): Promise<void> {
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${batchItems.status} = 'completed')::int`,
      failed: sql<number>`count(*) filter (where ${batchItems.status} = 'failed')::int`,
      canceled: sql<number>`count(*) filter (where ${batchItems.status} = 'canceled')::int`,
    })
    .from(batchItems)
    .where(and(eq(batchItems.batchJobId, batchJobId), eq(batchItems.workspaceId, workspaceId)));
  if (!counts) return;
  const finished = counts.completed + counts.failed + counts.canceled;
  let status: AsyncJobStatus = 'processing';
  if (counts.total > 0 && finished >= counts.total) {
    if (counts.completed === counts.total) status = 'completed';
    else if (counts.completed > 0) status = 'partial';
    else status = counts.canceled === counts.total ? 'canceled' : 'failed';
  }
  const [credits] = await db
    .select({ total: sql<number>`coalesce(sum(${renderJobs.creditsCharged}), 0)::int` })
    .from(renderJobs)
    .innerJoin(videos, eq(videos.currentRenderJobId, renderJobs.id))
    .where(and(eq(videos.batchJobId, batchJobId), eq(videos.workspaceId, workspaceId)));
  await db
    .update(batchJobs)
    .set({
      completed: counts.completed,
      failed: counts.failed,
      creditsCharged: credits?.total ?? 0,
      status,
      updatedAt: new Date(),
    })
    .where(and(eq(batchJobs.id, batchJobId), eq(batchJobs.workspaceId, workspaceId)));
}
