import type { StockPhotorealAvatarMeta } from '@parlante/shared';

/**
 * Photorealistic STOCK avatars (`real_<slug>`): SYNTHETIC people generated with the local
 * avatar engine (never photos of real persons) and versioned as images under
 * `packages/stock-assets/assets/avatars/` — `<slug>.png` (prepared portrait) and
 * `<slug>.mask.png` (alpha matte). Master prompt §2b requires at least 8.
 *
 * The catalogue starts EMPTY: the portraits are produced by the avatar-engine work package
 * (they cannot exist before the engine does). Add an avatar = commit its two images and append
 * its metadata here (prompt, seed and model make it reproducible; see docs/MODELS.md).
 * Ids are frozen once published.
 */
export const STOCK_PHOTOREAL_AVATARS: readonly StockPhotorealAvatarMeta[] = [];

export function listStockPhotorealAvatars(): StockPhotorealAvatarMeta[] {
  return [...STOCK_PHOTOREAL_AVATARS];
}

export function getStockPhotorealAvatar(avatarId: string): StockPhotorealAvatarMeta | null {
  return STOCK_PHOTOREAL_AVATARS.find((a) => a.id === avatarId) ?? null;
}
