import {
  collectAvatarIds,
  collectMediaRefs,
  isStockPhotorealAvatarId,
  resolutionSize,
} from '@parlante/shared';
import type { Composition, Providers } from '@parlante/shared';
import { and, assets, avatars, eq, inArray } from '@parlante/db';
import type { Db } from '@parlante/db';
import {
  MapRenderAssets,
  computeTimeline,
  createPhotoAvatarRig,
  renderFrame,
} from '@parlante/renderer';
import type { RenderImage } from '@parlante/renderer';
import {
  canvasToJpeg,
  createNodeCanvas,
  loadNodeImage,
  registerNodeFonts,
} from '@parlante/renderer/node';
import { getStockPhotorealAvatar } from '@parlante/stock-assets';
import { getStockAssetData, getStockPhotorealAvatarFile } from '@parlante/stock-assets/node';

export interface PosterDeps {
  db: Db;
  providers: Pick<Providers, 'storage'>;
}

export interface PosterOptions {
  /**
   * Workspace whose assets and avatars the composition may reference. `null` for built-in
   * templates (only stock media resolves; anything else is drawn as the renderer placeholder).
   */
  workspaceId: string | null;
  /** Output width in pixels (height follows the aspect ratio). Default 640. */
  width?: number;
}

/** Images bigger than this are not decoded for a poster (the placeholder is drawn instead). */
const MAX_POSTER_IMAGE_BYTES = 30 * 1024 * 1024;
/** Moment of the first scene shown: late enough for enter animations to have finished. */
const POSTER_TIME_MS = 1200;

/**
 * JPEG poster of a composition: its FIRST scene, drawn by the same renderer as the Studio and
 * the export (resting avatars, no subtitles). This is what fills thumbnails nobody else
 * produces:
 *  - drafts:           on create / autosave → `storageKeys.videoDraftThumb`, stored in
 *                      `videos.thumbnail_key` until the first render writes the real one
 *  - custom templates: on "save as template" → `storageKeys.templateThumb`
 *  - built-in ones:    served by `GET /api/templates/:templateId/thumbnail` (memoise per id)
 * Best effort by design: media that cannot be loaded (missing, foreign, too big, a video
 * without thumbnail) leaves the renderer's neutral placeholder — it never throws for that.
 */
export async function renderPoster(
  deps: PosterDeps,
  composition: Composition,
  options: PosterOptions,
): Promise<Buffer> {
  registerNodeFonts();
  const renderAssets = new MapRenderAssets();
  const firstScene: Composition = { ...composition, scenes: composition.scenes.slice(0, 1) };

  /* ---- images, and video stills, of the first scene ---- */
  const uses = collectMediaRefs(firstScene).filter((use) => use.usage !== 'audio');
  const assetIds = uses.flatMap((use) => (use.ref.source === 'asset' ? [use.ref.assetId] : []));
  const rows =
    options.workspaceId && assetIds.length > 0
      ? await deps.db
          .select()
          .from(assets)
          .where(and(eq(assets.workspaceId, options.workspaceId), inArray(assets.id, assetIds)))
      : [];
  for (const use of uses) {
    const image = await loadQuietly(async () => {
      if (use.ref.source === 'stock') {
        const data = await getStockAssetData(use.ref.stockId);
        return data.mimeType.startsWith('image/') ? loadNodeImage(data.bytes) : null;
      }
      const assetId = use.ref.assetId;
      const row = rows.find((r) => r.id === assetId);
      if (!row) return null;
      // Videos are represented by their upload thumbnail (a still), images by themselves.
      const key = row.kind === 'image' ? row.storageKey : row.thumbnailKey;
      if (!key || (row.kind === 'image' && row.sizeBytes > MAX_POSTER_IMAGE_BYTES)) return null;
      return loadNodeImage(await deps.providers.storage.get(key));
    });
    if (!image) continue;
    if (use.usage === 'image') {
      renderAssets.setImage(use.key, image);
    } else {
      renderAssets.setVideo(use.key, {
        durationMs: 0,
        width: image.width,
        height: image.height,
        frameAt: () => image,
      });
    }
  }

  /* ---- photorealistic avatars: stand-in rig from the cut-out ---- */
  const avatarIds = collectAvatarIds(firstScene).filter((id) => !id.startsWith('stock_'));
  const workspaceAvatarIds = avatarIds.filter((id) => !isStockPhotorealAvatarId(id));
  const avatarRows =
    options.workspaceId && workspaceAvatarIds.length > 0
      ? await deps.db
          .select()
          .from(avatars)
          .where(
            and(
              eq(avatars.workspaceId, options.workspaceId),
              inArray(avatars.id, workspaceAvatarIds),
            ),
          )
      : [];
  for (const avatarId of avatarIds) {
    await loadQuietly(async () => {
      if (isStockPhotorealAvatarId(avatarId)) {
        const meta = getStockPhotorealAvatar(avatarId);
        if (!meta) return null;
        const cutout = await getStockPhotorealAvatarFile(avatarId, 'cutout');
        renderAssets.setAvatar(
          avatarId,
          createPhotoAvatarRig(avatarId, await loadNodeImage(cutout.bytes), meta.rig),
        );
        return null;
      }
      const row = avatarRows.find((r) => r.id === avatarId);
      const key = row?.cutoutKey ?? row?.imageKey;
      if (!row?.rig || !key) return null;
      const cutout = await loadNodeImage(await deps.providers.storage.get(key));
      renderAssets.setAvatar(avatarId, createPhotoAvatarRig(avatarId, cutout, row.rig));
      return null;
    });
  }

  const size = resolutionSize(composition.canvas.aspect, '720p');
  const width = Math.round(options.width ?? 640);
  const height = Math.round((width * size.height) / size.width);
  const timeline = computeTimeline(firstScene, { scenes: {} }, { estimateMissing: true });
  const tMs = Math.min(POSTER_TIME_MS, Math.max(0, timeline.totalMs - 1000 / timeline.fps));
  const { canvas, ctx } = createNodeCanvas(width, height);
  renderFrame(ctx, firstScene, tMs, { scenes: {} }, renderAssets, {
    width,
    height,
    timeline,
    subtitles: false,
    quality: 'preview',
  });
  return canvasToJpeg(canvas, 82);
}

async function loadQuietly(load: () => Promise<RenderImage | null>): Promise<RenderImage | null> {
  try {
    return await load();
  } catch {
    return null; // a poster never fails because one of its images does
  }
}
