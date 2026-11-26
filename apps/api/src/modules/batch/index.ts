import {
  AppError,
  OK,
  PLANS,
  api,
  buildPage,
  collectModerationTexts,
  isAppError,
  newId,
  resolutionAllowed,
} from '@parlante/shared';
import type {
  BatchItem,
  BatchJob,
  BatchJobDetail,
  Resolution,
  StoredError,
} from '@parlante/shared';
import {
  and,
  asc,
  batchItems,
  batchJobs,
  cursorOrder,
  cursorWhere,
  eq,
  getCreditBalance,
  inArray,
  sql,
  users,
  videos,
} from '@parlante/db';
import type { BatchJobRow, Db, VideoRow, WorkspaceRow } from '@parlante/db';
import { enqueueOrCompensate, recomputeBatchStatus, videoDownloadName } from '@parlante/jobs';
import type { FileUrlBuilder, QueueClient } from '@parlante/jobs';
import { defineRoute } from '../../lib/define-route';
import { iso, toUserRef } from '../../lib/dto';
import { assertWithinLimit, planLimits } from '../../lib/limits';
import { assertContentAllowed } from '../../lib/moderation';
import { defineModule } from '../../lib/modules';
import { cancelRender } from '../videos/service';
import { parseBatchCsv } from './csv';
import { narrationAudioDurations, planBatch } from './plan';
import type { BatchPlan } from './plan';

/* -------------------------------------------------------------------------------------------
 * Personalised videos in batch (feature 15): a source video with `{{variables}}` + rows → one
 * video per row.
 *
 *   preview  parse the CSV, match columns to variables, estimate the cost — changes nothing
 *   create   validate rows, plan limits and moderation; CHECK that the balance covers the
 *            estimate WITHOUT charging; insert job + items; queue the fan-out job. Every
 *            video is charged on its own by `startRender` (ledger ref `renderJob`).
 *   get      aggregated state + every item with its video
 *   cancel   rows not rendered yet are cancelled (renders in flight are cancelled and
 *            refunded through the videos service); finished videos are kept
 *   delete   the batch record only; its videos stay in the library
 * ----------------------------------------------------------------------------------------- */

const ACTIVE = ['queued', 'processing'] as const;

function isActive(row: Pick<BatchJobRow, 'status'>): boolean {
  return row.status === 'queued' || row.status === 'processing';
}

interface BatchBundle {
  batch: BatchJobRow;
  creator: { id: string; name: string } | null;
}

function toBatchDto(bundle: BatchBundle, liveProgress: number | undefined): BatchJob {
  const { batch } = bundle;
  return {
    id: batch.id,
    workspaceId: batch.workspaceId,
    name: batch.name,
    sourceVideoId: batch.sourceVideoId,
    resolution: batch.resolution,
    status: batch.status,
    total: batch.total,
    completed: batch.completed,
    failed: batch.failed,
    // Finished rows count 100 and rows being rendered count their video's progress.
    progress: isActive(batch) ? Math.min(100, Math.max(0, Math.round(liveProgress ?? 0))) : 100,
    creditsCharged: batch.creditsCharged,
    error: batch.error,
    createdBy: toUserRef(bundle.creator),
    createdAt: iso(batch.createdAt),
    updatedAt: iso(batch.updatedAt),
  };
}

function batchQuery(db: Db) {
  return db
    .select({ batch: batchJobs, creator: { id: users.id, name: users.name } })
    .from(batchJobs)
    .leftJoin(users, eq(users.id, batchJobs.createdBy));
}

async function findBatch(db: Db, workspaceId: string, batchId: string): Promise<BatchBundle> {
  const [row] = await batchQuery(db).where(
    and(eq(batchJobs.id, batchId), eq(batchJobs.workspaceId, workspaceId)),
  );
  if (!row) throw AppError.notFound('Batch');
  return row;
}

/** Average progress (0..100) of the items of each batch. */
async function liveProgress(
  db: Db,
  workspaceId: string,
  batchIds: string[],
): Promise<Map<string, number>> {
  if (batchIds.length === 0) return new Map();
  const rows = await db
    .select({
      batchJobId: batchItems.batchJobId,
      progress: sql<number>`coalesce(avg(case
        when ${batchItems.status} in ('completed', 'failed', 'canceled') then 100
        else coalesce(${videos.progress}, 0) end), 0)::float`,
    })
    .from(batchItems)
    .leftJoin(
      videos,
      and(eq(videos.id, batchItems.videoId), eq(videos.workspaceId, batchItems.workspaceId)),
    )
    .where(and(eq(batchItems.workspaceId, workspaceId), inArray(batchItems.batchJobId, batchIds)))
    .groupBy(batchItems.batchJobId);
  return new Map(rows.map((row) => [row.batchJobId, Number(row.progress)]));
}

async function batchDto(db: Db, bundle: BatchBundle): Promise<BatchJob> {
  const progress = isActive(bundle.batch)
    ? await liveProgress(db, bundle.batch.workspaceId, [bundle.batch.id])
    : new Map<string, number>();
  return toBatchDto(bundle, progress.get(bundle.batch.id));
}

/** Items of a batch with their videos. The item follows its video while it renders. */
async function loadItems(
  db: Db,
  fileUrl: FileUrlBuilder,
  batch: BatchJobRow,
): Promise<BatchItem[]> {
  const rows = await db
    .select({ item: batchItems, video: videos })
    .from(batchItems)
    .leftJoin(
      videos,
      and(eq(videos.id, batchItems.videoId), eq(videos.workspaceId, batchItems.workspaceId)),
    )
    .where(and(eq(batchItems.batchJobId, batch.id), eq(batchItems.workspaceId, batch.workspaceId)))
    .orderBy(asc(batchItems.index));
  return Promise.all(
    rows.map(async ({ item, video }): Promise<BatchItem> => {
      let status = item.status;
      if (video && (status === 'pending' || status === 'queued' || status === 'rendering')) {
        if (video.status === 'rendering') status = 'rendering';
        else if (video.status === 'queued') status = 'queued';
        else if (video.status === 'completed') status = 'completed';
        else if (video.status === 'failed') status = 'failed';
      }
      const done = status === 'completed' && video?.status === 'completed';
      const key = done ? (video?.videoKey ?? null) : null;
      return {
        id: item.id,
        index: item.index,
        values: item.values,
        status,
        videoId: video ? video.id : null,
        videoUrl: await fileUrl(key),
        downloadUrl: await fileUrl(
          key,
          video ? { downloadName: videoDownloadName(video) } : undefined,
        ),
        thumbnailUrl: await fileUrl(video?.thumbnailKey),
        error: item.error ?? (status === 'failed' ? (video?.error ?? null) : null),
      };
    }),
  );
}

/** Terminal failure before the worker ever saw the batch (nothing was charged). */
async function failBatch(db: Db, workspaceId: string, batchId: string, error: StoredError) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(batchJobs)
      .set({ status: 'failed', error, updatedAt: new Date() })
      .where(
        and(
          eq(batchJobs.id, batchId),
          eq(batchJobs.workspaceId, workspaceId),
          inArray(batchJobs.status, ACTIVE),
        ),
      )
      .returning({ total: batchJobs.total });
    if (!row) return;
    await tx
      .update(batchItems)
      .set({ status: 'failed', error, updatedAt: new Date() })
      .where(
        and(
          eq(batchItems.batchJobId, batchId),
          eq(batchItems.workspaceId, workspaceId),
          eq(batchItems.status, 'pending'),
        ),
      );
    await tx
      .update(batchJobs)
      .set({ failed: row.total })
      .where(and(eq(batchJobs.id, batchId), eq(batchJobs.workspaceId, workspaceId)));
  });
}

/**
 * Stop a batch: rows that were never fanned out become `canceled`; renders already queued or
 * running are cancelled and refunded by the videos service (one implementation of "cancel a
 * render"); finished videos are untouched. The final status comes from the items
 * (`recomputeBatchStatus`): `canceled`, or `partial` / `failed` when some had already ended.
 * Returns false when the batch was not active any more.
 */
async function cancelBatch(
  deps: { db: Db; queues: QueueClient },
  batch: BatchJobRow,
): Promise<boolean> {
  const { db, queues } = deps;
  const scope = and(eq(batchJobs.id, batch.id), eq(batchJobs.workspaceId, batch.workspaceId));
  const flagged = await db.transaction(async (tx) => {
    // `canceled` on the row is what tells a fan-out job in flight to stop.
    const [row] = await tx
      .update(batchJobs)
      .set({ status: 'canceled', updatedAt: new Date() })
      .where(and(scope, inArray(batchJobs.status, ACTIVE)))
      .returning({ id: batchJobs.id });
    if (!row) return false;
    await tx
      .update(batchItems)
      .set({ status: 'canceled', updatedAt: new Date() })
      .where(
        and(
          eq(batchItems.batchJobId, batch.id),
          eq(batchItems.workspaceId, batch.workspaceId),
          eq(batchItems.status, 'pending'),
        ),
      );
    return true;
  });
  if (!flagged) return false;
  await queues.remove('batch', batch.id).catch(() => false);

  // Two passes: the fan-out job may have queued one more render while the first pass ran.
  for (let pass = 0; pass < 2; pass += 1) {
    const rendering: VideoRow[] = await db
      .select()
      .from(videos)
      .where(
        and(
          eq(videos.batchJobId, batch.id),
          eq(videos.workspaceId, batch.workspaceId),
          inArray(videos.status, ['queued', 'rendering']),
        ),
      );
    if (rendering.length === 0) break;
    for (const video of rendering) {
      try {
        await cancelRender({ db, queues }, video);
      } catch (err) {
        // It finished (or was cancelled) a moment ago: nothing left to cancel.
        if (!(isAppError(err) && err.code === 'INVALID_STATE')) throw err;
      }
    }
  }
  // Rows left without a video in flight or finished (a fan-out that stopped half-way).
  await db
    .update(batchItems)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(
      and(
        eq(batchItems.batchJobId, batch.id),
        eq(batchItems.workspaceId, batch.workspaceId),
        inArray(batchItems.status, ['pending', 'queued', 'rendering']),
        sql`not exists (select 1 from ${videos} where ${videos.id} = ${batchItems.videoId}
          and ${videos.status} in ('queued', 'rendering', 'completed', 'failed'))`,
      ),
    );
  await recomputeBatchStatus(db, batch.workspaceId, batch.id);
  return true;
}

/** Plan limits a batch must respect before anything is queued. */
function assertPlanAllows(
  workspace: Pick<WorkspaceRow, 'plan'>,
  plan: BatchPlan,
  scenes: number,
  resolution: Resolution,
): void {
  assertWithinLimit(workspace, 'maxBatchRows', plan.values.length);
  assertWithinLimit(workspace, 'maxScenesPerVideo', scenes);
  if (!resolutionAllowed(workspace.plan, resolution)) {
    throw new AppError(
      'PLAN_LIMIT_EXCEEDED',
      `The ${PLANS[workspace.plan].name} plan cannot render ${resolution}`,
      {
        limit: 'maxResolution',
        max: planLimits(workspace).maxResolution,
        value: resolution,
        plan: workspace.plan,
      },
    );
  }
  const maxMs = planLimits(workspace).maxVideoDurationSec * 1000;
  const tooLong = plan.durationsMs.findIndex((ms) => ms > maxMs);
  if (tooLong >= 0) {
    throw new AppError(
      'PLAN_LIMIT_EXCEEDED',
      `The ${PLANS[workspace.plan].name} plan limit was reached: row ${tooLong + 1} would be too long`,
      {
        limit: 'maxVideoDurationSec',
        max: planLimits(workspace).maxVideoDurationSec,
        value: Math.ceil((plan.durationsMs[tooLong] ?? 0) / 1000),
        plan: workspace.plan,
        row: tooLong + 1,
      },
    );
  }
}

async function findSourceVideo(db: Db, workspaceId: string, videoId: string): Promise<VideoRow> {
  const [video] = await db
    .select()
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.workspaceId, workspaceId)));
  if (!video) throw AppError.notFound('Video');
  return video;
}

export default defineModule({
  name: 'batch',
  register(app) {
    defineRoute(app, api.batches.preview, async ({ auth, body, app: { db } }) => {
      const video = await findSourceVideo(db, auth.workspaceId, body.sourceVideoId);
      const csv = parseBatchCsv(body.csv);
      const plan = planBatch({
        composition: video.composition,
        rows: csv.rows,
        resolution: body.resolution,
        audioDurations: await narrationAudioDurations(db, auth.workspaceId, video.composition),
      });
      return {
        variables: plan.variables,
        columns: csv.columns,
        rows: csv.rows,
        missingColumns: plan.missingColumns,
        unknownColumns: plan.unknownColumns,
        estimatedCredits: plan.estimatedCredits,
        maxRows: planLimits(auth.workspace).maxBatchRows,
      };
    });

    defineRoute(app, api.batches.create, async ({ auth, body, app: instance }) => {
      const { db, providers, queues } = instance;
      const workspaceId = auth.workspaceId;
      const video = await findSourceVideo(db, workspaceId, body.sourceVideoId);
      const rows = body.csv ? parseBatchCsv(body.csv).rows : (body.rows ?? []);
      const composition = video.composition;
      const plan = planBatch({
        composition,
        rows,
        resolution: body.resolution,
        audioDurations: await narrationAudioDurations(db, workspaceId, composition),
      });

      /* ---- the data must fit the video ---- */
      if (plan.variables.length === 0) {
        throw new AppError(
          'UNPROCESSABLE',
          'The source video has no {{variables}}: every row would produce the same video. Add a variable such as {{nombre}} to its script or texts',
          { sourceVideoId: video.id },
        );
      }
      if (plan.missingColumns.length > 0) {
        throw new AppError(
          'UNPROCESSABLE',
          `The data has no column for: ${plan.missingColumns.join(', ')}`,
          { missingColumns: plan.missingColumns, variables: plan.variables },
        );
      }
      const incomplete = plan.blanks.findIndex((blank) => blank.length > 0);
      if (incomplete >= 0) {
        const missing = plan.blanks[incomplete] ?? [];
        throw new AppError(
          'UNPROCESSABLE',
          `Row ${incomplete + 1} has no value for: ${missing.join(', ')}`,
          { row: incomplete + 1, missing },
        );
      }
      assertPlanAllows(auth.workspace, plan, composition.scenes.length, body.resolution);

      /* ---- moderation: the fixed texts once, then what each row adds ---- */
      await assertContentAllowed(providers, { text: body.name, context: 'name', field: 'name' });
      for (const entry of collectModerationTexts(composition)) {
        await assertContentAllowed(
          providers,
          { text: entry.text, context: 'script', language: entry.language },
          { sceneId: entry.sceneId, layerId: entry.layerId, kind: entry.kind },
        );
      }
      for (const [index, values] of plan.values.entries()) {
        await assertContentAllowed(
          providers,
          { text: Object.values(values).join('\n'), context: 'script' },
          { row: index + 1 },
        );
      }

      /* ---- credits: CHECKED here, charged per video by `startRender` ---- */
      const balance = await getCreditBalance(db, workspaceId);
      if (balance < plan.estimatedCredits) {
        throw new AppError(
          'INSUFFICIENT_CREDITS',
          'Not enough credits to render every row of this batch',
          { required: plan.estimatedCredits, available: balance },
        );
      }

      const batchId = newId('batchJob');
      const batch = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(batchJobs)
          .values({
            id: batchId,
            workspaceId,
            name: body.name,
            sourceVideoId: video.id,
            // Snapshot WITH its {{variables}}: later edits of the video do not change the batch.
            composition,
            variables: plan.variables,
            resolution: body.resolution,
            status: 'queued',
            total: plan.values.length,
            createdBy: auth.userId,
          })
          .returning();
        if (!created) throw new Error('Insert returned no row');
        await tx.insert(batchItems).values(
          plan.values.map((values, index) => ({
            id: newId('batchItem'),
            workspaceId,
            batchJobId: batchId,
            index,
            values,
            status: 'pending' as const,
          })),
        );
        return created;
      });

      await enqueueOrCompensate(
        queues,
        'batch',
        { batchJobId: batchId, workspaceId },
        { jobId: batchId },
        (error) => failBatch(db, workspaceId, batchId, error),
      );
      return toBatchDto({ batch, creator: auth.user }, 0);
    });

    defineRoute(app, api.batches.list, async ({ auth, query, app: { db } }) => {
      const rows = await batchQuery(db)
        .where(
          and(
            eq(batchJobs.workspaceId, auth.workspaceId),
            cursorWhere(batchJobs.createdAt, batchJobs.id, query.cursor),
          ),
        )
        .orderBy(...cursorOrder(batchJobs.createdAt, batchJobs.id))
        .limit(query.limit + 1);
      const page = buildPage(
        rows.map((row) => ({ ...row, id: row.batch.id, createdAt: row.batch.createdAt })),
        query.limit,
      );
      const progress = await liveProgress(
        db,
        auth.workspaceId,
        page.items.filter((row) => isActive(row.batch)).map((row) => row.batch.id),
      );
      return {
        items: page.items.map((row) => toBatchDto(row, progress.get(row.batch.id))),
        nextCursor: page.nextCursor,
      };
    });

    defineRoute(app, api.batches.get, async ({ auth, params, app: { db, fileUrl } }) => {
      const bundle = await findBatch(db, auth.workspaceId, params.batchId);
      const detail: BatchJobDetail = {
        ...(await batchDto(db, bundle)),
        variables: bundle.batch.variables,
        items: await loadItems(db, fileUrl, bundle.batch),
      };
      return detail;
    });

    defineRoute(app, api.batches.cancel, async ({ auth, params, app: { db, queues } }) => {
      const bundle = await findBatch(db, auth.workspaceId, params.batchId);
      const canceled = isActive(bundle.batch)
        ? await cancelBatch({ db, queues }, bundle.batch)
        : false;
      if (!canceled) {
        throw new AppError('INVALID_STATE', 'This batch has already finished', {
          status: bundle.batch.status,
        });
      }
      return batchDto(db, await findBatch(db, auth.workspaceId, params.batchId));
    });

    defineRoute(app, api.batches.remove, async ({ auth, params, app: { db, queues } }) => {
      const { batch } = await findBatch(db, auth.workspaceId, params.batchId);
      // A batch still running is stopped first, so no row keeps rendering for a batch that
      // no longer exists. Its videos are kept (`videos.batch_job_id` becomes null).
      if (isActive(batch)) await cancelBatch({ db, queues }, batch);
      await queues.remove('batch', batch.id).catch(() => false);
      await db
        .delete(batchJobs)
        .where(and(eq(batchJobs.id, batch.id), eq(batchJobs.workspaceId, auth.workspaceId)));
      return OK;
    });
  },
});
