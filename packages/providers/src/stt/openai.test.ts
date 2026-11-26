import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { providerEnvSchema } from '../env';
import { fakeService, jsonReply } from '../tts/testing/fake-fetch';
import type { RecordedCall, Reply } from '../tts/testing/fake-fetch';
import { decodeWav, encodeWav } from '../tts/wav';
import { planAudioChunks } from './chunking';
import { createOpenAiSttProvider, whisperLanguage } from './openai';

/*
 * Exercised against a scripted fake of the OpenAI `audio/transcriptions` endpoint (shapes from
 * the public documentation). NOT run against the real service: no keys or network access here.
 */

const KEY = 'sk-test-openai-secret';
const env = (overrides: Record<string, string> = {}) =>
  providerEnvSchema.parse({ OPENAI_API_KEY: KEY, ...overrides });

/**
 * Synthetic "speech": bursts of a tone separated by silences. `pattern` gives the length of
 * each burst and of the silence after it, in seconds, repeated until `totalSec`.
 */
function burstAudio(
  totalSec: number,
  sampleRate: number,
  speechSec: number,
  silenceSec: number,
): Int16Array {
  const samples = new Int16Array(Math.round(totalSec * sampleRate));
  const period = Math.round((speechSec + silenceSec) * sampleRate);
  const speech = Math.round(speechSec * sampleRate);
  for (let i = 0; i < samples.length; i += 1) {
    if (i % period < speech)
      samples[i] = Math.round(9000 * Math.sin((2 * Math.PI * 180 * i) / sampleRate));
  }
  return samples;
}

function field(call: RecordedCall | undefined, name: string): string | undefined {
  const value = call?.form?.get(name)?.[0];
  return typeof value === 'string' ? value : undefined;
}

async function uploadedAudio(call: RecordedCall | undefined) {
  const file = call?.form?.get('file')?.[0];
  if (!(file instanceof Blob)) throw new Error('no file in the request');
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { bytes, pcm: decodeWav(bytes), name: (file as File).name, type: file.type };
}

describe('planAudioChunks', () => {
  const rate = 8000;

  it('keeps a short recording whole', () => {
    const samples = burstAudio(30, rate, 4, 1);
    expect(planAudioChunks(samples, rate, { maxChunkSec: 60 })).toEqual([
      { start: 0, end: samples.length },
    ]);
    expect(planAudioChunks(new Int16Array(0), rate, { maxChunkSec: 60 })).toEqual([]);
  });

  it('cuts long recordings inside silences, contiguously, never over the limit', () => {
    const samples = burstAudio(200, rate, 6.2, 0.8);
    const chunks = planAudioChunks(samples, rate, { maxChunkSec: 60 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks[0]?.start).toBe(0);
    expect(chunks.at(-1)?.end).toBe(samples.length);
    chunks.forEach((chunk, i) => {
      expect(chunk.end - chunk.start).toBeLessThanOrEqual(60 * rate + 1.5 * rate);
      expect(chunk.end).toBeGreaterThan(chunk.start);
      if (i > 0) expect(chunk.start).toBe(chunks[i - 1]?.end);
    });
    // Every internal cut point lies in digital silence (±50 ms around it is all zeros).
    for (const chunk of chunks.slice(0, -1)) {
      const around = samples.subarray(chunk.end - rate * 0.05, chunk.end + rate * 0.05);
      expect(around.every((value) => value === 0)).toBe(true);
    }
    // And chunks are as long as the silences allow (not cut at the first one found).
    for (const chunk of chunks.slice(0, -1))
      expect((chunk.end - chunk.start) / rate).toBeGreaterThan(48);
  });

  it('cuts at the quietest moment when there is no real silence', () => {
    const samples = new Int16Array(100 * rate);
    for (let i = 0; i < samples.length; i += 1) {
      const loudness = i >= 55 * rate && i < 55.6 * rate ? 300 : 9000; // one soft passage
      samples[i] = Math.round(loudness * Math.sin((2 * Math.PI * 200 * i) / rate));
    }
    const [first] = planAudioChunks(samples, rate, { maxChunkSec: 60 });
    expect((first?.end ?? 0) / rate).toBeGreaterThan(55);
    expect((first?.end ?? 0) / rate).toBeLessThan(55.6);
  });

  it('glues a tiny tail to the previous chunk', () => {
    const samples = burstAudio(60.8, rate, 6.2, 0.8);
    const chunks = planAudioChunks(samples, rate, { maxChunkSec: 60 });
    expect(chunks.at(-1)?.end).toBe(samples.length);
    for (const chunk of chunks) expect((chunk.end - chunk.start) / rate).toBeGreaterThan(1.5);
  });
});

describe('OpenAI Whisper adapter (simulated service)', () => {
  it('requires the API key', () => {
    expect(() => createOpenAiSttProvider(providerEnvSchema.parse({}))).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }),
    );
    const stt = createOpenAiSttProvider(env());
    expect(stt.requiresUserTranscript).toBe(false);
    expect(stt.info).toEqual({
      id: 'openai',
      name: 'OpenAI Whisper',
      quality: 'premium',
      local: false,
    });
  });

  it('uploads the WAV and returns the segments in milliseconds', async () => {
    const samples = burstAudio(12, 16_000, 3, 1);
    const service = fakeService([
      jsonReply({
        task: 'transcribe',
        language: 'spanish',
        duration: 12,
        text: 'Hola a todos. Bienvenidos.',
        segments: [
          {
            id: 0,
            start: 0.0,
            end: 2.96,
            text: ' Hola a todos.',
            no_speech_prob: 0.01,
            avg_logprob: -0.2,
          },
          {
            id: 1,
            start: 4.0,
            end: 6.5,
            text: ' Bienvenidos. ',
            no_speech_prob: 0.02,
            avg_logprob: -0.3,
          },
          { id: 2, start: 7.0, end: 7.0, text: ' vacío', no_speech_prob: 0.0 },
          { id: 3, start: 8.0, end: 9.0, text: '   ', no_speech_prob: 0.0 },
          {
            id: 4,
            start: 9.0,
            end: 11.0,
            text: ' Gracias por ver el vídeo.',
            no_speech_prob: 0.93,
            avg_logprob: -1.6,
          },
          { id: 5, start: 11.5, end: 14.0, text: ' Fin.', no_speech_prob: 0.1, avg_logprob: -0.2 },
        ],
      }),
    ]);
    const result = await createOpenAiSttProvider(env(), service.http).transcribe({
      audio: encodeWav(samples, 16_000),
      language: 'es',
    });
    expect(service.calls).toHaveLength(1);
    const call = service.calls[0];
    expect(call?.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(call?.method).toBe('POST');
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(field(call, 'model')).toBe('whisper-1');
    expect(field(call, 'response_format')).toBe('verbose_json');
    expect(field(call, 'timestamp_granularities[]')).toBe('segment');
    expect(field(call, 'language')).toBe('es');
    expect(field(call, 'temperature')).toBe('0');
    expect(field(call, 'prompt')).toBeUndefined();
    const upload = await uploadedAudio(call);
    expect(upload).toMatchObject({ name: 'audio.wav', type: 'audio/wav' });
    expect(upload.pcm.sampleRate).toBe(16_000);
    expect(upload.pcm.samples.length).toBe(samples.length);

    expect(result.provider).toMatchObject({ id: 'openai', quality: 'premium' });
    expect(result.language).toBe('es');
    // Empty, zero-length and hallucinated-over-silence segments are dropped; times clamped.
    expect(result.segments).toEqual([
      { startMs: 0, endMs: 2960, text: 'Hola a todos.' },
      { startMs: 4000, endMs: 6500, text: 'Bienvenidos.' },
      { startMs: 11_500, endMs: 12_000, text: 'Fin.' },
    ]);
  });

  it('detects the language when none is given', async () => {
    const service = fakeService([
      jsonReply({
        language: 'portuguese',
        text: 'Olá.',
        segments: [{ start: 0, end: 1, text: 'Olá.' }],
      }),
    ]);
    const result = await createOpenAiSttProvider(env(), service.http).transcribe({
      audio: encodeWav(burstAudio(2, 16_000, 1, 1), 16_000),
    });
    expect(field(service.calls[0], 'language')).toBeUndefined();
    expect(result.language).toBe('pt');
    expect(whisperLanguage('Spanish')).toBe('es');
    expect(whisperLanguage('el')).toBe('el');
    expect(whisperLanguage('japanese')).toBeNull();
    expect(whisperLanguage(undefined)).toBeNull();
  });

  it('splits long audio at silences, transcribes in order and re-offsets every segment', async () => {
    // 26 minutes at 8 kHz: well over the 10-minute chunk limit.
    const rate = 8000;
    const samples = burstAudio(26 * 60, rate, 6.2, 0.8);
    const reply: Reply = async (call) => {
      const { pcm } = await uploadedAudio(call);
      const seconds = pcm.samples.length / pcm.sampleRate;
      const index = (call.form?.get('prompt')?.[0] as string | undefined)?.match(
        /parte (\d+)/,
      )?.[1];
      const part = index ? Number(index) + 1 : 1;
      return jsonReply({
        language: 'spanish',
        text: `Esto es la parte ${part}.`,
        segments: [
          { start: 1, end: 3, text: ` Inicio de la parte ${part}.` },
          { start: seconds - 2, end: seconds + 5, text: ` Esto es la parte ${part}.` },
        ],
      });
    };
    const service = fakeService([reply]);
    const result = await createOpenAiSttProvider(env(), service.http).transcribe({
      audio: encodeWav(samples, rate),
    });

    expect(service.calls.length).toBe(3);
    const uploads = await Promise.all(service.calls.map(uploadedAudio));
    // Each upload is a complete WAV under the service's 25 MB limit and at most ~10 minutes.
    let offsetSamples = 0;
    const offsetsMs: number[] = [];
    for (const upload of uploads) {
      expect(upload.bytes.byteLength).toBeLessThan(25 * 1024 * 1024);
      expect(upload.pcm.sampleRate).toBe(rate);
      expect(upload.pcm.samples.length / rate).toBeLessThanOrEqual(601.5);
      // Bit-exact slice of the source: nothing lost or repeated at the joins.
      expect(upload.pcm.samples[0]).toBe(samples[offsetSamples]);
      expect(upload.pcm.samples.at(-1)).toBe(
        samples[offsetSamples + upload.pcm.samples.length - 1],
      );
      offsetsMs.push((offsetSamples * 1000) / rate);
      offsetSamples += upload.pcm.samples.length;
    }
    expect(offsetSamples).toBe(samples.length);
    // Cuts fall in silence.
    expect(samples[uploads[0]?.pcm.samples.length ?? 0]).toBe(0);

    // The previous text primes the next request.
    expect(field(service.calls[0], 'prompt')).toBeUndefined();
    expect(field(service.calls[1], 'prompt')).toBe('Esto es la parte 1.');
    expect(field(service.calls[2], 'prompt')).toBe('Esto es la parte 2.');
    // The language detected in the first chunk is used for the rest.
    expect(field(service.calls[0], 'language')).toBeUndefined();
    expect(field(service.calls[1], 'language')).toBe('es');

    expect(result.language).toBe('es');
    expect(result.segments.map((s) => s.text)).toEqual([
      'Inicio de la parte 1.',
      'Esto es la parte 1.',
      'Inicio de la parte 2.',
      'Esto es la parte 2.',
      'Inicio de la parte 3.',
      'Esto es la parte 3.',
    ]);
    const totalMs = (samples.length * 1000) / rate;
    result.segments.forEach((segment, i) => {
      const chunk = Math.floor(i / 2);
      const chunkStart = offsetsMs[chunk] ?? 0;
      const chunkEnd = offsetsMs[chunk + 1] ?? totalMs;
      if (i % 2 === 0) {
        expect(segment.startMs).toBe(Math.round(chunkStart + 1000));
        expect(segment.endMs).toBe(Math.round(chunkStart + 3000));
      } else {
        // The service overshot the end of its chunk: clamped to the chunk, not past it.
        expect(segment.endMs).toBe(Math.round(chunkEnd));
        expect(segment.startMs).toBe(Math.round(chunkEnd - 2000));
      }
      if (i > 0) expect(segment.startMs).toBeGreaterThanOrEqual(result.segments[i - 1]?.endMs ?? 0);
    });
    expect(result.segments.at(-1)?.endMs).toBe(totalMs);
  }, 60_000);

  it('reads the audio from audioPath when no bytes are given', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-stt-'));
    try {
      const file = path.join(dir, 'audio.wav');
      const samples = burstAudio(3, 16_000, 1, 0.5);
      await fs.writeFile(file, encodeWav(samples, 16_000));
      const service = fakeService([
        jsonReply({ text: 'Hola.', segments: [{ start: 0.5, end: 1.5, text: 'Hola.' }] }),
      ]);
      const result = await createOpenAiSttProvider(env(), service.http).transcribe({
        audio: new Uint8Array(),
        audioPath: file,
        language: 'es',
      });
      expect((await uploadedAudio(service.calls[0])).pcm.samples.length).toBe(samples.length);
      expect(result.segments).toEqual([{ startMs: 500, endMs: 1500, text: 'Hola.' }]);
      expect(result.language).toBe('es');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('times the text itself for models that return no segments', async () => {
    const service = fakeService([
      jsonReply({ text: 'Primera frase. Segunda frase algo más larga.' }),
    ]);
    const result = await createOpenAiSttProvider(
      env({ OPENAI_STT_MODEL: 'gpt-4o-transcribe' }),
      service.http,
    ).transcribe({
      audio: encodeWav(burstAudio(10, 16_000, 2, 1), 16_000),
      language: 'es',
    });
    expect(field(service.calls[0], 'model')).toBe('gpt-4o-transcribe');
    expect(field(service.calls[0], 'response_format')).toBe('json');
    expect(field(service.calls[0], 'timestamp_granularities[]')).toBeUndefined();
    expect(result.segments.map((s) => s.text)).toEqual([
      'Primera frase.',
      'Segunda frase algo más larga.',
    ]);
    expect(result.segments[0]?.startMs).toBe(0);
    expect(result.segments.at(-1)?.endMs).toBe(10_000);
  });

  it('returns no segments for silence or an empty file, and rejects what is not WAV', async () => {
    const service = fakeService([jsonReply({ text: '', segments: [] })]);
    const stt = createOpenAiSttProvider(env(), service.http);
    expect(
      (await stt.transcribe({ audio: encodeWav(new Int16Array(16_000), 16_000) })).segments,
    ).toEqual([]);
    expect(service.calls).toHaveLength(1);
    expect(
      await stt.transcribe({ audio: encodeWav(new Int16Array(0), 16_000), language: 'fr' }),
    ).toMatchObject({
      segments: [],
      language: 'fr',
    });
    expect(service.calls).toHaveLength(1); // nothing to send
    await expect(
      stt.transcribe({ audio: new TextEncoder().encode('not audio at all') }),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
    });
  });

  it('maps upstream errors and retries transient ones', async () => {
    const audio = encodeWav(burstAudio(2, 16_000, 1, 1), 16_000);
    const tooLarge = fakeService([
      jsonReply(
        {
          error: {
            message: 'Maximum content size limit (26214400) exceeded',
            type: 'server_error',
          },
        },
        413,
      ),
    ]);
    const error = await createOpenAiSttProvider(env(), tooLarge.http)
      .transcribe({ audio })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { service: 'OpenAI', status: 413, attempts: 1 },
    });
    expect((error as Error).message).not.toContain(KEY);

    const flaky = fakeService([
      jsonReply({ error: { message: 'Rate limit reached' } }, 429, { 'retry-after': '1' }),
      jsonReply({ text: 'Ok.', segments: [{ start: 0, end: 1, text: 'Ok.' }] }),
    ]);
    const result = await createOpenAiSttProvider(env(), flaky.http).transcribe({ audio });
    expect(result.segments).toHaveLength(1);
    expect(flaky.sleeps).toEqual([1000]);

    const garbage = fakeService([jsonReply({ segments: 'nope' })]);
    await expect(
      createOpenAiSttProvider(env(), garbage.http).transcribe({ audio }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });
});
