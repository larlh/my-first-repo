import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '@parlante/shared';
import { cutoutPng, thumbnailJpeg } from '@parlante/renderer/node';
import {
  STOCK_BACKGROUND_MIME,
  STOCK_MUSIC_SAMPLE_RATE,
  getStockAssetDetails,
  getStockAssetMeta,
  isStockAssetId,
} from '../catalog';
import type { StockAssetDetails, StockBackgroundId } from '../catalog';
import { renderBackground } from '../generators/backgrounds';
import { getStockPhotorealAvatar } from '../photoreal-avatars';

/** Bytes of a built-in file plus the MIME type to serve them with. */
export interface GeneratedAsset {
  bytes: Uint8Array;
  mimeType: string;
}

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Directory that holds the committed stock files (`backgrounds/`, `music/`, `manifest.json`). */
export const STOCK_ASSETS_DIR = path.join(PACKAGE_DIR, 'assets');

function detailsOrThrow(stockId: string): StockAssetDetails {
  const details = getStockAssetDetails(stockId);
  if (!details) throw new AppError('NOT_FOUND', 'Stock asset not found', { stockId });
  return details;
}

/**
 * Absolute path of the committed file of a stock asset — hand it to ffmpeg (music) or to an
 * image decoder (backgrounds). The path is built from the catalogue, never from input.
 * Throws AppError NOT_FOUND for unknown ids.
 */
export function stockAssetFilePath(stockId: string): string {
  return path.join(STOCK_ASSETS_DIR, detailsOrThrow(stockId).file);
}

const cache = new Map<string, Promise<GeneratedAsset>>();

/**
 * Bytes of a stock asset (Node only): the committed file, read once per process and memoised.
 * Throws AppError NOT_FOUND for unknown ids.
 */
export function getStockAssetData(stockId: string): Promise<GeneratedAsset> {
  const meta = getStockAssetMeta(stockId);
  if (!meta || !isStockAssetId(stockId)) {
    return Promise.reject(new AppError('NOT_FOUND', 'Stock asset not found', { stockId }));
  }
  let pending = cache.get(stockId);
  if (!pending) {
    pending = fs
      .readFile(stockAssetFilePath(stockId))
      .then((bytes) => ({ bytes, mimeType: meta.mimeType }));
    cache.set(stockId, pending);
    pending.catch(() => cache.delete(stockId));
  }
  return pending;
}

/**
 * Paint a stock BACKGROUND at an exact pixel size (JPEG) instead of using the square master:
 * the same picture as a centred `cover` crop, at any aspect ratio or resolution. Synchronous
 * and not cached (≈ 0.1–0.5 s per megapixel) — meant for exports and tools, not for hot paths.
 * Throws AppError NOT_FOUND for unknown ids and for assets that are not backgrounds.
 */
export function renderStockBackground(
  stockId: string,
  width: number,
  height: number,
  quality = 90,
): GeneratedAsset {
  const details = detailsOrThrow(stockId);
  if (details.group === null) {
    throw new AppError('NOT_FOUND', 'Stock asset is not a background', { stockId });
  }
  const w = Math.min(4096, Math.max(16, Math.round(width)));
  const h = Math.min(4096, Math.max(16, Math.round(height)));
  const canvas = renderBackground(details.id as StockBackgroundId, w, h);
  return { bytes: canvas.toBuffer('image/jpeg', quality), mimeType: STOCK_BACKGROUND_MIME };
}

/** How to loop a stock music track without a gap or a click. */
export interface StockMusicLoop {
  /** Absolute path of the committed `.m4a`. */
  path: string;
  sampleRate: number;
  /** Exact length of the loop in samples per channel once decoded. */
  samples: number;
  durationMs: number;
  /**
   * ffmpeg audio filter that repeats the DECODED track forever (`-i <path> -af <aloopFilter>`,
   * or as the first filter of a chain; cut the result with `-t` / `atrim`). Prefer it to
   * `-stream_loop`, which restarts the AAC decoder at every repetition and fades the first
   * 20 ms of each one in.
   */
  aloopFilter: string;
}

/**
 * Loop parameters of a stock MUSIC track. Throws AppError NOT_FOUND for unknown ids and for
 * assets that are not music.
 */
export function stockMusicLoop(stockId: string): StockMusicLoop {
  const details = detailsOrThrow(stockId);
  const meta = getStockAssetMeta(stockId);
  if (details.loopSamples === null || !meta || meta.durationMs === null) {
    throw new AppError('NOT_FOUND', 'Stock asset is not a music track', { stockId });
  }
  return {
    path: path.join(STOCK_ASSETS_DIR, details.file),
    sampleRate: STOCK_MUSIC_SAMPLE_RATE,
    samples: details.loopSamples,
    durationMs: meta.durationMs,
    aloopFilter: `aloop=loop=-1:size=${details.loopSamples}`,
  };
}

/** One entry of `assets/manifest.json` (written by scripts/generate.ts). */
export interface StockManifestEntry {
  id: string;
  file: string;
  bytes: number;
  sha256: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** Music only: samples per channel at 48 kHz and hash of the rendered PCM (before AAC). */
  samples?: number;
  pcmSha256?: string;
}

export interface StockManifest {
  version: 1;
  assets: StockManifestEntry[];
}

/** The committed manifest: size, hash and dimensions of every stock file. */
export async function readStockManifest(): Promise<StockManifest> {
  const raw = await fs.readFile(path.join(STOCK_ASSETS_DIR, 'manifest.json'), 'utf8');
  return JSON.parse(raw) as StockManifest;
}

const AVATARS_DIR = path.join(STOCK_ASSETS_DIR, 'avatars');

/** Absolute paths of the versioned images of a photorealistic stock avatar (`real_…`). */
export function stockPhotorealAvatarFiles(avatarId: string): {
  portraitPath: string;
  maskPath: string | null;
  /** 256-px WebP thumbnail (`<portrait stem>.thumb.webp`), or null when it was not shipped. */
  thumbPath: string | null;
} {
  const meta = getStockPhotorealAvatar(avatarId);
  if (!meta) throw new AppError('NOT_FOUND', 'Stock avatar not found', { avatarId });
  // File names come from the catalogue (code), never from input; basename() is belt and braces.
  const portraitFile = path.basename(meta.portraitFile);
  const thumbPath = path.join(AVATARS_DIR, `${path.parse(portraitFile).name}.thumb.webp`);
  return {
    portraitPath: path.join(AVATARS_DIR, portraitFile),
    maskPath: meta.maskFile ? path.join(AVATARS_DIR, path.basename(meta.maskFile)) : null,
    thumbPath: existsSync(thumbPath) ? thumbPath : null,
  };
}

/** Bytes of the portrait (and matte) of a photorealistic stock avatar. */
export async function getStockPhotorealAvatarImages(
  avatarId: string,
): Promise<{ portrait: Uint8Array; mask: Uint8Array | null }> {
  const files = stockPhotorealAvatarFiles(avatarId);
  return {
    portrait: await fs.readFile(files.portraitPath),
    mask: files.maskPath ? await fs.readFile(files.maskPath) : null,
  };
}

export type StockAvatarFileKind = 'portrait' | 'mask' | 'cutout' | 'thumb';

const avatarFileCache = new Map<string, Promise<GeneratedAsset>>();

/**
 * Bytes behind `GET /api/stock-avatars/:avatarId/:file` and what the worker loads for
 * `real_…` avatars:
 *   portrait → the versioned prepared portrait (JPEG or PNG, see `mimeType`)
 *   mask     → its greyscale alpha matte (PNG); NOT_FOUND when the avatar has none
 *   cutout   → portrait with the matte applied (RGBA PNG) — the image of the stand-in rig
 *   thumb    → 256 px JPEG of the portrait
 * `cutout` and `thumb` are derived on first use and memoised (inputs are immutable files).
 * Throws AppError NOT_FOUND for unknown ids.
 */
export function getStockPhotorealAvatarFile(
  avatarId: string,
  file: StockAvatarFileKind,
): Promise<GeneratedAsset> {
  const cacheKey = `${avatarId}/${file}`;
  let pending = avatarFileCache.get(cacheKey);
  if (!pending) {
    pending = loadStockAvatarFile(avatarId, file);
    avatarFileCache.set(cacheKey, pending);
    pending.catch(() => avatarFileCache.delete(cacheKey));
  }
  return pending;
}

async function loadStockAvatarFile(
  avatarId: string,
  file: StockAvatarFileKind,
): Promise<GeneratedAsset> {
  const files = stockPhotorealAvatarFiles(avatarId); // throws NOT_FOUND for unknown ids
  switch (file) {
    case 'portrait':
      return {
        bytes: await fs.readFile(files.portraitPath),
        mimeType: /\.jpe?g$/i.test(files.portraitPath) ? 'image/jpeg' : 'image/png',
      };
    case 'mask':
      if (!files.maskPath) {
        throw new AppError('NOT_FOUND', 'This stock avatar has no matte', { avatarId });
      }
      return { bytes: await fs.readFile(files.maskPath), mimeType: 'image/png' };
    case 'cutout':
      return {
        bytes: await cutoutPng(files.portraitPath, files.maskPath),
        mimeType: 'image/png',
      };
    case 'thumb':
      return { bytes: await thumbnailJpeg(files.portraitPath, 256), mimeType: 'image/jpeg' };
  }
}
