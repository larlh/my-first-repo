import { isStockAvatarId } from '@parlante/shared';
import type { StockAvatarMeta } from '@parlante/shared';
import { STOCK_AVATAR_CATALOG } from './stock/catalog';
import { characterSpec } from './stock/characters';
import { createCharacterRig } from './stock/rig';
import type { AvatarRig, StockAvatarDefinition } from './types';

/**
 * Registry of stock avatars. Owner: avatar-artist.
 * Every catalogue entry gets a parametric character rig: its palette comes from the catalogue
 * traits, its look (hair, clothes, face) from `stock/characters.ts`.
 */
const DEFINITIONS: readonly StockAvatarDefinition[] = STOCK_AVATAR_CATALOG.map((meta) => ({
  meta,
  createRig: () => createCharacterRig(meta.id, characterSpec(meta)),
}));

const byId = new Map(DEFINITIONS.map((d) => [d.meta.id, d]));
const rigCache = new Map<string, AvatarRig>();

/** Catalogue metadata of every stock avatar (for the API, pickers and filters). */
export function listStockAvatars(): StockAvatarMeta[] {
  return DEFINITIONS.map((d) => d.meta);
}

export function getStockAvatarMeta(avatarId: string): StockAvatarMeta | null {
  return byId.get(avatarId)?.meta ?? null;
}

/** Rig of a stock avatar (cached), or null when the id is unknown / not a stock id. */
export function getStockAvatarRig(avatarId: string): AvatarRig | null {
  if (!isStockAvatarId(avatarId)) return null;
  const cached = rigCache.get(avatarId);
  if (cached) return cached;
  const def = byId.get(avatarId);
  if (!def) return null;
  const rig = def.createRig();
  rigCache.set(avatarId, rig);
  return rig;
}

/** Default avatar for new scenes / quick API videos. */
export const DEFAULT_STOCK_AVATAR_ID = 'stock_lucia';
