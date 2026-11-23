import { AppError, cloneCompositionWithNewIds, newId, toStoredError } from '@parlante/shared';
import type { StoredError, VideoStatus } from '@parlante/shared';
import { and, asc, batchItems, batchJobs, eq, inArray, videos } from '@parlante/db';
import type { BatchItemRow, BatchJobRow, Db } from '@parlante/db';
import { recomputeBatchStatus, startRender } from '@parlante/jobs';
import type { WorkerContext } from '../../context';
import { finalFailure, isFinalError } from '../../lib/errors';
import { defineJob } from '../../lib/job';
import type { JobHandle } from '../../lib/job';

/* -------------------------------------------------------------------------------------------
 * Personalised videos in batch (feature 15) — the FAN-OUT job. `POST /api/batches` stored the
 * batch (a snapshot of the source composition WITH its `{{variables}}`) and one `batch_items`
 * row per CSV row, all `pending`, and charged nothing. For every pending row this job:
 *
 *   1. creates a Video (source `batch`, `batch_job_id` set, the composition keeping its
 *      variables) and links it to the row
 *   2. calls `startRender({ variables: row.values, skipConcurrencyLimit: true })` — THE one
 *      implementation that applies the values, validates, moderates, charges (ledger ref
 *      `renderJob`) and queues the render
 *   3. marks the row `queued`. From there the row follows its video (`notifyVideoFinished`).
 *
 * A row that cannot start (credits ran out meanwhile, blocked content, a missing voice…)
 * becomes a `failed` item with that error and the others continue: one bad row never brings
 * the batch down. Counters, credits and status of the batch always come from
 * `recomputeBatchStatus`.
 *
 * Idempotent: only `pending` rows are touched and a row is claimed with a guarded UPDATE, so
 * a retry (or a second delivery) never renders a row twice. Cancelling the batch flips the
 * row status under the job; the loop notices and stops.
 * ----------------------------------------------------------------------------------------- */

interface BatchRef {
  batchJobId: string;
  workspaceId: string;
}

type Job = JobHandle<'batch'>;

const ACTIVE = ['queued', 'processing'] as const;

const batchWhere = (ref: BatchRef) =>
  and(eq(batchJobs.id, ref.batchJobId), eq(batchJobs.workspaceId, ref.workspaceId));

const itemWhere = (ref: BatchRef, itemId: string) =>
  and(
    eq(batchItems.id, itemId),
    eq(batchItems.batchJobId, ref.batchJobId),
    eq(batchItems.workspaceId, ref.workspaceId),
  );

/** Title of the video of a row: `<batch name> — 007` (zero-padded so they sort). */
export function batchVideoTitle(batch: Pick<BatchJobRow, 'name' | 'total'>, index: number): string {
  const width = Math.max(2, String(batch.total).length);
  return `${batch.name.slice(0, 180)} — ${String(index + 1).padStart(width, '0')}`;
}

async function isActive(db: Db, ref: BatchRef): Promise<boolean> {
  const [row] = await db
    .select({ status: batchJobs.status })
    .from(batchJobs)
    .where(batchWhere(ref));
  return row?.status === 'queued' || row?.status === 'processing';
}

/** Thrown inside the claim transaction to roll it back when the row is no longer `pending`. */
class RowNotPending extends Error {}

/** Row → `failed` with its error, only while it is still `pending`. */
async function failItem(db: Db, ref: BatchRef, itemId: string, error: StoredError): Promise<void> {
  await db
    .update(batchItems)
    .set({ status: 'failed', error, updatedAt: new Date() })
    .where(and(itemWhere(ref, itemId), eq(batchItems.status, 'pending')));
}

/**
 * The video of a row. A fresh row gets a new one; a row that an interrupted attempt already
 * linked keeps its video. Throws `RowNotPending` when the row is no longer `pending`
 * (cancelled, or handled by another run).
 */
async function claimVideo(
  db: Db,
  ref: BatchRef,
  batch: BatchJobRow,
  item: BatchItemRow,
): Promise<{ id: string; status: VideoStatus }> {
  if (item.videoId) {
    const [video] = await db
      .select({ id: videos.id, status: videos.status })
      .from(videos)
      .where(and(eq(videos.id, item.videoId), eq(videos.workspaceId, ref.workspaceId)));
    if (video) return video;
  }
  return db.transaction(async (tx) => {
    const [video] = await tx
      .insert(videos)
      .values({
        id: newId('video'),
        workspaceId: ref.workspaceId,
        title: batchVideoTitle(batch, item.index),
        // The document keeps its {{variables}}; `startRender` applies this row's values to
        // the snapshot it renders.
        composition: cloneCompositionWithNewIds(batch.composition),
        aspect: batch.composition.canvas.aspect,
        status: 'draft',
        source: 'batch',
        batchJobId: batch.id,
        createdBy: batch.createdBy,
      })
      .returning({ id: videos.id, status: videos.status });
    if (!video) throw new Error('Insert returned no row');
    const [claimed] = await tx
      .update(batchItems)
      .set({ videoId: video.id, updatedAt: new Date() })
      .where(and(itemWhere(ref, item.id), eq(batchItems.status, 'pending')))
      .returning({ id: batchItems.id });
    // Not ours any more (cancelled, or taken by another run): throwing undoes the insert.
    if (!claimed) throw new RowNotPending();
    return video;
  });
}

/** A video that never started rendering is not left in the library of a failed row. */
async function discardDraft(db: Db, ref: BatchRef, videoId: string): Promise<void> {
  await db
    .delete(videos)
    .where(
      and(
        eq(videos.id, videoId),
        eq(videos.workspaceId, ref.workspaceId),
        eq(videos.batchJobId, ref.batchJobId),
        eq(videos.status, 'draft'),
      ),
    );
}

type Outcome = 'queued' | 'failed' | 'skipped';

async function fanOutItem(
  ctx: WorkerContext,
  job: Job,
  batch: BatchJobRow,
  item: BatchItemRow,
): Promise<Outcome> {
  const { db } = ctx;
  const ref = job.payload;
  let video: { id: string; status: VideoStatus };
  try {
    video = await claimVideo(db, ref, batch, item);
  } catch (err) {
    if (err instanceof RowNotPending) return 'skipped';
    throw err;
  }

  // An interrupted attempt already started (or even finished) this render.
  if (video.status !== 'draft' && video.status !== 'failed') {
    const status =
      video.status === 'completed'
        ? 'completed'
        : video.status === 'rendering'
          ? 'rendering'
          : 'queued';
    await db
      .update(batchItems)
      .set({ status, updatedAt: new Date() })
      .where(and(itemWhere(ref, item.id), eq(batchItems.status, 'pending')));
    return 'skipped';
  }

  try {
    await startRender(
      { db, queues: ctx.queues, providers: ctx.providers },
      {
        workspaceId: ref.workspaceId,
        videoId: video.id,
        resolution: batch.resolution,
        createdBy: batch.createdBy,
        variables: item.values,
        skipConcurrencyLimit: true,
      },
    );
  } catch (err) {
    // Temporary trouble (database, queue, engine restarting): let the queue retry the batch —
    // rows already queued are skipped next time. On the last attempt the row fails instead.
    if (!isFinalError(err) && !job.isLastAttempt) throw err;
    await failItem(db, ref, item.id, toStoredError(err));
    await discardDraft(db, ref, video.id);
    job.log.info(
      { itemId: item.id, index: item.index, code: toStoredError(err).code },
      'row failed',
    );
    return 'failed';
  }
  // Guarded: the render may already have finished (and `notifyVideoFinished` moved the row),
  // or the batch may have been cancelled, while `startRender` was returning.
  await db
    .update(batchItems)
    .set({ status: 'queued', error: null, updatedAt: new Date() })
    .where(and(itemWhere(ref, item.id), eq(batchItems.status, 'pending')));
  return 'queued';
}

/**
 * The batch itself failed (final error or worker death): rows never fanned out fail with the
 * error; rows already rendering keep going and the status follows them. Idempotent.
 */
async function failRemaining(
  ctx: Pick<WorkerContext, 'db'>,
  ref: BatchRef,
  error: StoredError,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [batch] = await tx
      .update(batchJobs)
      .set({ error, updatedAt: new Date() })
      .where(and(batchWhere(ref), inArray(batchJobs.status, ACTIVE)))
      .returning({ id: batchJobs.id });
    if (!batch) return;
    await tx
      .update(batchItems)
      .set({ status: 'failed', error, updatedAt: new Date() })
      .where(
        and(
          eq(batchItems.batchJobId, ref.batchJobId),
          eq(batchItems.workspaceId, ref.workspaceId),
          eq(batchItems.status, 'pending'),
        ),
      );
    await recomputeBatchStatus(tx, ref.workspaceId, ref.batchJobId);
  });
}

export default defineJob({
  queue: 'batch',
  async handler(ctx, job) {
    const ref = job.payload;
    const { db } = ctx;
    const [batch] = await db.select().from(batchJobs).where(batchWhere(ref));
    if (!batch) throw new AppError('NOT_FOUND', 'Batch not found');
    // Cancelled before the job started, or a duplicate delivery of a finished fan-out.
    if (batch.status !== 'queued' && batch.status !== 'processing') {
      return { batchJobId: batch.id, enqueued: 0, skipped: batch.total };
    }

    try {
      await db
        .update(batchJobs)
        .set({ status: 'processing', updatedAt: new Date() })
        .where(and(batchWhere(ref), eq(batchJobs.status, 'queued')));

      const items = await db
        .select()
        .from(batchItems)
        .where(
          and(
            eq(batchItems.batchJobId, ref.batchJobId),
            eq(batchItems.workspaceId, ref.workspaceId),
          ),
        )
        .orderBy(asc(batchItems.index));
      const pending = items.filter((item) => item.status === 'pending');
      let enqueued = 0;
      let handled = items.length - pending.length;
      await job.progress({ enqueued: handled, total: items.length });

      for (const item of pending) {
        if (job.signal.aborted) throw new Error('The worker is shutting down');
        if (!(await isActive(db, ref))) break; // cancelled: the API settles the rest
        const outcome = await fanOutItem(ctx, job, batch, item);
        if (outcome === 'queued') enqueued += 1;
        handled += 1;
        await job.progress({ enqueued: handled, total: items.length });
      }

      // Counters and status from the rows (every row failed ⇒ the batch is `failed` now;
      // otherwise it stays `processing` until its renders end). A cancelled batch is settled
      // by the API.
      if (await isActive(db, ref)) await recomputeBatchStatus(db, ref.workspaceId, ref.batchJobId);
      return { batchJobId: batch.id, enqueued, skipped: items.length - enqueued };
    } catch (err) {
      if (finalFailure(err, job)) await failRemaining(ctx, ref, toStoredError(err));
      throw err;
    }
  },
  // Safety net for a worker that died mid fan-out (the handler never reached its catch).
  onFinalFailure: (ctx, payload, error) => failRemaining(ctx, payload, error),
});
