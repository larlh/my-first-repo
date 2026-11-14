import type { Capabilities, Providers } from '@parlante/shared';
import { parseEnv } from '@parlante/shared/node';
import { providerEnvSchema } from './env';
import type { ProviderEnv } from './env';
import { createLipSyncProvider } from './lipsync/index';
import { createLlmProvider } from './llm/index';
import { createModerationProvider } from './moderation/index';
import { createPortraitProvider } from './portrait/index';
import { createStorageProvider } from './storage/index';
import { createSttProvider } from './stt/index';
import { createTranslationProvider } from './translation/index';
import { createTtsProviders } from './tts/index';
import { createVoiceCloneProvider } from './voice-clone/index';

/**
 * Build every provider from environment variables. This file only wires capabilities together;
 * WHICH implementation is used is decided inside each capability directory (`<cap>/index.ts`),
 * so specialists add or change implementations without touching this file.
 */
export function createProviders(env: ProviderEnv): Providers {
  return {
    tts: createTtsProviders(env),
    stt: createSttProvider(env),
    llm: createLlmProvider(env),
    translation: createTranslationProvider(env),
    voiceClone: createVoiceCloneProvider(env),
    lipsync: createLipSyncProvider(env),
    portrait: createPortraitProvider(env),
    moderation: createModerationProvider(env),
    storage: createStorageProvider(env),
  };
}

/** Validate `process.env` (or the given source) and build the providers. */
export function createProvidersFromEnv(
  source: Record<string, string | undefined> = process.env,
): Providers {
  return createProviders(parseEnv(providerEnvSchema, source));
}

/**
 * Snapshot for `GET /api/capabilities`: which provider is active per capability, plus the live
 * state of the photorealistic avatar engine (never throws: an unreachable engine is reported
 * as unavailable).
 */
export async function describeCapabilities(providers: Providers): Promise<Capabilities> {
  const engine = await providers.lipsync.status().catch((err: unknown) => ({
    available: false,
    reason: err instanceof Error ? err.message : 'Avatar engine status check failed',
    device: null,
    secondsPerVideoSecond: null,
  }));
  return {
    active: {
      tts: providers.tts.default.info,
      stt: providers.stt.info,
      llm: providers.llm.info,
      translation: providers.translation.info,
      voiceClone: providers.voiceClone.info,
      lipsync: providers.lipsync.info,
      portrait: providers.portrait.info,
      moderation: providers.moderation.info,
      storage: providers.storage.info,
    },
    ttsProviders: providers.tts.all().map((p) => p.info),
    sttRequiresTranscript: providers.stt.requiresUserTranscript,
    avatarEngine: engine,
  };
}
