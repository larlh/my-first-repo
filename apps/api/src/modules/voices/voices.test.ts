import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AppError,
  LOCAL_VOICES,
  VOICE_PREVIEW_TEXTS,
  api,
  estimateSpeechTimeline,
  newId,
} from '@parlante/shared';
import type {
  ProviderRef,
  ProviderVoice,
  RouteBodyInput,
  RouteQueryInput,
  TTSProvider,
  TTSRequest,
  VoiceProfile,
} from '@parlante/shared';
import { consentRecords, voices } from '@parlante/db';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import voicesModule from './index';

/* -------------------------------------------------------------------------------------------
 * The TTS providers are replaced by deterministic doubles that honour the TTSProvider contract
 * (real WAV bytes, timeline from the shared estimator). Everything else is the real app:
 * routes, moderation provider, `synthesizeCached`, storage, signed file URLs, database.
 * ----------------------------------------------------------------------------------------- */

const SAMPLE_RATE = 16_000;

/** A valid RIFF/WAVE file (PCM 16-bit mono) with a quiet tone of the given length. */
function wav(durationMs: number, frequency: number): Uint8Array {
  const samples = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const value = Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE) * 6000;
    buffer.writeInt16LE(Math.round(value), 44 + i * 2);
  }
  return buffer;
}

interface FakeTts extends TTSProvider {
  requests: TTSRequest[];
  listCalls: number;
  /** Make the next calls fail. */
  failList: unknown;
  failSynthesis: unknown;
}

function fakeTts(info: ProviderRef, providerVoices: ProviderVoice[]): FakeTts {
  const provider: FakeTts = {
    info,
    requests: [],
    listCalls: 0,
    failList: null,
    failSynthesis: null,
    listVoices() {
      provider.listCalls += 1;
      return provider.failList
        ? Promise.reject(provider.failList as Error)
        : Promise.resolve(providerVoices);
    },
    synthesize(request) {
      provider.requests.push(request);
      if (provider.failSynthesis) return Promise.reject(provider.failSynthesis as Error);
      const durationMs = Math.round((request.text.length * 60) / request.speed);
      return Promise.resolve({
        audio: wav(durationMs, 220 + request.pitch * 10),
        format: 'wav',
        sampleRate: SAMPLE_RATE,
        durationMs,
        ...estimateSpeechTimeline(request.text, durationMs, request.language),
        provider: info,
      });
    },
  };
  return provider;
}

const LOCAL_INFO: ProviderRef = {
  id: 'espeak',
  name: 'eSpeak NG (local)',
  quality: 'basic',
  local: true,
};
const PREMIUM_INFO: ProviderRef = {
  id: 'acme',
  name: 'Acme Voices',
  quality: 'premium',
  local: false,
};

const LOCAL_PROVIDER_VOICES: ProviderVoice[] = LOCAL_VOICES.map((voice) => ({
  providerVoiceId: voice.providerVoiceId,
  name: voice.name,
  language: voice.language,
  gender: voice.gender,
  description: `Voz local en ${voice.language}`,
  tags: ['local'],
}));
const PREMIUM_PROVIDER_VOICES: ProviderVoice[] = [
  {
    providerVoiceId: 'Nova.v2',
    name: 'Nova',
    language: 'en-US',
    // One voice for every language — plus one the product does not support.
    languages: ['en-US', 'es', 'fr', 'de', 'ja'],
    gender: 'female',
    description: 'Warm narrator',
    tags: ['narration', 'warm'],
  },
  {
    providerVoiceId: 'bruno',
    name: 'Bruno',
    language: 'pt-BR',
    gender: 'male',
    description: 'Locutor brasileiro',
    tags: ['publicidade'],
  },
  {
    providerVoiceId: 'haruka',
    name: 'Haruka',
    language: 'ja',
    gender: 'female',
    description: 'Not a supported language',
    tags: [],
  },
];

let t: TestApp;
let local: FakeTts;
let premium: FakeTts;

/** Install fresh provider doubles: `premium` is the default, `local` is always active. */
function installTts(): void {
  local = fakeTts(LOCAL_INFO, LOCAL_PROVIDER_VOICES);
  premium = fakeTts(PREMIUM_INFO, PREMIUM_PROVIDER_VOICES);
  const active = [local, premium];
  t.app.providers.tts = {
    default: premium,
    get: (id) => active.find((provider) => provider.info.id === id) ?? null,
    all: () => active,
  };
}

beforeAll(async () => {
  t = await createTestApp({ modules: [voicesModule] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  installTts();
});

const PROFILE: VoiceProfile = {
  baseVoiceId: 'es-f1',
  pitchSemitones: -2,
  speed: 1.1,
  meanF0Hz: 180,
};

async function seedClonedVoice(
  actor: TestActor,
  values: Partial<typeof voices.$inferInsert> = {},
): Promise<string> {
  const consentId = newId('consent');
  await t.db.insert(consentRecords).values({
    id: consentId,
    workspaceId: actor.workspace.id,
    userId: actor.user.id,
    kind: 'voice_clone',
    subjectName: 'Ana García',
    relationship: 'self',
    statementVersion: '2026-01',
    statement: 'I consent',
    locale: 'es',
    ip: '203.0.113.9',
  });
  const id = newId('voice');
  await t.db.insert(voices).values({
    id,
    workspaceId: actor.workspace.id,
    name: 'Voz de Ana',
    language: 'es',
    gender: 'female',
    status: 'ready',
    ttsProviderId: 'espeak',
    providerVoiceId: 'es-f1',
    profile: PROFILE,
    consentId,
    ...values,
  });
  return id;
}

type ListQuery = RouteQueryInput<typeof api.voices.list>;
type SynthesizeBody = RouteBodyInput<typeof api.voices.synthesize>;

describe('voice catalogue', () => {
  it('lists the stock voices of every active provider and the cloned voices of the workspace', async () => {
    const alice = await t.signUp();
    const now = Date.now();
    const ready = await seedClonedVoice(alice, { createdAt: new Date(now - 120_000) });
    const processing = await seedClonedVoice(alice, {
      name: 'En proceso',
      status: 'processing',
      ttsProviderId: null,
      providerVoiceId: null,
      profile: null,
      provider: null,
      createdAt: new Date(now - 60_000),
    });

    const list = await t.call(api.voices.list, { as: alice });
    expect(list.status).toBe(200);
    // Default provider first, then the others, then cloned voices newest first.
    expect(list.body.items.map((v) => v.id)).toEqual([
      'acme:Nova.v2',
      'acme:bruno',
      ...LOCAL_VOICES.map((v) => `espeak:${v.providerVoiceId}`),
      processing,
      ready,
    ]);
    // At least 8 languages are covered (master prompt, feature 3).
    const languages = new Set(list.body.items.map((v) => v.language.slice(0, 2)));
    expect(languages.size).toBeGreaterThanOrEqual(8);

    expect(list.body.items.find((v) => v.id === 'espeak:es-f1')).toEqual({
      id: 'espeak:es-f1',
      kind: 'stock',
      name: 'Carmen',
      provider: LOCAL_INFO,
      language: 'es',
      multilingual: false,
      gender: 'female',
      description: 'Voz local en es',
      tags: ['local'],
      status: 'ready',
      workspaceId: null,
      consentId: null,
      profile: null,
      error: null,
      createdAt: null,
    });
    // A multilingual voice appears ONCE, flagged, with the supported languages only; honest
    // provider label (premium, not local).
    expect(list.body.items.find((v) => v.id === 'acme:Nova.v2')).toMatchObject({
      kind: 'stock',
      provider: PREMIUM_INFO,
      language: 'en-US',
      multilingual: true,
      languages: ['en-US', 'es', 'fr', 'de'],
    });
    // Voices in a language the product does not support are left out.
    expect(list.body.items.some((v) => v.name === 'Haruka')).toBe(false);

    expect(list.body.items.find((v) => v.id === ready)).toMatchObject({
      kind: 'cloned',
      name: 'Voz de Ana',
      language: 'es',
      status: 'ready',
      workspaceId: alice.workspace.id,
      profile: PROFILE,
      // No provider on the row: the cloning provider that is active.
      provider: t.app.providers.voiceClone.info,
    });
    expect(list.body.items.find((v) => v.id === ready)?.consentId).toMatch(/^cns_/);
    expect(list.body.items.find((v) => v.id === processing)).toMatchObject({
      status: 'processing',
      profile: null,
    });

    // Provider catalogues are asked once and reused.
    await t.call(api.voices.list, { as: alice });
    expect(local.listCalls).toBe(1);
    expect(premium.listCalls).toBe(1);
  });

  it('filters by language, gender, provider and kind, and searches', async () => {
    const alice = await t.signUp();
    const cloned = await seedClonedVoice(alice, {
      language: 'fr',
      gender: 'male',
      name: 'Voix de Luc',
      provider: { id: 'local', name: 'Perfil de voz (local)', quality: 'basic', local: true },
    });
    const ids = async (query: ListQuery) =>
      (await t.call(api.voices.list, { as: alice, query })).body.items.map((v) => v.id);

    // A language: its voices plus EVERY multilingual voice, plus cloned voices in it.
    expect(await ids({ language: 'fr' })).toEqual([
      'acme:Nova.v2',
      'espeak:fr-f1',
      'espeak:fr-m1',
      cloned,
    ]);
    // Regional variants belong to their base language.
    expect(await ids({ language: 'pt' })).toEqual([
      'acme:Nova.v2',
      'acme:bruno',
      'espeak:pt-f1',
      'espeak:pt-m1',
    ]);
    expect(await ids({ language: 'fr', gender: 'male' })).toEqual(['espeak:fr-m1', cloned]);
    expect(await ids({ language: 'fr', kind: 'cloned' })).toEqual([cloned]);
    expect(await ids({ language: 'es', kind: 'cloned' })).toEqual([]);
    expect(await ids({ kind: 'stock', provider: 'acme' })).toEqual(['acme:Nova.v2', 'acme:bruno']);
    expect(await ids({ provider: 'local' })).toEqual([cloned]);
    expect(await ids({ provider: 'nobody' })).toEqual([]);
    expect((await ids({ kind: 'stock' })).length).toBe(2 + LOCAL_VOICES.length);

    expect(await ids({ q: 'carmen' })).toEqual(['espeak:es-f1']);
    expect(await ids({ q: 'INES' })).toEqual(['espeak:pt-f1']); // "Inês"
    expect(await ids({ q: 'warm' })).toEqual(['acme:Nova.v2']);
    // By language name, in Spanish/native or English.
    expect(await ids({ q: 'deutsch' })).toEqual(['espeak:de-f1', 'espeak:de-m1']);
    expect(await ids({ q: 'german' })).toEqual(['espeak:de-f1', 'espeak:de-m1']);
    expect(await ids({ q: 'acme bruno' })).toEqual(['acme:bruno']);
    expect(await ids({ q: 'luc' })).toEqual([cloned]);
    expect(await ids({ q: 'zzzz' })).toEqual([]);

    const invalid: Record<string, string>[] = [
      { language: 'xx' },
      { gender: 'robot' },
      { kind: 'mine' },
    ];
    for (const query of invalid) {
      const bad = await t.inject({
        method: 'GET',
        url: '/api/voices',
        query,
        headers: { cookie: alice.cookie },
      });
      expect(bad.statusCode).toBe(400);
    }
  });

  it('keeps listing when one provider is down, and says so when none can answer', async () => {
    const alice = await t.signUp();
    premium.failList = new Error('upstream timeout');

    const partial = await t.call(api.voices.list, { as: alice });
    expect(partial.status).toBe(200);
    expect(partial.body.items.map((v) => v.provider.id)).toEqual(LOCAL_VOICES.map(() => 'espeak'));
    // Asking for exactly the provider that is down is an error, not an empty catalogue.
    const onlyDown = await t.call(api.voices.list, { as: alice, query: { provider: 'acme' } });
    expect(onlyDown.status).toBe(502);
    expect(onlyDown.error).toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { provider: 'acme' },
    });
    expect(onlyDown.error.message).toContain('Acme Voices');
    expect(onlyDown.error.message).not.toContain('upstream timeout');

    // Failures are not cached: once the provider answers again, its voices are back.
    premium.failList = null;
    const recovered = await t.call(api.voices.list, { as: alice, query: { provider: 'acme' } });
    expect(recovered.body.items.map((v) => v.id)).toEqual(['acme:Nova.v2', 'acme:bruno']);

    installTts();
    local.failList = new AppError('PROVIDER_NOT_CONFIGURED', 'eSpeak is not installed');
    premium.failList = new Error('upstream timeout');
    const none = await t.call(api.voices.list, { as: alice });
    expect(none.status).toBe(502);
    expect(none.error.code).toBe('PROVIDER_ERROR');
    // Cloned voices do not depend on the stock catalogues.
    const clonedOnly = await t.call(api.voices.list, { as: alice, query: { kind: 'cloned' } });
    expect(clonedOnly.status).toBe(200);
    expect(clonedOnly.body.items).toEqual([]);
  });

  it('reads one voice', async () => {
    const alice = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const cloned = await seedClonedVoice(alice);

    const stock = await t.call(api.voices.get, { as: viewer, params: { voiceId: 'espeak:de-m1' } });
    expect(stock.status).toBe(200);
    expect(stock.body).toMatchObject({ id: 'espeak:de-m1', name: 'Felix', language: 'de' });
    const multi = await t.call(api.voices.get, { as: alice, params: { voiceId: 'acme:Nova.v2' } });
    expect(multi.body).toMatchObject({ multilingual: true, provider: PREMIUM_INFO });
    const own = await t.call(api.voices.get, { as: viewer, params: { voiceId: cloned } });
    expect(own.body).toMatchObject({ id: cloned, kind: 'cloned', profile: PROFILE });

    for (const voiceId of [
      'espeak:xx-f9', // unknown voice of an active provider
      'elevenlabs:21m00Tcm', // provider that is not active on this server
      'acme:haruka', // unsupported language
      'vcl_0000000000000000',
    ]) {
      const missing = await t.call(api.voices.get, { as: alice, params: { voiceId } });
      expect(missing.status).toBe(404);
      expect(missing.error.code).toBe('NOT_FOUND');
    }
    for (const voiceId of ['carmen', 'vcl_x', 'avt_0000000000000000']) {
      expect((await t.call(api.voices.get, { as: alice, params: { voiceId } })).status).toBe(400);
    }
  });

  it('requires a session and never shows the cloned voices of another workspace', async () => {
    const alice = await t.signUp();
    const mallory = await t.signUp();
    const cloned = await seedClonedVoice(alice, { name: 'Voz privada' });

    expect((await t.call(api.voices.list)).status).toBe(401);
    expect((await t.call(api.voices.get, { params: { voiceId: 'espeak:es-f1' } })).status).toBe(
      401,
    );
    const theirs = await t.call(api.voices.list, { as: mallory });
    expect(theirs.body.items.every((v) => v.kind === 'stock')).toBe(true);
    expect(
      (await t.call(api.voices.list, { as: mallory, query: { kind: 'cloned' } })).body.items,
    ).toEqual([]);
    expect(
      (await t.call(api.voices.list, { as: mallory, query: { q: 'privada' } })).body.items,
    ).toEqual([]);
    expect(
      (await t.call(api.voices.get, { as: mallory, params: { voiceId: cloned } })).status,
    ).toBe(404);
  });
});

describe('POST /api/tts/synthesize', () => {
  const synthesize = (actor: TestActor | undefined, body: SynthesizeBody) =>
    t.call(api.voices.synthesize, { ...(actor ? { as: actor } : {}), body });

  it('returns a playable WAV with its lip-sync timeline and the provider that made it', async () => {
    const alice = await t.signUp();
    const text = VOICE_PREVIEW_TEXTS.es ?? '';
    const res = await synthesize(alice, { text, voiceId: 'espeak:es-f1', language: 'es' });

    expect(res.status).toBe(200);
    expect(res.body.mimeType).toBe('audio/wav');
    expect(res.body.provider).toEqual(LOCAL_INFO);
    expect(local.requests).toEqual([
      { text, providerVoiceId: 'es-f1', language: 'es', speed: 1, pitch: 0, profile: null },
    ]);
    // Timeline for the renderer: duration, visemes and one cue per word, inside the audio.
    const { runtime } = res.body;
    expect(runtime.audioDurationMs).toBe(text.length * 60);
    expect(runtime.words.map((w) => w.text).join(' ')).toBe(text);
    expect(runtime.visemes.length).toBeGreaterThan(runtime.words.length);
    expect(runtime.words.every((w) => w.durMs > 0)).toBe(true);
    const lastWord = runtime.words.at(-1);
    expect((lastWord?.tMs ?? 0) + (lastWord?.durMs ?? 0)).toBeLessThanOrEqual(
      runtime.audioDurationMs,
    );

    // The signed URL serves exactly the audio of the provider, from the shared TTS cache.
    const url = new URL(res.body.audioUrl);
    expect(url.pathname).toMatch(/^\/api\/files\/cache\/tts\/[0-9a-f]{64}\.wav$/);
    const audio = await t.inject({ method: 'GET', url: url.pathname + url.search });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/wav');
    expect(audio.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    expect(audio.rawPayload.byteLength).toBe(
      44 + Math.round((SAMPLE_RATE * text.length * 60) / 1000) * 2,
    );
    // Without the signature the cache is not readable.
    expect(
      (await t.inject({ method: 'GET', url: url.pathname })).statusCode,
    ).toBeGreaterThanOrEqual(400);
  });

  it('synthesizes each distinct request once and reuses the cached audio', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const body = { text: '  Hola a todos.  ', voiceId: 'espeak:es-m1', language: 'es' };

    const first = await synthesize(alice, body);
    const again = await synthesize(alice, { ...body, text: 'Hola a todos.' });
    // The cache is by content: another workspace asking for the same stock voice reuses it.
    const other = await synthesize(bob, body);
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0]?.text).toBe('Hola a todos.');
    const path = (url: string) => new URL(url).pathname;
    expect(path(again.body.audioUrl)).toBe(path(first.body.audioUrl));
    expect(path(other.body.audioUrl)).toBe(path(first.body.audioUrl));
    expect(again.body.runtime).toEqual(first.body.runtime);
    expect(again.body.provider).toEqual(LOCAL_INFO);

    // Speed, pitch, language, voice or text changes are different audio.
    const faster = await synthesize(alice, { ...body, speed: 1.5, pitch: -3 });
    expect(local.requests).toHaveLength(2);
    expect(local.requests[1]).toMatchObject({ speed: 1.5, pitch: -3 });
    expect(path(faster.body.audioUrl)).not.toBe(path(first.body.audioUrl));
    expect(faster.body.runtime.audioDurationMs).toBeLessThan(first.body.runtime.audioDurationMs);
    await synthesize(alice, { ...body, voiceId: 'espeak:es-f1' });
    await synthesize(alice, { ...body, text: 'Hola a casi todos.' });
    expect(local.requests).toHaveLength(4);

    // A multilingual premium voice speaks any language and is labelled as premium.
    const premiumSpeech = await synthesize(alice, {
      text: 'Bonjour à tous.',
      voiceId: 'acme:Nova.v2',
      language: 'fr',
    });
    expect(premiumSpeech.status).toBe(200);
    expect(premiumSpeech.body.provider).toEqual(PREMIUM_INFO);
    expect(premium.requests).toEqual([
      expect.objectContaining({ providerVoiceId: 'Nova.v2', language: 'fr' }),
    ]);
  });

  it('speaks with a cloned voice of the workspace only when it is ready', async () => {
    const alice = await t.signUp();
    const mallory = await t.signUp();
    const cloned = await seedClonedVoice(alice);
    const processing = await seedClonedVoice(alice, {
      status: 'processing',
      ttsProviderId: null,
      providerVoiceId: null,
      profile: null,
    });
    const body = { text: 'Esta es mi voz.', language: 'es' };

    const ok = await synthesize(alice, { ...body, voiceId: cloned });
    expect(ok.status).toBe(200);
    // The local profile of the clone reaches the provider.
    expect(local.requests).toEqual([
      {
        text: 'Esta es mi voz.',
        providerVoiceId: 'es-f1',
        language: 'es',
        speed: 1,
        pitch: 0,
        profile: PROFILE,
      },
    ]);

    const notReady = await synthesize(alice, { ...body, voiceId: processing });
    expect(notReady.status).toBe(409);
    expect(notReady.error.code).toBe('INVALID_STATE');
    // Somebody else's voice does not exist for you — and nothing is synthesized.
    const stolen = await synthesize(mallory, { ...body, voiceId: cloned });
    expect(stolen.status).toBe(404);
    expect(stolen.error.code).toBe('NOT_FOUND');
    expect(local.requests).toHaveLength(1);
  });

  it('moderates the text before any synthesis', async () => {
    const alice = await t.signUp();
    for (const text of [
      'Watch free porn videos here',
      'Muerte a los inmigrantes, son una raza inferior',
    ]) {
      const blocked = await synthesize(alice, { text, voiceId: 'espeak:en-f1', language: 'en' });
      expect(blocked.status).toBe(422);
      expect(blocked.error.code).toBe('CONTENT_BLOCKED');
      const details = blocked.error.details as { flags: { category: string; reason: string }[] };
      expect(details.flags.length).toBeGreaterThan(0);
      expect(details.flags[0]?.reason).toEqual(expect.any(String));
      // The reason never echoes the offending text.
      expect(JSON.stringify(blocked.error)).not.toContain('porn');
    }
    expect(local.requests).toEqual([]);
    expect(premium.requests).toEqual([]);

    const fine = await synthesize(alice, {
      text: 'Welcome to the quarterly update.',
      voiceId: 'espeak:en-f1',
      language: 'en',
    });
    expect(fine.status).toBe(200);
  });

  it('reports provider problems honestly', async () => {
    const alice = await t.signUp();
    const body = { text: 'Hola.', voiceId: 'espeak:es-f1', language: 'es' };

    // A voice of a provider that is not active on this server.
    const inactive = await synthesize(alice, { ...body, voiceId: 'elevenlabs:21m00Tcm' });
    expect(inactive.status).toBe(503);
    expect(inactive.error.code).toBe('PROVIDER_NOT_CONFIGURED');

    local.failSynthesis = new AppError('PROVIDER_ERROR', 'eSpeak crashed');
    const failed = await synthesize(alice, body);
    expect(failed.status).toBe(502);
    expect(failed.error).toMatchObject({ code: 'PROVIDER_ERROR', message: 'eSpeak crashed' });

    // An unexpected exception is a provider error too, without leaking internals.
    local.failSynthesis = new TypeError("Cannot read properties of undefined (reading 'wasm')");
    const crashed = await synthesize(alice, { ...body, text: 'Otra frase.' });
    expect(crashed.status).toBe(502);
    expect(crashed.error.code).toBe('PROVIDER_ERROR');
    expect(crashed.error.message).not.toContain('wasm');

    // Nothing broken was cached: once the provider works, the same text is synthesized.
    local.failSynthesis = null;
    const recovered = await synthesize(alice, body);
    expect(recovered.status).toBe(200);
    expect(recovered.body.runtime.audioDurationMs).toBeGreaterThan(0);
  });

  it('validates the request and requires a session (any role may preview)', async () => {
    const owner = await t.signUp();
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const body = { text: 'Hola.', voiceId: 'espeak:es-f1', language: 'es' };

    expect((await synthesize(undefined, body)).status).toBe(401);
    expect((await synthesize(viewer, body)).status).toBe(200);

    const invalid: Record<string, unknown>[] = [
      { ...body, text: '' },
      { ...body, text: '   ' },
      { ...body, text: 'a'.repeat(5001) },
      { ...body, voiceId: 'carmen' },
      { ...body, language: 'xx' },
      { ...body, language: 'español' },
      { ...body, speed: 0.4 },
      { ...body, speed: 2.1 },
      { ...body, pitch: 13 },
      { text: 'Hola.', language: 'es' },
      { text: 'Hola.', voiceId: 'espeak:es-f1' },
    ];
    for (const bad of invalid) {
      const res = await t.call(api.voices.synthesize, { as: owner, body: bad });
      expect(res.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
      expect(res.error.code).toBe('VALIDATION_ERROR');
    }
    expect(local.requests).toHaveLength(1);
  });
});
