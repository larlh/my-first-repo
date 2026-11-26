import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, LocaleSchema, VoiceIdSchema, makeStockVoiceId } from '@parlante/shared';
import { providerEnvSchema } from '../env';
import { createTtsProviders } from './index';
import {
  KOKORO_INFO,
  PIPER_INFO,
  createKokoroProvider,
  createPiperProvider,
  hasInstalledNeuralVoice,
  inspectNeuralVoice,
  voiceInstallCommand,
} from './neural';
import type { NeuralVoiceDeps } from './neural';
import { KOKORO_TIMELINE_LEAD_MS } from './neural-backends';
import type { NeuralJob, NeuralOutput } from './neural-engine';
import {
  KOKORO_SOURCE,
  KOKORO_TOKENIZER,
  KOKORO_VOICE_FILES,
  PIPER_SOURCE,
  PIPER_VOICE_FILES,
  voiceFilePath,
} from './neural-models';
import type { VoiceInstallState } from './neural-models';
import { KOKORO_VOICES, NEURAL_VOICES, PIPER_VOICES } from './neural-voices';
import type { NeuralVoiceDef } from './neural-voices';
import { decodeWav } from './wav';

/*
 * The two neural providers with a DOUBLE of the model: the engine answers every job with a
 * fixed duration per input id and a tone of the matching length. Text, phonemes (real eSpeak
 * NG), tensors and timelines are the real code; only the neural network is missing.
 */

const INSTALLED: VoiceInstallState = { installed: true, reasonCode: null, reason: null };
const MISSING: VoiceInstallState = {
  installed: false,
  reasonCode: 'voice_not_installed',
  reason: 'not installed',
};

let dir: string;
let env: ReturnType<typeof providerEnvSchema.parse>;

/** Kokoro symbols the double knows (a subset of the real table, same ids). */
const VOCAB: Record<string, number> = {
  $: 0,
  ';': 1,
  ':': 2,
  ',': 3,
  '.': 4,
  '!': 5,
  '?': 6,
  ' ': 16,
  A: 24,
  I: 25,
  O: 31,
  a: 43,
  b: 44,
  d: 46,
  e: 47,
  h: 50,
  i: 51,
  k: 53,
  l: 54,
  m: 55,
  n: 56,
  o: 57,
  s: 61,
  t: 62,
  u: 63,
  w: 65,
  ð: 81,
  ə: 83,
  ɹ: 123,
  ɾ: 125,
  ˈ: 156,
  ˌ: 157,
};

const PIPER_CONFIG = {
  audio: { sample_rate: 22_050 },
  espeak: { voice: 'de' },
  num_speakers: 1,
  inference: { noise_scale: 0.5, length_scale: 1, noise_w: 0.333 },
  phoneme_id_map: {
    _: [0],
    '^': [1],
    $: [2],
    ' ': [3],
    '!': [4],
    ',': [8],
    '.': [10],
    '?': [13],
    a: [14],
    d: [17],
    e: [18],
    h: [20],
    i: [21],
    l: [24],
    n: [26],
    o: [27],
    t: [32],
    v: [34],
    ɛ: [61],
    ʊ: [100],
    ˈ: [120],
    ː: [122],
    aɪ: [160],
  },
};

interface Seen {
  key: string;
  ids: number[];
  feeds: NeuralJob['feeds'];
}

/** A minimal ONNX file with one `Ceil` node, standing for a Piper graph. */
function fakePiperGraph(): Uint8Array {
  const text = (value: string) => [...new TextEncoder().encode(value)];
  const field = (number: number, payload: number[]) => [
    (number << 3) | 2,
    payload.length,
    ...payload,
  ];
  const node = field(1, [...field(2, text('/Ceil_output_0')), ...field(4, text('Ceil'))]);
  return Uint8Array.from(field(7, [...node, ...field(12, field(1, text('output')))]));
}

/** An engine that "speaks" 3 frames per id (pads included) at 600 / 256 samples per frame. */
function fakeEngine(seen: Seen[] = []): NonNullable<NeuralVoiceDeps['engine']> {
  const prepared = new Set<string>();
  return {
    async run(job: NeuralJob) {
      // Like the real engine: the graph is prepared (Piper: durations exposed) on first use.
      if (job.model.prepare && !prepared.has(job.model.key)) {
        job.model.prepare(fakePiperGraph());
        prepared.add(job.model.key);
      }
      const kokoro = 'input_ids' in job.feeds;
      const input = (kokoro ? job.feeds.input_ids : job.feeds.input)?.data as BigInt64Array;
      const ids = [...input].map(Number);
      seen.push({ key: job.model.key, ids, feeds: job.feeds });
      const samples = ids.length * 3 * (kokoro ? 600 : 256);
      const waveform = new Float32Array(samples);
      for (let i = 0; i < samples; i += 1) waveform[i] = 0.3 * Math.sin(i / 10);
      const durations = new Float32Array(ids.length).fill(3);
      const out: Record<string, NeuralOutput> = {};
      const names = typeof job.outputs === 'function' ? job.outputs() : job.outputs;
      out[names[0] ?? 'waveform'] = { data: waveform, dims: [1, samples] };
      out[names[1] ?? 'durations'] = { data: durations, dims: [1, ids.length] };
      return out;
    },
  };
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-voices-'));
  env = providerEnvSchema.parse({ VOICE_MODEL_DIR: dir, STORAGE_LOCAL_DIR: dir });
  const write = async (file: string, data: string | Uint8Array) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  };
  await write(
    voiceFilePath(dir, KOKORO_SOURCE, KOKORO_TOKENIZER),
    JSON.stringify({ model: { vocab: VOCAB } }),
  );
  // A voice file: 510 styles of 256 floats; style n is filled with the value n.
  const styles = new Float32Array(510 * 256);
  for (let row = 0; row < 510; row += 1) styles.fill(row, row * 256, (row + 1) * 256);
  for (const id of ['ef_dora', 'af_heart'] as const) {
    await write(
      voiceFilePath(dir, KOKORO_SOURCE, KOKORO_VOICE_FILES[id]),
      new Uint8Array(styles.buffer),
    );
  }
  await write(
    voiceFilePath(dir, PIPER_SOURCE, PIPER_VOICE_FILES['de_DE-thorsten-medium'].config),
    JSON.stringify(PIPER_CONFIG),
  );
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('catalogue of neural voices', () => {
  it('has well-formed, unique voice ids in languages the product supports', () => {
    const ids = new Set<string>();
    for (const def of NEURAL_VOICES) {
      const id = makeStockVoiceId(def.engine, def.providerVoiceId);
      expect(VoiceIdSchema.safeParse(id).success, id).toBe(true);
      expect(LocaleSchema.safeParse(def.language).success, id).toBe(true);
      expect(ids.has(id), id).toBe(false);
      ids.add(id);
      expect(def.name.trim()).not.toBe('');
      expect(def.description).toMatch(/Voz neuronal local \((Kokoro|Piper)\)/);
      expect(def.tags).toContain('neuronal');
      expect(def.license).not.toBe('');
    }
  });

  it('offers Spanish and English in both genders with Kokoro', () => {
    for (const language of ['es', 'en']) {
      for (const gender of ['female', 'male']) {
        expect(
          KOKORO_VOICES.some((def) => def.language === language && def.gender === gender),
          `${language} ${gender}`,
        ).toBe(true);
      }
    }
  });

  it('uses Piper only for what Kokoro does not speak natively, never a non-commercial voice', () => {
    for (const def of PIPER_VOICES) {
      expect(def.license).not.toMatch(/NC|non-?commercial|unknown/i);
    }
    const piperOnly = new Set(PIPER_VOICES.map((def) => def.language.slice(0, 2)));
    for (const language of ['de', 'nl', 'pl', 'ru', 'sv', 'el', 'ca']) {
      expect(piperOnly.has(language), language).toBe(true);
    }
    // Turkish has no voice with a licence that allows commercial use: it stays on eSpeak.
    expect(NEURAL_VOICES.some((def) => def.language.startsWith('tr'))).toBe(false);
  });

  it('names the command that installs each voice', () => {
    expect(voiceInstallCommand(KOKORO_VOICES[0] as NeuralVoiceDef)).toBe('pnpm voices:setup');
    expect(voiceInstallCommand(PIPER_VOICES[0] as NeuralVoiceDef)).toBe(
      `pnpm voices:setup --voices ${PIPER_VOICES[0]?.providerVoiceId}`,
    );
  });
});

describe('neural providers without their models', () => {
  it('list every voice as unavailable, with a reason code and the install command', async () => {
    // `dir` holds a few small files but no model: nothing is installed.
    for (const provider of [createKokoroProvider(env), createPiperProvider(env)]) {
      const voices = await provider.listVoices();
      expect(voices.length).toBeGreaterThan(0);
      for (const voice of voices) {
        expect(voice.unavailable?.reasonCode).toMatch(/^voice_(not_installed|incomplete)$/);
        expect(voice.unavailable?.command).toMatch(/^pnpm voices:setup/);
        expect(voice.pitchRange).toEqual({ minSemitones: -4, maxSemitones: 4, resampled: true });
      }
    }
    expect(hasInstalledNeuralVoice(env, 'kokoro')).toBe(false);
    expect(hasInstalledNeuralVoice(env, 'piper')).toBe(false);
    // Files that the installer did not verify (no marker) do not count at all.
    expect(inspectNeuralVoice(env, KOKORO_VOICES[0] as NeuralVoiceDef)).toMatchObject({
      installed: false,
      reasonCode: 'voice_not_installed',
    });
  });

  it('refuse to synthesize with a translatable reason instead of failing obscurely', async () => {
    const kokoro = createKokoroProvider(env, { engine: fakeEngine() });
    const attempt = kokoro.synthesize({
      text: 'Hola',
      providerVoiceId: 'ef_dora',
      language: 'es',
      speed: 1,
      pitch: 0,
    });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: { reason: 'voice_not_installed', provider: 'kokoro', command: 'pnpm voices:setup' },
    });
  });

  it('answer 404 for a voice that is not in the catalogue', async () => {
    for (const provider of [createKokoroProvider(env), createPiperProvider(env)]) {
      await expect(
        provider.synthesize({
          text: 'x',
          providerVoiceId: 'nope',
          language: 'es',
          speed: 1,
          pitch: 0,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });
});

describe('Kokoro provider', () => {
  const deps = (seen: Seen[]): NeuralVoiceDeps => ({
    engine: fakeEngine(seen),
    inspect: () => INSTALLED,
  });

  it('lists its voices as usable once installed, the Spanish ones first', async () => {
    const voices = await createKokoroProvider(env, deps([])).listVoices();
    expect(voices.every((voice) => voice.unavailable === undefined)).toBe(true);
    expect(voices.slice(0, 2).map((voice) => [voice.language, voice.gender])).toEqual([
      ['es', 'female'],
      ['es', 'male'],
    ]);
  });

  it('feeds the model ids between two pads, the style of that length and the speed', async () => {
    const seen: Seen[] = [];
    const result = await createKokoroProvider(env, deps(seen)).synthesize({
      text: 'Hola, mundo.',
      providerVoiceId: 'ef_dora',
      language: 'es',
      speed: 1.25,
      pitch: 0,
    });
    expect(seen).toHaveLength(1);
    const call = seen[0] as Seen;
    // ˈ o l a , ␣ m ˈ u n d o .
    const symbols = ['ˈ', 'o', 'l', 'a', ',', ' ', 'm', 'ˈ', 'u', 'n', 'd', 'o', '.'];
    expect(call.ids).toEqual([0, ...symbols.map((symbol) => VOCAB[symbol]), 0]);
    expect(call.feeds.style?.dims).toEqual([1, 256]);
    expect([...(call.feeds.style?.data as Float32Array)].every((v) => v === symbols.length)).toBe(
      true,
    );
    expect((call.feeds.speed?.data as Float32Array)[0]).toBeCloseTo(1.25, 5);
    expect(call.key).toContain('kokoro:uint8:');

    expect(result.provider).toEqual(KOKORO_INFO);
    expect(result.sampleRate).toBe(24_000);
    expect(result.words.map((word) => word.text)).toEqual(['Hola,', 'mundo.']);
    // 3 frames of 25 ms per id: "ˈola" = 4 ids, then "," and " " before "mˈundo".
    expect(result.words[0]?.durMs).toBe(300);
    expect((result.words[1]?.tMs ?? 0) - (result.words[0]?.tMs ?? 0)).toBe(450);
    expect(result.visemes.filter((cue) => cue.viseme !== 'rest').map((cue) => cue.viseme)).toEqual([
      'O',
      'NL',
      'A',
      'MBP',
      'U',
      'NL',
      'DT',
      'O',
    ]);
    expect(decodeWav(result.audio).sampleRate).toBe(24_000);
  });

  it('places every symbol 75 ms before the sum of the predicted durations', async () => {
    const result = await createKokoroProvider(env, deps([])).synthesize({
      text: 'Hola, mundo.',
      providerVoiceId: 'ef_dora',
      language: 'es',
      speed: 1,
      pitch: 0,
    });
    // The fake model gives 3 frames (75 ms) to every id, the leading pad included, and its
    // audio is a steady tone. Raw sums: "ˈ" at 75 ms and "o" at 150 ms of the model's audio.
    // With the lead of the vocoder taken off: 0 ms and 75 ms. The audio is cut 12 ms before
    // the first symbol (here: at its very start) and follows 40 ms of leading silence.
    expect(KOKORO_TIMELINE_LEAD_MS).toBe(75);
    expect(result.words[0]?.tMs).toBe(40);
    const firstVowel = result.visemes.find((cue) => cue.viseme === 'O');
    expect(firstVowel?.tMs).toBe(40 + 75);
    // The end of the speech is not moved, so nothing of the last word is cut off: its last
    // sound ("o", the 12th symbol after the pad) ends at 13 * 75 = 975 ms of the model's audio.
    const lastWord = result.words[result.words.length - 1];
    expect((lastWord?.tMs ?? 0) + (lastWord?.durMs ?? 0)).toBe(40 + 975);
  });

  it('uses the pronunciation rules of the text language when Kokoro speaks it', async () => {
    const seen: Seen[] = [];
    const provider = createKokoroProvider(env, deps(seen));
    // A Spanish voice reading English: English rules ("hello" is not read as "eyo").
    await provider.synthesize({
      text: 'Hello',
      providerVoiceId: 'ef_dora',
      language: 'en',
      speed: 1,
      pitch: 0,
    });
    // h ə l ˈ O
    expect(seen[0]?.ids).toEqual([0, VOCAB.h, VOCAB['ə'], VOCAB.l, VOCAB['ˈ'], VOCAB.O, 0]);
    // German is not one of Kokoro's languages: the voice keeps its own rules.
    await provider.synthesize({
      text: 'Hola',
      providerVoiceId: 'ef_dora',
      language: 'de',
      speed: 1,
      pitch: 0,
    });
    expect(seen[1]?.ids).toEqual([0, VOCAB['ˈ'], VOCAB.o, VOCAB.l, VOCAB.a, 0]);
  });

  it('applies a local voice profile on top of the request, on its base voice', async () => {
    const seen: Seen[] = [];
    await createKokoroProvider(env, deps(seen)).synthesize({
      text: 'Hola',
      providerVoiceId: 'ef_dora',
      language: 'es',
      speed: 1,
      pitch: 0,
      profile: { baseVoiceId: 'af_heart', pitchSemitones: 2, speed: 1.1, meanF0Hz: 210 },
    });
    // Pitch +2 st by resampling: the model speaks 2^(2/12) times slower.
    expect((seen[0]?.feeds.speed?.data as Float32Array)[0]).toBeCloseTo(1.1 / 2 ** (2 / 12), 4);
  });

  it('returns a valid empty result for empty text without touching the model', async () => {
    const seen: Seen[] = [];
    const result = await createKokoroProvider(env, deps(seen)).synthesize({
      text: '   ',
      providerVoiceId: 'ef_dora',
      language: 'es',
      speed: 1,
      pitch: 0,
    });
    expect(result).toMatchObject({ durationMs: 0, words: [], visemes: [], provider: KOKORO_INFO });
    expect(seen).toHaveLength(0);
  });
});

describe('Piper provider', () => {
  it('interleaves the blank id, starts with ^ and ends with $, and scales the length', async () => {
    const seen: Seen[] = [];
    const provider = createPiperProvider(env, {
      engine: fakeEngine(seen),
      inspect: () => INSTALLED,
    });
    const result = await provider.synthesize({
      text: 'Hallo, du!',
      providerVoiceId: 'de_DE-thorsten-medium',
      language: 'de',
      speed: 2,
      pitch: 0,
    });
    const map = PIPER_CONFIG.phoneme_id_map;
    const call = seen[0] as Seen;
    expect(call.ids[0]).toBe(1); // ^
    expect(call.ids[1]).toBe(0); // _
    expect(call.ids[call.ids.length - 1]).toBe(2); // $
    // After the two leading ids every symbol is followed by the blank.
    const body = call.ids.slice(2, -1);
    expect(body.filter((_, i) => i % 2 === 1).every((id) => id === 0)).toBe(true);
    const spoken = body.filter((_, i) => i % 2 === 0);
    expect(spoken).toContain(map[','][0]);
    expect(spoken[spoken.length - 1]).toBe(map['!'][0]);
    expect(spoken.slice(0, 2)).toEqual([map.h[0], map['ˈ'][0]]);
    expect([...(call.feeds.scales?.data as Float32Array)]).toEqual([
      expect.closeTo(0.5, 5),
      expect.closeTo(0.5, 5), // length_scale 1 / speed 2
      expect.closeTo(0.333, 5),
    ]);
    expect([...(call.feeds.input_lengths?.data as BigInt64Array)].map(Number)).toEqual([
      call.ids.length,
    ]);
    expect(call.feeds.sid).toBeUndefined();

    expect(result.provider).toEqual(PIPER_INFO);
    expect(result.sampleRate).toBe(22_050);
    expect(result.words.map((word) => word.text)).toEqual(['Hallo,', 'du!']);
    expect(result.words[0]?.tMs).toBeLessThan(result.words[1]?.tMs ?? 0);
  });

  it('speaks one sentence per inference', async () => {
    const seen: Seen[] = [];
    const provider = createPiperProvider(env, {
      engine: fakeEngine(seen),
      inspect: () => INSTALLED,
    });
    await provider.synthesize({
      text: 'Hallo. Hallo du. Hallo!',
      providerVoiceId: 'de_DE-thorsten-medium',
      language: 'de',
      speed: 1,
      pitch: 0,
    });
    expect(seen).toHaveLength(3);
  });
});

describe('default provider ranking (TTS_PROVIDER)', () => {
  const registry = (
    overrides: Record<string, string>,
    installed: (def: NeuralVoiceDef) => boolean,
  ) =>
    createTtsProviders(providerEnvSchema.parse({ VOICE_MODEL_DIR: dir, ...overrides }), {
      inspect: (def) => (installed(def) ? INSTALLED : MISSING),
    });
  const ids = (providers: ReturnType<typeof registry>) =>
    (providers.ranked?.() ?? []).map((provider) => provider.info.id);

  it('auto: eSpeak alone when no neural voice is installed', () => {
    const providers = registry({}, () => false);
    expect(ids(providers)).toEqual(['espeak']);
    expect(providers.default.info.id).toBe('espeak');
    // Both neural providers are still active (their voices are listed as unavailable).
    expect(providers.get('kokoro')?.info).toEqual(KOKORO_INFO);
    expect(providers.get('piper')?.info).toEqual(PIPER_INFO);
    expect(providers.all().map((provider) => provider.info.id)).toEqual([
      'espeak',
      'kokoro',
      'piper',
      // Speaks voices cloned by the local voice engine; it has no stock voices.
      'chatterbox',
    ]);
  });

  it('auto: installed neural voices go before eSpeak, and follow the disk without a restart', () => {
    let kokoro = false;
    const providers = registry({}, (def) => def.engine === 'kokoro' && kokoro);
    expect(providers.default.info.id).toBe('espeak');
    kokoro = true; // `pnpm voices:setup` finished
    expect(ids(providers)).toEqual(['kokoro', 'espeak']);
    expect(providers.default.info.id).toBe('kokoro');
    expect(ids(registry({}, () => true))).toEqual(['kokoro', 'piper', 'espeak']);
    expect(ids(registry({}, (def) => def.engine === 'piper'))).toEqual(['piper', 'espeak']);
  });

  it('auto: an external provider with a key stays first', () => {
    const providers = registry({ OPENAI_API_KEY: 'sk-test' }, () => true);
    expect(ids(providers)).toEqual(['openai', 'kokoro', 'piper', 'espeak']);
  });

  it('neural: local neural voices first even when a key is set', () => {
    const providers = registry({ TTS_PROVIDER: 'neural', OPENAI_API_KEY: 'sk-test' }, () => true);
    expect(ids(providers)).toEqual(['kokoro', 'piper', 'espeak']);
    expect(ids(registry({ TTS_PROVIDER: 'neural' }, () => false))).toEqual(['espeak']);
  });

  it('espeak: an explicit choice of the basic voice is respected', () => {
    const providers = registry({ TTS_PROVIDER: 'espeak' }, () => true);
    expect(ids(providers)).toEqual(['espeak']);
    expect(providers.default.info.id).toBe('espeak');
  });

  it('an explicit external provider without its key still fails loudly', () => {
    expect(() => registry({ TTS_PROVIDER: 'elevenlabs' }, () => true)).toThrow(
      /ELEVENLABS_API_KEY/,
    );
  });
});
