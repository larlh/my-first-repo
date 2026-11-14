import { TtsCacheMetaSchema } from '@parlante/shared';
import type { ProviderRef, Providers, SceneRuntime } from '@parlante/shared';
import { storageKeys, ttsCacheKey } from '@parlante/shared/node';
import type { DbOrTx } from '@parlante/db';
import { resolveVoice } from './voices';

/** The fields of a TTS script that define its audio (same as `SynthesizeBody`). */
export interface SpeechRequest {
  text: string;
  voiceId: string;
  /** Locale of the text. */
  language: string;
  speed?: number;
  pitch?: number;
}

export interface CachedSpeech {
  /** Storage key of the WAV (PCM 16-bit mono). Turn it into a URL with `fileUrl(audioKey)`. */
  audioKey: string;
  /** Viseme and word timeline, times relative to the start of the audio. */
  runtime: SceneRuntime;
  /** Provider that produced the audio (honesty rule: surface it). */
  provider: ProviderRef;
  sampleRate: number;
  /** True when the audio came from the cache (nothing was synthesised now). */
  cached: boolean;
}

export interface SynthesisDeps {
  db: DbOrTx;
  providers: Pick<Providers, 'tts' | 'storage'>;
}

/**
 * Synthesize a narration ONCE and share it between the API (`POST /api/tts/synthesize`, which
 * the Studio calls for every scene preview) and the worker (render, translation dubbing): the
 * render of a previewed scene finds the entry the API wrote, with exactly the timeline the
 * user saw. This function owns the cache protocol — do not read or write `cache/tts/*` by hand:
 *
 *   key   = ttsCacheKey({ provider, providerVoiceId, text.trim(), language, speed, pitch, profile })
 *   files = cache/tts/<key>.wav  +  cache/tts/<key>.json  (TtsCacheMetaSchema)
 *
 * The JSON is written last and is the commit marker; an entry whose JSON is missing or does not
 * parse is a miss and gets rewritten. Moderation is the CALLER's job (the API route moderates
 * before calling; `startRender` moderated the whole document before the job runs).
 */
export async function synthesizeCached(
  deps: SynthesisDeps,
  workspaceId: string,
  request: SpeechRequest,
): Promise<CachedSpeech> {
  const { storage } = deps.providers;
  const voice = await resolveVoice(deps.db, deps.providers, workspaceId, request.voiceId);
  const text = request.text.trim();
  const speed = request.speed ?? 1;
  const pitch = request.pitch ?? 0;
  const hash = ttsCacheKey({
    provider: voice.tts.info.id,
    providerVoiceId: voice.providerVoiceId,
    text,
    language: request.language,
    speed,
    pitch,
    profile: voice.profile,
  });
  const audioKey = storageKeys.ttsCacheAudio(hash);
  const metaKey = storageKeys.ttsCacheMeta(hash);

  const hit = await readMeta(storage, metaKey);
  if (hit && (await storage.exists(audioKey))) {
    return {
      audioKey,
      runtime: hit.runtime,
      provider: hit.provider,
      sampleRate: hit.sampleRate,
      cached: true,
    };
  }

  const result = await voice.tts.synthesize({
    text,
    providerVoiceId: voice.providerVoiceId,
    language: request.language,
    speed,
    pitch,
    profile: voice.profile,
  });
  const meta = TtsCacheMetaSchema.parse({
    v: 1,
    runtime: {
      audioDurationMs: result.durationMs,
      visemes: result.visemes,
      words: result.words,
    },
    provider: result.provider,
    sampleRate: result.sampleRate,
  });
  await storage.put(audioKey, result.audio, { contentType: 'audio/wav' });
  await storage.put(metaKey, new TextEncoder().encode(JSON.stringify(meta)), {
    contentType: 'application/json',
  });
  return {
    audioKey,
    runtime: meta.runtime,
    provider: meta.provider,
    sampleRate: meta.sampleRate,
    cached: false,
  };
}

async function readMeta(storage: Providers['storage'], metaKey: string) {
  try {
    if (!(await storage.exists(metaKey))) return null;
    const parsed = TtsCacheMetaSchema.safeParse(
      JSON.parse(new TextDecoder().decode(await storage.get(metaKey))),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // unreadable entry = miss
  }
}
