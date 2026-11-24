import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  defaultVoiceId,
  estimateSpeechTimeline,
  pickDefaultVoice,
  pickDefaultVoiceId,
} from '@parlante/shared';
import type {
  Composition,
  ProviderRef,
  ProviderVoice,
  TTSProvider,
  TTSRequest,
  Voice,
} from '@parlante/shared';
import { synthesizeCached } from '@parlante/jobs';
import {
  createKokoroProvider,
  decodeWav,
  disposeNeuralEngines,
  findKokoroVoice,
  inspectNeuralVoice,
  providerEnvSchema,
  resolveVoiceModelDir,
} from '@parlante/providers';
import { getBuiltinTemplate } from '@parlante/templates';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import templatesModule from '../templates/index';
import videosModule from '../videos/index';
import { replaceDefaultVoices } from './defaults';
import voicesModule from './index';

/* -------------------------------------------------------------------------------------------
 * The local neural voices as the API shows them.
 *
 *  1. The REAL registry on a machine without voice models (the test harness points
 *     VOICE_MODEL_DIR at an empty folder): nothing fails, the voices are listed as not
 *     installed, eSpeak keeps working and stays the default.
 *  2. Doubles of installed neural providers: which voice becomes the default of new content,
 *     and that videos created from the built-in templates start with it.
 *  3. [slow] The real Kokoro model through the real route, when it is installed here.
 * ----------------------------------------------------------------------------------------- */

const SAMPLE_RATE = 16_000;

function wav(durationMs: number): Uint8Array {
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
  return buffer;
}

interface FakeTts extends TTSProvider {
  requests: TTSRequest[];
}

/** A provider double whose audio differs on every call, like a neural model's. */
function fakeTts(info: ProviderRef, providerVoices: ProviderVoice[]): FakeTts {
  let calls = 0;
  const provider: FakeTts = {
    info,
    requests: [],
    listVoices: () => Promise.resolve(providerVoices),
    synthesize(request) {
      provider.requests.push(request);
      calls += 1;
      const durationMs = request.text.length * 60 + calls; // never twice the same
      return Promise.resolve({
        audio: wav(durationMs),
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

const voice = (
  providerVoiceId: string,
  language: string,
  gender: 'female' | 'male',
  extra: Partial<ProviderVoice> = {},
): ProviderVoice => ({
  providerVoiceId,
  name: providerVoiceId,
  language,
  gender,
  description: '',
  tags: [],
  ...extra,
});

const ESPEAK: ProviderRef = {
  id: 'espeak',
  name: 'eSpeak NG (local)',
  quality: 'basic',
  local: true,
};
const KOKORO: ProviderRef = {
  id: 'kokoro',
  name: 'Kokoro (neuronal local)',
  quality: 'premium',
  local: true,
};
const PIPER: ProviderRef = {
  id: 'piper',
  name: 'Piper (neuronal local)',
  quality: 'premium',
  local: true,
};
const CLOUD: ProviderRef = { id: 'acme', name: 'Acme Voices', quality: 'premium', local: false };

const ESPEAK_VOICES = ['es', 'en', 'fr', 'de', 'ru'].flatMap((language) => [
  voice(`${language}-f1`, language, 'female'),
  voice(`${language}-m1`, language, 'male'),
]);
const KOKORO_VOICES = [
  voice('ef_dora', 'es', 'female'),
  voice('em_alex', 'es', 'male'),
  voice('af_heart', 'en', 'female'),
  voice('am_michael', 'en', 'male'),
  voice('ff_siwis', 'fr', 'female'),
  // Listed, but its files are missing.
  voice('if_sara', 'it', 'female', {
    unavailable: { reasonCode: 'voice_not_installed', command: 'pnpm voices:setup' },
  }),
];
const PIPER_VOICES = [
  voice('de_DE-thorsten-medium', 'de', 'male'),
  voice('ru_RU-denis-medium', 'ru', 'male'),
];

const ids = (list: readonly Voice[]) => list.map((item) => item.id);
const defaults = (list: readonly Voice[]) => ids(list.filter((item) => item.isDefault));

describe('neural voices without their models (real registry)', () => {
  let t: TestApp;
  let alice: TestActor;
  beforeAll(async () => {
    t = await createTestApp({ modules: [voicesModule] });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = await t.signUp();
  });

  it('keeps them out of the normal listing and makes eSpeak the default', async () => {
    const response = await t.call(api.voices.list, { as: alice });
    expect(response.status).toBe(200);
    const items = response.body.items;
    expect(new Set(items.map((item) => item.provider.id))).toEqual(new Set(['espeak']));
    expect(items.every((item) => item.unavailable === undefined)).toBe(true);
    expect(pickDefaultVoiceId(items, 'es')).toBe('espeak:es-f1');
    expect(pickDefaultVoiceId(items, 'es', 'male')).toBe('espeak:es-m1');
    expect(pickDefaultVoiceId(items, 'de')).toBe(defaultVoiceId('de'));
  });

  it('lists them as not installed, with a reason and the command, when asked', async () => {
    const response = await t.call(api.voices.list, { as: alice, query: { availability: 'all' } });
    const missing = response.body.items.filter((item) => item.unavailable !== undefined);
    expect(new Set(missing.map((item) => item.provider.id))).toEqual(new Set(['kokoro', 'piper']));
    const dora = missing.find((item) => item.id === 'kokoro:ef_dora');
    expect(dora).toMatchObject({
      kind: 'stock',
      name: 'Dora',
      language: 'es',
      gender: 'female',
      status: 'ready',
      provider: { id: 'kokoro', quality: 'premium', local: true },
      unavailable: { reasonCode: 'voice_not_installed', command: 'pnpm voices:setup' },
      pitchRange: { minSemitones: -4, maxSemitones: 4, resampled: true },
    });
    expect(dora?.isDefault).toBeUndefined();
    const thorsten = missing.find((item) => item.id === 'piper:de_DE-thorsten-medium');
    expect(thorsten?.unavailable?.command).toBe('pnpm voices:setup --voices de_DE-thorsten-medium');
    // Usable voices come first; the filters still work on the whole list.
    const firstMissing = response.body.items.findIndex((item) => item.unavailable !== undefined);
    expect(response.body.items.slice(0, firstMissing).every((item) => !item.unavailable)).toBe(
      true,
    );
    const spanish = await t.call(api.voices.list, {
      as: alice,
      query: { availability: 'all', language: 'es', provider: 'kokoro' },
    });
    expect(ids(spanish.body.items)).toEqual(['kokoro:ef_dora', 'kokoro:em_alex']);
  });

  it('reads one of them by id and refuses to synthesize with a translatable reason', async () => {
    const one = await t.call(api.voices.get, { as: alice, params: { voiceId: 'kokoro:ef_dora' } });
    expect(one.status).toBe(200);
    expect(one.body.unavailable?.reasonCode).toBe('voice_not_installed');

    const speech = await t.call(api.voices.synthesize, {
      as: alice,
      body: { text: 'Hola a todos.', voiceId: 'kokoro:ef_dora', language: 'es' },
    });
    expect(speech.status).toBe(503);
    expect(speech.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: { reason: 'voice_not_installed', command: 'pnpm voices:setup' },
    });
    // The basic voice keeps the product talking.
    const basic = await t.call(api.voices.synthesize, {
      as: alice,
      body: { text: 'Hola a todos.', voiceId: 'espeak:es-f1', language: 'es' },
    });
    expect(basic.status).toBe(200);
    expect(basic.body.provider).toMatchObject({ id: 'espeak', quality: 'basic' });
    expect(basic.body.runtime.words.map((word) => word.text)).toEqual(['Hola', 'a', 'todos.']);
  });
});

describe('default voices with neural voices installed (provider doubles)', () => {
  let t: TestApp;
  let alice: TestActor;
  let espeak: FakeTts;
  let kokoro: FakeTts;
  let piper: FakeTts;
  let cloud: FakeTts;

  /** Replace the registry: `ranked` is the order TTS_PROVIDER produced. */
  function install(
    ranked: (keyof typeof all)[],
    active: (keyof typeof all)[] = ['espeak', 'kokoro', 'piper'],
  ) {
    t.app.providers.tts = {
      default: all[ranked[0] ?? 'espeak'],
      get: (id) => active.map((key) => all[key]).find((p) => p.info.id === id) ?? null,
      all: () => active.map((key) => all[key]),
      ranked: () => ranked.map((key) => all[key]),
    };
  }
  let all: { espeak: FakeTts; kokoro: FakeTts; piper: FakeTts; cloud: FakeTts };

  beforeAll(async () => {
    t = await createTestApp({ modules: [voicesModule, videosModule, templatesModule] });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    alice = await t.signUp();
    espeak = fakeTts(ESPEAK, ESPEAK_VOICES);
    kokoro = fakeTts(KOKORO, KOKORO_VOICES);
    piper = fakeTts(PIPER, PIPER_VOICES);
    cloud = fakeTts(CLOUD, [
      voice('nova', 'en-US', 'female', { languages: ['en-US', 'es', 'fr', 'de', 'ru'] }),
    ]);
    all = { espeak, kokoro, piper, cloud };
  });

  const list = async (query: Record<string, string> = {}) =>
    (await t.call(api.voices.list, { as: alice, query })).body.items;

  it('auto: lists neural voices first and makes them the default of their language and gender', async () => {
    install(['kokoro', 'piper', 'espeak']);
    const items = await list();
    // Kokoro, then Piper, then eSpeak — and the voice that is not installed is left out.
    expect(items.map((item) => item.provider.id).filter((id, i, a) => a.indexOf(id) === i)).toEqual(
      ['kokoro', 'piper', 'espeak'],
    );
    expect(ids(items)).not.toContain('kokoro:if_sara');
    expect(defaults(items)).toEqual([
      'kokoro:ef_dora',
      'kokoro:em_alex',
      'kokoro:af_heart',
      'kokoro:am_michael',
      'kokoro:ff_siwis',
      'piper:de_DE-thorsten-medium',
      'piper:ru_RU-denis-medium',
      // Where no neural voice exists for a language and gender, the eSpeak one stays.
      'espeak:fr-m1',
      'espeak:de-f1',
      'espeak:ru-f1',
    ]);
    expect(pickDefaultVoiceId(items, 'es')).toBe('kokoro:ef_dora');
    expect(pickDefaultVoiceId(items, 'es', 'male')).toBe('kokoro:em_alex');
    expect(pickDefaultVoiceId(items, 'en-US')).toBe('kokoro:af_heart');
    // Without a gender the neural voice wins even if it is the other gender…
    expect(pickDefaultVoiceId(items, 'de')).toBe('piper:de_DE-thorsten-medium');
    expect(pickDefaultVoiceId(items, 'ru')).toBe('piper:ru_RU-denis-medium');
    // …but an avatar that needs a woman's voice keeps one, even if it is the basic one.
    expect(pickDefaultVoiceId(items, 'de', 'female')).toBe('espeak:de-f1');
    expect(pickDefaultVoice(items, 'fr', 'male')?.id).toBe('espeak:fr-m1');
    // A language nobody speaks here falls back to the frozen local id.
    expect(pickDefaultVoiceId(items, 'el')).toBe('espeak:el-f1');
  });

  it('keeps the same defaults whatever filter narrows the listing', async () => {
    install(['kokoro', 'piper', 'espeak']);
    expect(defaults(await list({ language: 'es' }))).toEqual(['kokoro:ef_dora', 'kokoro:em_alex']);
    // Asking only for eSpeak does not make its Spanish voices the default again.
    expect(defaults(await list({ provider: 'espeak', language: 'es' }))).toEqual([]);
    expect(defaults(await list({ provider: 'espeak', language: 'de' }))).toEqual(['espeak:de-f1']);
    expect(defaults(await list({ gender: 'male', language: 'en' }))).toEqual(['kokoro:am_michael']);
  });

  it('TTS_PROVIDER=espeak: the basic voices are listed first and stay the default', async () => {
    install(['espeak']);
    const items = await list();
    // The explicit choice goes first; the neural voices are still offered after it.
    expect(items.map((item) => item.provider.id).filter((id, i, a) => a.indexOf(id) === i)).toEqual(
      ['espeak', 'kokoro', 'piper'],
    );
    expect(defaults(items).every((id) => id.startsWith('espeak:'))).toBe(true);
    expect(pickDefaultVoiceId(items, 'es')).toBe('espeak:es-f1');
  });

  it('an external multilingual provider that is ranked first is the default everywhere', async () => {
    install(['cloud', 'kokoro', 'piper', 'espeak'], ['espeak', 'kokoro', 'piper', 'cloud']);
    const items = await list();
    expect(items[0]?.id).toBe('acme:nova');
    expect(pickDefaultVoiceId(items, 'es', 'female')).toBe('acme:nova');
    expect(pickDefaultVoiceId(items, 'ru')).toBe('acme:nova');
    // It has no male voice: the installed neural one is next.
    expect(pickDefaultVoiceId(items, 'es', 'male')).toBe('kokoro:em_alex');
  });

  it('a registry without `ranked` behaves as before: its default provider only', async () => {
    t.app.providers.tts = {
      default: espeak,
      get: (id) => [espeak, kokoro].find((p) => p.info.id === id) ?? null,
      all: () => [espeak, kokoro],
    };
    expect(pickDefaultVoiceId(await list(), 'es')).toBe('espeak:es-f1');
  });

  it('starts a video made from a built-in template with the default voices', async () => {
    install(['kokoro', 'piper', 'espeak']);
    const template = getBuiltinTemplate('builtin_explainer', 'es');
    const original = (template?.composition.scenes ?? []).flatMap((scene) =>
      scene.script.kind === 'tts' ? [scene.script.voiceId] : [],
    );
    expect(original.length).toBeGreaterThan(0);
    expect(original.every((id) => id.startsWith('espeak:'))).toBe(true);

    const voicesOf = (composition: Composition) =>
      composition.scenes.flatMap((scene) => (scene.script.kind === 'tts' ? [scene.script] : []));
    const created = await t.call(api.videos.create, {
      as: alice,
      body: { templateId: 'builtin_explainer' },
    });
    expect(created.status).toBe(201);
    for (const script of voicesOf(created.body.composition)) {
      expect(script.language).toBe('es');
      expect(script.voiceId).toMatch(/^kokoro:(ef_dora|em_alex)$/);
    }
    const used = await t.call(api.templates.use, {
      as: alice,
      params: { templateId: 'builtin_explainer' },
      body: {},
    });
    expect(voicesOf(used.body.composition).every((s) => s.voiceId.startsWith('kokoro:'))).toBe(
      true,
    );
    // The template itself is untouched.
    expect(
      (getBuiltinTemplate('builtin_explainer', 'es')?.composition.scenes ?? []).flatMap((scene) =>
        scene.script.kind === 'tts' ? [scene.script.voiceId] : [],
      ),
    ).toEqual(original);

    // A video that is saved keeps its voice: duplicating it changes nothing.
    const kept = await t.call(api.videos.create, {
      as: alice,
      body: {
        composition: {
          ...created.body.composition,
          scenes: created.body.composition.scenes.map((scene) =>
            scene.script.kind === 'tts'
              ? { ...scene, script: { ...scene.script, voiceId: 'espeak:es-f1' } }
              : scene,
          ),
        },
      },
    });
    expect(voicesOf(kept.body.composition).every((s) => s.voiceId === 'espeak:es-f1')).toBe(true);
    const copy = await t.call(api.videos.duplicate, {
      as: alice,
      params: { videoId: kept.body.id },
      body: {},
    });
    expect(voicesOf(copy.body.composition).every((s) => s.voiceId === 'espeak:es-f1')).toBe(true);
  });

  it('leaves template voices alone when eSpeak is the default or the voice is not a frozen default', async () => {
    install(['espeak']);
    const created = await t.call(api.videos.create, {
      as: alice,
      body: { templateId: 'builtin_explainer' },
    });
    for (const scene of created.body.composition.scenes) {
      if (scene.script.kind === 'tts') expect(scene.script.voiceId).toMatch(/^espeak:/);
    }
    // Pure function: only `espeak:<lang>-f1|m1` are replaced, gender for gender.
    const stock = (id: string, gender: 'female' | 'male'): Voice => ({
      id,
      kind: 'stock',
      name: id,
      provider: KOKORO,
      language: 'es',
      multilingual: false,
      gender,
      description: '',
      tags: [],
      status: 'ready',
      workspaceId: null,
      consentId: null,
      profile: null,
      error: null,
      createdAt: null,
      isDefault: true,
    });
    const items = [stock('kokoro:em_alex', 'male'), stock('kokoro:ef_dora', 'female')];
    const composition = created.body.composition;
    const scenes = composition.scenes.filter((scene) => scene.script.kind === 'tts');
    const first = scenes[0];
    if (!first || first.script.kind !== 'tts') throw new Error('the template has no narration');
    const custom: Composition = {
      ...composition,
      scenes: [
        { ...first, id: 'scn_a', script: { ...first.script, voiceId: 'espeak:es-m1' } },
        { ...first, id: 'scn_b', script: { ...first.script, voiceId: 'espeak:es-f2' } },
        { ...first, id: 'scn_c', script: { ...first.script, voiceId: 'vcl_abcdefgh12345678' } },
        {
          ...first,
          id: 'scn_d',
          script: { ...first.script, voiceId: 'espeak:de-f1', language: 'de' },
        },
      ],
    };
    const replaced = replaceDefaultVoices(custom, items);
    expect(
      replaced.scenes.map((scene) => (scene.script.kind === 'tts' ? scene.script.voiceId : null)),
    ).toEqual([
      'kokoro:em_alex',
      'espeak:es-f2', // a second timbre somebody chose on purpose
      'vcl_abcdefgh12345678',
      'espeak:de-f1', // no default for German in this catalogue
    ]);
    expect(replaceDefaultVoices(custom, [])).toBe(custom);
  });

  it('serves preview and export the SAME audio and timeline of a neural voice', async () => {
    install(['kokoro', 'piper', 'espeak']);
    const body = { text: 'Hola a todos.', voiceId: 'kokoro:ef_dora', language: 'es' };
    // The Studio previews the scene…
    const preview = await t.call(api.voices.synthesize, { as: alice, body });
    expect(preview.status).toBe(200);
    expect(preview.body.provider).toEqual(KOKORO);
    // …and the render job asks for the same narration through the shared service.
    const rendered = await synthesizeCached(
      { db: t.db, providers: t.app.providers },
      alice.workspace.id,
      body,
    );
    // The double would have produced different audio on a second synthesis: there was none.
    expect(kokoro.requests).toHaveLength(1);
    expect(rendered.cached).toBe(true);
    expect(rendered.runtime).toEqual(preview.body.runtime);
    expect(rendered.provider).toEqual(KOKORO);
    expect(new URL(preview.body.audioUrl).pathname).toContain(rendered.audioKey);
    const again = await t.call(api.voices.synthesize, { as: alice, body });
    expect(again.body.runtime).toEqual(preview.body.runtime);
    expect(kokoro.requests).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------------------------------
 * [slow] The same routes with the REAL Kokoro model, when it is installed on this machine.
 * ------------------------------------------------------------------------------------------- */

const realEnv = providerEnvSchema.parse({});
const dora = findKokoroVoice('ef_dora');
const realInstalled = dora !== null && inspectNeuralVoice(realEnv, dora).installed;

describe.skipIf(!realInstalled)(
  '[slow] neural voices with the real model',
  { timeout: 300_000 },
  () => {
    let t: TestApp;
    let alice: TestActor;
    beforeAll(async () => {
      t = await createTestApp({
        modules: [voicesModule],
        env: { VOICE_MODEL_DIR: resolveVoiceModelDir(realEnv) },
      });
      alice = await t.signUp();
    });
    afterAll(async () => {
      await t.close();
      await disposeNeuralEngines();
    });

    it('lists the installed neural voices first and as the default', async () => {
      const response = await t.call(api.voices.list, { as: alice, query: { language: 'es' } });
      const items = response.body.items;
      expect(items[0]).toMatchObject({
        id: 'kokoro:ef_dora',
        isDefault: true,
        provider: { id: 'kokoro', quality: 'premium', local: true },
      });
      expect(items[0]?.unavailable).toBeUndefined();
      expect(pickDefaultVoiceId(items, 'es')).toBe('kokoro:ef_dora');
      expect(pickDefaultVoiceId(items, 'es', 'male')).toBe('kokoro:em_alex');
      expect(items.at(-1)?.provider.id).toBe('espeak');
    });

    it('synthesizes a preview with the real model and reuses it for the render', async () => {
      const body = {
        text: 'Hola, esta es una voz neuronal.',
        voiceId: 'kokoro:ef_dora',
        language: 'es',
      };
      const preview = await t.call(api.voices.synthesize, { as: alice, body });
      expect(preview.status).toBe(200);
      expect(preview.body.provider).toMatchObject({ id: 'kokoro', local: true });
      expect(preview.body.runtime.words.map((word) => word.text).join(' ')).toBe(body.text);
      expect(preview.body.runtime.audioDurationMs).toBeGreaterThan(1200);
      expect(preview.body.runtime.visemes.length).toBeGreaterThan(10);

      const file = await t.inject({
        method: 'GET',
        url: preview.body.audioUrl.replace('http://api.test', ''),
      });
      expect(file.statusCode).toBe(200);
      const pcm = decodeWav(file.rawPayload);
      expect(pcm.sampleRate).toBe(24_000);
      const peak = pcm.samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
      expect(peak).toBeGreaterThan(3000);
      expect(
        Math.abs(
          (pcm.samples.length * 1000) / pcm.sampleRate - preview.body.runtime.audioDurationMs,
        ),
      ).toBeLessThan(2);

      const rendered = await synthesizeCached(
        { db: t.db, providers: t.app.providers },
        alice.workspace.id,
        body,
      );
      expect(rendered.cached).toBe(true);
      expect(rendered.runtime).toEqual(preview.body.runtime);
    });

    it('is the same provider object the API registry and a direct caller use', () => {
      expect(t.app.providers.tts.get('kokoro')?.info).toEqual(createKokoroProvider(realEnv).info);
      expect(t.app.providers.tts.default.info.id).toBe('kokoro');
    });
  },
);
