import fs from 'node:fs/promises';
import { z } from 'zod';
import { AppError, LANGUAGES, baseLanguage, timePlainTranscript } from '@parlante/shared';
import type {
  LanguageCode,
  ProviderRef,
  STTProvider,
  STTRequest,
  STTResult,
  TimedText,
} from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { notConfigured } from '../errors';
import { readJson, speechFetch } from '../tts/http';
import type { SpeechHttpOptions } from '../tts/http';
import { decodeWav, encodeWav } from '../tts/wav';
import { planAudioChunks } from './chunking';

/* -------------------------------------------------------------------------------------------
 * OpenAI speech-to-text (Whisper; public REST API, written from its documentation):
 *
 *   POST {OPENAI_BASE_URL}/audio/transcriptions     multipart/form-data
 *        file, model, response_format=verbose_json, timestamp_granularities[]=segment,
 *        temperature=0, language?, prompt?
 *        → { language, duration, text, segments: [{ start, end, text, no_speech_prob… }] }
 *
 * The API refuses uploads over 25 MB (about 13 minutes of the 16 kHz mono WAV the worker
 * sends), so long recordings are cut at quiet moments into chunks of at most 10 minutes,
 * transcribed one after another (each one primed with the end of the previous text, which
 * keeps names and spelling consistent) and their times shifted back onto the full recording.
 * Models without segment timestamps (the `gpt-4o-…-transcribe` family) return only text:
 * their text is spread over each chunk in proportion to sentence length.
 * ----------------------------------------------------------------------------------------- */

export const OPENAI_STT_INFO: ProviderRef = {
  id: 'openai',
  name: 'OpenAI Whisper',
  quality: 'premium',
  local: false,
};

const SERVICE = 'OpenAI';
const UPLOAD_LIMIT_BYTES = 24 * 1024 * 1024;
const MAX_CHUNK_SEC = 600;
const CHUNK_TIMEOUT_MS = 300_000;
const PROMPT_CHARS = 200;

const TranscriptionSchema = z.object({
  text: z.string().nullish(),
  language: z.string().nullish(),
  segments: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        text: z.string(),
        no_speech_prob: z.number().nullish(),
        avg_logprob: z.number().nullish(),
      }),
    )
    .nullish(),
});

/** Whisper reports the language as an English name ("spanish"); newer models as a code. */
export function whisperLanguage(value: string | null | undefined): LanguageCode | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const byName = LANGUAGES.find((l) => l.englishName.toLowerCase() === v);
  return byName ? byName.code : baseLanguage(v.length <= 5 ? v : '');
}

async function readAudio(request: STTRequest): Promise<Uint8Array> {
  if (request.audio.byteLength > 0) return request.audio;
  if (request.audioPath) return new Uint8Array(await fs.readFile(request.audioPath));
  return request.audio;
}

/** OpenAI Whisper adapter. Requires OPENAI_API_KEY. */
export function createOpenAiSttProvider(
  env: ProviderEnv,
  http: SpeechHttpOptions = {},
): STTProvider {
  const configuredKey = env.OPENAI_API_KEY;
  if (!configuredKey) throw notConfigured('openai', 'OPENAI_API_KEY');
  const apiKey: string = configuredKey;
  const base = env.OPENAI_BASE_URL.replace(/\/+$/, '');
  const model = env.OPENAI_STT_MODEL;
  const hasSegments = model.toLowerCase().startsWith('whisper');

  async function transcribeChunk(
    wav: Uint8Array,
    durationMs: number,
    language: LanguageCode | undefined,
    prompt: string,
  ): Promise<{ segments: TimedText[]; text: string; language: LanguageCode | null }> {
    const response = await speechFetch(http, {
      service: SERVICE,
      url: `${base}/audio/transcriptions`,
      init: () => {
        const form = new FormData();
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
        form.append('model', model);
        form.append('temperature', '0');
        if (hasSegments) {
          form.append('response_format', 'verbose_json');
          form.append('timestamp_granularities[]', 'segment');
        } else {
          form.append('response_format', 'json');
        }
        if (language) form.append('language', language);
        if (prompt !== '') form.append('prompt', prompt);
        return { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form };
      },
      timeoutMs: CHUNK_TIMEOUT_MS,
    });
    const parsed = TranscriptionSchema.safeParse(await readJson(SERVICE, response));
    if (!parsed.success) {
      throw new AppError('PROVIDER_ERROR', 'OpenAI returned an unexpected transcription');
    }
    const data = parsed.data;
    const text = (data.text ?? '').trim();
    let segments: TimedText[];
    if (data.segments && data.segments.length > 0) {
      segments = data.segments
        // Whisper invents text over silence; it flags those segments itself.
        .filter((s) => !((s.no_speech_prob ?? 0) > 0.8 && (s.avg_logprob ?? -2) < -1))
        .map((s) => ({
          startMs: Math.round(Math.min(durationMs, Math.max(0, s.start * 1000))),
          endMs: Math.round(Math.min(durationMs, Math.max(0, s.end * 1000))),
          text: s.text.replace(/\s+/g, ' ').trim(),
        }))
        .filter((s) => s.text !== '' && s.endMs > s.startMs);
    } else {
      segments = timePlainTranscript(text, durationMs);
    }
    return { segments, text, language: whisperLanguage(data.language) };
  }

  async function transcribe(request: STTRequest): Promise<STTResult> {
    const pcm = decodeWav(await readAudio(request));
    const { samples, sampleRate } = pcm;
    const maxChunkSec = Math.min(MAX_CHUNK_SEC, Math.floor(UPLOAD_LIMIT_BYTES / (sampleRate * 2)));
    const chunks = planAudioChunks(samples, sampleRate, { maxChunkSec });
    const segments: TimedText[] = [];
    let language: LanguageCode | null = request.language ?? null;
    let prompt = '';
    for (const chunk of chunks) {
      const offsetMs = (chunk.start * 1000) / sampleRate;
      const durationMs = ((chunk.end - chunk.start) * 1000) / sampleRate;
      const wav =
        chunks.length === 1 && chunk.end === samples.length
          ? encodeWav(samples, sampleRate)
          : encodeWav(samples.subarray(chunk.start, chunk.end), sampleRate);
      const result = await transcribeChunk(
        wav,
        durationMs,
        request.language ?? language ?? undefined,
        prompt,
      );
      language ??= result.language;
      for (const segment of result.segments) {
        segments.push({
          startMs: Math.round(offsetMs + segment.startMs),
          endMs: Math.round(offsetMs + segment.endMs),
          text: segment.text,
        });
      }
      if (result.text !== '') prompt = result.text.slice(-PROMPT_CHARS);
    }
    return { segments, language, provider: OPENAI_STT_INFO };
  }

  return { info: OPENAI_STT_INFO, requiresUserTranscript: false, transcribe };
}
