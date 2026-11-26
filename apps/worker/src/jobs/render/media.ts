import { AppError, collectMediaRefs } from '@parlante/shared';
import type { AssetKind, Composition, MediaRef } from '@parlante/shared';
import { and, assets as assetsTable, eq, inArray } from '@parlante/db';
import { MapRenderAssets } from '@parlante/renderer';
import { NodeImageCache, openVideoSource } from '@parlante/renderer/node';
import type { PreparableVideoSource } from '@parlante/renderer/node';
import { getStockAssetMeta } from '@parlante/stock-assets';
import { stockAssetFilePath, stockMusicLoop } from '@parlante/stock-assets/node';
import { ffprobe } from '../../lib/ffmpeg';
import type { MediaInfo } from '../../lib/ffmpeg';
import type { RenderRun } from './run';

/* -------------------------------------------------------------------------------------------
 * Stage `prepare`: every file the snapshot references becomes something the renderer or
 * ffmpeg can use — decoded images, on-demand video frame sources, local audio paths.
 * A reference that cannot be resolved FAILS the render (the user gets the credits back and a
 * message) instead of silently exporting a placeholder.
 * ----------------------------------------------------------------------------------------- */

/** A local audio or video file with what ffprobe says about it. */
export interface MediaFile {
  path: string;
  info: MediaInfo;
  /** Stock music only: how to loop the decoded track without a gap (see `stockMusicLoop`). */
  aloopFilter?: string;
}

export interface PreparedMedia {
  assets: MapRenderAssets;
  /** `mediaRefKey` → file, for music and narration audio. */
  audio: Map<string, MediaFile>;
  /** `mediaRefKey` → file, for video backgrounds / layers (their soundtrack is mixed in). */
  video: Map<string, MediaFile>;
  /** File-backed frame sources to close when the render ends. */
  sources: PreparableVideoSource[];
}

function missing(ref: MediaRef): AppError {
  return new AppError(
    'UNPROCESSABLE',
    'A file used by this video no longer exists. Replace it in the editor and render again.',
    ref.source === 'asset' ? { assetId: ref.assetId } : { stockId: ref.stockId },
  );
}

export async function prepareMedia(
  run: RenderRun,
  composition: Composition,
  size: { width: number; height: number },
): Promise<PreparedMedia> {
  const { ctx, ref, files, signal } = run;
  const uses = collectMediaRefs(composition);
  const assetIds = [
    ...new Set(uses.flatMap((use) => (use.ref.source === 'asset' ? [use.ref.assetId] : []))),
  ];
  const rows =
    assetIds.length > 0
      ? await ctx.db
          .select()
          .from(assetsTable)
          .where(
            and(eq(assetsTable.workspaceId, ref.workspaceId), inArray(assetsTable.id, assetIds)),
          )
      : [];

  /** Local path of a media reference, checked against the kind the composition uses it as. */
  const locate = async (mediaRef: MediaRef, kind: AssetKind): Promise<string> => {
    if (mediaRef.source === 'stock') {
      const meta = getStockAssetMeta(mediaRef.stockId);
      if (!meta || meta.kind !== kind) throw missing(mediaRef);
      return stockAssetFilePath(mediaRef.stockId);
    }
    const row = rows.find((r) => r.id === mediaRef.assetId);
    if (!row || row.kind !== kind) throw missing(mediaRef);
    return files.fromStorage(row.storageKey);
  };

  const prepared: PreparedMedia = {
    assets: new MapRenderAssets(),
    audio: new Map(),
    video: new Map(),
    sources: [],
  };
  const images = new NodeImageCache();
  try {
    let done = 0;
    for (const use of uses) {
      run.cancel.throwIfCanceled();
      if (use.usage === 'image') {
        const file = await locate(use.ref, 'image');
        try {
          prepared.assets.setImage(use.key, await images.load(use.key, file));
        } catch {
          throw new AppError('UNPROCESSABLE', 'An image used by this video could not be decoded', {
            key: use.key,
          });
        }
      } else if (use.usage === 'video') {
        const file = await locate(use.ref, 'video');
        const info = await ffprobe(file, { signal });
        const source = await openVideoSource({
          path: file,
          maxWidth: size.width,
          maxHeight: size.height,
          signal,
        });
        prepared.sources.push(source);
        prepared.assets.setVideo(use.key, source);
        prepared.video.set(use.key, { path: file, info });
      } else {
        const file = await locate(use.ref, 'audio');
        const info = await ffprobe(file, { signal });
        if (!info.hasAudio) {
          throw new AppError('UNPROCESSABLE', 'An audio file used by this video has no sound', {
            key: use.key,
          });
        }
        prepared.audio.set(use.key, {
          path: file,
          info,
          aloopFilter:
            use.ref.source === 'stock' ? stockMusicLoop(use.ref.stockId).aloopFilter : undefined,
        });
      }
      done += 1;
      await run.progress.update('prepare', done / uses.length);
    }
    return prepared;
  } catch (err) {
    await closeSources(prepared.sources);
    throw err;
  }
}

/** Stop every decoder; never throws (used on every exit path). */
export async function closeSources(sources: readonly { close(): Promise<void> }[]): Promise<void> {
  await Promise.all(sources.map((source) => source.close().catch(() => undefined)));
}
