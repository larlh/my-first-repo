import { AppError, OK, api, buildPage, buildPath, localizeCatalogEntry } from '@parlante/shared';
import type { StockAsset } from '@parlante/shared';
import { and, assets, cursorOrder, cursorWhere, eq, ilike, users } from '@parlante/db';
import type { AssetRow, Db } from '@parlante/db';
import { listStockAssets } from '@parlante/stock-assets';
import { getStockAssetData } from '@parlante/stock-assets/node';
import { sendPublicBinary } from '../../lib/binary';
import { defineRoute } from '../../lib/define-route';
import { toUserRef } from '../../lib/dto';
import { planLimits } from '../../lib/limits';
import { defineModule } from '../../lib/modules';
import { receiveUpload } from '../../lib/uploads';
import { deleteAsset, storeUploadedAsset, toAssetDto } from './service';

/** `%` and `_` typed by the user are literal characters, not LIKE wildcards. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const creatorColumns = { id: users.id, name: users.name };

/** Load an asset of THIS workspace (with its uploader) or 404. */
async function findAsset(db: Db, workspaceId: string, assetId: string) {
  const [found] = await db
    .select({ asset: assets, creator: creatorColumns })
    .from(assets)
    .leftJoin(users, eq(assets.createdBy, users.id))
    .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)));
  if (!found) throw AppError.notFound('Asset');
  return found;
}

export default defineModule({
  name: 'assets',
  register(app) {
    defineRoute(app, api.assets.list, async ({ auth, query, app: { db, fileUrl } }) => {
      const rows = await db
        .select({ asset: assets, creator: creatorColumns })
        .from(assets)
        .leftJoin(users, eq(assets.createdBy, users.id))
        .where(
          and(
            eq(assets.workspaceId, auth.workspaceId),
            // Source photos, voice samples and translation sources stay out of the library.
            eq(assets.purpose, query.purpose),
            query.kind ? eq(assets.kind, query.kind) : undefined,
            query.q ? ilike(assets.name, likePattern(query.q)) : undefined,
            cursorWhere(assets.createdAt, assets.id, query.cursor),
          ),
        )
        .orderBy(...cursorOrder(assets.createdAt, assets.id))
        .limit(query.limit + 1);
      const creators = new Map(rows.map((row) => [row.asset.id, row.creator]));
      const page = buildPage<AssetRow>(
        rows.map((row) => row.asset),
        query.limit,
      );
      return {
        items: await Promise.all(
          page.items.map((row) => toAssetDto(fileUrl, row, toUserRef(creators.get(row.id)))),
        ),
        nextCursor: page.nextCursor,
      };
    });

    defineRoute(
      app,
      api.assets.upload,
      async ({ auth, request, app: { db, providers, fileUrl } }) => {
        // Size is enforced while streaming; the type comes from the bytes, not from the client.
        const upload = await receiveUpload(request, {
          maxBytes: planLimits(auth.workspace).maxUploadBytes,
        });
        try {
          const fields = api.assets.upload.multipart.fields.parse(upload.fields);
          const row = await storeUploadedAsset(
            { db, providers },
            {
              workspace: auth.workspace,
              userId: auth.userId,
              upload,
              name: fields.name,
              purpose: fields.purpose,
            },
          );
          return await toAssetDto(fileUrl, row, toUserRef(auth.user));
        } finally {
          await upload.cleanup();
        }
      },
    );

    defineRoute(app, api.assets.get, async ({ auth, params, app: { db, fileUrl } }) => {
      const { asset, creator } = await findAsset(db, auth.workspaceId, params.assetId);
      return toAssetDto(fileUrl, asset, toUserRef(creator));
    });

    defineRoute(app, api.assets.update, async ({ auth, params, body, app: { db, fileUrl } }) => {
      const [updated] = await db
        .update(assets)
        .set({ name: body.name })
        .where(and(eq(assets.id, params.assetId), eq(assets.workspaceId, auth.workspaceId)))
        .returning({ id: assets.id });
      if (!updated) throw AppError.notFound('Asset');
      const { asset, creator } = await findAsset(db, auth.workspaceId, params.assetId);
      return toAssetDto(fileUrl, asset, toUserRef(creator));
    });

    defineRoute(app, api.assets.remove, async ({ auth, params, app: { db, providers } }) => {
      await deleteAsset({ db, providers }, auth.workspaceId, params.assetId);
      return OK;
    });

    /* ---------- built-in stock media (code-generated files of @parlante/stock-assets) ---------- */

    defineRoute(app, api.assets.listStock, async ({ auth, query, app: { config } }) => {
      const base = config.PUBLIC_API_URL.replace(/\/+$/, '');
      const items: StockAsset[] = listStockAssets()
        .filter((meta) => !query.kind || meta.kind === query.kind)
        .filter((meta) => !query.category || meta.category === query.category)
        .map((meta) => {
          const text = localizeCatalogEntry(meta, auth.user.locale);
          return {
            id: meta.id,
            kind: meta.kind,
            category: meta.category,
            name: text.name,
            tags: text.tags,
            mimeType: meta.mimeType,
            width: meta.width,
            height: meta.height,
            durationMs: meta.durationMs,
            url: `${base}${buildPath(api.assets.stockFile.path, { stockId: meta.id })}`,
          };
        });
      return { items };
    });

    defineRoute(app, api.assets.stockFile, async ({ params, reply }) =>
      // Ids are looked up in the catalogue (code); unknown ones are a 404.
      sendPublicBinary(reply, await getStockAssetData(params.stockId)),
    );
  },
});
