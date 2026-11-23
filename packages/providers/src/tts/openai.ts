import { AppError, LANGUAGES, LANGUAGE_CODES, estimateSpeechTimeline } from '@parlante/shared';
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
import { speechFetch } from './http';
import type { SpeechHttpOptions } from './http';
import { prepareSpeech, splitPlainText } from './text';
import { joinVisemes, shiftWords } from './timeline';
import { concatPcm, encodeWav, pcm16FromBytes, samplesToMs } from './wav';

/* -------------------------------------------------------------------------------------------
 * OpenAI text-to-speech (public REST API, written from its documentation):
 *
 *   POST {OPENAI_BASE_URL}/audio/speech
 *        { model, voice, input, response_format: "pcm", speed?, instructions? }
 *        → raw PCM, 24 kHz, signed 16-bit little-endian, mono
 *
 * The service returns NO timing, so words and visemes come from the shared estimator
 * (`estimateSpeechTimeline`), chunk by chunk over the real length of each piece of audio.
 * The voices are a fixed set that speaks every language: each is listed once with `languages`.
 * `speed` is a parameter of the `tts-1` models; the `gpt-4o…` models take free-text
 * `instructions` instead, so pace, pitch and language are requested in words (best effort).
 * ----------------------------------------------------------------------------------------- */

export const OPENAI_TTS_INFO: ProviderRef = {
  id: 'openai',
  name: 'OpenAI TTS',
  quality: 'premium',
  local: false,
};

const SERVICE = 'OpenAI';
const SAMPLE_RATE = 24_000;
const SYNTH_TIMEOUT_MS = 90_000;
/** The API accepts 4 096 characters (and 2 000 tokens on gpt-4o models): stay well inside. */
const MAX_CHARS_PER_REQUEST = 1800;

interface OpenAiVoice {
  id: string;
  name: string;
  gender: Gender;
  /** Spanish description (default UI language). */
  description: string;
  tags: string[];
  /** Only offered by the `gpt-4o…` speech models. */
  gpt4oOnly?: boolean;
}

const VOICES: readonly OpenAiVoice[] = [
  {
    id: 'alloy',
    name: 'Alloy',
    gender: 'neutral',
    description: 'Neutra y equilibrada',
    tags: ['neutra'],
  },
  {
    id: 'ash',
    name: 'Ash',
    gender: 'male',
    description: 'Masculina, cercana y segura',
    tags: ['cercana'],
  },
  {
    id: 'ballad',
    name: 'Ballad',
    gender: 'male',
    description: 'Masculina, suave y expresiva',
    tags: ['expresiva'],
    gpt4oOnly: true,
  },
  {
    id: 'coral',
    name: 'Coral',
    gender: 'female',
    description: 'Femenina, cálida y amable',
    tags: ['cálida'],
  },
  { id: 'echo', name: 'Echo', gender: 'male', description: 'Masculina, serena', tags: ['serena'] },
  {
    id: 'fable',
    name: 'Fable',
    gender: 'neutral',
    description: 'Narradora, con acento británico',
    tags: ['narración'],
  },
  {
    id: 'nova',
    name: 'Nova',
    gender: 'female',
    description: 'Femenina, enérgica',
    tags: ['enérgica'],
  },
  { id: 'onyx', name: 'Onyx', gender: 'male', description: 'Masculina, grave', tags: ['grave'] },
  {
    id: 'sage',
    name: 'Sage',
    gender: 'female',
    description: 'Femenina, tranquila',
    tags: ['tranquila'],
  },
  {
    id: 'shimmer',
    name: 'Shimmer',
    gender: 'female',
    description: 'Femenina, clara y luminosa',
    tags: ['clara'],
  },
  {
    id: 'verse',
    name: 'Verse',
    gender: 'male',
    description: 'Masculina, versátil',
    tags: ['versátil'],
    gpt4oOnly: true,
  },
];

function instructionsFor(request: TTSRequest): string {
  const language = LANGUAGES.find((l) => l.code === request.language.slice(0, 2).toLowerCase());
  const parts = [
    language
      ? `Speak in ${language.englishName} with a natural native accent.`
      : 'Speak with a natural accent.',
    'Read the text exactly as written, as a clear voice-over.',
  ];
  if (request.speed >= 1.15)
    parts.push(
      `Speak faster than normal, about ${Math.round(request.speed * 100)}% of a normal pace.`,
    );
  else if (request.speed <= 0.87)
    parts.push(
      `Speak slower than normal, about ${Math.round(request.speed * 100)}% of a normal pace.`,
    );
  if (request.pitch >= 2) parts.push('Use a noticeably higher-pitched voice.');
  else if (request.pitch <= -2) parts.push('Use a noticeably lower-pitched voice.');
  return parts.join(' ');
}

/** OpenAI TTS adapter. Requires OPENAI_API_KEY. */
export function createOpenAiTtsProvider(
  env: ProviderEnv,
  http: SpeechHttpOptions = {},
): TTSProvider {
  const configuredKey = env.OPENAI_API_KEY;
  if (!configuredKey) throw notConfigured('openai', 'OPENAI_API_KEY');
  const apiKey: string = configuredKey;
  const base = env.OPENAI_BASE_URL.replace(/\/+$/, '');
  const model = env.OPENAI_TTS_MODEL;
  const isGpt4o = model.toLowerCase().startsWith('gpt-4o');

  async function listVoices(): Promise<ProviderVoice[]> {
    return VOICES.filter((voice) => isGpt4o || !voice.gpt4oOnly).map((voice) => ({
      providerVoiceId: voice.id,
      name: voice.name,
      language: 'en',
      languages: [...LANGUAGE_CODES],
      gender: voice.gender,
      description: voice.description,
      tags: ['multilingüe', ...voice.tags],
    }));
  }

  async function synthesizeChunk(request: TTSRequest, input: string): Promise<Int16Array> {
    const body = {
      model,
      voice: request.providerVoiceId,
      input,
      response_format: 'pcm',
      ...(isGpt4o
        ? { instructions: instructionsFor(request) }
        : { speed: Math.min(4, Math.max(0.25, request.speed)) }),
    };
    const response = await speechFetch(http, {
      service: SERVICE,
      url: `${base}/audio/speech`,
      init: () => ({
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      timeoutMs: SYNTH_TIMEOUT_MS,
    });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new AppError('PROVIDER_ERROR', 'OpenAI closed the connection while sending the audio');
    }
    return pcm16FromBytes(bytes);
  }

  async function synthesize(request: TTSRequest): Promise<TTSResult> {
    if (!/^[a-z0-9_-]{1,40}$/i.test(request.providerVoiceId)) {
      throw new AppError('NOT_FOUND', 'Voice not found', {
        provider: OPENAI_TTS_INFO.id,
        providerVoiceId: request.providerVoiceId,
      });
    }
    const pieces = splitPlainText(prepareSpeech(request.text).spoken, MAX_CHARS_PER_REQUEST);
    const blocks: Int16Array[] = [];
    const words: WordCue[] = [];
    const visemes: { offsetMs: number; visemes: VisemeCue[] }[] = [];
    let offsetSamples = 0;
    for (const piece of pieces) {
      const samples = await synthesizeChunk(request, piece);
      const offsetMs = (offsetSamples * 1000) / SAMPLE_RATE;
      const estimate = estimateSpeechTimeline(
        piece,
        samplesToMs(samples.length, SAMPLE_RATE),
        request.language,
      );
      blocks.push(samples);
      words.push(...shiftWords(estimate.words, offsetMs));
      visemes.push({ offsetMs, visemes: estimate.visemes });
      offsetSamples += samples.length;
    }
    const pcm = concatPcm(blocks);
    const durationMs = samplesToMs(pcm.length, SAMPLE_RATE);
    return {
      audio: encodeWav(pcm, SAMPLE_RATE),
      format: 'wav',
      sampleRate: SAMPLE_RATE,
      durationMs,
      visemes: durationMs > 0 ? joinVisemes(visemes, durationMs) : [],
      words: durationMs > 0 ? words : [],
      provider: OPENAI_TTS_INFO,
    };
  }

  return { info: OPENAI_TTS_INFO, listVoices, synthesize };
}
