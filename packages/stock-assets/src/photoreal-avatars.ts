import type { StockPhotorealAvatarMeta } from '@parlante/shared';
import { PHOTOREAL_AVATAR_DATA } from './photoreal-avatars.data';

/**
 * Photorealistic STOCK avatars (`real_<slug>`): SYNTHETIC people generated with the local
 * avatar engine (never photos of real persons) and versioned as images under
 * `packages/stock-assets/assets/avatars/`:
 *   `<slug>.jpg`        prepared portrait (square, upright, ≤ 768 px; JPEG ≤ 300 KB)
 *   `<slug>.mask.png`   alpha matte, same size, white = person
 *   `<slug>.thumb.webp` 256-px thumbnail (cut-out over a neutral gradient)
 * Always read the file names from the metadata (`portraitFile`, `maskFile`), not from the id.
 * Master prompt §2b requires at least 8.
 *
 * The entries are GENERATED: `services/avatar-engine/stock/avatars.json` holds the structured
 * description and seed of every person; `scripts/build_stock_avatars.py` runs the engine
 * (generate → quality control → prepare → matte) and, after a human has reviewed the staged
 * images, writes the published ones to `./photoreal-avatars.data.ts` (prompt, seed and model
 * make each one reproducible; see docs/MODELS.md). Ids are frozen once published.
 */
export const STOCK_PHOTOREAL_AVATARS: readonly StockPhotorealAvatarMeta[] = PHOTOREAL_AVATAR_DATA;

export function listStockPhotorealAvatars(): StockPhotorealAvatarMeta[] {
  return [...STOCK_PHOTOREAL_AVATARS];
}

export function getStockPhotorealAvatar(avatarId: string): StockPhotorealAvatarMeta | null {
  return STOCK_PHOTOREAL_AVATARS.find((a) => a.id === avatarId) ?? null;
}
