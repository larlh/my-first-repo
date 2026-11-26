import { describe, expect, it } from 'vitest';
import { LANGUAGE_CODES, estimateSpeechTimeline } from '@parlante/shared';
import type { TTSRequest } from '@parlante/shared';
import { providerEnvSchema } from '../env';
import { createOpenAiTtsProvider } from './openai';
import { bytesReply, fakeService, jsonReply, tonePcmBytes } from './testing/fake-fetch';
import type { Reply } from './testing/fake-fetch';
import { decodeWav } from './wav';

/*
 * Exercised against a scripted fake of the OpenAI `audio/speech` endpoint (shapes from the
 * public documentation). NOT run against the real service: no keys or network access here.
 */

const KEY = 'sk-test-openai-secret';
const env = (overrides: Record<string, string> = {}) =>
  providerEnvSchema.parse({ OPENAI_API_KEY: KEY, ...overrides });

const request = (overrides: Partial<TTSRequest> = {}): TTSRequest => ({
  text: 'Hola mundo.',
  providerVoiceId: 'nova',
  language: 'es',
  speed: 1,
  pitch: 0,
  ...overrides,
});

/** 70 ms of raw 24 kHz PCM per input character. */
const speech: Reply = (call) =>
  bytesReply(tonePcmBytes((call.json as { input: string }).input.length * 70, 24_000));

describe('OpenAI TTS adapter (simulated service)', () => {
  it('requires the API key', () => {
    expect(() => createOpenAiTtsProvider(providerEnvSchema.parse({}))).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }),
    );
  });

  it('lists each voice once, speaking every product language', async () => {
    const service = fakeService([speech]);
    const voices = await createOpenAiTtsProvider(env(), service.http).listVoices();
    expect(service.calls).toHaveLength(0); // a fixed catalogue: no request
    expect(voices.map((v) => v.providerVoiceId)).toEqual([
      ...['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable'],
      ...['nova', 'onyx', 'sage', 'shimmer', 'verse'],
    ]);
    expect(new Set(voices.map((v) => v.providerVoiceId)).size).toBe(voices.length);
    for (const voice of voices) {
      expect(voice.languages).toEqual([...LANGUAGE_CODES]);
      expect(voice.language).toBe('en');
      expect(['female', 'male', 'neutral']).toContain(voice.gender);
      expect(voice.description.length).toBeGreaterThan(3);
    }
    // The tts-1 models do not have the gpt-4o-only voices.
    const legacy = await createOpenAiTtsProvider(
      env({ OPENAI_TTS_MODEL: 'tts-1' }),
      service.http,
    ).listVoices();
    expect(legacy.map((v) => v.providerVoiceId)).not.toContain('ballad');
    expect(legacy).toHaveLength(9);
  });

  it('synthesises raw PCM into a WAV and estimates the timeline over its real length', async () => {
    const service = fakeService([speech]);
    const text = 'Hola mundo, esto es una prueba.';
    const result = await createOpenAiTtsProvider(env(), service.http).synthesize(request({ text }));
    const call = service.calls[0];
    expect(call?.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(call?.headers).toMatchObject({
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
    });
    expect(call?.json).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'nova',
      input: text,
      response_format: 'pcm',
    });
    // gpt-4o models take instructions (language, reading style), not a speed parameter.
    const body = call?.json as { instructions?: string; speed?: number };
    expect(body.speed).toBeUndefined();
    expect(body.instructions).toMatch(/Speak in Spanish/);
    expect(body.instructions).not.toMatch(/faster|slower|pitch/);

    const durationMs = text.length * 70;
    expect(result.durationMs).toBe(durationMs);
    expect(result.sampleRate).toBe(24_000);
    expect(decodeWav(result.audio).samples.length).toBe((durationMs * 24_000) / 1000);
    expect(result.provider).toEqual({
      id: 'openai',
      name: 'OpenAI TTS',
      quality: 'premium',
      local: false,
    });
    // No timing from the service: exactly THE shared estimator.
    const estimate = estimateSpeechTimeline(text, durationMs, 'es');
    expect(result.words).toEqual(estimate.words);
    expect(result.visemes).toEqual(estimate.visemes);
  });

  it('asks gpt-4o models for pace and pitch in words; tts-1 gets the speed parameter', async () => {
    const gpt = fakeService([speech]);
    await createOpenAiTtsProvider(env(), gpt.http).synthesize(
      request({ speed: 1.5, pitch: -4, language: 'fr' }),
    );
    const instructions = (gpt.calls[0]?.json as { instructions: string }).instructions;
    expect(instructions).toMatch(/Speak in French/);
    expect(instructions).toMatch(/faster than normal, about 150%/);
    expect(instructions).toMatch(/lower-pitched/);

    const legacy = fakeService([speech]);
    const provider = createOpenAiTtsProvider(env({ OPENAI_TTS_MODEL: 'tts-1-hd' }), legacy.http);
    await provider.synthesize(request({ speed: 1.5 }));
    await provider.synthesize(request({ speed: 9 }));
    expect(legacy.calls[0]?.json).toMatchObject({ model: 'tts-1-hd', speed: 1.5 });
    expect((legacy.calls[0]?.json as { instructions?: string }).instructions).toBeUndefined();
    expect(legacy.calls[1]?.json).toMatchObject({ speed: 4 });
  });

  it('splits long scripts under the input limit and stitches the pieces', async () => {
    const sentence = 'Esta es otra frase de un guion bastante largo.';
    const text = Array.from({ length: 150 }, () => sentence).join(' ');
    const service = fakeService([speech]);
    const result = await createOpenAiTtsProvider(env(), service.http).synthesize(request({ text }));
    const inputs = service.calls.map((c) => (c.json as { input: string }).input);
    expect(inputs.length).toBeGreaterThanOrEqual(4);
    for (const input of inputs) expect(input.length).toBeLessThanOrEqual(1800);
    expect(inputs.join(' ')).toBe(text);
    expect(result.durationMs).toBe(inputs.reduce((sum, input) => sum + input.length * 70, 0));
    expect(result.words.map((w) => w.text).join(' ')).toBe(text);
    result.words.forEach((word, i) => {
      if (i > 0) expect(word.tMs).toBeGreaterThanOrEqual(result.words[i - 1]?.tMs ?? 0);
      expect(word.tMs + word.durMs).toBeLessThanOrEqual(result.durationMs + 1);
    });
    // The second piece starts after the whole first piece.
    const firstPieceMs = (inputs[0]?.length ?? 0) * 70;
    const firstOfSecond = result.words[(inputs[0] ?? '').split(' ').length];
    expect(firstOfSecond?.tMs).toBeGreaterThanOrEqual(firstPieceMs);
    expect(firstOfSecond?.tMs).toBeLessThan(firstPieceMs + 200);
    expect(result.visemes[0]).toEqual({ tMs: 0, viseme: 'rest' });
    expect(result.visemes.at(-1)?.viseme).toBe('rest');
    result.visemes.forEach((cue, i) => {
      if (i > 0) expect(cue.tMs).toBeGreaterThan(result.visemes[i - 1]?.tMs ?? 0);
      expect(cue.tMs).toBeLessThanOrEqual(result.durationMs);
    });
  });

  it('strips markup and returns an empty result for empty text without calling the service', async () => {
    const service = fakeService([speech]);
    const provider = createOpenAiTtsProvider(env(), service.http);
    await provider.synthesize(request({ text: '<speak>Hola <emphasis>mundo</emphasis></speak>' }));
    expect((service.calls[0]?.json as { input: string }).input).toBe('Hola mundo');
    const empty = await provider.synthesize(request({ text: '   ' }));
    expect(service.calls).toHaveLength(1);
    expect(empty).toMatchObject({ durationMs: 0, words: [], visemes: [] });
    expect(empty.audio.byteLength).toBe(44);
  });

  it('maps upstream errors, retries transient ones and never leaks the key', async () => {
    const unauthorized = fakeService([
      jsonReply(
        {
          error: {
            message: 'Incorrect API key provided',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        401,
      ),
    ]);
    const error = await createOpenAiTtsProvider(env(), unauthorized.http)
      .synthesize(request())
      .catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { service: 'OpenAI', status: 401, upstreamCode: 'invalid_api_key' },
    });
    expect((error as Error).message).toContain('Incorrect API key provided');
    expect(JSON.stringify(error) + (error as Error).message).not.toContain(KEY);
    expect(unauthorized.calls).toHaveLength(1);

    const flaky = fakeService([
      jsonReply({ error: { message: 'overloaded', type: 'server_error' } }, 500),
      speech,
    ]);
    const ok = await createOpenAiTtsProvider(env(), flaky.http).synthesize(request());
    expect(ok.durationMs).toBe('Hola mundo.'.length * 70);
    expect(flaky.sleeps).toEqual([500]);

    const down = fakeService([jsonReply({ error: { message: 'bad gateway' } }, 502)]);
    await expect(
      createOpenAiTtsProvider(env(), down.http).synthesize(request()),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { attempts: 3, status: 502 },
    });
    expect(down.calls).toHaveLength(3);
  });

  it('rejects malformed voice ids and uses OPENAI_BASE_URL', async () => {
    const service = fakeService([speech]);
    const provider = createOpenAiTtsProvider(
      env({ OPENAI_BASE_URL: 'http://127.0.0.1:9999/v1/' }),
      service.http,
    );
    await expect(provider.synthesize(request({ providerVoiceId: 'no va' }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await provider.synthesize(request());
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]?.url).toBe('http://127.0.0.1:9999/v1/audio/speech');
  });
});
