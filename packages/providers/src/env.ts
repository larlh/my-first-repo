import path from 'node:path';
import { z } from 'zod';
import { envBoolean, envOptionalString, findRepoRoot } from '@parlante/shared/node';

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

  // ---- TTS
  TTS_PROVIDER: z.enum(['auto', 'espeak', 'elevenlabs', 'openai']).default('auto'),
  ELEVENLABS_API_KEY: envOptionalString,
  ELEVENLABS_MODEL: z.string().default('eleven_multilingual_v2'),
  OPENAI_API_KEY: envOptionalString,
  OPENAI_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),

  // ---- STT
  STT_PROVIDER: z.enum(['auto', 'manual', 'openai']).default('auto'),
  OPENAI_STT_MODEL: z.string().default('whisper-1'),

  // ---- LLM / translation
  LLM_PROVIDER: z.enum(['auto', 'local', 'anthropic']).default('auto'),
  TRANSLATION_PROVIDER: z.enum(['auto', 'local', 'anthropic']).default('auto'),
  ANTHROPIC_API_KEY: envOptionalString,
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),

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
  /** HTTPS endpoint of an external lip-sync service (only with LIPSYNC_PROVIDER=external). */
  LIPSYNC_ENDPOINT_URL: envOptionalString,
  LIPSYNC_API_KEY: envOptionalString,
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
