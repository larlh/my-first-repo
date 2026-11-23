import { AppError, OK, api, newId } from '@parlante/shared';
import type { BrandKit } from '@parlante/shared';
import { and, assets, brandKits, desc, eq, inArray, ne } from '@parlante/db';
import type { BrandKitRow, Db, DbOrTx } from '@parlante/db';
import type { FileUrlBuilder } from '@parlante/jobs';
import { defineRoute } from '../../lib/define-route';
import { iso } from '../../lib/dto';
import { defineModule } from '../../lib/modules';
import { lockWorkspace } from '../workspaces/service';

/**
 * Brand kits are a short, unpaginated list (`GET /api/brand-kits` returns all of them), so
 * their number per workspace is bounded.
 */
export const MAX_BRAND_KITS = 50;

/** Storage keys of the logos of a set of kits, in one query scoped to the workspace. */
async function logoKeys(
  db: DbOrTx,
  workspaceId: string,
  rows: BrandKitRow[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((row) => (row.logoAssetId ? [row.logoAssetId] : [])))];
  if (ids.length === 0) return new Map();
  const logos = await db
    .select({ id: assets.id, storageKey: assets.storageKey })
    .from(assets)
    .where(and(inArray(assets.id, ids), eq(assets.workspaceId, workspaceId)));
  return new Map(logos.map((logo) => [logo.id, logo.storageKey]));
}

/** Row → DTO in ONE place; the logo travels as a signed URL, never as a storage key. */
async function toBrandKitDto(
  fileUrl: FileUrlBuilder,
  row: BrandKitRow,
  keys: Map<string, string>,
): Promise<BrandKit> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    logoAssetId: row.logoAssetId,
    logoUrl: await fileUrl(row.logoAssetId ? keys.get(row.logoAssetId) : null),
    colors: row.colors,
    fonts: row.fonts,
    isDefault: row.isDefault,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

async function oneDto(db: Db, fileUrl: FileUrlBuilder, row: BrandKitRow): Promise<BrandKit> {
  return toBrandKitDto(fileUrl, row, await logoKeys(db, row.workspaceId, [row]));
}

/** Load a brand kit of THIS workspace or 404 (a foreign id looks like a missing one). */
async function findBrandKit(
  db: DbOrTx,
  workspaceId: string,
  brandKitId: string,
): Promise<BrandKitRow> {
  const [row] = await db
    .select()
    .from(brandKits)
    .where(and(eq(brandKits.id, brandKitId), eq(brandKits.workspaceId, workspaceId)));
  if (!row) throw AppError.notFound('Brand kit');
  return row;
}

/**
 * The logo must be an image from the asset library of the same workspace. Source photos of
 * people (`avatar_source`) and other non-library uploads cannot be turned into a logo.
 */
async function assertLogoAsset(
  db: DbOrTx,
  workspaceId: string,
  assetId: string | null | undefined,
) {
  if (!assetId) return;
  const [asset] = await db
    .select({ kind: assets.kind, purpose: assets.purpose })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)));
  if (!asset || asset.purpose !== 'library') {
    throw AppError.validation('Logo asset not found', [
      { path: 'logoAssetId', message: 'Not found' },
    ]);
  }
  if (asset.kind !== 'image') {
    throw AppError.validation('The logo must be an image', [
      { path: 'logoAssetId', message: 'Not an image' },
    ]);
  }
}

/** "At most one default per workspace": clear the flag on every other kit. */
async function clearOtherDefaults(tx: DbOrTx, workspaceId: string, keepId: string) {
  await tx
    .update(brandKits)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(brandKits.workspaceId, workspaceId),
        eq(brandKits.isDefault, true),
        ne(brandKits.id, keepId),
      ),
    );
}

export default defineModule({
  name: 'brand-kits',
  register(app) {
    defineRoute(app, api.brandKits.list, async ({ auth, app: { db, fileUrl } }) => {
      // The default kit first (it is the one pre-selected for new videos), then newest first.
      const rows = await db
        .select()
        .from(brandKits)
        .where(eq(brandKits.workspaceId, auth.workspaceId))
        .orderBy(desc(brandKits.isDefault), desc(brandKits.createdAt), desc(brandKits.id))
        .limit(MAX_BRAND_KITS);
      const keys = await logoKeys(db, auth.workspaceId, rows);
      return { items: await Promise.all(rows.map((row) => toBrandKitDto(fileUrl, row, keys))) };
    });

    defineRoute(app, api.brandKits.create, async ({ auth, body, app: { db, fileUrl } }) => {
      const row = await db.transaction(async (tx) => {
        // Count, default switch and insert under the workspace lock: two concurrent requests
        // can neither exceed the cap nor leave two default kits.
        await lockWorkspace(tx, auth.workspaceId);
        await assertLogoAsset(tx, auth.workspaceId, body.logoAssetId);
        const existing = await tx.$count(brandKits, eq(brandKits.workspaceId, auth.workspaceId));
        if (existing >= MAX_BRAND_KITS) {
          throw new AppError(
            'PLAN_LIMIT_EXCEEDED',
            `A workspace can have at most ${MAX_BRAND_KITS} brand kits`,
            { limit: 'maxBrandKits', max: MAX_BRAND_KITS, value: existing + 1 },
          );
        }
        const [created] = await tx
          .insert(brandKits)
          .values({
            id: newId('brandKit'),
            workspaceId: auth.workspaceId,
            name: body.name,
            logoAssetId: body.logoAssetId,
            colors: body.colors,
            fonts: body.fonts,
            isDefault: body.isDefault,
            createdBy: auth.userId,
          })
          .returning();
        if (!created) throw new Error('Insert returned no row');
        if (created.isDefault) await clearOtherDefaults(tx, auth.workspaceId, created.id);
        return created;
      });
      return oneDto(db, fileUrl, row);
    });

    defineRoute(app, api.brandKits.get, async ({ auth, params, app: { db, fileUrl } }) =>
      oneDto(db, fileUrl, await findBrandKit(db, auth.workspaceId, params.brandKitId)),
    );

    defineRoute(app, api.brandKits.update, async ({ auth, params, body, app: { db, fileUrl } }) => {
      const row = await db.transaction(async (tx) => {
        await lockWorkspace(tx, auth.workspaceId);
        const current = await findBrandKit(tx, auth.workspaceId, params.brandKitId);
        // Only a logo that is being SET is checked; clearing it (null) is always allowed.
        if (body.logoAssetId && body.logoAssetId !== current.logoAssetId) {
          await assertLogoAsset(tx, auth.workspaceId, body.logoAssetId);
        }
        const [updated] = await tx
          .update(brandKits)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.logoAssetId !== undefined ? { logoAssetId: body.logoAssetId } : {}),
            // Partial patches: colours / fonts that are not sent keep their stored value.
            ...(body.colors ? { colors: { ...current.colors, ...definedOnly(body.colors) } } : {}),
            ...(body.fonts ? { fonts: { ...current.fonts, ...definedOnly(body.fonts) } } : {}),
            ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
            updatedAt: new Date(),
          })
          // The workspace filter is repeated on the write: never update by id alone.
          .where(and(eq(brandKits.id, current.id), eq(brandKits.workspaceId, auth.workspaceId)))
          .returning();
        if (!updated) throw AppError.notFound('Brand kit');
        if (body.isDefault) await clearOtherDefaults(tx, auth.workspaceId, updated.id);
        return updated;
      });
      return oneDto(db, fileUrl, row);
    });

    defineRoute(app, api.brandKits.remove, async ({ auth, params, app: { db } }) => {
      // Videos keep the colours and fonts already applied to their composition; deleting the
      // default kit simply leaves the workspace without a default.
      const deleted = await db
        .delete(brandKits)
        .where(
          and(eq(brandKits.id, params.brandKitId), eq(brandKits.workspaceId, auth.workspaceId)),
        )
        .returning({ id: brandKits.id });
      if (deleted.length === 0) throw AppError.notFound('Brand kit');
      return OK;
    });
  },
});

/** Drop keys whose value is `undefined` so a spread never erases a stored value. */
function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
