import { api } from '@parlante/shared';
import { describeCapabilities } from '@parlante/providers';
import { getStockPhotorealAvatarFile } from '@parlante/stock-assets/node';
import type { FastifyInstance } from 'fastify';
import { sendPublicBinary } from '../../lib/binary';
import { defineRoute } from '../../lib/define-route';
import { defineModule } from '../../lib/modules';
import { getAvatar, listAvatarCatalog } from './catalog';
import type { AvatarCatalogDeps } from './catalog';

function catalogDeps(app: FastifyInstance): AvatarCatalogDeps {
  return {
    db: app.db,
    providers: app.providers,
    fileUrl: app.fileUrl,
    publicApiUrl: app.config.PUBLIC_API_URL,
  };
}

export default defineModule({
  name: 'avatars',
  register(app) {
    defineRoute(app, api.avatars.list, async ({ auth, query, app: instance }) => {
      const [items, capabilities] = await Promise.all([
        listAvatarCatalog(catalogDeps(instance), auth.workspaceId, auth.user.locale, query),
        // Never throws: a stopped engine is reported as unavailable with its reason, so the
        // library can label photorealistic avatars honestly instead of failing at render time.
        describeCapabilities(instance.providers),
      ]);
      return { items, engine: capabilities.avatarEngine };
    });

    defineRoute(app, api.avatars.get, async ({ auth, params, app: instance }) =>
      getAvatar(catalogDeps(instance), auth.workspaceId, auth.user.locale, params.avatarId),
    );

    defineRoute(app, api.avatars.stockFile, async ({ params, reply }) =>
      // Versioned files of synthetic people, looked up in the catalogue by id (public and
      // immutable per id). Unknown ids, or `mask` of an avatar without matte, are a 404.
      sendPublicBinary(reply, await getStockPhotorealAvatarFile(params.avatarId, params.file)),
    );
  },
});
