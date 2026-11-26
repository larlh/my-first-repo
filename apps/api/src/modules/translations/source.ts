import { AppError, newId, resolutionSize } from '@parlante/shared';
import type { Providers } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { and, assets, eq, videos } from '@parlante/db';
import type { AssetRow, Db, VideoRow, WorkspaceRow } from '@parlante/db';
import { assertWithinLimit } from '../../lib/limits';
import { storageBytesUsed } from '../assets/service';
import { lockWorkspace } from '../workspaces/service';

/* -------------------------------------------------------------------------------------------
 * Source of a translation job. The job always works on an Asset (`translation_jobs
 * .source_asset_id`): either one the user uploaded, or — `sourceVideoId` — a copy of the
 * rendered MP4 of one of the workspace's own videos, stored as a `translation_source` asset.
 * ----------------------------------------------------------------------------------------- */

export interface SourceDeps {
  db: Db;
  providers: Pick<Providers, 'storage'>;
}

/** A completed video of THIS workspace with its file, or 404 / UNPROCESSABLE. */
export async function findTranslatableVideo(
  db: Db,
  workspaceId: string,
  videoId: string,
): Promise<VideoRow & { videoKey: string; durationMs: number }> {
  const [video] = await db
    .select()
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.workspaceId, workspaceId)));
  if (!video) throw AppError.notFound('Video');
  if (video.status !== 'completed' || !video.videoKey || !video.durationMs) {
    throw new AppError(
      'UNPROCESSABLE',
      'Only a video that has been rendered can be translated. Render it first',
      { videoId, status: video.status },
    );
  }
  return { ...video, videoKey: video.videoKey, durationMs: video.durationMs };
}

/**
 * Copy the rendered MP4 (and poster) of a video into a new `translation_source` asset. The
 * copy counts against the plan storage like any upload; files are removed if the row fails.
 */
export async function assetFromRenderedVideo(
  deps: SourceDeps,
  input: {
    workspace: Pick<WorkspaceRow, 'id' | 'plan'>;
    userId: string | null;
    video: VideoRow & { videoKey: string; durationMs: number };
  },
): Promise<AssetRow> {
  const { db, providers } = deps;
  const { video } = input;
  const workspaceId = input.workspace.id;
  const stat = await providers.storage.stat(video.videoKey);
  if (!stat) {
    throw new AppError(
      'UNPROCESSABLE',
      'The rendered file of this video is missing. Render it again',
      {
        videoId: video.id,
      },
    );
  }
  assertWithinLimit(
    input.workspace,
    'maxStorageBytes',
    (await storageBytesUsed(db, workspaceId)) + stat.size,
  );

  const id = newId('asset');
  const storageKey = storageKeys.asset(workspaceId, id, 'mp4');
  const copy = async (from: string, to: string, contentType: string) => {
    const local = providers.storage.localPath(from);
    await providers.storage.put(
      to,
      local ? { filePath: local } : await providers.storage.getStream(from),
      { contentType },
    );
  };
  try {
    await copy(video.videoKey, storageKey, 'video/mp4');
    let thumbnailKey: string | null = null;
    if (video.thumbnailKey && (await providers.storage.exists(video.thumbnailKey))) {
      thumbnailKey = storageKeys.assetThumb(workspaceId, id);
      await copy(video.thumbnailKey, thumbnailKey, 'image/jpeg');
    }
    const size = resolutionSize(video.aspect, video.resolution ?? '720p');
    return await db.transaction(async (tx) => {
      const locked = await lockWorkspace(tx, workspaceId);
      assertWithinLimit(
        locked,
        'maxStorageBytes',
        (await storageBytesUsed(tx, workspaceId)) + stat.size,
      );
      const [row] = await tx
        .insert(assets)
        .values({
          id,
          workspaceId,
          kind: 'video',
          purpose: 'translation_source',
          name: `${video.title}.mp4`.slice(0, 120),
          mimeType: 'video/mp4',
          sizeBytes: stat.size,
          width: size.width,
          height: size.height,
          durationMs: video.durationMs,
          storageKey,
          thumbnailKey,
          createdBy: input.userId,
        })
        .returning();
      if (!row) throw new Error('Insert returned no row');
      return row;
    });
  } catch (err) {
    await providers.storage.deletePrefix(storageKeys.assetPrefix(workspaceId, id)).catch(() => {
      // Best effort: the original error is the one worth reporting.
    });
    throw err;
  }
}
