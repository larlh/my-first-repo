import fs from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AppError,
  DICTATION_MAX_SEGMENT_MS,
  DICTATION_MAX_UPLOAD_BYTES,
  allRoutes,
  api,
} from '@parlante/shared';
import type {
  DictationProvider,
  DictationRequest,
  DictationResult,
  DictationStatus,
  ProviderRef,
} from '@parlante/shared';
import { creditLedger, eq, workspaces } from '@parlante/db';
import {
  disposeWhisperEngines,
  isLocalWhisperInstalled,
  providerEnvSchema,
  resolveDictationModelDir,
} from '@parlante/providers';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import systemModule from '../system/index';
import dictationModule from './index';
import { parseDictationWav } from './wav';

const RATE = 16_000;
const FAKE_INFO: ProviderRef = {
  id: 'local-whisper',
  name: 'Whisper base (local)',
  quality: 'basic',
  local: true,
};

/** Build a WAV file; the defaults are the only format dictation accepts. */
function wav(
  samples: Int16Array,
  format: { sampleRate?: number; channels?: number; bits?: number; code?: number; dataSize?: number } = {},
): Buffer {
  const { sampleRate = RATE, channels = 1, bits = 16, code = 1 } = format;
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(code, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(format.dataSize ?? data.length, 40);
  return Buffer.concat([header, data]);
}

function tone(seconds: number): Int16Array {
  const samples = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(9000 * Math.sin((2 * Math.PI * 180 * i) / RATE));
  }
  return samples;
}

interface FakeDictation extends DictationProvider {
  requests: DictationRequest[];
  /** When set, `transcribe` waits for `release()`. */
  hold: boolean;
  release(): void;
  next: () => DictationResult | Promise<DictationResult>;
  state: DictationStatus;
}

function fakeDictation(): FakeDictation {
  let waiters: (() => void)[] = [];
  const fake: FakeDictation = {
    info: FAKE_INFO,
    requests: [],
    hold: false,
    release() {
      const current = waiters;
      waiters = [];
      for (const resolve of current) resolve();
    },
    next: () => ({ text: 'Hola, esto es un dictado.', language: 'es', provider: FAKE_INFO }),
    state: {
      available: true,
      reason: null,
      reasonCode: null,
      languages: ['es', 'en'],
      model: 'whisper-base',
    },
    status: async () => fake.state,
    async transcribe(request) {
      fake.requests.push(request);
      if (fake.hold) await new Promise<void>((resolve) => waiters.push(resolve));
      return fake.next();
    },
  };
  return fake;
}

function upload(data: Buffer, fields?: Record<string, string>) {
  return { field: 'audio', filename: 'segment.wav', contentType: 'audio/wav', data, fields };
}

describe('dictation WAV reader', () => {
  it('reads PCM 16-bit mono 16 kHz and measures its real length', () => {
    const audio = parseDictationWav(wav(Int16Array.from([0, 1, -1, 32767, -32768])));
    expect([...audio.samples]).toEqual([0, 1, -1, 32767, -32768]);
    expect(audio.sampleRate).toBe(RATE);
    expect(parseDictationWav(wav(tone(2.5))).durationMs).toBe(2500);
  });

  it('skips other chunks, accepts streamed sizes and an odd offset in memory', () => {
    const body = wav(tone(0.5));
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc'), Buffer.from([0])]);
    const withList = Buffer.concat([body.subarray(0, 36), list, body.subarray(36)]);
    expect(parseDictationWav(withList).samples).toHaveLength(8000);
    // ffmpeg writing to a pipe leaves 0xFFFFFFFF as the data size.
    expect(parseDictationWav(wav(tone(0.5), { dataSize: 0xffffffff })).samples).toHaveLength(8000);
    // The bytes of a multipart part rarely start on an even address.
    const shifted = Buffer.concat([Buffer.from([0]), body]).subarray(1);
    expect(parseDictationWav(shifted).samples).toHaveLength(8000);
  });

  it('rejects everything else with a translatable reason', () => {
    const reason = (bytes: Buffer): unknown => {
      try {
        parseDictationWav(bytes);
        return 'accepted';
      } catch (err) {
        return [(err as AppError).code, ((err as AppError).details as { reason: string }).reason];
      }
    };
    expect(reason(Buffer.from('\x89PNG\r\n\x1a\n0000000000000000'))).toEqual([
      'UNSUPPORTED_MEDIA_TYPE',
      'not_wav',
    ]);
    expect(reason(Buffer.alloc(4))).toEqual(['UNSUPPORTED_MEDIA_TYPE', 'not_wav']);
    expect(reason(wav(tone(1), { channels: 2 }))).toEqual(['VALIDATION_ERROR', 'unsupported_format']);
    expect(reason(wav(tone(1), { sampleRate: 44_100 }))).toEqual([
      'VALIDATION_ERROR',
      'unsupported_format',
    ]);
    expect(reason(wav(tone(1), { bits: 8 }))).toEqual(['VALIDATION_ERROR', 'unsupported_format']);
    expect(reason(wav(tone(1), { code: 3 }))).toEqual(['VALIDATION_ERROR', 'unsupported_format']);
    expect(reason(wav(new Int16Array(0)))).toEqual(['VALIDATION_ERROR', 'empty_audio']);
    // The header promises more audio than arrived (a cut upload).
    expect(reason(wav(tone(1), { dataSize: 64_000 }))).toEqual(['VALIDATION_ERROR', 'invalid_wav']);
    expect(reason(wav(tone(1)).subarray(0, 30))).toEqual(['VALIDATION_ERROR', 'invalid_wav']);
    expect(reason(Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEdata'), Buffer.alloc(8)]))).toEqual([
      'VALIDATION_ERROR',
      'invalid_wav',
    ]);
    expect(reason(wav(tone(30)))).toBe('accepted');
    expect(reason(wav(tone(30.001)))).toEqual(['PAYLOAD_TOO_LARGE', 'audio_too_long']);
  });
});

describe('POST /api/dictation/transcribe', () => {
  let t: TestApp;
  let fake: FakeDictation;
  let alice: TestActor;

  beforeAll(async () => {
    t = await createTestApp({ modules: [dictationModule, systemModule] });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    fake = fakeDictation();
    t.app.providers.dictation = fake;
    alice = await t.signUp();
  });

  it('transcribes a segment for any member, in memory, without charging credits', async () => {
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const res = await t.call(api.dictation.transcribe, {
      as: viewer,
      multipart: upload(wav(tone(2)), { language: 'es' }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      text: 'Hola, esto es un dictado.',
      language: 'es',
      provider: FAKE_INFO,
      audioMs: 2000,
      processingMs: expect.any(Number),
    });
    expect(res.body.processingMs).toBeGreaterThanOrEqual(0);

    // What the provider received: the samples, their rate and the hint — nothing else.
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request.sampleRate).toBe(RATE);
    expect(request.language).toBe('es');
    expect(request.samples).toBeInstanceOf(Int16Array);
    expect([...request.samples.subarray(0, 64)]).toEqual([...tone(2).subarray(0, 64)]);
    expect(request.samples).toHaveLength(32_000);
    expect(request.signal).toBeInstanceOf(AbortSignal);

    // No credits, no ledger entry.
    const [workspace] = await t.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, alice.workspace.id));
    expect(workspace?.credits).toBe(alice.workspace.credits);
    expect(await t.db.select().from(creditLedger)).toHaveLength(0);
    // Nothing on disk: neither storage objects nor upload temp files.
    expect(await fs.readdir(t.storageDir)).toEqual([]);
  });

  it('lets the model detect the language when the client sends none', async () => {
    fake.next = () => ({ text: 'Hello there.', language: 'en', provider: FAKE_INFO });
    const res = await t.call(api.dictation.transcribe, { as: alice, multipart: upload(wav(tone(1))) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ text: 'Hello there.', language: 'en', audioMs: 1000 });
    expect(fake.requests[0]!.language).toBeUndefined();
    // Silence: an empty text and no language is a valid answer.
    fake.next = () => ({ text: '', language: null, provider: FAKE_INFO });
    const quiet = await t.call(api.dictation.transcribe, { as: alice, multipart: upload(wav(tone(1))) });
    expect(quiet.body).toMatchObject({ text: '', language: null });
  });

  it('requires a session and rejects other origins', async () => {
    const anonymous = await t.call(api.dictation.transcribe, { multipart: upload(wav(tone(1))) });
    expect(anonymous.status).toBe(401);
    expect(anonymous.error.code).toBe('UNAUTHENTICATED');
    const foreign = await t.call(api.dictation.transcribe, {
      as: alice,
      multipart: upload(wav(tone(1))),
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    // An API key is not a session: dictation is not part of the public API.
    const key = await t.apiKeyFor(alice.workspace);
    const withKey = await t.call(api.dictation.transcribe, { as: key, multipart: upload(wav(tone(1))) });
    expect(withKey.status).toBe(401);
    expect(fake.requests).toHaveLength(0);
  });

  it('is not exposed under /v1', async () => {
    const v1 = allRoutes().filter((entry) => entry.route.path.startsWith('/v1/'));
    expect(v1.length).toBeGreaterThan(0);
    expect(v1.some((entry) => /dictation|transcri/i.test(entry.route.path))).toBe(false);
    const key = await t.apiKeyFor(alice.workspace);
    const res = await t.inject({
      method: 'POST',
      url: '/v1/dictation/transcribe',
      headers: { authorization: `Bearer ${key.apiKey}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('validates the audio before it reaches the model', async () => {
    const send = (data: Buffer, fields?: Record<string, string>) =>
      t.call(api.dictation.transcribe, { as: alice, multipart: upload(data, fields) });
    const reasonOf = (res: Awaited<ReturnType<typeof send>>) =>
      (res.error.details as { reason?: string } | undefined)?.reason;

    const png = await send(Buffer.from('\x89PNG\r\n\x1a\n-not-audio-at-all-'));
    expect([png.status, png.error.code, reasonOf(png)]).toEqual([
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'not_wav',
    ]);
    const stereo = await send(wav(tone(1), { channels: 2 }));
    expect([stereo.status, stereo.error.code, reasonOf(stereo)]).toEqual([
      400,
      'VALIDATION_ERROR',
      'unsupported_format',
    ]);
    expect(stereo.error.details).toMatchObject({
      received: { channels: 2, sampleRate: 16_000, bitsPerSample: 16 },
      expected: { channels: 1, sampleRate: 16_000, bitsPerSample: 16 },
    });
    const cd = await send(wav(tone(1), { sampleRate: 44_100 }));
    expect([cd.status, reasonOf(cd)]).toEqual([400, 'unsupported_format']);
    const cut = await send(wav(tone(1), { dataSize: 640_000 }));
    expect([cut.status, reasonOf(cut)]).toEqual([400, 'invalid_wav']);
    const empty = await send(wav(new Int16Array(0)));
    expect([empty.status, reasonOf(empty)]).toEqual([400, 'empty_audio']);

    const badLanguage = await send(wav(tone(1)), { language: 'klingon' });
    expect([badLanguage.status, badLanguage.error.code]).toEqual([400, 'VALIDATION_ERROR']);

    const noFile = await t.inject({
      method: 'POST',
      url: api.dictation.transcribe.path,
      headers: {
        cookie: alice.cookie,
        'content-type': 'multipart/form-data; boundary=x',
      },
      payload: '--x\r\nContent-Disposition: form-data; name="language"\r\n\r\nes\r\n--x--\r\n',
    });
    expect(noFile.statusCode).toBe(400);
    expect(noFile.json().error.code).toBe('VALIDATION_ERROR');

    const json = await t.call(api.dictation.transcribe, { as: alice, body: { audio: 'UklGRg==' } });
    expect([json.status, json.error.code]).toEqual([400, 'BAD_REQUEST']);

    expect(fake.requests).toHaveLength(0);
  });

  it('accepts exactly 30 s and rejects anything longer, by duration and by size', async () => {
    const limit = await t.call(api.dictation.transcribe, {
      as: alice,
      multipart: upload(wav(tone(DICTATION_MAX_SEGMENT_MS / 1000))),
    });
    expect(limit.status).toBe(200);
    expect(limit.body.audioMs).toBe(30_000);

    const tooLong = await t.call(api.dictation.transcribe, {
      as: alice,
      multipart: upload(wav(tone(30.05))),
    });
    expect(tooLong.status).toBe(413);
    expect(tooLong.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(tooLong.error.details).toMatchObject({
      reason: 'audio_too_long',
      maxSegmentMs: 30_000,
      audioMs: 30_050,
    });

    // Far beyond the byte limit: cut off while it is being received.
    const huge = await t.call(api.dictation.transcribe, {
      as: alice,
      multipart: upload(wav(tone(90))),
    });
    expect(huge.status).toBe(413);
    expect(huge.error.details).toMatchObject({ reason: 'audio_too_long', maxSegmentMs: 30_000 });
    expect(wav(tone(90)).length).toBeGreaterThan(DICTATION_MAX_UPLOAD_BYTES);
    expect(fake.requests).toHaveLength(1);
  });

  it('answers 503 with the reason of the provider, and 502 when a segment fails', async () => {
    fake.state = {
      available: false,
      reason: 'The speech model could not be loaded: bad file',
      reasonCode: 'runtime_unavailable',
      languages: ['es'],
      model: 'whisper-base',
    };
    const down = await t.call(api.dictation.transcribe, { as: alice, multipart: upload(wav(tone(1))) });
    expect(down.status).toBe(503);
    expect(down.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: { reason: 'runtime_unavailable' },
    });
    expect(fake.requests).toHaveLength(0);

    fake.state = { ...fake.state, available: true, reason: null, reasonCode: null };
    fake.next = () => {
      throw new AppError('PROVIDER_ERROR', 'Local speech recognition failed: invalid tensor');
    };
    const failed = await t.call(api.dictation.transcribe, { as: alice, multipart: upload(wav(tone(1))) });
    expect(failed.status).toBe(502);
    // A failure frees its turn: the next segment is served.
    fake.next = () => ({ text: 'bien', language: 'es', provider: FAKE_INFO });
    for (let i = 0; i < 6; i += 1) {
      const ok = await t.call(api.dictation.transcribe, { as: alice, multipart: upload(wav(tone(1))) });
      expect(ok.status).toBe(200);
    }
  });

  it('answers 503 not_configured when the server has no dictation provider', async () => {
    delete t.app.providers.dictation;
    const res = await t.call(api.dictation.transcribe, { as: alice, multipart: upload(wav(tone(1))) });
    expect(res.status).toBe(503);
    expect(res.error.details).toEqual({ reason: 'not_configured' });
    const caps = await t.call(api.system.capabilities, { as: alice });
    expect(caps.body.dictation).toMatchObject({
      local: { available: false, provider: null, reasonCode: 'not_configured' },
      maxSegmentMs: 30_000,
    });
  });

  it('reports dictation in the capabilities', async () => {
    const caps = await t.call(api.system.capabilities, { as: alice });
    expect(caps.status).toBe(200);
    expect(caps.body.dictation).toEqual({
      local: {
        available: true,
        provider: FAKE_INFO,
        reason: null,
        reasonCode: null,
        languages: ['es', 'en'],
      },
      maxSegmentMs: DICTATION_MAX_SEGMENT_MS,
    });
  });
});

describe('dictation without the model installed (real provider)', () => {
  let t: TestApp;
  beforeAll(async () => {
    // The harness points DICTATION_MODEL_DIR at an empty directory: nothing is installed.
    t = await createTestApp({ modules: [dictationModule, systemModule] });
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  it('announces it in the capabilities and answers 503 model_not_installed; the app keeps working', async () => {
    const alice = await t.signUp();
    const caps = await t.call(api.system.capabilities, { as: alice });
    expect(caps.status).toBe(200);
    expect(caps.body.dictation).toEqual({
      local: {
        available: false,
        provider: { id: 'local-whisper', name: 'Whisper base (local)', quality: 'basic', local: true },
        reason: expect.stringContaining('pnpm dictation:setup'),
        reasonCode: 'model_not_installed',
        languages: [],
      },
      maxSegmentMs: 30_000,
    });
    // Without the model, speech-to-text stays what it was: the user supplies the transcript.
    expect(caps.body.active.stt.id).toBe('manual');
    expect(caps.body.sttRequiresTranscript).toBe(true);

    const res = await t.call(api.dictation.transcribe, {
      as: alice,
      multipart: upload(wav(tone(1)), { language: 'es' }),
    });
    expect(res.status).toBe(503);
    expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.error.details).toEqual({ reason: 'model_not_installed' });
    expect(res.error.message).toMatch(/pnpm dictation:setup/);
  });
});

describe('dictation limits', () => {
  let t: TestApp;
  let fake: FakeDictation;

  afterEach(async () => {
    fake.release();
    await t.close();
  });

  it('limits the segments per user and minute with 429 and Retry-After', async () => {
    t = await createTestApp({
      modules: [dictationModule],
      env: { RATE_LIMIT_ENABLED: 'true', DICTATION_RATE_LIMIT_PER_MIN: '2' },
    });
    await t.reset();
    fake = fakeDictation();
    t.app.providers.dictation = fake;
    const alice = await t.signUp();
    const bob = await t.signUp();
    const send = (as: TestActor) =>
      t.call(api.dictation.transcribe, { as, multipart: upload(wav(tone(1))) });

    const first = await send(alice);
    expect(first.status).toBe(200);
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');
    expect((await send(alice)).status).toBe(200);

    const limited = await send(alice);
    expect(limited.status).toBe(429);
    expect(limited.error.code).toBe('RATE_LIMITED');
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.error.details).toMatchObject({
      reason: 'user_rate_limit',
      limit: 2,
      windowSec: 60,
      retryAfterSec: retryAfter,
    });
    expect(fake.requests).toHaveLength(2); // the limited request never reached the model

    // The limit is per user: a colleague is not affected.
    expect((await send(bob)).status).toBe(200);
  });

  it('bounds how many segments wait for the model, with 429 and Retry-After', async () => {
    t = await createTestApp({ modules: [dictationModule], env: { DICTATION_MAX_PENDING: '2' } });
    await t.reset();
    fake = fakeDictation();
    t.app.providers.dictation = fake;
    const alice = await t.signUp();
    const bob = await t.signUp();
    const send = (as: TestActor) =>
      t.call(api.dictation.transcribe, { as, multipart: upload(wav(tone(1))) });

    fake.hold = true;
    const running = send(alice);
    const waiting = send(bob);
    // Both reached the provider and are being held there.
    await expect.poll(() => fake.requests.length).toBe(2);

    const rejected = await send(alice);
    expect(rejected.status).toBe(429);
    expect(rejected.error.code).toBe('RATE_LIMITED');
    expect(Number(rejected.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(rejected.error.details).toMatchObject({ reason: 'busy', pending: 2 });
    expect(fake.requests).toHaveLength(2);

    fake.hold = false;
    fake.release();
    expect((await running).status).toBe(200);
    expect((await waiting).status).toBe(200);
    // The turns were given back.
    expect((await send(alice)).status).toBe(200);
  });
});

/* ---------------------------------------------------------------------------------------------
 * [slow] The same route with the REAL model, when it is installed on this machine: speech
 * synthesized by the repo's eSpeak goes in as WAV, the right words come out.
 * ------------------------------------------------------------------------------------------- */

const realEnv = providerEnvSchema.parse({});
const realModelsDir = resolveDictationModelDir(realEnv);

describe.skipIf(!isLocalWhisperInstalled(realEnv))(
  '[slow] dictation with the real model',
  { timeout: 240_000 },
  () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp({
        modules: [dictationModule, systemModule],
        env: { DICTATION_MODEL_DIR: realModelsDir },
      });
      await t.reset();
    });
    afterAll(async () => {
      await t.close();
      await disposeWhisperEngines();
    });

    /** eSpeak (the product's local TTS) → WAV PCM 16-bit mono 16 kHz. */
    async function speak(text: string, language: 'es' | 'en'): Promise<Buffer> {
      const speech = await t.app.providers.tts.default.synthesize({
        text,
        providerVoiceId: `${language}-f1`,
        language,
        speed: 1,
        pitch: 0,
      });
      const bytes = Buffer.from(speech.audio);
      const at = bytes.indexOf('data', 12, 'ascii') + 8;
      const source = new Int16Array(Math.floor((bytes.length - at) / 2));
      for (let i = 0; i < source.length; i += 1) source[i] = bytes.readInt16LE(at + i * 2);
      const out = new Int16Array(Math.round((source.length * RATE) / speech.sampleRate));
      for (let i = 0; i < out.length; i += 1) {
        const position = (i * speech.sampleRate) / RATE;
        const index = Math.floor(position);
        const a = source[index] ?? 0;
        const b = source[index + 1] ?? a;
        out[i] = Math.round(a + (b - a) * (position - index));
      }
      return wav(out);
    }
    const words = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    it('turns Spanish and English speech into the right text', async () => {
      const alice = await t.signUp();
      const caps = await t.call(api.system.capabilities, { as: alice });
      expect(caps.body.dictation.local).toMatchObject({ available: true, reasonCode: null });
      expect(caps.body.dictation.local.languages).toEqual(expect.arrayContaining(['es', 'en']));
      // With the model installed, `auto` also gives video translation automatic transcription.
      expect(caps.body.active.stt).toMatchObject({ id: 'local-whisper', quality: 'basic', local: true });
      expect(caps.body.sttRequiresTranscript).toBe(false);

      const spanish = 'Hola, bienvenidos a esta presentación sobre nuestro nuevo producto.';
      const es = await t.call(api.dictation.transcribe, {
        as: alice,
        multipart: upload(await speak(spanish, 'es'), { language: 'es' }),
      });
      expect(es.status).toBe(200);
      expect(words(es.body.text)).toBe(words(spanish));
      expect(es.body.language).toBe('es');
      expect(es.body.provider).toEqual({
        id: 'local-whisper',
        name: 'Whisper base (local)',
        quality: 'basic',
        local: true,
      });
      expect(es.body.audioMs).toBeGreaterThan(2000);
      expect(es.body.processingMs).toBeGreaterThan(0);

      // No hint: the language is detected.
      const english = 'Hello and welcome to this presentation about our new product.';
      const en = await t.call(api.dictation.transcribe, {
        as: alice,
        multipart: upload(await speak(english, 'en')),
      });
      expect(en.status).toBe(200);
      expect(words(en.body.text)).toBe(words(english));
      expect(en.body.language).toBe('en');

      const silence = await t.call(api.dictation.transcribe, {
        as: alice,
        multipart: upload(wav(new Int16Array(RATE * 3))),
      });
      expect(silence.body).toMatchObject({ text: '', language: null, audioMs: 3000 });
      expect(await fs.readdir(t.storageDir)).toEqual([]);
    });
  },
);
