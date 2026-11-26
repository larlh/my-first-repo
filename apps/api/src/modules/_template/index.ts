import { AppError, api, buildPage, newId } from '@parlante/shared';
import type { BrandKit } from '@parlante/shared';
import { and, assets, brandKits, cursorOrder, cursorWhere, eq } from '@parlante/db';
import type { BrandKitRow, Db } from '@parlante/db';
import { defineRoute } from '../../lib/define-route';
import { iso } from '../../lib/dto';
import { defineModule } from '../../lib/modules';
import type { FileUrlBuilder } from '@parlante/jobs';

/* -------------------------------------------------------------------------------------------
 * REFERENCE MODULE — not autoloaded (directories starting with `_` are skipped); it is
 * registered only by its own test. Copy this directory to start a database-backed module.
 *
 * It implements the brand-kit contract end to end and demonstrates the mandatory patterns:
 *   1. WORKSPACE SCOPING: every query filters by `auth.workspaceId`. A resource of another
 *      workspace is indistinguishable from a missing one → 404 NOT_FOUND (never 403).
 *   2. ROLES come from the contract (`minRole`); handlers do not re-check them.
 *   3. Referenced resources (here `logoAssetId`) are verified to belong to the workspace.
 *   4. Row → DTO mapping in one function; dates as ISO strings; files as signed URLs via
 *      `app.fileUrl(storageKey)` — never raw storage keys.
 *   5. Errors are thrown as `AppError`; the error handler serialises them.
 *   6. Multi-statement changes run in `db.transaction`.
 * ----------------------------------------------------------------------------------------- */

async function toBrandKitDto(db: Db, fileUrl: FileUrlBuilder, row: BrandKitRow): Promise<BrandKit> {
  let logoUrl: string | null = null;
  if (row.logoAssetId) {
    const [logo] = await db
      .select({ storageKey: assets.storageKey })
      .from(assets)
      .where(and(eq(assets.id, row.logoAssetId), eq(assets.workspaceId, row.workspaceId)));
    logoUrl = await fileUrl(logo?.storageKey);
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    logoAssetId: row.logoAssetId,
    logoUrl,
    colors: row.colors,
    fonts: row.fonts,
    isDefault: row.isDefault,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** Load a brand kit of THIS workspace or throw 404. */
async function findBrandKit(db: Db, workspaceId: string, brandKitId: string): Promise<BrandKitRow> {
  const [row] = await db
    .select()
    .from(brandKits)
    .where(and(eq(brandKits.id, brandKitId), eq(brandKits.workspaceId, workspaceId)));
  if (!row) throw AppError.notFound('Brand kit');
  return row;
}

/** A referenced asset must be an image of the same workspace. */
async function assertLogoAsset(db: Db, workspaceId: string, assetId: string | null | undefined) {
  if (!assetId) return;
  const [asset] = await db
    .select({ kind: assets.kind })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)));
  if (!asset)
    throw AppError.validation('Logo asset not found', [
      { path: 'logoAssetId', message: 'Not found' },
    ]);
  if (asset.kind !== 'image') {
    throw AppError.validation('The logo must be an image', [
      { path: 'logoAssetId', message: 'Not an image' },
    ]);
  }
}

export default defineModule({
  name: 'template-brand-kits',
  register(app) {
    defineRoute(app, api.brandKits.list, async ({ auth, app: { db, fileUrl } }) => {
      const rows = await db
        .select()
        .from(brandKits)
        .where(
          and(
            eq(brandKits.workspaceId, auth.workspaceId),
            cursorWhere(brandKits.createdAt, brandKits.id, undefined),
          ),
        )
        .orderBy(...cursorOrder(brandKits.createdAt, brandKits.id))
        .limit(200);
      // Paginated endpoints: fetch `limit + 1` rows with `cursorWhere(…, query.cursor)` and
      // return `buildPage(rows, query.limit)` mapped to DTOs (see `buildPage` below).
      const page = buildPage(rows, 200);
      return { items: await Promise.all(page.items.map((row) => toBrandKitDto(db, fileUrl, row))) };
    });

    defineRoute(app, api.brandKits.create, async ({ auth, body, app: { db, fileUrl } }) => {
      await assertLogoAsset(db, auth.workspaceId, body.logoAssetId);
      const row = await db.transaction(async (tx) => {
        if (body.isDefault) {
          await tx
            .update(brandKits)
            .set({ isDefault: false })
            .where(eq(brandKits.workspaceId, auth.workspaceId));
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
        return created;
      });
      return toBrandKitDto(db, fileUrl, row);
    });

    defineRoute(app, api.brandKits.get, async ({ auth, params, app: { db, fileUrl } }) => {
      return toBrandKitDto(
        db,
        fileUrl,
        await findBrandKit(db, auth.workspaceId, params.brandKitId),
      );
    });

    defineRoute(app, api.brandKits.update, async ({ auth, params, body, app: { db, fileUrl } }) => {
      const current = await findBrandKit(db, auth.workspaceId, params.brandKitId);
      await assertLogoAsset(db, auth.workspaceId, body.logoAssetId);
      const row = await db.transaction(async (tx) => {
        if (body.isDefault) {
          await tx
            .update(brandKits)
            .set({ isDefault: false })
            .where(eq(brandKits.workspaceId, auth.workspaceId));
        }
        const [updated] = await tx
          .update(brandKits)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.logoAssetId !== undefined ? { logoAssetId: body.logoAssetId } : {}),
            ...(body.colors ? { colors: { ...current.colors, ...body.colors } } : {}),
            ...(body.fonts ? { fonts: { ...current.fonts, ...body.fonts } } : {}),
            ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
            updatedAt: new Date(),
          })
          // The workspace filter is repeated on the write: never update by id alone.
          .where(and(eq(brandKits.id, current.id), eq(brandKits.workspaceId, auth.workspaceId)))
          .returning();
        if (!updated) throw AppError.notFound('Brand kit');
        return updated;
      });
      return toBrandKitDto(db, fileUrl, row);
    });

    defineRoute(app, api.brandKits.remove, async ({ auth, params, app: { db } }) => {
      const deleted = await db
        .delete(brandKits)
        .where(
          and(eq(brandKits.id, params.brandKitId), eq(brandKits.workspaceId, auth.workspaceId)),
        )
        .returning({ id: brandKits.id });
      if (deleted.length === 0) throw AppError.notFound('Brand kit');
      return { ok: true as const };
    });
  },
});
