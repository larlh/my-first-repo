import { AppError, isAppError } from '@parlante/shared';
import type { SynthesizedSpeech } from '@parlante/shared';
import { synthesizeCached } from '@parlante/jobs';
import type { FastifyInstance } from 'fastify';

type CacheDeps = Parameters<typeof synthesizeCached>[0];
type SynthesizeBody = Parameters<typeof synthesizeCached>[2];

export interface SynthesizeDeps {
  db: CacheDeps['db'];
  providers: CacheDeps['providers'] & Pick<FastifyInstance['providers'], 'moderation'>;
  fileUrl: FastifyInstance['fileUrl'];
}

/**
 * Text → WAV + timeline with any voice of the workspace (stock or cloned), shared by the app
 * (`POST /api/tts/synthesize`) and the public API (`POST /v1/speech`) so both moderate,
 * resolve voices and cache exactly alike. Moderation (context `script`) is applied here — the
 * same check a render applies to the whole document; voice resolution (provider active,
 * cloned voice of THIS workspace and ready) and the cache shared with the worker are
 * `synthesizeCached`, so a render reuses exactly the audio and timeline returned here.
 */
export async function synthesizeForWorkspace(
  deps: SynthesizeDeps,
  workspaceId: string,
  body: SynthesizeBody,
): Promise<SynthesizedSpeech> {
  const { db, providers, fileUrl } = deps;
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
    speech = await synthesizeCached({ db, providers }, workspaceId, {
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
    // Honesty rule: who actually produced this audio (basic local voice, local clone, premium).
    provider: speech.provider,
  };
}
