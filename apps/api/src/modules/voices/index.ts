import { AppError, api, isAppError } from '@parlante/shared';
import { synthesizeCached } from '@parlante/jobs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { defineRoute } from '../../lib/define-route';
import { defineModule } from '../../lib/modules';
import { getVoice, listVoiceCatalog } from './catalog';
import type { VoiceCatalogDeps } from './catalog';

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
    defineRoute(app, api.voices.synthesize, async ({ auth, body, app: instance }) => {
      const { db, providers, fileUrl } = instance;
      const verdict = await providers.moderation.check({
        text: body.text,
        language: body.language,
        context: 'script',
      });
      if (!verdict.allowed) {
        throw new AppError('CONTENT_BLOCKED', 'This text was blocked by moderation', {
          flags: verdict.flags,
        });
      }
      let speech: Awaited<ReturnType<typeof synthesizeCached>>;
      try {
        speech = await synthesizeCached({ db, providers }, auth.workspaceId, {
          text: body.text,
          voiceId: body.voiceId,
          language: body.language,
          speed: body.speed,
          pitch: body.pitch,
        });
      } catch (err) {
        if (isAppError(err)) throw err;
        throw new AppError(
          'PROVIDER_ERROR',
          'The voice provider could not synthesize this text. Try again',
          { voiceId: body.voiceId },
          { cause: err },
        );
      }
      return {
        audioUrl: await fileUrl(speech.audioKey),
        mimeType: 'audio/wav' as const,
        runtime: speech.runtime,
        // Honesty rule: who actually produced this audio (basic local voice or premium).
        provider: speech.provider,
      };
    });
  },
});
