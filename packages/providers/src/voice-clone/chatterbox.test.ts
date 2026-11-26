import { describe, expect, it } from 'vitest';
import type { VoiceCloneRequest } from '@parlante/shared';
import { providerEnvSchema } from '../env';
import { createChatterboxTtsProvider } from '../tts/chatterbox';
import { fakeService, jsonReply } from '../tts/testing/fake-fetch';
import { decodeWav, encodeWav } from '../tts/wav';
import { createChatterboxVoiceCloneProvider } from './chatterbox';
import { createVoiceCloneProvider } from './index';
import { CHATTERBOX_INFO, createVoiceEngineClient } from './voice-engine';
import type { VoiceEngineClient } from './voice-engine';

/*
 * The local voice engine (services/voice-engine) is simulated here with its HTTP contract.
 * The real engine is exercised by the e2e (`e2e/voices.mjs`) and its own Python tests.
 */

const env = (overrides: Record<string, string> = {}) =>
  providerEnvSchema.parse({ VOICE_ENGINE_TOKEN: 'engine-secret', ...overrides });

const VOICE = 'cbx_0123456789abcdef0123';

function tone(seconds: number, sampleRate = 24_000): Int16Array {
  const samples = new Int16Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(6000 * Math.sin((2 * Math.PI * 180 * i) / sampleRate));
  }
  return samples;
}

const request = (overrides: Partial<VoiceCloneRequest> = {}): VoiceCloneRequest => ({
  name: 'Voz de Luis',
  sample: encodeWav(tone(5, 22_050), 22_050),
  sampleRate: 22_050,
  language: 'es',
  gender: 'male',
  consentId: 'cns_0123456789abcdef',
  ...overrides,
});

const health = (overrides: Record<string, unknown> = {}) =>
  jsonReply({
    status: 'ok',
    ready: true,
    loading: false,
    error: null,
    device: 'cuda',
    languages: ['es'],
    watermark: 'perth',
    ...overrides,
  });

function speechReply(seconds: number, watermark = 1, segments?: unknown[]) {
  const wav = encodeWav(tone(seconds), 24_000);
  return jsonReply({
    audioWav: Buffer.from(wav).toString('base64'),
    sampleRate: 24_000,
    durationMs: Math.round(seconds * 1000),
    watermark,
    chunks: 2,
    seconds: seconds,
    segments: segments ?? [
      { text: 'Hola a todos.', startMs: 0, endMs: 1200 },
      { text: 'Hoy hablamos de voces clonadas.', startMs: 1380, endMs: Math.round(seconds * 1000) },
    ],
  });
}

describe('Chatterbox voice cloning (simulated voice engine)', () => {
  it('registers the sample with its consent record and returns a chatterbox voice', async () => {
    const service = fakeService([health(), jsonReply({ voiceId: VOICE, referenceSec: 5 }, 201)]);
    const provider = createChatterboxVoiceCloneProvider(
      env(),
      createVoiceEngineClient(env(), service.http),
    );
    const result = await provider.createVoice(request());
    expect(result).toEqual({
      ttsProviderId: 'chatterbox',
      providerVoiceId: VOICE,
      profile: null,
      provider: CHATTERBOX_INFO,
    });
    expect(CHATTERBOX_INFO).toMatchObject({ quality: 'premium', local: true });
    const call = service.calls[1];
    expect(call?.url).toBe('http://127.0.0.1:8091/v1/voices');
    expect(call?.headers.authorization).toBe('Bearer engine-secret');
    const body = call?.json as { sampleWav: string; language: string; consentId: string };
    expect(body.language).toBe('es');
    expect(body.consentId).toBe('cns_0123456789abcdef');
    expect(decodeWav(new Uint8Array(Buffer.from(body.sampleWav, 'base64'))).sampleRate).toBe(
      22_050,
    );
  });

  it('clones Spanish only and reports what the engine rejects', async () => {
    const service = fakeService([
      health(),
      jsonReply({ error: { code: 'SAMPLE_TOO_SHORT', message: 'At least 3 seconds' } }, 422),
    ]);
    const provider = createChatterboxVoiceCloneProvider(
      env(),
      createVoiceEngineClient(env(), service.http),
    );
    await expect(provider.createVoice(request({ language: 'en' }))).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
    });
    await expect(provider.createVoice(request())).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
      message: 'At least 3 seconds',
    });
  });

  it('waits while the engine loads and fails clearly when it is down', async () => {
    const loading = fakeService([
      health({ ready: false, loading: true }),
      health(),
      jsonReply({ voiceId: VOICE, referenceSec: 5 }, 201),
    ]);
    const client = createVoiceEngineClient(env(), loading.http);
    await expect(
      client.registerVoice({
        sampleWav: encodeWav(tone(4), 24_000),
        language: 'es',
        consentId: 'cns_x',
      }),
    ).resolves.toEqual({ voiceId: VOICE, referenceSec: 5 });
    expect(loading.sleeps.length).toBeGreaterThan(0);

    const down = fakeService([new TypeError('fetch failed')]);
    const offline = createVoiceEngineClient(env(), down.http);
    expect(await offline.usable()).toBe(false);
    await expect(
      offline.speech({ voiceId: VOICE, text: 'Hola', language: 'es', speed: 1, pitch: 0 }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('pnpm voice-engine'),
    });
  });

  it('deletes voices idempotently and never sends a foreign id', async () => {
    const service = fakeService([jsonReply({ deleted: true }), jsonReply({ deleted: false })]);
    const client = createVoiceEngineClient(env(), service.http);
    await client.deleteVoice(VOICE);
    await client.deleteVoice(VOICE);
    await client.deleteVoice('../../etc');
    expect(service.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `DELETE http://127.0.0.1:8091/v1/voices/${VOICE}`,
      `DELETE http://127.0.0.1:8091/v1/voices/${VOICE}`,
    ]);
  });
});

describe('Chatterbox TTS provider', () => {
  it('speaks a cloned voice with word and viseme timings placed sentence by sentence', async () => {
    const service = fakeService([health(), speechReply(3)]);
    const tts = createChatterboxTtsProvider(env(), createVoiceEngineClient(env(), service.http));
    expect(await tts.listVoices()).toEqual([]);
    const result = await tts.synthesize({
      text: 'Hola a todos. <break time="300ms"/> Hoy hablamos de voces clonadas.',
      providerVoiceId: VOICE,
      language: 'es-ES',
      speed: 1.1,
      pitch: 0,
    });
    const body = service.calls[1]?.json as Record<string, unknown>;
    expect(body).toMatchObject({ voiceId: VOICE, language: 'es', speed: 1.1, pitch: 0 });
    expect(String(body.text)).not.toContain('<break');
    expect(result.provider).toEqual(CHATTERBOX_INFO);
    expect(result.durationMs).toBe(3000);
    expect(result.words.map((word) => word.text)).toEqual([
      'Hola',
      'a',
      'todos.',
      'Hoy',
      'hablamos',
      'de',
      'voces',
      'clonadas.',
    ]);
    // The second sentence starts where the engine says it does, not where a whole-text guess would.
    expect(result.words[3]?.tMs).toBeGreaterThanOrEqual(1380);
    expect(result.words.every((word) => word.tMs + word.durMs <= 3000)).toBe(true);
    expect(result.visemes[0]?.viseme).toBe('rest');
    expect(result.visemes.at(-1)?.viseme).toBe('rest');
  });

  it('never passes on audio whose watermark was not confirmed', async () => {
    const service = fakeService([health(), speechReply(1, 0.1)]);
    const tts = createChatterboxTtsProvider(env(), createVoiceEngineClient(env(), service.http));
    await expect(
      tts.synthesize({ text: 'Hola', providerVoiceId: VOICE, language: 'es', speed: 1, pitch: 0 }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('watermark'),
    });
  });

  it('answers empty text without calling the engine and rejects unknown ids', async () => {
    const service = fakeService([]);
    const tts = createChatterboxTtsProvider(env(), createVoiceEngineClient(env(), service.http));
    const empty = await tts.synthesize({
      text: '  ',
      providerVoiceId: VOICE,
      language: 'es',
      speed: 1,
      pitch: 0,
    });
    expect(empty).toMatchObject({ durationMs: 0, words: [], visemes: [] });
    await expect(
      tts.synthesize({ text: 'Hola', providerVoiceId: 'nova', language: 'es', speed: 1, pitch: 0 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(service.calls).toEqual([]);
  });
});

describe('voice cloning selection with the voice engine', () => {
  function engineDouble(up: boolean): VoiceEngineClient & { deleted: string[] } {
    const deleted: string[] = [];
    return {
      deleted,
      health: () => Promise.resolve(null),
      usable: () => Promise.resolve(up),
      registerVoice: () => Promise.resolve({ voiceId: VOICE, referenceSec: 5 }),
      deleteVoice: (id) => {
        deleted.push(id);
        return Promise.resolve();
      },
      speech: () => Promise.reject(new Error('not used')),
    };
  }
  // The basic profile is not exercised here: an empty neural list and a TTS double that is
  // never asked (its createVoice is not called in these cases).
  const local = {
    tts: {
      info: { id: 'espeak', name: 'eSpeak', quality: 'basic' as const, local: true },
      listVoices: () => Promise.resolve([]),
      synthesize: () => Promise.reject(new Error('unused')),
    },
    neural: [],
  };

  it('auto: clones Spanish with the engine while it answers, otherwise falls back to the basic profile', async () => {
    const up = createVoiceCloneProvider(env(), { engine: engineDouble(true), local });
    expect(await up.current?.()).toEqual(CHATTERBOX_INFO);
    expect((await up.createVoice(request())).provider).toEqual(CHATTERBOX_INFO);
    expect(up.info).toEqual(CHATTERBOX_INFO);
    expect(await up.current?.('en')).toMatchObject({ id: 'local', quality: 'basic' });

    const down = createVoiceCloneProvider(env(), { engine: engineDouble(false), local });
    expect(await down.current?.()).toMatchObject({ id: 'local', quality: 'basic' });
  });

  it('always deletes engine voices in the engine, whatever is selected now', async () => {
    for (const choice of ['auto', 'local', 'chatterbox']) {
      const engine = engineDouble(false);
      const provider = createVoiceCloneProvider(env({ VOICE_CLONE_PROVIDER: choice }), {
        engine,
        local,
      });
      expect(provider.handles?.('chatterbox')).toBe(true);
      await provider.deleteVoice(VOICE);
      await provider.deleteVoice('es-m1'); // a basic profile's base voice: nothing to delete
      expect(engine.deleted).toEqual([VOICE]);
    }
    const external = createVoiceCloneProvider(env({ ELEVENLABS_API_KEY: 'sk_x' }), {
      engine: engineDouble(true),
      local,
    });
    expect(external.info.id).toBe('elevenlabs');
    expect(await external.current?.()).toMatchObject({ id: 'elevenlabs' });
    expect(external.handles?.('chatterbox')).toBe(true);
    expect(external.handles?.('elevenlabs')).toBe(true);
    expect(external.handles?.('local')).toBe(false);
    // A basic voice profile is only its database row: nothing to delete elsewhere.
    expect(
      createVoiceCloneProvider(env(), { engine: engineDouble(false), local }).handles?.('local'),
    ).toBe(false);
  });
});
