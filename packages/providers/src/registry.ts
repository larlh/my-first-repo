import { DICTATION_MAX_SEGMENT_MS, DICTATION_NOT_CONFIGURED } from '@parlante/shared';
import type {
  Capabilities,
  DictationCapabilities,
  DictationProvider,
  EngineModelInfo,
  EngineStatus,
  Providers,
} from '@parlante/shared';
import { parseEnv } from '@parlante/shared/node';
import { providerEnvSchema } from './env';
import type { ProviderEnv } from './env';
import { createLipSyncProvider } from './lipsync/index';
import { createLlmProvider } from './llm/index';
import { createModerationProvider } from './moderation/index';
import { createPortraitProvider } from './portrait/index';
import { createStorageProvider } from './storage/index';
import { createDictationProvider, createSttProvider } from './stt/index';
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
    dictation: createDictationProvider(env),
  };
}

/** Validate `process.env` (or the given source) and build the providers. */
export function createProvidersFromEnv(
  source: Record<string, string | undefined> = process.env,
): Providers {
  return createProviders(parseEnv(providerEnvSchema, source));
}

function statusOrUnavailable(status: Promise<EngineStatus>): Promise<EngineStatus> {
  return status.catch((err: unknown) => ({
    available: false,
    reason: err instanceof Error ? err.message : 'Avatar engine status check failed',
    reasonCode: 'unknown' as const,
    device: null,
    secondsPerVideoSecond: null,
  }));
}

/**
 * State of the photorealistic avatar engine for `/api/capabilities`, merged from BOTH neural
 * providers: per-operation availability (animate ← lip-sync; generate / prepare ← portrait),
 * the models with their licences, and the measured costs. A provider that does not report
 * `operations` contributes its `available` flag to the operations it implements.
 */
export function mergeEngineStatus(
  lipsync: EngineStatus,
  portrait: EngineStatus,
): Capabilities['avatarEngine'] {
  const operations = {
    generate: portrait.operations?.generate ?? portrait.available,
    prepare: portrait.operations?.prepare ?? portrait.available,
    animate: lipsync.operations?.animate ?? lipsync.available,
  };
  const models = new Map<string, EngineModelInfo>();
  for (const model of [...(lipsync.models ?? []), ...(portrait.models ?? [])]) {
    models.set(model.id, model);
  }
  const available = operations.generate || operations.prepare || operations.animate;
  const allUp = operations.generate && operations.prepare && operations.animate;
  return {
    available,
    reason: allUp ? null : (lipsync.reason ?? portrait.reason),
    // Same precedence as `reason`, so code and sentence always describe the same cause.
    reasonCode: allUp
      ? null
      : lipsync.reason !== null
        ? (lipsync.reasonCode ?? 'unknown')
        : portrait.reason !== null
          ? (portrait.reasonCode ?? 'unknown')
          : 'unknown',
    device: lipsync.device ?? portrait.device,
    secondsPerVideoSecond: lipsync.secondsPerVideoSecond,
    operations,
    models: [...models.values()],
    nonCommercial:
      Boolean(lipsync.nonCommercial || portrait.nonCommercial) ||
      [...models.values()].some((model) => model.downloaded && !model.commercialUse),
    secondsPerPortrait: portrait.secondsPerPortrait ?? lipsync.secondsPerPortrait ?? null,
  };
}

/**
 * State of dictation for `/api/capabilities`. Never throws: a provider whose status check
 * fails is reported as unavailable, and a registry without one as not configured.
 */
export async function describeDictation(
  provider: DictationProvider | undefined,
): Promise<DictationCapabilities> {
  if (!provider) return DICTATION_NOT_CONFIGURED;
  try {
    const status = await provider.status();
    return {
      local: {
        available: status.available,
        provider: provider.info,
        reason: status.reason,
        reasonCode: status.available ? null : (status.reasonCode ?? 'unknown'),
        languages: status.languages,
      },
      maxSegmentMs: DICTATION_MAX_SEGMENT_MS,
    };
  } catch (err) {
    return {
      local: {
        available: false,
        provider: provider.info,
        reason: err instanceof Error ? err.message : 'Dictation status check failed',
        reasonCode: 'unknown',
        languages: [],
      },
      maxSegmentMs: DICTATION_MAX_SEGMENT_MS,
    };
  }
}

/**
 * TTS providers that have voices to offer right now. A local neural provider is always
 * active (it lists its voices as "not installed"), but it only counts here once one of its
 * voices is installed; providers whose list is stable are not asked (an external one would
 * cost a network call).
 */
async function ttsProvidersWithVoices(providers: Providers): Promise<Capabilities['ttsProviders']> {
  const usable = await Promise.all(
    providers.tts.all().map(async (provider) => {
      if (!provider.volatileVoices) return true;
      try {
        return (await provider.listVoices()).some((voice) => voice.unavailable === undefined);
      } catch {
        return false;
      }
    }),
  );
  return providers.tts
    .all()
    .filter((_, index) => usable[index])
    .map((provider) => provider.info);
}

/**
 * Snapshot for `GET /api/capabilities`: which provider is active per capability, plus the live
 * state of the photorealistic avatar engine (never throws: an unreachable engine is reported
 * as unavailable).
 */
export async function describeCapabilities(providers: Providers): Promise<Capabilities> {
  const [lipsync, portrait, dictation, ttsProviders, voiceClone] = await Promise.all([
    statusOrUnavailable(providers.lipsync.status()),
    statusOrUnavailable(providers.portrait.status()),
    describeDictation(providers.dictation),
    ttsProvidersWithVoices(providers),
    // The engine that would clone right now (auto: the local voice engine only while it answers).
    providers.voiceClone.current
      ? providers.voiceClone.current().catch(() => providers.voiceClone.info)
      : Promise.resolve(providers.voiceClone.info),
  ]);
  const engine = mergeEngineStatus(lipsync, portrait);
  return {
    active: {
      tts: providers.tts.default.info,
      stt: providers.stt.info,
      llm: providers.llm.info,
      translation: providers.translation.info,
      voiceClone,
      lipsync: providers.lipsync.info,
      portrait: providers.portrait.info,
      moderation: providers.moderation.info,
      storage: providers.storage.info,
    },
    ttsProviders,
    sttRequiresTranscript: providers.stt.requiresUserTranscript,
    avatarEngine: engine,
    dictation,
  };
}
