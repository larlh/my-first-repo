import fs from 'node:fs/promises';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VOICE_PREVIEW_TEXTS } from '@parlante/shared';
import type { TTSResult } from '@parlante/shared';
import { providerEnvSchema } from '../env';
import { createLocalWhisperDictation, isLocalWhisperInstalled } from '../stt/local-whisper';
import { disposeWhisperEngines } from '../stt/whisper-engine';
import { analyzeVoice } from '../voice-clone/analysis';
import { createLocalVoiceCloneProvider } from '../voice-clone/local';
import { createEspeakProvider } from './espeak';
import { getEspeakEngine } from './espeak-engine';
import {
  createKokoroProvider,
  createPiperProvider,
  hasInstalledNeuralVoice,
  inspectNeuralVoice,
} from './neural';
import { readKokoroVocab, readPiperConfig } from './neural-backends';
import { disposeNeuralEngines } from './neural-engine';
import {
  KOKORO_SOURCE,
  KOKORO_TOKENIZER,
  PIPER_SOURCE,
  PIPER_VOICE_FILES,
  resolveVoiceModelDir,
  voiceFilePath,
} from './neural-models';
import { kokoroPhonemes, phonemizeSegment, piperSymbols } from './neural-phonemes';
import type { KokoroDialect } from './neural-phonemes';
import { PIPER_VOICES, findKokoroVoice } from './neural-voices';
import type { NeuralVoiceDef } from './neural-voices';
import { prepareSpeech } from './text';
import { decodeWav, encodeWav, resampleLinear } from './wav';

/*
 * [slow] The REAL models, on this CPU, in their worker thread. Skipped when the voices are not
 * installed (`pnpm voices:setup`). Kokoro needs a few seconds to load and, on 4 cores, between
 * a third of and the whole length of the audio to synthesize it, so the file takes about a
 * minute; the checks against the local Whisper model also need `pnpm dictation:setup`.
 *
 * Nothing here can be listened to by the test, so what is asserted is what can be measured:
 * the audio has the level and length of speech, its pitch is the voice's, the word cues sit on
 * the onsets of energy, and — when the speech model is installed — the repository's own
 * Whisper writes back the sentence that was asked for.
 */

const env = providerEnvSchema.parse({});
const dora = findKokoroVoice('ef_dora') as NeuralVoiceDef;
const heart = findKokoroVoice('af_heart') as NeuralVoiceDef;
const installed =
  inspectNeuralVoice(env, dora).installed && inspectNeuralVoice(env, heart).installed;
const whisper = isLocalWhisperInstalled(env);
const piperVoice = PIPER_VOICES.find((def) => inspectNeuralVoice(env, def).installed) ?? null;

const SPANISH = 'La semana que viene tenemos una reunión importante con todo el equipo.';
const ENGLISH = 'Next week we have an important meeting with the whole team.';
const REAL_TEXT = 'El 23 de abril de 2024 la ONU aprobó el 15,5 % del plan. ¿Qué te parece?';

const words = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** 5 ms loudness envelope of a result. */
function envelope(result: TTSResult): number[] {
  const pcm = decodeWav(result.audio);
  const hop = Math.round(pcm.sampleRate * 0.005);
  const rms: number[] = [];
  for (let i = 0; i + hop <= pcm.samples.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < hop; j += 1) sum += ((pcm.samples[i + j] ?? 0) / 32768) ** 2;
    rms.push(Math.sqrt(sum / hop));
  }
  return rms;
}

/** Onsets of speech (ms): the envelope rises after at least 90 ms of silence. */
function onsets(result: TTSResult): number[] {
  const rms = envelope(result);
  const loud = [...rms].sort((a, b) => a - b)[Math.floor(rms.length * 0.95)] ?? 0;
  const found: number[] = [];
  let quiet = 1000;
  rms.forEach((value, i) => {
    if (value < loud * 0.03) quiet += 1;
    else if (value >= loud * 0.08) {
      if (quiet * 5 >= 90) found.push(i * 5);
      quiet = 0;
    }
  });
  return found;
}

function nearestWordStart(result: TTSResult, onsetMs: number): number {
  return result.words.reduce(
    (best, word) => (Math.abs(word.tMs - onsetMs) < Math.abs(best) ? word.tMs - onsetMs : best),
    Infinity,
  );
}

function to16k(result: TTSResult): Int16Array {
  const pcm = decodeWav(result.audio);
  return resampleLinear(pcm.samples, 16_000 / pcm.sampleRate);
}

describe.skipIf(!installed)('[slow] local neural voices, real models', { timeout: 600_000 }, () => {
  // "Nothing leaves the machine" is checked, not assumed (same trap as the speech model test).
  const outbound: string[] = [];
  const savedEnv = new Map<string, string | undefined>();
  let sink: net.Server;
  let home: string;
  let spanish: TTSResult;

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-voice-home-'));
    sink = net.createServer((socket) => {
      socket.on('error', () => undefined);
      socket.once('data', (data) => {
        outbound.push(data.toString('latin1').split('\r\n')[0] ?? '');
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      });
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    const proxy = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
    const overrides: Record<string, string> = {
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: path.join(home, '.cache'),
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      ALL_PROXY: proxy,
      all_proxy: proxy,
      NO_PROXY: '',
      no_proxy: '',
    };
    for (const [key, value] of Object.entries(overrides)) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    spanish = await createKokoroProvider(env).synthesize({
      text: SPANISH,
      providerVoiceId: 'ef_dora',
      language: 'es',
      speed: 1,
      pitch: 0,
    });
  });
  afterAll(async () => {
    await disposeNeuralEngines();
    await disposeWhisperEngines();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });

  it('speaks a Spanish sentence: plausible length, level, pitch and a complete timeline', () => {
    expect(spanish.provider).toMatchObject({ id: 'kokoro', quality: 'premium', local: true });
    expect(spanish.sampleRate).toBe(24_000);
    // 12 words: between 2.5 and 7 seconds at a normal pace.
    expect(spanish.durationMs).toBeGreaterThan(2500);
    expect(spanish.durationMs).toBeLessThan(7000);
    const pcm = decodeWav(spanish.audio);
    const peak = pcm.samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    expect(peak).toBeGreaterThan(3000);
    expect(peak).toBeLessThan(32767); // no clipping
    // A woman's voice: the measured median pitch is in the female range.
    const analysis = analyzeVoice(pcm.samples, pcm.sampleRate);
    expect(analysis.medianF0Hz).toBeGreaterThan(140);
    expect(analysis.medianF0Hz).toBeLessThan(280);
    expect(analysis.voicedSec).toBeGreaterThan(1);

    expect(spanish.words.map((word) => word.text).join(' ')).toBe(SPANISH);
    let previous = 0;
    for (const word of spanish.words) {
      expect(word.tMs).toBeGreaterThanOrEqual(previous);
      expect(word.durMs).toBeGreaterThan(20);
      previous = word.tMs;
    }
    expect(spanish.visemes[0]).toEqual({ tMs: 0, viseme: 'rest' });
    expect(spanish.visemes.at(-1)?.viseme).toBe('rest');
    expect(spanish.visemes.length).toBeGreaterThan(30);
    expect(new Set(spanish.visemes.map((cue) => cue.viseme)).size).toBeGreaterThan(6);
  });

  it('puts the word cues on the real audio: speech starts where a word is said to start', () => {
    // The first word: no sound before it, sound right at it.
    const first = spanish.words[0]?.tMs ?? 0;
    const rms = envelope(spanish);
    const loud = Math.max(...rms);
    const level = (fromMs: number, toMs: number) =>
      Math.max(...rms.slice(Math.floor(fromMs / 5), Math.ceil(toMs / 5)), 0);
    expect(level(0, first - 25)).toBeLessThan(loud * 0.05);
    expect(level(first, first + 120)).toBeGreaterThan(loud * 0.1);
    // Every onset of energy after a pause is within 80 ms of the start of a word.
    const found = onsets(spanish);
    expect(found.length).toBeGreaterThanOrEqual(1);
    for (const onset of found) expect(Math.abs(nearestWordStart(spanish, onset))).toBeLessThan(80);
    // The last word ends before the audio does, and what follows is silence.
    const last = spanish.words.at(-1);
    const end = (last?.tMs ?? 0) + (last?.durMs ?? 0);
    expect(end).toBeLessThanOrEqual(spanish.durationMs);
    expect(level(end + 100, spanish.durationMs)).toBeLessThan(loud * 0.05);
  });

  it('reads numbers, signs, acronyms and two sentences with a pause between them', async () => {
    const result = await createKokoroProvider(env).synthesize({
      text: REAL_TEXT,
      providerVoiceId: 'em_alex',
      language: 'es',
      speed: 1,
      pitch: 0,
    });
    expect(result.words.map((word) => word.text).join(' ')).toBe(REAL_TEXT);
    // "2024" is four words spoken ("dos mil veinticuatro"): its cue is clearly longer than "de".
    const cue = (text: string) => result.words.find((word) => word.text === text);
    expect(cue('2024')?.durMs).toBeGreaterThan((cue('de')?.durMs ?? 0) * 3);
    expect(cue('%')?.durMs).toBeGreaterThan(200); // "por ciento"
    // The model pauses at the full stop: the mouth goes to rest between the two sentences.
    const stop = cue('plan.');
    const question = cue('¿Qué');
    const gap = (question?.tMs ?? 0) - ((stop?.tMs ?? 0) + (stop?.durMs ?? 0));
    expect(gap).toBeGreaterThan(150);
    expect(
      result.visemes.some(
        (v) => v.viseme === 'rest' && v.tMs >= (stop?.tMs ?? 0) && v.tMs < (question?.tMs ?? 0),
      ),
    ).toBe(true);
    // A man's voice this time.
    const pcm = decodeWav(result.audio);
    expect(analyzeVoice(pcm.samples, pcm.sampleRate).medianF0Hz).toBeLessThan(165);
  });

  it('honours speed, and changes pitch by resampling within its short range', async () => {
    const kokoro = createKokoroProvider(env);
    const base = { text: SPANISH, providerVoiceId: 'ef_dora', language: 'es' };
    const fast = await kokoro.synthesize({ ...base, speed: 1.5, pitch: 0 });
    expect(fast.durationMs).toBeLessThan(spanish.durationMs * 0.8);
    expect(fast.durationMs).toBeGreaterThan(spanish.durationMs * 0.5);
    const high = await kokoro.synthesize({ ...base, speed: 1, pitch: 3 });
    const f0 = (result: TTSResult) => {
      const pcm = decodeWav(result.audio);
      return analyzeVoice(pcm.samples, pcm.sampleRate).medianF0Hz ?? 0;
    };
    const semitones = 12 * Math.log2(f0(high) / f0(spanish));
    expect(semitones).toBeGreaterThan(1.8);
    expect(semitones).toBeLessThan(4.2);
    // The tempo is kept (the model speaks slower before the audio is shortened).
    expect(Math.abs(high.durationMs - spanish.durationMs)).toBeLessThan(spanish.durationMs * 0.2);
    expect(high.words.map((word) => word.text).join(' ')).toBe(SPANISH);
  });

  it('speaks a long text in several chunks without clicks at the seams', async () => {
    const paragraph = Array.from({ length: 6 }, () => SPANISH).join(' ');
    const result = await createKokoroProvider(env).synthesize({
      text: `${paragraph}\n\n${SPANISH}`,
      providerVoiceId: 'ef_dora',
      language: 'es',
      speed: 1,
      pitch: 0,
    });
    expect(result.durationMs).toBeGreaterThan(spanish.durationMs * 5);
    expect(result.words).toHaveLength(spanish.words.length * 7);
    // A seam is where a chunk ends and the silence the provider inserts begins (exact zeros),
    // and where the next chunk starts. A click would be a sound that is cut there at full
    // level; with the short fades every chunk reaches the silence — and leaves it — from
    // almost nothing. (Loud neighbouring samples by themselves prove nothing: an "s" at this
    // level jumps 18 000 units from one sample to the next, measured.)
    const pcm = decodeWav(result.audio);
    const runs: { from: number; to: number }[] = [];
    let start = -1;
    for (let i = 0; i <= pcm.samples.length; i += 1) {
      const zero = i < pcm.samples.length && pcm.samples[i] === 0;
      if (zero && start < 0) start = i;
      if (!zero && start >= 0) {
        if (i - start >= pcm.sampleRate * 0.1) runs.push({ from: start, to: i });
        start = -1;
      }
    }
    // Three chunks of two sentences and the paragraph: at least three pauses plus the tail.
    expect(runs.length).toBeGreaterThanOrEqual(4);
    for (const run of runs) {
      for (const index of [run.from - 1, run.from - 2, run.to, run.to + 1]) {
        expect(Math.abs(pcm.samples[index] ?? 0), `sample ${index}`).toBeLessThan(1500);
      }
    }
    // And every silence between chunks is real silence, not a cut in mid-sound.
    const rms = envelope(result);
    const loud = Math.max(...rms);
    const paragraphGap = result.words[spanish.words.length * 6];
    const before = result.words[spanish.words.length * 6 - 1];
    const gapStart = (before?.tMs ?? 0) + (before?.durMs ?? 0) + 120;
    const gapEnd = (paragraphGap?.tMs ?? 0) - 30;
    expect(gapEnd - gapStart).toBeGreaterThan(200);
    expect(Math.max(...rms.slice(Math.ceil(gapStart / 5), Math.floor(gapEnd / 5)))).toBeLessThan(
      loud * 0.05,
    );
  });

  it('speaks English with an English voice', async () => {
    const result = await createKokoroProvider(env).synthesize({
      text: ENGLISH,
      providerVoiceId: 'af_heart',
      language: 'en',
      speed: 1,
      pitch: 0,
    });
    expect(result.words.map((word) => word.text).join(' ')).toBe(ENGLISH);
    expect(result.durationMs).toBeGreaterThan(2000);
    expect(result.durationMs).toBeLessThan(6000);
  });

  it('does not block the event loop while it synthesizes', async () => {
    const delay = monitorEventLoopDelay({ resolution: 5 });
    delay.enable();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    const started = performance.now();
    await createKokoroProvider(env).synthesize({
      text: ENGLISH,
      providerVoiceId: 'af_heart',
      language: 'en',
      speed: 1,
      pitch: 0,
    });
    const elapsed = performance.now() - started;
    clearInterval(timer);
    delay.disable();
    expect(delay.max / 1e6).toBeLessThan(500);
    expect(ticks).toBeGreaterThan(elapsed / 10 / 4);
  });

  it.skipIf(!whisper)(
    'is understood by the local speech model far better than the eSpeak voice',
    async () => {
      const dictation = createLocalWhisperDictation(env);
      const heard = async (result: TTSResult, language: 'es' | 'en') =>
        words(
          (await dictation.transcribe({ samples: to16k(result), sampleRate: 16_000, language }))
            .text,
        );
      // The Spanish neural voice: the sentence comes back word for word.
      expect(await heard(spanish, 'es')).toBe(words(SPANISH));
      const english = await createKokoroProvider(env).synthesize({
        text: ENGLISH,
        providerVoiceId: 'af_heart',
        language: 'en',
        speed: 1,
        pitch: 0,
      });
      expect(await heard(english, 'en')).toBe(words(ENGLISH));
      // The same Spanish sentence with the eSpeak female voice is NOT understood word for
      // word by the same model (the reference of the table in docs/MODELS.md).
      const robotic = await createEspeakProvider(env).synthesize({
        text: 'El tiempo en la costa será soleado durante todo el fin de semana.',
        providerVoiceId: 'es-f1',
        language: 'es',
        speed: 1,
        pitch: 0,
      });
      const neural = await createKokoroProvider(env).synthesize({
        text: 'El tiempo en la costa será soleado durante todo el fin de semana.',
        providerVoiceId: 'ef_dora',
        language: 'es',
        speed: 1,
        pitch: 0,
      });
      const target = words('El tiempo en la costa será soleado durante todo el fin de semana.');
      expect(await heard(neural, 'es')).toBe(target);
      expect(await heard(robotic, 'es')).not.toBe(target);
    },
  );

  it('bases a local voice profile on the neural voice closest in pitch, not on eSpeak', async () => {
    // A "person": the eSpeak male voice, synthesized (no recording of anyone).
    const sample = await createEspeakProvider(env).synthesize({
      text: `${SPANISH} ${SPANISH}`,
      providerVoiceId: 'es-m1',
      language: 'es',
      speed: 1,
      pitch: 0,
    });
    const pcm = decodeWav(sample.audio);
    const clone = createLocalVoiceCloneProvider(env);
    const result = await clone.createVoice({
      name: 'Prueba',
      sample: encodeWav(pcm.samples, pcm.sampleRate),
      sampleRate: pcm.sampleRate,
      language: 'es',
      consentId: 'cns_0000000000000000',
    });
    expect(result.ttsProviderId).toBe('kokoro');
    expect(result.providerVoiceId).toBe('em_alex'); // the Spanish male neural voice
    expect(result.profile?.baseVoiceId).toBe('em_alex');
    expect(Math.abs(result.profile?.pitchSemitones ?? 99)).toBeLessThanOrEqual(4);
    // Still labelled for what it is: a basic local profile, not a clone of the timbre.
    expect(result.provider).toMatchObject({ id: 'local', quality: 'basic' });
    // And the profile really speaks, with the neural provider.
    const spoken = await createKokoroProvider(env).synthesize({
      text: 'Hola, esta es mi voz.',
      providerVoiceId: result.providerVoiceId,
      language: 'es',
      speed: 1,
      pitch: 0,
      profile: result.profile,
    });
    expect(spoken.provider.id).toBe('kokoro');
    expect(spoken.durationMs).toBeGreaterThan(800);
  });

  it.skipIf(piperVoice === null)(
    'speaks with an installed Piper voice, timeline included',
    async () => {
      const def = piperVoice as NeuralVoiceDef;
      const result = await createPiperProvider(env).synthesize({
        text: 'Hallo. Guten Tag, wie geht es Ihnen heute?',
        providerVoiceId: def.providerVoiceId,
        language: def.language,
        speed: 1,
        pitch: 0,
      });
      expect(result.provider.id).toBe('piper');
      expect(result.durationMs).toBeGreaterThan(1500);
      expect(result.words.length).toBeGreaterThanOrEqual(7);
      for (const onset of onsets(result)) {
        expect(Math.abs(nearestWordStart(result, onset))).toBeLessThan(90);
      }
    },
  );

  it('writes only phonemes the models have a symbol for (eSpeak ↔ model alphabets)', async () => {
    // What eSpeak writes for real text — numbers, acronyms, accents, loan words — goes through
    // the mapping of each model. A symbol the model's table lacks would be dropped silently
    // and the word mispronounced: none may be.
    const espeak = await getEspeakEngine();
    const modelsDir = resolveVoiceModelDir(env);
    const vocab = await readKokoroVocab(voiceFilePath(modelsDir, KOKORO_SOURCE, KOKORO_TOKENIZER));
    const texts: [string, KokoroDialect, string][] = [
      [
        'es',
        'other',
        'El 23 de abril de 2024 la ONU aprobó el 15,5 % del plan (según la OTAN). El pingüino y la cigüeña; la Dra. Núñez cobra 49,99 €. Software, marketing, WhatsApp, ñandú, exhibición, huevo, guiño, yate, lluvia, chocolate, jamón, perro.',
      ],
      [
        'en-us',
        'en-us',
        'On May 3rd, 2024, Dr. Smith paid $1,250 — NASA and the FBI agreed. Thought, church, judge, measure, bird, tour, about, button, little, world, year, pure, boy, now, go.',
      ],
      [
        'en',
        'en-gb',
        'The quick brown fox jumps over the lazy dog. Hair, near, water, tour, bird, thought, judge, measure, go, now.',
      ],
      [
        'fr',
        'other',
        "Bonjour, les amis. Vous avez vingt-trois ans ? Le garçon mange un œuf à l'hôtel. Un bon vin blanc, brun, parfum, agneau, fille, huit, champagne, rue.",
      ],
      [
        'it',
        'other',
        'Buongiorno a tutti. Gli gnocchi costano 12,50 €. Ciao, perché, città, giorno, sciare, aglio, zucchero, pizza, quattro, acqua.',
      ],
      [
        'pt-br',
        'other',
        'Olá, bom dia a todos. A nação e os corações. Não, pão, mãe, muito, chave, lhama, ninho, quente, gente, carro, três, português.',
      ],
    ];
    for (const [voice, dialect, text] of texts) {
      const prepared = prepareSpeech(text);
      const words = prepared.segments.flatMap((segment) =>
        phonemizeSegment(espeak, prepared, segment, voice),
      );
      expect(words.length).toBeGreaterThan(15);
      const missing = new Set<string>();
      for (const word of words) {
        for (const symbol of kokoroPhonemes(word.phonemes, dialect)) {
          if (!vocab.has(symbol)) missing.add(symbol);
        }
      }
      expect([...missing], `${voice}: symbols missing in Kokoro's vocabulary`).toEqual([]);
    }
    // The same for every Piper voice installed here, with its own symbol table.
    for (const def of PIPER_VOICES.filter((voice) => inspectNeuralVoice(env, voice).installed)) {
      const config = await readPiperConfig(
        voiceFilePath(modelsDir, PIPER_SOURCE, PIPER_VOICE_FILES[def.files].config),
      );
      const known = new Set(Object.keys(config.phoneme_id_map));
      const longest = Math.max(...[...known].map((symbol) => [...symbol].length));
      const prepared = prepareSpeech(VOICE_PREVIEW_TEXTS[def.language.slice(0, 2)] ?? SPANISH);
      const missing = new Set<string>();
      for (const segment of prepared.segments) {
        for (const word of phonemizeSegment(espeak, prepared, segment, def.espeakVoice)) {
          for (const ipa of word.phonemes) {
            const kept = piperSymbols(ipa, known, longest).join('');
            for (const ch of ipa.normalize('NFD')) if (!kept.includes(ch)) missing.add(ch);
          }
        }
      }
      expect([...missing], `${def.providerVoiceId}: symbols missing`).toEqual([]);
    }
  });

  it('falls back to the CPU when a GPU provider is asked for and cannot be used', async () => {
    // VOICE_DEVICE=dml / cuda is NOT verified on a real GPU (this machine has none): what is
    // checked is that asking for one never breaks synthesis.
    for (const device of ['dml', 'cuda'] as const) {
      const result = await createKokoroProvider({ ...env, VOICE_DEVICE: device }).synthesize({
        text: 'Hola.',
        providerVoiceId: 'ef_dora',
        language: 'es',
        speed: 1,
        pitch: 0,
      });
      expect(result.durationMs).toBeGreaterThan(300);
      expect(result.words).toHaveLength(1);
    }
  });

  // LAST on purpose: by now the models have been loaded and used for a good while.
  it('sends nothing out and leaves nothing in the home directory', async () => {
    expect(hasInstalledNeuralVoice(env, 'kokoro')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const left = await fs.readdir(home, { recursive: true });
    expect({ outbound, left }).toEqual({ outbound: [], left: [] });
    expect(process.env.ORT_DISABLE_TELEMETRY).toBe('1');
  });
});
