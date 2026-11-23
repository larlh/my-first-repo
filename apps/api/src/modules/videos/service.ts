import { isDeepStrictEqual } from 'node:util';
import {
  AppError,
  applyVariables,
  estimateCompositionDurationMs,
  listUsedVariables,
  newId,
  usesPhotorealAvatars,
} from '@parlante/shared';
import type {
  Composition,
  Providers,
  RenderJob,
  UserRef,
  Video,
  VideoSource,
  VideoSummary,
} from '@parlante/shared';
import { sanitizeFilename, storageKeys } from '@parlante/shared/node';
import {
  and,
  assets,
  batchItems,
  desc,
  eq,
  inArray,
  notInArray,
  refundCredits,
  renderJobs,
  users,
  videos,
} from '@parlante/db';
import type { Db, DbOrTx, RenderJobRow, VideoRow } from '@parlante/db';
import { recomputeBatchStatus, videoDownloadName } from '@parlante/jobs';
import type { FileUrlBuilder, QueueClient } from '@parlante/jobs';
import type { FastifyInstance } from 'fastify';
import { iso, isoOrNull, toUserRef } from '../../lib/dto';
import { renderPoster } from '../../lib/poster';

/* -------------------------------------------------------------------------------------------
 * Video rows shared by `/api/videos`, `/api/templates/:id/use` and the public API v1:
 * creation of drafts (with their poster), row → DTO, cancellation and deletion. Starting a
 * render is NOT here: that is `startRender` in @parlante/jobs.
 * ----------------------------------------------------------------------------------------- */

export interface VideoDeps {
  db: Db;
  queues: QueueClient;
  providers: Pick<Providers, 'storage'>;
  fileUrl: FileUrlBuilder;
  /** Called when a draft poster could not be rendered or stored (the request goes on). */
  onPosterError?: (error: unknown, videoId: string) => void;
}

/** Dependencies of the video service, taken from the app (poster failures are only logged). */
export function videoDeps(app: FastifyInstance): VideoDeps {
  return {
    db: app.db,
    queues: app.queues,
    providers: app.providers,
    fileUrl: app.fileUrl,
    onPosterError: (err, videoId) => {
      app.log.warn({ err, videoId }, 'draft poster could not be rendered');
    },
  };
}

const ACTIVE_VIDEO: VideoRow['status'][] = ['queued', 'rendering'];
const ACTIVE_JOB: RenderJobRow['status'][] = ['queued', 'running'];

/** Load a video of THIS workspace or 404 (a foreign id looks exactly like a missing one). */
export async function findVideo(db: DbOrTx, workspaceId: string, videoId: string) {
  const [video] = await db
    .select()
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.workspaceId, workspaceId)));
  if (!video) throw AppError.notFound('Video');
  return video;
}

/* ---------- row → DTO ---------- */

export interface VideoExtras {
  creator: UserRef | null;
  /** Stage and ETA of the render in progress (null when the video is not rendering). */
  renderJob: Pick<RenderJobRow, 'stage' | 'etaSec'> | null;
}

const NO_EXTRAS: VideoExtras = { creator: null, renderJob: null };

/** Creators and in-progress render jobs of a page of videos, in two queries. */
export async function loadVideoExtras(
  db: DbOrTx,
  workspaceId: string,
  rows: readonly VideoRow[],
): Promise<Map<string, VideoExtras>> {
  const userIds = [...new Set(rows.flatMap((row) => (row.createdBy ? [row.createdBy] : [])))];
  const jobIds = rows.flatMap((row) =>
    isRendering(row) && row.currentRenderJobId ? [row.currentRenderJobId] : [],
  );
  const creators =
    userIds.length > 0
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
  const jobs =
    jobIds.length > 0
      ? await db
          .select({ id: renderJobs.id, stage: renderJobs.stage, etaSec: renderJobs.etaSec })
          .from(renderJobs)
          .where(and(eq(renderJobs.workspaceId, workspaceId), inArray(renderJobs.id, jobIds)))
      : [];
  return new Map(
    rows.map((row) => [
      row.id,
      {
        creator: toUserRef(creators.find((user) => user.id === row.createdBy)),
        renderJob: jobs.find((job) => job.id === row.currentRenderJobId) ?? null,
      },
    ]),
  );
}

const isRendering = (row: Pick<VideoRow, 'status'>): boolean =>
  row.status === 'queued' || row.status === 'rendering';

const isDraftPoster = (row: Pick<VideoRow, 'id' | 'workspaceId' | 'thumbnailKey'>): boolean =>
  row.thumbnailKey === storageKeys.videoDraftThumb(row.workspaceId, row.id);

/**
 * A draft poster keeps its storage key while its pixels change, and file URLs are cacheable:
 * the revision goes in the query string of URLs served by this API so browsers fetch the new
 * image. (The signature covers key and expiry only; other storage back ends sign the whole
 * query, so their URLs are left untouched.)
 */
async function thumbnailUrl(fileUrl: FileUrlBuilder, row: VideoRow): Promise<string | null> {
  const url = await fileUrl(row.thumbnailKey);
  if (!url || !isDraftPoster(row) || !url.includes('/api/files/')) return url;
  return `${url}&v=${row.revision}`;
}

export async function toVideoSummaryDto(
  fileUrl: FileUrlBuilder,
  row: VideoRow,
  extras: VideoExtras = NO_EXTRAS,
): Promise<VideoSummary> {
  const rendering = isRendering(row);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    status: row.status,
    progress: Math.min(100, Math.max(0, row.progress)),
    aspect: row.aspect,
    resolution: row.resolution,
    durationMs: row.durationMs,
    thumbnailUrl: await thumbnailUrl(fileUrl, row),
    source: row.source,
    batchJobId: row.batchJobId,
    createdBy: extras.creator,
    error: row.error,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    renderedAt: isoOrNull(row.renderedAt),
    renderStage: rendering ? (extras.renderJob?.stage ?? null) : null,
    renderEtaSec: rendering ? (extras.renderJob?.etaSec ?? null) : null,
    usesPhotorealAvatars: usesPhotorealAvatars(row.composition),
  };
}

/** Durations (assetId → ms) of the narration audio a composition uses, for the estimate. */
async function narrationDurations(
  db: DbOrTx,
  workspaceId: string,
  composition: Composition,
): Promise<Record<string, number>> {
  const ids = [
    ...new Set(
      composition.scenes.flatMap((scene) =>
        scene.script.kind === 'audio' ? [scene.script.assetId] : [],
      ),
    ),
  ];
  if (ids.length === 0) return {};
  const rows = await db
    .select({ id: assets.id, durationMs: assets.durationMs })
    .from(assets)
    .where(and(eq(assets.workspaceId, workspaceId), inArray(assets.id, ids)));
  return Object.fromEntries(rows.map((row) => [row.id, row.durationMs ?? 0]));
}

/** File name of a subtitle download: the sanitised title + extension. */
function subtitleName(row: Pick<VideoRow, 'title'>, ext: 'srt' | 'vtt'): string {
  return `${sanitizeFilename(row.title, 'video')}.${ext}`;
}

/**
 * Detail DTO. The output URLs describe the CURRENT output (`renderedRevision`): they stay
 * available while a newer render is queued, running, cancelled or failed.
 */
export async function toVideoDto(
  deps: Pick<VideoDeps, 'db' | 'fileUrl'>,
  row: VideoRow,
  extras?: VideoExtras,
): Promise<Video> {
  const { db, fileUrl } = deps;
  const resolved =
    extras ?? (await loadVideoExtras(db, row.workspaceId, [row])).get(row.id) ?? NO_EXTRAS;
  const hasOutput = row.videoKey !== null;
  const [summary, durations, videoUrl, downloadUrl, srtUrl, vttUrl] = await Promise.all([
    toVideoSummaryDto(fileUrl, row, resolved),
    narrationDurations(db, row.workspaceId, row.composition),
    fileUrl(row.videoKey),
    fileUrl(row.videoKey, { downloadName: videoDownloadName(row) }),
    fileUrl(hasOutput ? row.srtKey : null, { downloadName: subtitleName(row, 'srt') }),
    fileUrl(hasOutput ? row.vttKey : null, { downloadName: subtitleName(row, 'vtt') }),
  ]);
  return {
    ...summary,
    composition: row.composition,
    revision: row.revision,
    renderedRevision: row.renderedRevision,
    estimatedDurationMs: Math.round(estimateCompositionDurationMs(row.composition, durations)),
    videoUrl,
    downloadUrl,
    srtUrl,
    vttUrl,
    providers: row.providers,
    templateId: row.templateId,
  };
}

export function toRenderJobDto(row: RenderJobRow): RenderJob {
  return {
    id: row.id,
    videoId: row.videoId,
    status: row.status,
    stage: row.stage,
    progress: Math.min(100, Math.max(0, row.progress)),
    etaSec: row.etaSec,
    resolution: row.resolution,
    creditsCharged: row.creditsCharged,
    error: row.error,
    createdAt: iso(row.createdAt),
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
  };
}

/* ---------- draft poster ---------- */

/**
 * The document a poster is drawn from: `{{variables}}` show their example (default) value, as
 * the rendered video will; a variable without one stays visible as its placeholder.
 */
export function posterDocument(composition: Composition): Composition {
  const defaults = new Map(composition.variables.map((v) => [v.name, v.defaultValue]));
  const keep: Record<string, string> = {};
  for (const name of listUsedVariables(composition)) {
    if ((defaults.get(name) ?? '') === '') keep[name] = `{{${name}}}`;
  }
  return applyVariables(composition, keep);
}

/** What the poster shows: the canvas format and the first scene, with example values. */
function posterSource(composition: Composition): unknown {
  return [composition.canvas.aspect, posterDocument(composition).scenes[0] ?? null];
}

/** True when two documents would produce a different poster. */
export function posterChanged(previous: Composition, next: Composition): boolean {
  return !isDeepStrictEqual(posterSource(previous), posterSource(next));
}

/**
 * Render the poster of a draft (first scene, same renderer as the Studio and the export) and
 * store it at `storageKeys.videoDraftThumb`. Returns the key, or null when it could not be
 * produced — a draft without thumbnail is still a valid draft, so this never throws.
 */
async function writeDraftPoster(
  deps: Pick<VideoDeps, 'db' | 'providers' | 'onPosterError'>,
  video: { id: string; workspaceId: string; composition: Composition },
): Promise<string | null> {
  try {
    const poster = await renderPoster(deps, posterDocument(video.composition), {
      workspaceId: video.workspaceId,
    });
    const key = storageKeys.videoDraftThumb(video.workspaceId, video.id);
    await deps.providers.storage.put(key, poster, { contentType: 'image/jpeg' });
    return key;
  } catch (err) {
    deps.onPosterError?.(err, video.id);
    return null;
  }
}

/**
 * Thumbnail key a video should have after its composition changed. Until the first render
 * writes the real thumbnail (`videoKey` set) the poster of the draft is the thumbnail; after
 * that the thumbnail keeps showing the rendered output.
 */
export async function refreshDraftPoster(
  deps: Pick<VideoDeps, 'db' | 'providers' | 'onPosterError'>,
  row: VideoRow,
  nextComposition: Composition,
): Promise<string | null> {
  if (row.videoKey !== null) return row.thumbnailKey;
  if (row.thumbnailKey !== null && !posterChanged(row.composition, nextComposition)) {
    return row.thumbnailKey;
  }
  const key = await writeDraftPoster(deps, { ...row, composition: nextComposition });
  return key ?? row.thumbnailKey;
}

/**
 * Re-render the poster of a draft from the composition its row holds (used after a save lost
 * a race: the poster file may show the losing document).
 */
export async function restoreDraftPoster(
  deps: Pick<VideoDeps, 'db' | 'providers' | 'onPosterError'>,
  row: VideoRow,
): Promise<void> {
  if (row.videoKey === null && isDraftPoster(row)) await writeDraftPoster(deps, row);
}

/* ---------- create ---------- */

export interface CreateDraftInput {
  workspaceId: string;
  /** null for API-key requests. */
  userId: string | null;
  title: string;
  composition: Composition;
  source: VideoSource;
  templateId?: string | null;
}

/** Longest title the contract accepts (`TitleSchema`). */
export const MAX_TITLE_LENGTH = 120;

/** Insert a draft video with its poster. */
export async function createDraftVideo(
  deps: Pick<VideoDeps, 'db' | 'providers' | 'onPosterError'>,
  input: CreateDraftInput,
): Promise<VideoRow> {
  const id = newId('video');
  const thumbnailKey = await writeDraftPoster(deps, {
    id,
    workspaceId: input.workspaceId,
    composition: input.composition,
  });
  try {
    // Millisecond precision (JS clock): keyset cursors compare these values exactly.
    const now = new Date();
    const [row] = await deps.db
      .insert(videos)
      .values({
        id,
        workspaceId: input.workspaceId,
        title: input.title.slice(0, MAX_TITLE_LENGTH),
        status: 'draft',
        composition: input.composition,
        aspect: input.composition.canvas.aspect,
        thumbnailKey,
        source: input.source,
        templateId: input.templateId ?? null,
        createdBy: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  } catch (err) {
    await deps.providers.storage
      .deletePrefix(storageKeys.videoPrefix(input.workspaceId, id))
      .catch(() => {
        // Best effort: the original error is the one worth reporting.
      });
    throw err;
  }
}

/* ---------- cancel & delete ---------- */

/**
 * A batch row whose video stops rendering by hand (cancel / delete) must not stay "rendering"
 * for ever: it becomes `canceled` and the counters of its batch are recomputed.
 */
async function releaseBatchItem(tx: DbOrTx, video: VideoRow): Promise<void> {
  if (!video.batchJobId) return;
  await tx
    .update(batchItems)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(
      and(
        eq(batchItems.workspaceId, video.workspaceId),
        eq(batchItems.batchJobId, video.batchJobId),
        eq(batchItems.videoId, video.id),
        inArray(batchItems.status, ['pending', 'queued', 'rendering']),
      ),
    );
  await recomputeBatchStatus(tx, video.workspaceId, video.batchJobId);
}

/**
 * Cancel the queued / running render of a video: the job becomes `canceled`, everything still
 * charged for it is refunded and the video returns to the state its previous render left it in
 * (`completed`, `failed` or `draft`). The worker notices between stages and stops quietly.
 * INVALID_STATE when nothing is rendering (also when the job finished a moment ago).
 *
 * Lock order job → workspace (refund) → video, the same as the worker's terminal helpers.
 */
export async function cancelRender(
  deps: Pick<VideoDeps, 'db' | 'queues'>,
  video: VideoRow,
): Promise<VideoRow> {
  const { db, queues } = deps;
  const jobId = video.currentRenderJobId;
  if (!jobId || !isRendering(video)) {
    throw AppError.invalidState('This video is not being rendered');
  }
  const updated = await db.transaction(async (tx) => {
    const now = new Date();
    const [job] = await tx
      .update(renderJobs)
      .set({ status: 'canceled', etaSec: null, finishedAt: now, creditsCharged: 0 })
      .where(
        and(
          eq(renderJobs.id, jobId),
          eq(renderJobs.workspaceId, video.workspaceId),
          eq(renderJobs.videoId, video.id),
          inArray(renderJobs.status, ACTIVE_JOB),
        ),
      )
      .returning({ id: renderJobs.id });
    if (!job) throw AppError.invalidState('This video is not being rendered');
    await refundCredits(tx, {
      workspaceId: video.workspaceId,
      refType: 'renderJob',
      refId: jobId,
      description: 'Render cancelled — credits refunded',
    });
    const [previous] = await tx
      .select({ status: renderJobs.status, error: renderJobs.error })
      .from(renderJobs)
      .where(
        and(
          eq(renderJobs.videoId, video.id),
          eq(renderJobs.workspaceId, video.workspaceId),
          inArray(renderJobs.status, ['completed', 'failed']),
        ),
      )
      .orderBy(desc(renderJobs.createdAt), desc(renderJobs.id))
      .limit(1);
    const status =
      previous?.status === 'completed' && video.videoKey !== null
        ? 'completed'
        : previous?.status === 'failed'
          ? 'failed'
          : 'draft';
    const [row] = await tx
      .update(videos)
      .set({
        status,
        progress: status === 'completed' ? 100 : 0,
        error: status === 'failed' ? (previous?.error ?? null) : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(videos.id, video.id),
          eq(videos.workspaceId, video.workspaceId),
          eq(videos.currentRenderJobId, jobId),
        ),
      )
      .returning();
    if (!row) throw AppError.invalidState('This video is not being rendered');
    await releaseBatchItem(tx, video);
    return row;
  });
  // A job that has not started is simply dropped; a running one stops at its next check.
  await queues.remove('render', jobId).catch(() => false);
  return updated;
}

/**
 * Delete a video of the workspace: cancels and refunds its render in progress, removes every
 * file under its storage prefix (outputs of all renders and the draft poster) and the row —
 * render history and share link go with it (FK cascade). 404 for a missing / foreign video.
 *
 * The row is only deleted while it has no active render, re-checked by the DELETE itself, so
 * a render that starts at the same instant is cancelled and refunded on the next pass instead
 * of vanishing with its credits. Files go before the commit: if storage fails the row stays
 * and the request can be retried.
 */
export async function deleteVideo(
  deps: Pick<VideoDeps, 'db' | 'queues' | 'providers'>,
  workspaceId: string,
  videoId: string,
): Promise<void> {
  const { db, queues, providers } = deps;
  const scope = and(eq(videos.id, videoId), eq(videos.workspaceId, workspaceId));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await db.transaction(async (tx) => {
      const video = await findVideo(tx, workspaceId, videoId);
      const canceled = await tx
        .update(renderJobs)
        .set({ status: 'canceled', etaSec: null, finishedAt: new Date(), creditsCharged: 0 })
        .where(
          and(
            eq(renderJobs.videoId, videoId),
            eq(renderJobs.workspaceId, workspaceId),
            inArray(renderJobs.status, ACTIVE_JOB),
          ),
        )
        .returning({ id: renderJobs.id });
      for (const job of canceled) {
        await refundCredits(tx, {
          workspaceId,
          refType: 'renderJob',
          refId: job.id,
          description: 'Video deleted while rendering — credits refunded',
        });
      }
      if (canceled.length > 0) {
        await tx
          .update(videos)
          .set({ status: 'draft', progress: 0 })
          .where(
            and(
              scope,
              inArray(
                videos.currentRenderJobId,
                canceled.map((job) => job.id),
              ),
            ),
          );
      }
      await releaseBatchItem(tx, video);
      const deleted = await tx
        .delete(videos)
        .where(and(scope, notInArray(videos.status, ACTIVE_VIDEO)))
        .returning({ id: videos.id });
      if (deleted.length === 0) return { done: false, canceled };
      await providers.storage.deletePrefix(storageKeys.videoPrefix(workspaceId, videoId));
      return { done: true, canceled };
    });
    for (const job of outcome.canceled) await queues.remove('render', job.id).catch(() => false);
    if (outcome.done) return;
  }
  throw AppError.invalidState('This video is busy right now. Try again in a moment');
}
