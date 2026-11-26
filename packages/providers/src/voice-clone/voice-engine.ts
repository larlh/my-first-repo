import { z } from 'zod';
import { AppError } from '@parlante/shared';
import type { ProviderRef } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { readJson, speechFetch } from '../tts/http';
import type { SpeechHttpOptions } from '../tts/http';

/* -------------------------------------------------------------------------------------------
 * Client of services/voice-engine: realistic LOCAL voice cloning with Chatterbox Multilingual
 * (Resemble AI, MIT) and its Spain-Spanish T3. The engine keeps, per cloned voice, only the
 * conditionals derived from the sample (`cbx_…` ids); every audio it returns carries the Perth
 * watermark, checked by the engine's detector before it answers (`watermark` = score 0..1).
 *
 *   GET    /health            state, device, licence, defaults (exaggeration 0.3, cfg 0.7, temp 0.7)
 *   POST   /v1/voices         {sampleWav, language, consentId} → {voiceId, referenceSec}
 *   DELETE /v1/voices/:id     {deleted} (idempotent)
 *   POST   /v1/speech         {voiceId, text, language, speed, pitch} → {audioWav, segments, …}
 * ----------------------------------------------------------------------------------------- */

export const CHATTERBOX_INFO: ProviderRef = {
  id: 'chatterbox',
  name: 'Chatterbox es-ES (local)',
  quality: 'premium',
  local: true,
};

const SERVICE = 'The local voice engine';
/** Ids the engine hands out; anything else never reaches it (no path games). */
export const CHATTERBOX_VOICE_ID = /^cbx_[a-z0-9]{20}$/;
/** Languages the engine can clone and speak (its T3 is the Spain-Spanish finetune). */
export const CHATTERBOX_LANGUAGES: readonly string[] = ['es'];

const HEALTH_TTL_MS = 5000;
const HEALTH_TIMEOUT_MS = 2500;
const LOADING_WAIT_MS = 120_000;
const LOADING_POLL_MS = 2000;
const REGISTER_TIMEOUT_MS = 120_000;
/** Generation runs about real time on a GPU and several times slower on a CPU. */
const SPEECH_TIMEOUT_MS = 30 * 60_000;
const DELETE_TIMEOUT_MS = 15_000;

const HealthSchema = z.object({
  ready: z.boolean(),
  loading: z.boolean(),
  error: z.string().nullable(),
  device: z.string().nullable(),
  languages: z.array(z.string()),
  watermark: z.literal('perth'),
});
export type VoiceEngineHealth = z.infer<typeof HealthSchema>;

const RegisterSchema = z.object({
  voiceId: z.string().regex(CHATTERBOX_VOICE_ID),
  referenceSec: z.number(),
});

const SpeechSchema = z.object({
  audioWav: z.string().min(1),
  sampleRate: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  watermark: z.number(),
  segments: z.array(
    z.object({ text: z.string(), startMs: z.number().int(), endMs: z.number().int() }),
  ),
});
export type VoiceEngineSpeech = Omit<z.infer<typeof SpeechSchema>, 'audioWav'> & {
  audio: Uint8Array;
};

/** Below this detector score the engine never returns audio; double-checked here. */
export const WATERMARK_THRESHOLD = 0.5;

export interface VoiceEngineOptions extends SpeechHttpOptions {
  /** Injected in tests. */
  now?: () => number;
}

export interface VoiceEngineClient {
  /** Engine state, or null when it does not answer (cached for a few seconds). */
  health(): Promise<VoiceEngineHealth | null>;
  /** True when the engine answers and has not failed to load (it may still be loading). */
  usable(): Promise<boolean>;
  registerVoice(input: {
    sampleWav: Uint8Array;
    language: string;
    consentId: string;
  }): Promise<{ voiceId: string; referenceSec: number }>;
  deleteVoice(voiceId: string): Promise<void>;
  speech(input: {
    voiceId: string;
    text: string;
    language: string;
    speed: number;
    pitch: number;
  }): Promise<VoiceEngineSpeech>;
}

export function createVoiceEngineClient(
  env: Pick<ProviderEnv, 'VOICE_ENGINE_URL' | 'VOICE_ENGINE_TOKEN'>,
  options: VoiceEngineOptions = {},
): VoiceEngineClient {
  const base = env.VOICE_ENGINE_URL.replace(/\/+$/, '');
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const headers = (json: boolean): Record<string, string> => ({
    accept: 'application/json',
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(env.VOICE_ENGINE_TOKEN ? { authorization: `Bearer ${env.VOICE_ENGINE_TOKEN}` } : {}),
  });
  // One attempt per call: a generation is expensive and the engine answers 503 while loading,
  // which `ready()` waits for explicitly.
  const http: SpeechHttpOptions = { ...options, maxAttempts: 1 };

  let cached: { at: number; value: VoiceEngineHealth | null } | null = null;

  async function health(): Promise<VoiceEngineHealth | null> {
    if (cached && now() - cached.at < HEALTH_TTL_MS) return cached.value;
    let value: VoiceEngineHealth | null;
    try {
      const response = await speechFetch(http, {
        service: SERVICE,
        url: `${base}/health`,
        init: () => ({ method: 'GET', headers: headers(false) }),
        timeoutMs: HEALTH_TIMEOUT_MS,
      });
      const parsed = HealthSchema.safeParse(await response.json());
      value = parsed.success ? parsed.data : null;
    } catch {
      value = null;
    }
    cached = { at: now(), value };
    return value;
  }

  async function usable(): Promise<boolean> {
    const state = await health();
    return state !== null && state.error === null;
  }

  /** Wait while the engine loads its models; fail clearly when it is down or broken. */
  async function ready(): Promise<void> {
    const deadline = now() + LOADING_WAIT_MS;
    for (;;) {
      const state = await health();
      if (!state) {
        throw new AppError(
          'PROVIDER_ERROR',
          'The local voice engine is not running. Start it with `pnpm voice-engine` and try again',
          { service: 'voice-engine' },
        );
      }
      if (state.error !== null) {
        throw new AppError(
          'PROVIDER_ERROR',
          `The local voice engine could not start: ${state.error}`,
          {
            service: 'voice-engine',
          },
        );
      }
      if (state.ready) return;
      if (now() >= deadline) {
        throw new AppError('PROVIDER_ERROR', 'The local voice engine is still loading its models', {
          service: 'voice-engine',
        });
      }
      cached = null;
      await sleep(LOADING_POLL_MS);
    }
  }

  async function registerVoice(input: {
    sampleWav: Uint8Array;
    language: string;
    consentId: string;
  }): Promise<{ voiceId: string; referenceSec: number }> {
    await ready();
    const response = await speechFetch(http, {
      service: SERVICE,
      url: `${base}/v1/voices`,
      init: () => ({
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({
          sampleWav: Buffer.from(input.sampleWav).toString('base64'),
          language: input.language,
          consentId: input.consentId,
        }),
      }),
      timeoutMs: REGISTER_TIMEOUT_MS,
      acceptStatus: [422],
    });
    const body = await readJson(SERVICE, response);
    if (response.status === 422) {
      const message = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
      throw new AppError(
        'UNPROCESSABLE',
        message.success ? message.data.error.message : 'The voice sample cannot be cloned',
      );
    }
    const parsed = RegisterSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError('PROVIDER_ERROR', 'The local voice engine did not return the new voice');
    }
    return parsed.data;
  }

  /** Idempotent: an unknown voice counts as deleted. */
  async function deleteVoice(voiceId: string): Promise<void> {
    if (!CHATTERBOX_VOICE_ID.test(voiceId)) return;
    await speechFetch(http, {
      service: SERVICE,
      url: `${base}/v1/voices/${voiceId}`,
      init: () => ({ method: 'DELETE', headers: headers(false) }),
      timeoutMs: DELETE_TIMEOUT_MS,
    });
  }

  async function speech(input: {
    voiceId: string;
    text: string;
    language: string;
    speed: number;
    pitch: number;
  }): Promise<VoiceEngineSpeech> {
    if (!CHATTERBOX_VOICE_ID.test(input.voiceId)) {
      throw new AppError('NOT_FOUND', 'Voice not found', { provider: CHATTERBOX_INFO.id });
    }
    await ready();
    const response = await speechFetch(http, {
      service: SERVICE,
      url: `${base}/v1/speech`,
      init: () => ({
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify(input),
      }),
      timeoutMs: SPEECH_TIMEOUT_MS,
      acceptStatus: [404],
    });
    if (response.status === 404) {
      void response.body?.cancel().catch(() => undefined);
      throw new AppError(
        'NOT_FOUND',
        'This cloned voice no longer exists in the local voice engine; clone it again',
        { provider: CHATTERBOX_INFO.id },
      );
    }
    const parsed = SpeechSchema.safeParse(await readJson(SERVICE, response));
    if (!parsed.success) {
      throw new AppError('PROVIDER_ERROR', 'The local voice engine returned an unreadable answer');
    }
    // The engine refuses unmarked audio; never pass on audio whose mark was not confirmed.
    if (parsed.data.watermark < WATERMARK_THRESHOLD) {
      throw new AppError('PROVIDER_ERROR', 'The voice engine returned audio without its watermark');
    }
    const { audioWav, ...rest } = parsed.data;
    return { ...rest, audio: new Uint8Array(Buffer.from(audioWav, 'base64')) };
  }

  return { health, usable, registerVoice, deleteVoice, speech };
}
