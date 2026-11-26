import { api } from '@parlante/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { defineRoute } from '../../lib/define-route';
import { defineModule } from '../../lib/modules';
import { getVoice, listVoiceCatalog } from './catalog';
import type { VoiceCatalogDeps } from './catalog';
import { synthesizeForWorkspace } from './synthesize';

function catalogDeps(app: FastifyInstance, request: FastifyRequest): VoiceCatalogDeps {
  return {
    db: app.db,
    providers: app.providers,
    onProviderError: (providerId, error) =>
      request.log.warn({ err: error, providerId }, 'TTS provider could not list its voices'),
  };
}

export default defineModule({
  name: 'voices',
  register(app) {
    defineRoute(app, api.voices.list, async ({ auth, query, request, app: instance }) => ({
      items: await listVoiceCatalog(catalogDeps(instance, request), auth.workspaceId, query),
    }));

    defineRoute(app, api.voices.get, async ({ auth, params, request, app: instance }) =>
      getVoice(catalogDeps(instance, request), auth.workspaceId, params.voiceId),
    );

    /**
     * Voice preview and Studio live preview. Moderation is this route's job (the same check a
     * render applies to the whole document); voice resolution — provider active, cloned voice
     * of THIS workspace and ready — and the cache shared with the worker are
     * `synthesizeCached`, so the render reuses exactly the audio and timeline previewed here.
     */
    defineRoute(app, api.voices.synthesize, async ({ auth, body, app: instance }) =>
      synthesizeForWorkspace(instance, auth.workspaceId, body),
    );
  },
});
