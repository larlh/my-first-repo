import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '@parlante/shared';
import { getStockAssetMeta } from '../catalog';
import { getStockPhotorealAvatar } from '../photoreal-avatars';
import { GENERATORS } from './generators';
import type { GeneratedAsset } from './generators';

export type { GeneratedAsset } from './generators';

const cache = new Map<string, Promise<GeneratedAsset>>();

/**
 * Bytes of a stock asset (Node only). Generated once per process and memoised.
 * Throws AppError NOT_FOUND for unknown ids.
 */
export function getStockAssetData(stockId: string): Promise<GeneratedAsset> {
  const meta = getStockAssetMeta(stockId);
  const generator = GENERATORS[stockId];
  if (!meta || !generator) {
    return Promise.reject(new AppError('NOT_FOUND', 'Stock asset not found', { stockId }));
  }
  let pending = cache.get(stockId);
  if (!pending) {
    pending = Promise.resolve().then(generator);
    cache.set(stockId, pending);
    pending.catch(() => cache.delete(stockId));
  }
  return pending;
}

const AVATARS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../assets/avatars',
);

/** Absolute paths of the versioned images of a photorealistic stock avatar (`real_…`). */
export function stockPhotorealAvatarFiles(avatarId: string): {
  portraitPath: string;
  maskPath: string | null;
} {
  const meta = getStockPhotorealAvatar(avatarId);
  if (!meta) throw new AppError('NOT_FOUND', 'Stock avatar not found', { avatarId });
  // File names come from the catalogue (code), never from input; basename() is belt and braces.
  return {
    portraitPath: path.join(AVATARS_DIR, path.basename(meta.portraitFile)),
    maskPath: meta.maskFile ? path.join(AVATARS_DIR, path.basename(meta.maskFile)) : null,
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
