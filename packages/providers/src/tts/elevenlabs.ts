import { z } from 'zod';
import { AppError, LANGUAGE_CODES, estimateSpeechTimeline } from '@parlante/shared';
import type {
  Gender,
  ProviderRef,
  ProviderVoice,
  TTSProvider,
  TTSRequest,
  TTSResult,
  VisemeCue,
  WordCue,
} from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { notConfigured } from '../errors';
import { readJson, speechFetch } from './http';
import type { SpeechHttpOptions } from './http';
import { prepareSpeech, splitPlainText } from './text';
import { clampWords, joinVisemes, shiftWords, visemesFromWords } from './timeline';
import { concatPcm, encodeWav, pcm16FromBytes, samplesToMs } from './wav';

/* -------------------------------------------------------------------------------------------
 * ElevenLabs text-to-speech (public REST API, written from its documentation — see the tests
 * for the exact shapes assumed):
 *
 *   GET  /v1/voices                                              voices of the account
 *   POST /v1/text-to-speech/{voice_id}/with-timestamps           audio + character alignment
 *        ?output_format=pcm_24000                                raw PCM16 mono, base64 in JSON
 *
 * Timing is REAL: the service returns the start and end of every character, from which the
 * word cues are built; mouth shapes come from the shared estimator applied word by word.
 * Limits of the service that callers should know: `speed` only between 0.7 and 1.2 (values
 * outside are clamped) and no pitch control (`pitch` is ignored).
 * ----------------------------------------------------------------------------------------- */

export const ELEVENLABS_INFO: ProviderRef = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  quality: 'premium',
  local: false,
};

const SERVICE = 'ElevenLabs';
const SAMPLE_RATE = 24_000;
const LIST_TIMEOUT_MS = 20_000;
const SYNTH_TIMEOUT_MS = 90_000;
/** Well under the smallest per-request limit of the current models (v3: 5 000 characters). */
const MAX_CHARS_PER_REQUEST = 2500;
const MIN_SPEED = 0.7;
const MAX_SPEED = 1.2;
/** Context sent with each chunk so prosody stays continuous across requests. */
const CONTEXT_CHARS = 300;

/** Languages of `eleven_multilingual_v2` (29); v2.5 adds a few, v3 covers every product one. */
const MULTILINGUAL_V2 = new Set([
  ...['en', 'ja', 'zh', 'de', 'hi', 'fr', 'ko', 'pt', 'it', 'es', 'id', 'nl', 'tr', 'fil', 'pl'],
  ...['sv', 'bg', 'ro', 'ar', 'cs', 'el', 'fi', 'hr', 'ms', 'sk', 'da', 'ta', 'uk', 'ru'],
]);

/** Product languages a model speaks; empty for the English-only models. */
export function elevenLabsModelLanguages(model: string): string[] {
  const id = model.toLowerCase();
  if (/monolingual|english|_(turbo|flash)_v2$/.test(id)) return [];
  if (id.includes('_v3')) return [...LANGUAGE_CODES];
  return LANGUAGE_CODES.filter((code) => MULTILINGUAL_V2.has(code));
}

const VoiceSchema = z.object({
  voice_id: z.string().min(1),
  name: z.string().nullish(),
  category: z.string().nullish(),
  description: z.string().nullish(),
  labels: z.record(z.string(), z.unknown()).nullish(),
  verified_languages: z
    .array(z.object({ language: z.string().nullish(), locale: z.string().nullish() }))
    .nullish(),
});
const VoicesResponseSchema = z.object({ voices: z.array(VoiceSchema) });

const AlignmentSchema = z.object({
  characters: z.array(z.string()),
  character_start_times_seconds: z.array(z.number()),
  character_end_times_seconds: z.array(z.number()),
});
const SpeechResponseSchema = z.object({
  audio_base64: z.string(),
  alignment: AlignmentSchema.nullish(),
});

function label(labels: Record<string, unknown> | null | undefined, key: string): string {
  const value = labels?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** `en`, `en-US`, `pt_br`, `es-419`… → a locale of a supported language, or null. */
function toLocale(value: string): string | null {
  const match = /^([a-z]{2})(?:[-_]([a-z]{2}))?(?:$|[-_])/i.exec(value.trim());
  if (!match?.[1]) return null;
  const base = match[1].toLowerCase();
  if (!(LANGUAGE_CODES as readonly string[]).includes(base)) return null;
  return match[2] ? `${base}-${match[2].toUpperCase()}` : base;
}

function toGender(value: string): Gender {
  const v = value.toLowerCase();
  return v === 'female' || v === 'male' ? v : 'neutral';
}

function toVoice(raw: z.infer<typeof VoiceSchema>, languages: string[]): ProviderVoice {
  const candidates = [
    label(raw.labels, 'language'),
    ...(raw.verified_languages ?? []).flatMap((v) => [v.locale ?? '', v.language ?? '']),
  ];
  const language = candidates.map(toLocale).find((locale) => locale !== null) ?? 'en';
  const tags = [
    label(raw.labels, 'accent'),
    label(raw.labels, 'age'),
    label(raw.labels, 'use_case'),
    label(raw.labels, 'descriptive'),
    raw.category ?? '',
  ]
    .map((tag) => tag.replace(/_/g, ' ').trim())
    .filter((tag) => tag !== '');
  return {
    providerVoiceId: raw.voice_id,
    name: raw.name?.trim() || raw.voice_id,
    language,
    ...(languages.length > 0 ? { languages } : {}),
    gender: toGender(label(raw.labels, 'gender')),
    description: (raw.description ?? label(raw.labels, 'description')).trim().slice(0, 300),
    tags: [...new Set(tags)],
  };
}

interface Chunk {
  samples: Int16Array;
  words: WordCue[];
  visemes: VisemeCue[];
}

/** Character alignment → word cues (times in ms relative to the chunk). */
export function wordsFromAlignment(alignment: z.infer<typeof AlignmentSchema>): WordCue[] {
  const words: WordCue[] = [];
  let text = '';
  let start = 0;
  let end = 0;
  const flush = () => {
    if (text !== '') {
      const tMs = Math.round(start * 1000);
      words.push({ tMs, durMs: Math.max(1, Math.round(end * 1000) - tMs), text });
    }
    text = '';
  };
  alignment.characters.forEach((character, index) => {
    if (/^\s*$/.test(character)) {
      flush();
      return;
    }
    const from = alignment.character_start_times_seconds[index];
    const to = alignment.character_end_times_seconds[index];
    if (text === '') start = from ?? end;
    end = Math.max(end, to ?? from ?? end);
    text += character;
  });
  flush();
  return words;
}

/** ElevenLabs adapter. Requires ELEVENLABS_API_KEY. */
export function createElevenLabsProvider(
  env: ProviderEnv,
  http: SpeechHttpOptions = {},
): TTSProvider {
  const configuredKey = env.ELEVENLABS_API_KEY;
  if (!configuredKey) throw notConfigured('elevenlabs', 'ELEVENLABS_API_KEY');
  const apiKey: string = configuredKey;
  const base = env.ELEVENLABS_BASE_URL.replace(/\/+$/, '');
  const model = env.ELEVENLABS_MODEL;
  const modelLanguages = elevenLabsModelLanguages(model);
  // Only the v2.5 models accept `language_code`; the others reject the request with it.
  const acceptsLanguageCode = /_v2_5/.test(model);
  const supportsContext = !model.includes('_v3');

  async function listVoices(): Promise<ProviderVoice[]> {
    const response = await speechFetch(http, {
      service: SERVICE,
      url: `${base}/v1/voices`,
      init: () => ({
        method: 'GET',
        headers: { 'xi-api-key': apiKey, accept: 'application/json' },
      }),
      timeoutMs: LIST_TIMEOUT_MS,
    });
    const parsed = VoicesResponseSchema.safeParse(await readJson(SERVICE, response));
    if (!parsed.success) {
      throw new AppError('PROVIDER_ERROR', 'ElevenLabs returned an unexpected list of voices');
    }
    return (
      parsed.data.voices
        // Voices cloned through the API belong to ONE workspace (they are `vcl_…` voices in
        // the database): never list them as stock voices of everybody.
        .filter((voice) => voice.category !== 'cloned' && !label(voice.labels, 'parlante_consent'))
        .map((voice) => toVoice(voice, modelLanguages))
    );
  }

  async function synthesizeChunk(
    request: TTSRequest,
    text: string,
    previous: string,
    next: string,
  ): Promise<Chunk> {
    const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, request.speed));
    const body = {
      text,
      model_id: model,
      ...(acceptsLanguageCode ? { language_code: request.language.slice(0, 2).toLowerCase() } : {}),
      ...(Math.abs(speed - 1) > 0.001 ? { voice_settings: { speed } } : {}),
      ...(supportsContext && previous !== '' ? { previous_text: previous } : {}),
      ...(supportsContext && next !== '' ? { next_text: next } : {}),
    };
    const voiceId = encodeURIComponent(request.providerVoiceId);
    const response = await speechFetch(http, {
      service: SERVICE,
      url: `${base}/v1/text-to-speech/${voiceId}/with-timestamps?output_format=pcm_${SAMPLE_RATE}`,
      init: () => ({
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      }),
      timeoutMs: SYNTH_TIMEOUT_MS,
    });
    const parsed = SpeechResponseSchema.safeParse(await readJson(SERVICE, response));
    if (!parsed.success) {
      throw new AppError('PROVIDER_ERROR', 'ElevenLabs returned an unexpected synthesis response');
    }
    const samples = pcm16FromBytes(Buffer.from(parsed.data.audio_base64, 'base64'));
    const durationMs = samplesToMs(samples.length, SAMPLE_RATE);
    const aligned = parsed.data.alignment ? wordsFromAlignment(parsed.data.alignment) : [];
    if (aligned.length > 0) {
      const words = clampWords(aligned, durationMs);
      return { samples, words, visemes: visemesFromWords(words, durationMs, request.language) };
    }
    // No alignment in the answer: fall back to the shared estimator for this chunk.
    const estimate = estimateSpeechTimeline(text, durationMs, request.language);
    return { samples, words: estimate.words, visemes: estimate.visemes };
  }

  async function synthesize(request: TTSRequest): Promise<TTSResult> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(request.providerVoiceId)) {
      throw new AppError('NOT_FOUND', 'Voice not found', {
        provider: ELEVENLABS_INFO.id,
        providerVoiceId: request.providerVoiceId,
      });
    }
    const pieces = splitPlainText(prepareSpeech(request.text).spoken, MAX_CHARS_PER_REQUEST);
    const blocks: Int16Array[] = [];
    const words: WordCue[] = [];
    const visemes: { offsetMs: number; visemes: VisemeCue[] }[] = [];
    let offsetSamples = 0;
    for (const [index, piece] of pieces.entries()) {
      const chunk = await synthesizeChunk(
        request,
        piece,
        (pieces[index - 1] ?? '').slice(-CONTEXT_CHARS),
        (pieces[index + 1] ?? '').slice(0, CONTEXT_CHARS),
      );
      const offsetMs = (offsetSamples * 1000) / SAMPLE_RATE;
      blocks.push(chunk.samples);
      words.push(...shiftWords(chunk.words, offsetMs));
      visemes.push({ offsetMs, visemes: chunk.visemes });
      offsetSamples += chunk.samples.length;
    }
    const pcm = concatPcm(blocks);
    const durationMs = samplesToMs(pcm.length, SAMPLE_RATE);
    return {
      audio: encodeWav(pcm, SAMPLE_RATE),
      format: 'wav',
      sampleRate: SAMPLE_RATE,
      durationMs,
      visemes: durationMs > 0 ? joinVisemes(visemes, durationMs) : [],
      words: durationMs > 0 ? clampWords(words, durationMs) : [],
      provider: ELEVENLABS_INFO,
    };
  }

  return { info: ELEVENLABS_INFO, listVoices, synthesize };
}
