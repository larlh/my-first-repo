import {
  AppError,
  api,
  buildPath,
  isStockAvatarId,
  isStockPhotorealAvatarId,
} from '@parlante/shared';
import { localizeCatalogEntry } from '@parlante/shared';
import type {
  AgeGroup,
  Avatar,
  AvatarRendering,
  AvatarStyle,
  CatalogEnglish,
  Gender,
  ProviderRef,
  Providers,
  StockAvatarMeta,
  StockPhotorealAvatarMeta,
} from '@parlante/shared';
import { and, avatars, desc, eq } from '@parlante/db';
import type { AvatarRow, Db } from '@parlante/db';
import type { FileUrlBuilder } from '@parlante/jobs';
import { getStockAvatarMeta, listStockAvatars } from '@parlante/renderer';
import { getStockPhotorealAvatar, listStockPhotorealAvatars } from '@parlante/stock-assets';
import { iso } from '../../lib/dto';

/* -------------------------------------------------------------------------------------------
 * The avatar catalogue as ONE list of `Avatar` DTOs, whatever the origin:
 *   stock_<slug>  instant 2D rigs drawn by code            (@parlante/renderer)
 *   real_<slug>   photorealistic stock, versioned images   (@parlante/stock-assets)
 *   avt_…         photo / generated avatars of a workspace (table `avatars`)
 * Used by `GET /api/avatars` and reusable by any other listing of avatars (public API v1).
 * ----------------------------------------------------------------------------------------- */

export interface AvatarCatalogDeps {
  db: Db;
  providers: Pick<Providers, 'portrait'>;
  fileUrl: FileUrlBuilder;
  /** `config.PUBLIC_API_URL`: stock images are served by this API. */
  publicApiUrl: string;
}

export interface AvatarFilters {
  kind?: Avatar['kind'] | undefined;
  rendering?: AvatarRendering | undefined;
  gender?: Gender | undefined;
  ageGroup?: AgeGroup | undefined;
  style?: AvatarStyle | undefined;
  /** Free text: name, description, tags and traits, in Spanish and English. */
  q?: string | undefined;
}

/**
 * Who draws an instant avatar: the Canvas2D rig of the renderer, on this machine. Honest
 * label for the UI — it is the real-time 2D style, not a photorealistic result.
 */
export const INSTANT_AVATAR_PROVIDER: ProviderRef = {
  id: 'canvas2d',
  name: 'Parlante 2D (Canvas)',
  quality: 'basic',
  local: true,
};

/** Case- and accent-insensitive form used to match search text. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

interface CatalogTexts {
  name: string;
  description: string;
  tags: string[];
  traits: Record<string, string>;
  en?: CatalogEnglish | undefined;
}

/** Everything a search may hit: both languages, so `q` works whatever the UI locale. */
function searchText(entry: CatalogTexts): string {
  return fold(
    [
      entry.name,
      entry.description,
      ...entry.tags,
      ...Object.values(entry.traits),
      entry.en?.name ?? '',
      entry.en?.description ?? '',
      ...(entry.en?.tags ?? []),
    ].join(' \n '),
  );
}

/** Every word of the query must appear (in any order). */
function matchesQuery(haystack: string, q: string | undefined): boolean {
  if (!q) return true;
  return fold(q)
    .split(/\s+/)
    .filter((word) => word !== '')
    .every((word) => haystack.includes(word));
}

function matchesFacets(
  avatar: Pick<Avatar, 'kind' | 'rendering' | 'gender' | 'ageGroup' | 'style'>,
  filters: AvatarFilters,
): boolean {
  return (
    (!filters.kind || avatar.kind === filters.kind) &&
    (!filters.rendering || avatar.rendering === filters.rendering) &&
    (!filters.gender || avatar.gender === filters.gender) &&
    (!filters.ageGroup || avatar.ageGroup === filters.ageGroup) &&
    (!filters.style || avatar.style === filters.style)
  );
}

function instantStockDto(meta: StockAvatarMeta, locale: string): Avatar {
  const text = localizeCatalogEntry(meta, locale);
  return {
    id: meta.id,
    kind: 'stock',
    rendering: 'instant',
    name: text.name,
    gender: meta.gender,
    ageGroup: meta.ageGroup,
    style: meta.style,
    description: text.description,
    tags: text.tags,
    traits: meta.traits,
    status: 'ready',
    progress: 100,
    etaSec: null,
    // No image: clients draw the rig with the renderer (`getStockAvatarRig`).
    thumbnailUrl: null,
    imageUrl: null,
    maskUrl: null,
    cutoutUrl: null,
    rig: null,
    prompt: null,
    seed: null,
    model: null,
    provider: INSTANT_AVATAR_PROVIDER,
    workspaceId: null,
    consentId: null,
    error: null,
    createdAt: null,
  };
}

function photorealStockDto(
  meta: StockPhotorealAvatarMeta,
  locale: string,
  deps: Pick<AvatarCatalogDeps, 'providers' | 'publicApiUrl'>,
): Avatar {
  const text = localizeCatalogEntry(meta, locale);
  const base = deps.publicApiUrl.replace(/\/+$/, '');
  const file = (name: 'portrait' | 'mask' | 'cutout' | 'thumb') =>
    `${base}${buildPath(api.avatars.stockFile.path, { avatarId: meta.id, file: name })}`;
  return {
    id: meta.id,
    kind: 'stock',
    rendering: 'photoreal',
    name: text.name,
    gender: meta.gender,
    ageGroup: meta.ageGroup,
    style: meta.style,
    description: text.description,
    tags: text.tags,
    traits: meta.traits,
    status: 'ready',
    progress: 100,
    etaSec: null,
    thumbnailUrl: file('thumb'),
    imageUrl: file('portrait'),
    maskUrl: meta.maskFile ? file('mask') : null,
    cutoutUrl: file('cutout'),
    rig: meta.rig,
    prompt: meta.prompt,
    seed: meta.seed,
    model: meta.model,
    // A synthetic person generated (and animated at export time) by the local engine.
    provider: deps.providers.portrait.info,
    workspaceId: null,
    consentId: null,
    error: null,
    createdAt: null,
  };
}

/** Row → DTO for a workspace avatar. Images are exposed only once the avatar is `ready`. */
export async function toWorkspaceAvatarDto(
  deps: Pick<AvatarCatalogDeps, 'providers' | 'fileUrl'>,
  row: AvatarRow,
): Promise<Avatar> {
  const ready = row.status === 'ready';
  const url = (key: string | null) => (ready ? deps.fileUrl(key) : Promise.resolve(null));
  return {
    id: row.id,
    kind: row.origin,
    rendering: 'photoreal',
    name: row.name,
    gender: row.gender,
    ageGroup: null,
    style: null,
    description: '',
    tags: [],
    traits: {},
    status: row.status,
    progress: ready ? 100 : Math.min(100, Math.max(0, row.progress)),
    etaSec: row.status === 'processing' ? row.etaSec : null,
    thumbnailUrl: await url(row.thumbnailKey),
    imageUrl: await url(row.imageKey),
    maskUrl: await url(row.maskKey),
    cutoutUrl: await url(row.cutoutKey),
    rig: ready ? row.rig : null,
    prompt: row.prompt,
    seed: row.seed,
    model: row.model,
    // Null on the row until the job finishes: the engine that will do (or did) the work.
    provider: row.provider ?? deps.providers.portrait.info,
    workspaceId: row.workspaceId,
    consentId: row.consentId,
    error: row.error,
    createdAt: iso(row.createdAt),
  };
}

/**
 * Stock avatars (instant first, then photorealistic, in catalogue order) followed by the
 * avatars of the workspace, newest first — including the ones still processing or failed, so
 * the UI can show their progress. Texts in the user's UI language.
 */
export async function listAvatarCatalog(
  deps: AvatarCatalogDeps,
  workspaceId: string,
  locale: string,
  filters: AvatarFilters = {},
): Promise<Avatar[]> {
  const items: Avatar[] = [];
  if (!filters.kind || filters.kind === 'stock') {
    for (const meta of listStockAvatars()) {
      const dto = instantStockDto(meta, locale);
      if (matchesFacets(dto, filters) && matchesQuery(searchText(meta), filters.q)) items.push(dto);
    }
    for (const meta of listStockPhotorealAvatars()) {
      const dto = photorealStockDto(meta, locale, deps);
      if (matchesFacets(dto, filters) && matchesQuery(searchText(meta), filters.q)) items.push(dto);
    }
  }
  if (filters.kind !== 'stock' && filters.rendering !== 'instant') {
    const rows = await deps.db
      .select()
      .from(avatars)
      .where(
        and(
          // Workspace scope: another workspace's people are never listed.
          eq(avatars.workspaceId, workspaceId),
          filters.kind ? eq(avatars.origin, filters.kind) : undefined,
          filters.gender ? eq(avatars.gender, filters.gender) : undefined,
        ),
      )
      .orderBy(desc(avatars.createdAt), desc(avatars.id));
    for (const row of rows) {
      const dto = await toWorkspaceAvatarDto(deps, row);
      const text = searchText({ ...dto, description: row.prompt ?? '' });
      if (matchesFacets(dto, filters) && matchesQuery(text, filters.q)) items.push(dto);
    }
  }
  return items;
}

/** One avatar by id, or 404 — a foreign `avt_…` looks exactly like a missing one. */
export async function getAvatar(
  deps: AvatarCatalogDeps,
  workspaceId: string,
  locale: string,
  avatarId: string,
): Promise<Avatar> {
  if (isStockAvatarId(avatarId)) {
    const meta = getStockAvatarMeta(avatarId);
    if (!meta) throw AppError.notFound('Avatar');
    return instantStockDto(meta, locale);
  }
  if (isStockPhotorealAvatarId(avatarId)) {
    const meta = getStockPhotorealAvatar(avatarId);
    if (!meta) throw AppError.notFound('Avatar');
    return photorealStockDto(meta, locale, deps);
  }
  const [row] = await deps.db
    .select()
    .from(avatars)
    .where(and(eq(avatars.id, avatarId), eq(avatars.workspaceId, workspaceId)));
  if (!row) throw AppError.notFound('Avatar');
  return toWorkspaceAvatarDto(deps, row);
}
