import { makeStockVoiceId } from './ids';
import type { Gender } from './entities';
import type { LanguageCode } from './languages';

/**
 * Catalogue of the LOCAL stock voices (provider `espeak`) — ids are FROZEN so templates, the
 * API and the web can reference them before/independently of the TTS implementation.
 * The eSpeak provider (packages/providers/src/tts) must return exactly these `providerVoiceId`s
 * from `listVoices()` and map each one to an eSpeak voice/variant. It may add more voices.
 *
 * Full voice id = `espeak:<providerVoiceId>`, e.g. `espeak:es-f1`.
 */
export interface LocalVoiceDef {
  providerVoiceId: string;
  name: string;
  language: LanguageCode;
  gender: Gender;
}

export const LOCAL_TTS_PROVIDER_ID = 'espeak';

const def = (
  language: LanguageCode,
  female: string,
  male: string,
): [LocalVoiceDef, LocalVoiceDef] => [
  { providerVoiceId: `${language}-f1`, name: female, language, gender: 'female' },
  { providerVoiceId: `${language}-m1`, name: male, language, gender: 'male' },
];

export const LOCAL_VOICES: readonly LocalVoiceDef[] = [
  ...def('es', 'Carmen', 'Diego'),
  ...def('en', 'Emma', 'James'),
  ...def('fr', 'Camille', 'Louis'),
  ...def('de', 'Hanna', 'Felix'),
  ...def('it', 'Giulia', 'Marco'),
  ...def('pt', 'Inês', 'Tiago'),
  ...def('ca', 'Laia', 'Pau'),
  ...def('nl', 'Sanne', 'Daan'),
  ...def('pl', 'Zofia', 'Jakub'),
  ...def('sv', 'Astrid', 'Erik'),
  ...def('tr', 'Elif', 'Emre'),
  ...def('ru', 'Anna', 'Dmitri'),
  ...def('el', 'Eleni', 'Nikos'),
];

/** Default (always available, local) voice id for a language and gender. */
export function defaultVoiceId(language: string, gender: 'female' | 'male' = 'female'): string {
  const base = language.slice(0, 2).toLowerCase();
  const voice =
    LOCAL_VOICES.find((v) => v.language === base && v.gender === gender) ??
    LOCAL_VOICES.find((v) => v.language === base) ??
    LOCAL_VOICES[0];
  return makeStockVoiceId(LOCAL_TTS_PROVIDER_ID, voice?.providerVoiceId ?? 'es-f1');
}

/**
 * Local NEURAL voice providers (packages/providers/src/tts): open models that run on this
 * machine. Their voices only work once their files are installed (`pnpm voices:setup`).
 */
export const NEURAL_TTS_PROVIDER_IDS = ['kokoro', 'piper'] as const;
export type NeuralTtsProviderId = (typeof NEURAL_TTS_PROVIDER_IDS)[number];

export function isNeuralTtsProvider(providerId: string): providerId is NeuralTtsProviderId {
  return (NEURAL_TTS_PROVIDER_IDS as readonly string[]).includes(providerId);
}

/** The part of a `Voice` DTO the default-voice rules look at. */
export interface DefaultVoiceCandidate {
  id: string;
  kind: 'stock' | 'cloned';
  language: string;
  multilingual?: boolean | undefined;
  gender: Gender;
  status: 'processing' | 'ready' | 'failed';
  unavailable?: unknown;
  isDefault?: boolean | undefined;
}

/** True when a voice of the catalogue can synthesize right now. */
export function isVoiceUsable(voice: Pick<DefaultVoiceCandidate, 'status' | 'unavailable'>) {
  return voice.status === 'ready' && voice.unavailable === undefined;
}

/**
 * The voice to put in NEW content (blank video, script writer, avatar sheet, interactive
 * avatar…) for a language, out of the catalogue `GET /api/voices` returned. The server marks
 * its recommendations with `isDefault` (an installed local neural voice when `TTS_PROVIDER` is
 * `auto` and one exists; see `markDefaultVoices` in the API) and lists the voices in its order
 * of preference: this function only reads both.
 *
 *  - with a `gender`: the default of that gender, so an avatar keeps a matching voice
 *  - without: the first default of the language in the server's order — the one of the
 *    preferred provider, female before male inside a provider
 *
 * Returns null when the catalogue has no default for the language (not loaded yet, or a
 * server that predates the flag): callers fall back to `defaultVoiceId`.
 */
export function pickDefaultVoice<T extends DefaultVoiceCandidate>(
  voices: readonly T[],
  language: string,
  gender?: 'female' | 'male',
): T | null {
  const base = language.slice(0, 2).toLowerCase();
  return (
    voices.find(
      (voice) =>
        voice.isDefault === true &&
        voice.kind === 'stock' &&
        isVoiceUsable(voice) &&
        (gender === undefined || voice.gender === gender) &&
        (voice.multilingual === true || voice.language.slice(0, 2).toLowerCase() === base),
    ) ?? null
  );
}

/** `pickDefaultVoice(...)?.id`, or the always-available local voice when there is none. */
export function pickDefaultVoiceId(
  voices: readonly DefaultVoiceCandidate[],
  language: string,
  gender?: 'female' | 'male',
): string {
  return pickDefaultVoice(voices, language, gender)?.id ?? defaultVoiceId(language, gender);
}
