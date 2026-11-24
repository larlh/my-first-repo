import path from 'node:path';
import { z } from 'zod';
import { envBoolean, envOptionalString, findRepoRoot } from '@parlante/shared/node';
import { DEFAULT_WHISPER_MODEL, WHISPER_MODEL_IDS } from './stt/whisper-models';
import { DEFAULT_KOKORO_VARIANT, KOKORO_VARIANT_IDS } from './tts/neural-models';

/**
 * Environment variables that select and configure providers. `auto` (the default) means: use
 * the external adapter when its key is configured, otherwise the local implementation — so the
 * product works with zero keys and gets better when keys are added.
 * Documented in `.env.example`.
 */
export const providerEnvSchema = z.object({
  // ---- storage
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  /** Directory for local storage. Relative paths resolve from the repo root. */
  STORAGE_LOCAL_DIR: z.string().default('./data/storage'),
  S3_ENDPOINT: envOptionalString,
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: envOptionalString,
  S3_ACCESS_KEY_ID: envOptionalString,
  S3_SECRET_ACCESS_KEY: envOptionalString,
  S3_FORCE_PATH_STYLE: envBoolean(true),
  /** Temporary credentials (AWS STS) need the session token next to the key pair. */
  S3_SESSION_TOKEN: envOptionalString,
  /**
   * Endpoint written into SIGNED URLs when browsers reach the bucket under another host than
   * the servers do (docker compose: servers use http://minio:9000, browsers
   * http://localhost:9000). Defaults to S3_ENDPOINT.
   */
  S3_PUBLIC_ENDPOINT: envOptionalString,

  // ---- TTS
  /**
   * Provider whose voices are the DEFAULT of new content. `auto` → an external one when its
   * key is set, else the local neural voices when they are installed (`pnpm voices:setup`),
   * else eSpeak. `neural` prefers the local neural voices even when a key is set. Every
   * provider whose requirements are met stays active whatever this says.
   */
  TTS_PROVIDER: z.enum(['auto', 'espeak', 'elevenlabs', 'openai', 'neural']).default('auto'),
  ELEVENLABS_API_KEY: envOptionalString,
  ELEVENLABS_MODEL: z.string().default('eleven_multilingual_v2'),
  /** Origin of the ElevenLabs API (TTS and voice cloning); change it only for a proxy. */
  ELEVENLABS_BASE_URL: z.string().url().default('https://api.elevenlabs.io'),
  OPENAI_API_KEY: envOptionalString,
  OPENAI_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  /**
   * Base URL of the OpenAI API (TTS and Whisper), including `/v1`. Any server that speaks the
   * same `audio/speech` and `audio/transcriptions` endpoints works (a proxy, a self-hosted one).
   */
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),

  // ---- local neural voices (Kokoro and Piper, docs/MODELS.md)
  /** Directory of the voice models. Relative paths resolve from the repo root. */
  VOICE_MODEL_DIR: z.string().default('./data/models'),
  /** Precision of the Kokoro weights to load (install it with `pnpm voices:setup`). */
  VOICE_KOKORO_VARIANT: z.enum(KOKORO_VARIANT_IDS).default(DEFAULT_KOKORO_VARIANT),
  /** CPU threads of the voice models. 0 = every core, up to 4. */
  VOICE_THREADS: z.coerce.number().int().min(0).max(64).default(0),
  /**
   * Where ONNX Runtime runs the voice models. `cpu` is what was measured and tested. `dml`
   * (DirectML, Windows) and `cuda` ask the runtime for a GPU and fall back to the CPU when it
   * cannot be used; NOT verified (docs/MODELS.md).
   */
  VOICE_DEVICE: z.enum(['cpu', 'dml', 'cuda']).default('cpu'),
  /** Unload the voice models after this many seconds without use (0 = keep them in memory). */
  VOICE_IDLE_UNLOAD_SEC: z.coerce.number().int().min(0).max(86_400).default(900),

  // ---- STT
  /**
   * `auto` → `openai` when keyed, else `local-whisper` when its model is installed, else
   * `manual` (the user supplies the transcript).
   */
  STT_PROVIDER: z.enum(['auto', 'manual', 'openai', 'local-whisper']).default('auto'),
  OPENAI_STT_MODEL: z.string().default('whisper-1'),

  // ---- local speech recognition (dictation by microphone, and STT when no key is set)
  /** Local Whisper model (docs/MODELS.md). Install it with `pnpm dictation:setup`. */
  DICTATION_MODEL: z.enum(WHISPER_MODEL_IDS).default(DEFAULT_WHISPER_MODEL),
  /** Directory of the speech models. Relative paths resolve from the repo root. */
  DICTATION_MODEL_DIR: z.string().default('./data/models'),
  /** CPU threads of the speech model. 0 = every core, up to 4. */
  DICTATION_THREADS: z.coerce.number().int().min(0).max(64).default(0),
  /** Unload the speech model after this many seconds without use (0 = keep it in memory). */
  DICTATION_IDLE_UNLOAD_SEC: z.coerce.number().int().min(0).max(86_400).default(900),

  // ---- LLM / translation
  LLM_PROVIDER: z.enum(['auto', 'local', 'anthropic']).default('auto'),
  TRANSLATION_PROVIDER: z.enum(['auto', 'local', 'anthropic']).default('auto'),
  ANTHROPIC_API_KEY: envOptionalString,
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  /**
   * Server-side refusal fallbacks (`fallbacks: "default"`): when the model's safety classifiers
   * decline a request, the API re-runs it on the model Anthropic recommends. Turn it off only
   * for a model or deployment that rejects the parameter.
   */
  ANTHROPIC_FALLBACKS: envBoolean(true),

  // ---- voice cloning
  VOICE_CLONE_PROVIDER: z.enum(['auto', 'local', 'elevenlabs']).default('auto'),

  // ---- moderation
  MODERATION_PROVIDER: z.enum(['local']).default('local'),
  /** Extra blocked terms for the local moderation list, comma separated. */
  MODERATION_EXTRA_BLOCKLIST: z.string().default(''),

  // ---- photorealistic avatars (local neural engine, master prompt §2b)
  /** `local-neural` (default, no paid service) or `external` (optional HTTP endpoint). */
  LIPSYNC_PROVIDER: z.enum(['local-neural', 'external']).default('local-neural'),
  PORTRAIT_PROVIDER: z.enum(['local-neural']).default('local-neural'),
  /** Base URL of services/avatar-engine (loopback by default; a service name under compose). */
  AVATAR_ENGINE_URL: z.string().url().default('http://127.0.0.1:8090'),
  /**
   * Shared secret of the engine. Optional on loopback; REQUIRED whenever the engine listens on
   * another interface (docker compose). When set, the `local-neural` providers send
   * `Authorization: Bearer <token>` on every request (see `engineRequestHeaders`).
   */
  AVATAR_ENGINE_TOKEN: envOptionalString,
  /**
   * Directory shared with the engine for exchanging files by path — it must be the SAME
   * absolute path in the Node processes and in the engine. Relative paths resolve from the
   * repo root. Only the `local-neural` providers touch it (through `createEngineJobDir`).
   */
  AVATAR_ENGINE_WORK_DIR: z.string().default('./data/avatar-engine'),
  /** Milliseconds between two polls of an engine job (progress and ETA granularity). */
  AVATAR_ENGINE_POLL_MS: z.coerce.number().int().min(20).max(60_000).default(1000),
  /** A RUNNING engine job without progress for this many seconds is cancelled and failed. */
  AVATAR_ENGINE_STALL_SEC: z.coerce.number().int().min(1).max(86_400).default(900),
  /**
   * Side in pixels of generated portraits (the engine rounds to multiples of 64 in 384…768).
   * 768 matches the stock library; 512 is about twice as fast and softer.
   */
  AVATAR_PORTRAIT_SIZE: z.coerce.number().int().min(256).max(1024).default(768),
  /** HTTPS endpoint of an external lip-sync service (only with LIPSYNC_PROVIDER=external). */
  LIPSYNC_ENDPOINT_URL: envOptionalString,
  LIPSYNC_API_KEY: envOptionalString,
  /** Optional health URL of the external lip-sync service (GET, 2xx = available). */
  LIPSYNC_STATUS_URL: envOptionalString,
  /** Give up on an external lip-sync job after this many seconds (it is cancelled). */
  LIPSYNC_TIMEOUT_SEC: z.coerce.number().int().min(10).max(86_400).default(1800),
});

export type ProviderEnv = z.infer<typeof providerEnvSchema>;

/** Absolute path of the directory shared with the avatar engine. */
export function resolveEngineWorkDir(env: Pick<ProviderEnv, 'AVATAR_ENGINE_WORK_DIR'>): string {
  return path.isAbsolute(env.AVATAR_ENGINE_WORK_DIR)
    ? env.AVATAR_ENGINE_WORK_DIR
    : path.resolve(findRepoRoot(), env.AVATAR_ENGINE_WORK_DIR);
}

/** Absolute path of the local storage directory. */
export function resolveStorageDir(env: Pick<ProviderEnv, 'STORAGE_LOCAL_DIR'>): string {
  return path.isAbsolute(env.STORAGE_LOCAL_DIR)
    ? env.STORAGE_LOCAL_DIR
    : path.resolve(findRepoRoot(), env.STORAGE_LOCAL_DIR);
}

/**
 * Resolve an `auto | local | external` choice: explicit choices are honoured as-is; `auto`
 * picks the first candidate whose requirement (key) is present, otherwise `fallback`.
 */
export function resolveChoice<T extends string>(
  choice: T | 'auto',
  candidates: readonly { id: T; available: boolean }[],
  fallback: T,
): T {
  if (choice !== 'auto') return choice;
  return candidates.find((c) => c.available)?.id ?? fallback;
}
