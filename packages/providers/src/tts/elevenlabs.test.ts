import { describe, expect, it } from 'vitest';
import { LocaleSchema, isAppError } from '@parlante/shared';
import type { TTSRequest } from '@parlante/shared';
import { providerEnvSchema } from '../env';
import {
  createElevenLabsProvider,
  elevenLabsModelLanguages,
  wordsFromAlignment,
} from './elevenlabs';
import { fakeService, jsonReply, tonePcmBytes } from './testing/fake-fetch';
import type { Reply } from './testing/fake-fetch';
import { decodeWav } from './wav';

/*
 * The adapter is exercised against a scripted fake of the ElevenLabs REST API (shapes taken
 * from its public documentation). It has NOT been run against the real service: there are no
 * keys or network access in the build environment.
 */

const KEY = 'sk_test_elevenlabs_secret';
const env = (overrides: Record<string, string> = {}) =>
  providerEnvSchema.parse({ ELEVENLABS_API_KEY: KEY, ...overrides });

const request = (overrides: Partial<TTSRequest> = {}): TTSRequest => ({
  text: 'Hola mundo.',
  providerVoiceId: 'voiceABC123',
  language: 'es',
  speed: 1,
  pitch: 0,
  ...overrides,
});

/** A synthesis reply whose alignment gives every character 60 ms, words separated by spaces. */
function speechReply(text: string, options: { leadMs?: number; tailMs?: number } = {}) {
  const lead = options.leadMs ?? 100;
  const per = 60;
  const characters = [...text];
  const starts = characters.map((_, i) => (lead + i * per) / 1000);
  const ends = characters.map((_, i) => (lead + (i + 1) * per) / 1000);
  const durationMs = lead + characters.length * per + (options.tailMs ?? 200);
  return jsonReply({
    audio_base64: Buffer.from(tonePcmBytes(durationMs, 24_000)).toString('base64'),
    alignment: {
      characters,
      character_start_times_seconds: starts,
      character_end_times_seconds: ends,
    },
    normalized_alignment: null,
  });
}

const echoSpeech: Reply = (call) => speechReply((call.json as { text: string }).text);

describe('ElevenLabs TTS adapter (simulated service)', () => {
  it('requires the API key', () => {
    expect(() => createElevenLabsProvider(providerEnvSchema.parse({}))).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }),
    );
    expect(createElevenLabsProvider(env()).info).toEqual({
      id: 'elevenlabs',
      name: 'ElevenLabs',
      quality: 'premium',
      local: false,
    });
  });

  it('lists the account voices once each, multilingual, without cloned voices', async () => {
    const service = fakeService([
      jsonReply({
        voices: [
          {
            voice_id: 'v1',
            name: 'Rachel',
            category: 'premade',
            description: 'Calm narrator',
            labels: {
              gender: 'female',
              accent: 'american',
              age: 'young',
              use_case: 'narration',
              language: 'en',
            },
          },
          {
            voice_id: 'v2',
            name: 'Mateo ',
            category: 'professional',
            labels: { gender: 'male', description: 'Locutor', language: 'es' },
            verified_languages: [{ language: 'es', locale: 'es-MX' }],
          },
          { voice_id: 'v3', name: null, category: 'generated', labels: { language: 'ja' } },
          { voice_id: 'v4', name: 'Somebody', category: 'cloned', labels: {} },
          {
            voice_id: 'v5',
            name: 'Tagged',
            category: 'premade',
            labels: { parlante_consent: 'cns_1' },
          },
        ],
      }),
    ]);
    const voices = await createElevenLabsProvider(env(), service.http).listVoices();
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]).toMatchObject({
      url: 'https://api.elevenlabs.io/v1/voices',
      method: 'GET',
      headers: { 'xi-api-key': KEY },
    });
    expect(voices.map((v) => v.providerVoiceId)).toEqual(['v1', 'v2', 'v3']);
    expect(voices[0]).toMatchObject({
      name: 'Rachel',
      language: 'en',
      gender: 'female',
      description: 'Calm narrator',
      tags: ['american', 'young', 'narration', 'premade'],
    });
    expect(voices[1]).toMatchObject({
      name: 'Mateo',
      language: 'es',
      gender: 'male',
      description: 'Locutor',
    });
    // Unsupported primary language: still a valid locale; unknown gender: neutral.
    expect(voices[2]).toMatchObject({ name: 'v3', language: 'en', gender: 'neutral' });
    for (const voice of voices) {
      // One voice, every language of the model — never one entry per language.
      expect(voice.languages).toEqual(elevenLabsModelLanguages('eleven_multilingual_v2'));
      expect(LocaleSchema.safeParse(voice.language).success).toBe(true);
    }
    expect(voices[0]?.languages).toContain('es');
    expect(voices[0]?.languages).not.toContain('ca');
  });

  it('knows which product languages each model speaks', () => {
    expect(elevenLabsModelLanguages('eleven_multilingual_v2')).toHaveLength(12);
    expect(elevenLabsModelLanguages('eleven_v3')).toHaveLength(13);
    expect(elevenLabsModelLanguages('eleven_flash_v2_5')).toContain('ru');
    expect(elevenLabsModelLanguages('eleven_monolingual_v1')).toEqual([]);
    expect(elevenLabsModelLanguages('eleven_turbo_v2')).toEqual([]);
  });

  it('English-only models do not claim to be multilingual', async () => {
    const service = fakeService([
      jsonReply({ voices: [{ voice_id: 'v1', name: 'A', labels: {} }] }),
    ]);
    const voices = await createElevenLabsProvider(
      env({ ELEVENLABS_MODEL: 'eleven_monolingual_v1' }),
      service.http,
    ).listVoices();
    expect(voices[0]?.languages).toBeUndefined();
  });

  it('synthesises with real timestamps: PCM → WAV, characters → words, words → visemes', async () => {
    const text = 'Hola mundo, ¿qué tal?';
    const service = fakeService([speechReply(text)]);
    const result = await createElevenLabsProvider(env(), service.http).synthesize(
      request({ text }),
    );

    const call = service.calls[0];
    expect(call?.url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voiceABC123/with-timestamps?output_format=pcm_24000',
    );
    expect(call?.method).toBe('POST');
    expect(call?.headers).toMatchObject({ 'xi-api-key': KEY, 'content-type': 'application/json' });
    // Normal speed, v2 model: no voice settings, no language_code (that model rejects it).
    expect(call?.json).toEqual({ text, model_id: 'eleven_multilingual_v2' });

    const expectedMs = 100 + [...text].length * 60 + 200;
    expect(result.durationMs).toBe(expectedMs);
    expect(result.sampleRate).toBe(24_000);
    expect(result.provider).toMatchObject({ id: 'elevenlabs', quality: 'premium', local: false });
    const pcm = decodeWav(result.audio);
    expect(pcm.sampleRate).toBe(24_000);
    expect(pcm.samples.length).toBe((expectedMs * 24_000) / 1000);

    // Words carry the REAL times of the alignment (60 ms per character, 100 ms lead-in).
    expect(result.words).toEqual([
      { tMs: 100, durMs: 240, text: 'Hola' },
      { tMs: 400, durMs: 360, text: 'mundo,' },
      { tMs: 820, durMs: 240, text: '¿qué' },
      { tMs: 1120, durMs: 240, text: 'tal?' },
    ]);
    // Visemes: rest at both ends, strictly increasing, and inside the word they belong to.
    const { visemes } = result;
    expect(visemes[0]).toEqual({ tMs: 0, viseme: 'rest' });
    expect(visemes.at(-1)).toEqual({ tMs: 1360, viseme: 'rest' });
    visemes.forEach((cue, i) => {
      if (i > 0) expect(cue.tMs).toBeGreaterThan(visemes[i - 1]?.tMs ?? 0);
      expect(cue.tMs).toBeLessThanOrEqual(result.durationMs);
    });
    for (const word of result.words) {
      const inside = visemes.filter(
        (c) => c.viseme !== 'rest' && c.tMs >= word.tMs && c.tMs < word.tMs + word.durMs,
      );
      expect(inside.length, word.text).toBeGreaterThan(0);
    }
    // "Hola" starts with the O of "ho-", "mundo" with closed lips.
    expect(visemes[1]).toMatchObject({ viseme: 'KG' });
    expect(visemes.find((c) => c.tMs >= 400)?.viseme).toBe('MBP');
    expect(visemes.filter((c) => c.tMs < 100)).toEqual([{ tMs: 0, viseme: 'rest' }]);
  });

  it('clamps speed to what the service supports and passes the language only to v2.5 models', async () => {
    const v2 = fakeService([echoSpeech]);
    const provider = createElevenLabsProvider(env(), v2.http);
    await provider.synthesize(request({ speed: 2 }));
    await provider.synthesize(request({ speed: 0.5 }));
    await provider.synthesize(request({ speed: 1.1, pitch: 6 }));
    expect(v2.calls.map((c) => (c.json as { voice_settings?: unknown }).voice_settings)).toEqual([
      { speed: 1.2 },
      { speed: 0.7 },
      { speed: 1.1 },
    ]);
    expect(JSON.stringify(v2.calls.map((c) => c.json))).not.toContain('pitch');

    const flash = fakeService([echoSpeech]);
    await createElevenLabsProvider(
      env({ ELEVENLABS_MODEL: 'eleven_flash_v2_5' }),
      flash.http,
    ).synthesize(request({ language: 'pt-BR' }));
    expect(flash.calls[0]?.json).toMatchObject({
      model_id: 'eleven_flash_v2_5',
      language_code: 'pt',
    });
  });

  it('sends plain text: markup is stripped before it leaves the server', async () => {
    const service = fakeService([echoSpeech]);
    const result = await createElevenLabsProvider(env(), service.http).synthesize(
      request({ text: 'Hola <break time="1s"/> <b>mundo</b> 🙂 **ya** <script>x()</script>.' }),
    );
    expect((service.calls[0]?.json as { text: string }).text).toBe('Hola mundo ya .');
    expect(result.words.map((w) => w.text)).toEqual(['Hola', 'mundo', 'ya', '.']);
  });

  it('splits long scripts into several requests and stitches audio and timelines', async () => {
    const sentence = 'Esta es una frase de prueba para un guion largo de verdad.';
    const text = Array.from({ length: 120 }, () => sentence).join(' ');
    expect(text.length).toBeGreaterThan(6000);
    const service = fakeService([echoSpeech]);
    const result = await createElevenLabsProvider(env(), service.http).synthesize(
      request({ text }),
    );

    expect(service.calls.length).toBeGreaterThanOrEqual(3);
    const sent = service.calls.map(
      (c) => c.json as { text: string; previous_text?: string; next_text?: string },
    );
    for (const body of sent) expect(body.text.length).toBeLessThanOrEqual(2500);
    expect(sent.map((b) => b.text).join(' ')).toBe(text);
    // Continuity hints: each request knows what comes before and after it.
    expect(sent[0]?.previous_text).toBeUndefined();
    expect(sent[0]?.next_text).toBe(sent[1]?.text.slice(0, 300));
    expect(sent[1]?.previous_text).toBe(sent[0]?.text.slice(-300));
    expect(sent.at(-1)?.next_text).toBeUndefined();

    // Audio: the chunks one after another.
    const chunkMs = sent.map((b) => 100 + [...b.text].length * 60 + 200);
    expect(result.durationMs).toBe(chunkMs.reduce((a, b) => a + b, 0));
    // Words: all of them, in order, shifted by the length of the previous chunks.
    expect(result.words.map((w) => w.text).join(' ')).toBe(text);
    result.words.forEach((word, i) => {
      if (i > 0)
        expect(word.tMs).toBeGreaterThanOrEqual(
          (result.words[i - 1]?.tMs ?? 0) + (result.words[i - 1]?.durMs ?? 0),
        );
      expect(word.tMs + word.durMs).toBeLessThanOrEqual(result.durationMs);
    });
    const firstOfSecond = result.words[(sent[0]?.text.split(' ') ?? []).length];
    expect(firstOfSecond?.tMs).toBe((chunkMs[0] ?? 0) + 100);
    // Visemes: one continuous, strictly increasing track ending in rest.
    result.visemes.forEach((cue, i) => {
      if (i > 0) expect(cue.tMs).toBeGreaterThan(result.visemes[i - 1]?.tMs ?? 0);
    });
    expect(result.visemes.at(-1)?.viseme).toBe('rest');
    expect(result.visemes.at(-1)?.tMs).toBeLessThanOrEqual(result.durationMs);
  });

  it('falls back to the shared estimator when the service returns no alignment', async () => {
    const service = fakeService([
      jsonReply({
        audio_base64: Buffer.from(tonePcmBytes(2000, 24_000)).toString('base64'),
        alignment: null,
      }),
    ]);
    const result = await createElevenLabsProvider(env(), service.http).synthesize(
      request({ text: 'Hola mundo cruel' }),
    );
    expect(result.durationMs).toBe(2000);
    expect(result.words.map((w) => w.text)).toEqual(['Hola', 'mundo', 'cruel']);
    expect(result.visemes[0]?.viseme).toBe('rest');
    expect(result.visemes.at(-1)?.viseme).toBe('rest');
  });

  it('returns an empty result without calling the service when there is nothing to say', async () => {
    const service = fakeService([echoSpeech]);
    const result = await createElevenLabsProvider(env(), service.http).synthesize(
      request({ text: '  <break/> ' }),
    );
    expect(service.calls).toHaveLength(0);
    expect(result).toMatchObject({ durationMs: 0, visemes: [], words: [], format: 'wav' });
    expect(result.audio.byteLength).toBe(44);
  });

  it('builds words from a character alignment', () => {
    expect(
      wordsFromAlignment({
        characters: ['S', 'í', ',', ' ', ' ', 'n', 'o', '.'],
        character_start_times_seconds: [0.1, 0.2, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7],
        character_end_times_seconds: [0.2, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.75],
      }),
    ).toEqual([
      { tMs: 100, durMs: 250, text: 'Sí,' },
      { tMs: 500, durMs: 250, text: 'no.' },
    ]);
    expect(
      wordsFromAlignment({
        characters: [],
        character_start_times_seconds: [],
        character_end_times_seconds: [],
      }),
    ).toEqual([]);
  });

  it('never puts a strange voice id into the URL', async () => {
    const service = fakeService([echoSpeech]);
    const provider = createElevenLabsProvider(env(), service.http);
    await expect(
      provider.synthesize(request({ providerVoiceId: '../../v1/user' })),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(service.calls).toHaveLength(0);
  });

  describe('errors, time limits and retries', () => {
    it('maps an invalid key to PROVIDER_ERROR without retrying or leaking the key', async () => {
      const service = fakeService([
        jsonReply({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 401),
      ]);
      const error = await createElevenLabsProvider(env(), service.http)
        .synthesize(request())
        .catch((err: unknown) => err);
      expect(isAppError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'PROVIDER_ERROR',
        status: 502,
        details: {
          service: 'ElevenLabs',
          status: 401,
          upstreamCode: 'invalid_api_key',
          attempts: 1,
        },
      });
      expect((error as Error).message).toMatch(
        /ElevenLabs rejected the API key.*HTTP 401.*Invalid API key/,
      );
      expect(JSON.stringify(error) + (error as Error).message).not.toContain(KEY);
      expect(service.calls).toHaveLength(1);
      expect(service.sleeps).toEqual([]);
    });

    it('does not retry a rejected request (422)', async () => {
      const service = fakeService([jsonReply({ detail: 'text too long' }, 422)]);
      await expect(
        createElevenLabsProvider(env(), service.http).synthesize(request()),
      ).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        message: expect.stringMatching(
          /rejected the request \(HTTP 422\): text too long/,
        ) as unknown,
      });
      expect(service.calls).toHaveLength(1);
    });

    it('retries rate limits honouring Retry-After, then succeeds', async () => {
      const service = fakeService([
        jsonReply(
          { detail: { status: 'too_many_concurrent_requests', message: 'slow down' } },
          429,
          { 'retry-after': '2' },
        ),
        jsonReply({ detail: 'busy' }, 503),
        echoSpeech,
      ]);
      const result = await createElevenLabsProvider(env(), service.http).synthesize(request());
      expect(result.words.map((w) => w.text)).toEqual(['Hola', 'mundo.']);
      expect(service.calls).toHaveLength(3);
      expect(service.sleeps).toEqual([2000, 1000]);
    });

    it('gives up after three attempts', async () => {
      const service = fakeService([
        jsonReply({ detail: { status: 'quota_exceeded', message: 'No credits left' } }, 429),
      ]);
      await expect(
        createElevenLabsProvider(env(), service.http).synthesize(request()),
      ).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        message: expect.stringMatching(
          /rate limit or quota exceeded \(HTTP 429\): No credits left/,
        ) as unknown,
        details: { attempts: 3, upstreamCode: 'quota_exceeded' },
      });
      expect(service.calls).toHaveLength(3);
      expect(service.sleeps).toEqual([500, 1000]);
    });

    it('caps a huge Retry-After', async () => {
      const service = fakeService([jsonReply({}, 503, { 'retry-after': '3600' }), echoSpeech]);
      await createElevenLabsProvider(env(), service.http).synthesize(request());
      expect(service.sleeps).toEqual([10_000]);
    });

    it('retries network failures and timeouts, then reports them', async () => {
      const network = fakeService([new TypeError('fetch failed')]);
      await expect(
        createElevenLabsProvider(env(), network.http).listVoices(),
      ).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        message: 'ElevenLabs could not be reached',
        details: { attempts: 3, timeout: false },
      });
      expect(network.calls).toHaveLength(3);

      const timeout = fakeService([new DOMException('The operation timed out', 'TimeoutError')]);
      await expect(
        createElevenLabsProvider(env(), timeout.http).listVoices(),
      ).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        message: 'ElevenLabs did not answer within 20 s',
        details: { attempts: 3, timeout: true },
      });

      const recovered = fakeService([new TypeError('fetch failed'), jsonReply({ voices: [] })]);
      expect(await createElevenLabsProvider(env(), recovered.http).listVoices()).toEqual([]);
      expect(recovered.sleeps).toEqual([500]);
    });

    it('every request carries a time limit', async () => {
      const signals: (AbortSignal | null | undefined)[] = [];
      const provider = createElevenLabsProvider(env(), {
        fetch: (async (_url: unknown, init?: RequestInit) => {
          signals.push(init?.signal);
          return jsonReply({ voices: [] });
        }) as typeof fetch,
      });
      await provider.listVoices();
      expect(signals[0]).toBeInstanceOf(AbortSignal);
    });

    it('rejects malformed answers', async () => {
      const notJson = fakeService([new Response('<html>gateway</html>', { status: 200 })]);
      await expect(
        createElevenLabsProvider(env(), notJson.http).synthesize(request()),
      ).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        message: 'ElevenLabs returned an unreadable response',
      });
      const wrongShape = fakeService([jsonReply({ audio: 'nope' })]);
      await expect(
        createElevenLabsProvider(env(), wrongShape.http).synthesize(request()),
      ).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
      });
      const wrongVoices = fakeService([jsonReply({ items: [] })]);
      await expect(
        createElevenLabsProvider(env(), wrongVoices.http).listVoices(),
      ).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
      });
    });

    it('uses ELEVENLABS_BASE_URL', async () => {
      const service = fakeService([jsonReply({ voices: [] })]);
      await createElevenLabsProvider(
        env({ ELEVENLABS_BASE_URL: 'https://proxy.example.com/' }),
        service.http,
      ).listVoices();
      expect(service.calls[0]?.url).toBe('https://proxy.example.com/v1/voices');
    });
  });
});
