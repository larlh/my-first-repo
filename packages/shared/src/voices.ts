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
