import { languageName } from '@parlante/shared';
import type { Gender, ProviderVoice } from '@parlante/shared';
import type { KokoroVoiceFileId, PiperVoiceFileId } from './neural-models';
import type { KokoroDialect } from './neural-phonemes';

/* -------------------------------------------------------------------------------------------
 * Catalogue of the local NEURAL voices of Parlante.
 *
 *   kokoro:<voice>   Kokoro-82M (Apache-2.0): one model, a style tensor per voice. Spanish,
 *                    English (US / UK), French, Italian and Brazilian Portuguese.
 *   piper:<voice>    Piper (VITS), one model per voice, for the product languages Kokoro does
 *                    not speak — and only the voices whose licence allows commercial use for
 *                    the dataset AND for the checkpoint they were fine-tuned from.
 *
 * Not offered, on purpose (licences read on each MODEL_CARD, docs/MODELS.md): Turkish (the
 * only Piper voice is CC BY-NC-SA), a female Russian voice (`irina`: licence unknown;
 * `ruslan`: non-commercial), a male French voice (`tom`: AGPL dataset; `gilles`, `upmc`:
 * fine-tuned from a voice whose dataset licence is not open). Those languages and genders keep
 * the eSpeak voice. Two voices with a clean licence were measured and left out because their
 * median pitch (180 Hz) does not match the gender their name suggests and nobody could listen
 * to them here: `ru_RU-dmitri` and `pt_PT-tugão`.
 *
 * Voice ids are the upstream ids, so a voice can always be traced back to its model card.
 * ----------------------------------------------------------------------------------------- */

interface NeuralVoiceBase extends ProviderVoice {
  /** eSpeak language voice that writes the phonemes (`es`, `en-us`, `pt-br`…). */
  espeakVoice: string;
  /** Licence of the voice (its training data), as its model card states it. */
  license: string;
  /** Who must be credited when the licence asks for attribution; null otherwise. */
  attribution: string | null;
}

export interface KokoroVoiceDef extends NeuralVoiceBase {
  engine: 'kokoro';
  file: KokoroVoiceFileId;
  dialect: KokoroDialect;
}

export interface PiperVoiceDef extends NeuralVoiceBase {
  engine: 'piper';
  files: PiperVoiceFileId;
  /** Speaker index of a multi-speaker model; null for single-speaker voices. */
  speaker: number | null;
}

export type NeuralVoiceDef = KokoroVoiceDef | PiperVoiceDef;

const GENDER_LABEL: Readonly<Record<Gender, string>> = {
  female: 'femenina',
  male: 'masculina',
  neutral: 'neutra',
};

const REGION_LABEL: Readonly<Record<string, string>> = {
  'en-US': 'inglés (Estados Unidos)',
  'en-GB': 'inglés (Reino Unido)',
  'pt-BR': 'portugués (Brasil)',
  'es-MX': 'español (México)',
  'nl-BE': 'neerlandés (Flandes)',
};

function languageLabel(locale: string): string {
  return REGION_LABEL[locale] ?? languageName(locale, 'es').toLowerCase();
}

function kokoro(
  file: KokoroVoiceFileId,
  name: string,
  language: string,
  gender: Gender,
  espeakVoice: string,
  dialect: KokoroDialect,
  extra: { tags?: string[]; attribution?: string } = {},
): KokoroVoiceDef {
  return {
    engine: 'kokoro',
    providerVoiceId: file,
    file,
    name,
    language,
    gender,
    description: `Voz neuronal local (Kokoro) · ${languageLabel(language)} · ${GENDER_LABEL[gender]}`,
    tags: ['local', 'neuronal', ...(extra.tags ?? [])],
    espeakVoice,
    dialect,
    license: 'Apache-2.0',
    attribution: extra.attribution ?? null,
  };
}

function piper(
  providerVoiceId: string,
  files: PiperVoiceFileId,
  name: string,
  language: string,
  gender: Gender,
  espeakVoice: string,
  license: string,
  extra: { tags?: string[]; attribution?: string; speaker?: number } = {},
): PiperVoiceDef {
  return {
    engine: 'piper',
    providerVoiceId,
    files,
    speaker: extra.speaker ?? null,
    name,
    language,
    gender,
    description: `Voz neuronal local (Piper) · ${languageLabel(language)} · ${GENDER_LABEL[gender]}`,
    tags: ['local', 'neuronal', ...(extra.tags ?? [])],
    espeakVoice,
    license,
    attribution: extra.attribution ?? null,
  };
}

/** Kokoro voices, the default of each language and gender first. */
export const KOKORO_VOICES: readonly KokoroVoiceDef[] = [
  kokoro('ef_dora', 'Dora', 'es', 'female', 'es', 'other'),
  kokoro('em_alex', 'Álex', 'es', 'male', 'es', 'other'),
  kokoro('af_heart', 'Heart', 'en', 'female', 'en-us', 'en-us', { tags: ['cálida'] }),
  kokoro('am_michael', 'Michael', 'en', 'male', 'en-us', 'en-us'),
  kokoro('af_bella', 'Bella', 'en', 'female', 'en-us', 'en-us', { tags: ['expresiva'] }),
  kokoro('am_fenrir', 'Fenrir', 'en', 'male', 'en-us', 'en-us', { tags: ['grave'] }),
  kokoro('bf_emma', 'Emma (UK)', 'en-GB', 'female', 'en', 'en-gb'),
  kokoro('bm_george', 'George', 'en-GB', 'male', 'en', 'en-gb'),
  kokoro('ff_siwis', 'Siwis', 'fr', 'female', 'fr', 'other', {
    attribution: 'SIWIS French Speech Synthesis Database (CC BY 4.0)',
  }),
  kokoro('if_sara', 'Sara', 'it', 'female', 'it', 'other'),
  kokoro('im_nicola', 'Nicola', 'it', 'male', 'it', 'other'),
  kokoro('pf_dora', 'Dora (BR)', 'pt-BR', 'female', 'pt-br', 'other'),
  kokoro('pm_alex', 'Alex (BR)', 'pt-BR', 'male', 'pt-br', 'other'),
];

/** eSpeak language voice for a text in `language` spoken by a Kokoro voice. */
const KOKORO_LANGUAGE_VOICE: Readonly<Record<string, { espeak: string; dialect: KokoroDialect }>> =
  {
    es: { espeak: 'es', dialect: 'other' },
    en: { espeak: 'en-us', dialect: 'en-us' },
    fr: { espeak: 'fr', dialect: 'other' },
    it: { espeak: 'it', dialect: 'other' },
    pt: { espeak: 'pt-br', dialect: 'other' },
  };

/**
 * Phoneme rules for a request: the voice's own accent when the text is in the voice's
 * language; the rules of the TEXT's language when Kokoro was trained on it too (the timbre is
 * kept, the pronunciation is right); the voice's own otherwise.
 */
export function kokoroPhonemeRules(
  def: KokoroVoiceDef,
  requestLanguage: string,
): { espeak: string; dialect: KokoroDialect } {
  const own = { espeak: def.espeakVoice, dialect: def.dialect };
  const base = requestLanguage.slice(0, 2).toLowerCase();
  if (base === '' || base === def.language.slice(0, 2).toLowerCase()) return own;
  return KOKORO_LANGUAGE_VOICE[base] ?? own;
}

/** Languages Kokoro speaks (base codes). */
export const KOKORO_LANGUAGES: readonly string[] = Object.keys(KOKORO_LANGUAGE_VOICE);

/** Piper voices, the default of each language and gender first. */
export const PIPER_VOICES: readonly PiperVoiceDef[] = [
  piper('de_DE-kerstin-medium', 'de_DE-kerstin-medium', 'Kerstin', 'de', 'female', 'de', 'CC0'),
  piper('de_DE-thorsten-medium', 'de_DE-thorsten-medium', 'Thorsten', 'de', 'male', 'de', 'CC0'),
  piper(
    'nl_BE-nathalie-medium',
    'nl_BE-nathalie-medium',
    'Nathalie',
    'nl-BE',
    'female',
    'nl',
    'CC0',
  ),
  piper('nl_NL-pim-medium', 'nl_NL-pim-medium', 'Pim', 'nl', 'male', 'nl', 'CC0'),
  piper('pl_PL-gosia-medium', 'pl_PL-gosia-medium', 'Gosia', 'pl', 'female', 'pl', 'CC0'),
  piper('pl_PL-darkman-medium', 'pl_PL-darkman-medium', 'Darkman', 'pl', 'male', 'pl', 'CC0'),
  piper('ru_RU-denis-medium', 'ru_RU-denis-medium', 'Denis', 'ru', 'male', 'ru', 'CC0'),
  piper('sv_SE-alma-medium', 'sv_SE-alma-medium', 'Alma', 'sv', 'female', 'sv', 'CC BY 4.0', {
    attribution: 'NST Swedish TTS dataset (Språkbanken), voice by yeagersthlm',
  }),
  piper('sv_SE-nst-medium', 'sv_SE-nst-medium', 'Nils', 'sv', 'male', 'sv', 'CC0'),
  piper(
    'el_GR-rapunzelina-medium',
    'el_GR-rapunzelina-medium',
    'Rapunzelina',
    'el',
    'female',
    'el',
    'CC0',
  ),
  piper(
    'ca_ES-upc_ona-x_low',
    'ca_ES-upc_ona-x_low',
    'Ona',
    'ca',
    'female',
    'ca',
    'CC BY-SA 3.0 ES',
    {
      tags: ['16 kHz'],
      attribution: 'UPC FestCat TTS corpora (CC BY-SA 3.0 ES)',
    },
  ),
  piper(
    'ca_ES-upc_pau-x_low',
    'ca_ES-upc_pau-x_low',
    'Pau (UPC)',
    'ca',
    'male',
    'ca',
    'CC BY-SA 3.0 ES',
    {
      tags: ['16 kHz'],
      attribution: 'UPC FestCat TTS corpora (CC BY-SA 3.0 ES)',
    },
  ),
  piper('es_ES-davefx-medium', 'es_ES-davefx-medium', 'Dave', 'es', 'male', 'es', 'CC0'),
  piper(
    'es_ES-sharvard-medium+F',
    'es_ES-sharvard-medium',
    'Marta',
    'es',
    'female',
    'es',
    'CC BY 3.0',
    {
      speaker: 1,
      attribution: 'Sharvard Corpus (Aubanel, García Lecumberri & Cooke), CC BY 3.0',
    },
  ),
  piper('es_MX-ald-medium', 'es_MX-ald-medium', 'Aldo', 'es-MX', 'male', 'es-419', 'Unlicense'),
];

const KOKORO_BY_ID = new Map(KOKORO_VOICES.map((def) => [def.providerVoiceId, def]));
const PIPER_BY_ID = new Map(PIPER_VOICES.map((def) => [def.providerVoiceId, def]));

export function findKokoroVoice(providerVoiceId: string): KokoroVoiceDef | null {
  return KOKORO_BY_ID.get(providerVoiceId) ?? null;
}

export function findPiperVoice(providerVoiceId: string): PiperVoiceDef | null {
  return PIPER_BY_ID.get(providerVoiceId) ?? null;
}

/** Every neural voice of the catalogue (Kokoro first). */
export const NEURAL_VOICES: readonly NeuralVoiceDef[] = [...KOKORO_VOICES, ...PIPER_VOICES];
