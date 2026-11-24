import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { providerEnvSchema } from '../env';
import { createEspeakProvider } from '../tts/espeak';
import { concatPcm, decodeWav, encodeWav, resampleLinear } from '../tts/wav';
import {
  createLocalWhisperDictation,
  createLocalWhisperStt,
  isLocalWhisperInstalled,
} from './local-whisper';
import { disposeWhisperEngines } from './whisper-engine';

/*
 * [slow] The REAL model: Whisper running on this CPU in its worker thread, fed with speech
 * synthesized by the repo's own eSpeak (no recordings of people). Skipped when the model is
 * not installed (`pnpm dictation:setup`); a model takes a few seconds to load and one to three
 * per phrase, so the whole file needs about half a minute on 4 cores.
 *
 * eSpeak is a robotic voice and Whisper was trained on people: the phrases below are ones the
 * default model gets exactly right (measured, see docs/MODELS.md). They prove the pipeline —
 * audio in, the right words out, in the right language — not the accuracy on human speech.
 */

const env = providerEnvSchema.parse({});
const installed = isLocalWhisperInstalled(env);
const RATE = 16_000;
const SPANISH = 'Hola, bienvenidos a esta presentación sobre nuestro nuevo producto.';
const ENGLISH = 'Hello and welcome to this presentation about our new product.';

const words = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function speak(text: string, language: 'es' | 'en'): Promise<Int16Array> {
  const tts = createEspeakProvider(env);
  const result = await tts.synthesize({
    text,
    providerVoiceId: `${language}-f1`,
    language,
    speed: 1,
    pitch: 0,
  });
  const pcm = decodeWav(result.audio);
  return pcm.sampleRate === RATE ? pcm.samples : resampleLinear(pcm.samples, RATE / pcm.sampleRate);
}

describe.skipIf(!installed)('[slow] local Whisper, real model', { timeout: 240_000 }, () => {
  let spanish: Int16Array;
  let english: Int16Array;

  beforeAll(async () => {
    spanish = await speak(SPANISH, 'es');
    english = await speak(ENGLISH, 'en');
  });
  afterAll(async () => {
    await disposeWhisperEngines();
  });

  it('transcribes a Spanish and an English phrase given their language', async () => {
    const dictation = createLocalWhisperDictation(env);
    expect(await dictation.status()).toMatchObject({ available: true, reasonCode: null });
    const es = await dictation.transcribe({ samples: spanish, sampleRate: RATE, language: 'es' });
    expect(words(es.text)).toBe(words(SPANISH));
    expect(es.language).toBe('es');
    expect(es.provider).toEqual(dictation.info);
    const en = await dictation.transcribe({ samples: english, sampleRate: RATE, language: 'en' });
    expect(words(en.text)).toBe(words(ENGLISH));
    expect(en.language).toBe('en');
  });

  it('detects the language when none is given', async () => {
    const dictation = createLocalWhisperDictation(env);
    const es = await dictation.transcribe({ samples: spanish, sampleRate: RATE });
    expect(es.language).toBe('es');
    expect(words(es.text)).toBe(words(SPANISH));
    const en = await dictation.transcribe({ samples: english, sampleRate: RATE });
    expect(en.language).toBe('en');
    expect(words(en.text)).toBe(words(ENGLISH));
  });

  it('returns no text for silence and for background hiss', async () => {
    const dictation = createLocalWhisperDictation(env);
    expect((await dictation.transcribe({ samples: new Int16Array(RATE * 5), sampleRate: RATE })).text).toBe(
      '',
    );
    const hiss = Int16Array.from({ length: RATE * 3 }, (_, i) => ((i * 7919) % 61) - 30);
    expect((await dictation.transcribe({ samples: hiss, sampleRate: RATE, language: 'es' })).text).toBe('');
  });

  it('does not block the event loop while it transcribes', async () => {
    const dictation = createLocalWhisperDictation(env);
    const delay = monitorEventLoopDelay({ resolution: 5 });
    delay.enable();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    const started = performance.now();
    const result = await dictation.transcribe({ samples: english, sampleRate: RATE, language: 'en' });
    const elapsed = performance.now() - started;
    clearInterval(timer);
    delay.disable();
    expect(words(result.text)).toBe(words(ENGLISH));
    // In-process inference stalls the loop for seconds (measured: 1.8–7 s). In the worker
    // thread the timers keep firing all along.
    expect(delay.max / 1e6).toBeLessThan(500);
    expect(ticks).toBeGreaterThan(elapsed / 10 / 4);
  });

  it('transcribes a recording longer than one window into timed segments (video translation)', async () => {
    const stt = createLocalWhisperStt(env);
    expect(stt.requiresUserTranscript).toBe(false);
    const pause = new Int16Array(RATE);
    const blocks: Int16Array[] = [];
    for (let i = 0; i < 10; i += 1) blocks.push(spanish, pause);
    const recording = concatPcm(blocks);
    const durationMs = (recording.length * 1000) / RATE;
    expect(durationMs).toBeGreaterThan(40_000);

    const result = await stt.transcribe({ audio: encodeWav(recording, RATE) });
    expect(result.provider).toEqual(stt.info);
    expect(result.language).toBe('es'); // detected: no hint was given
    expect(result.segments.length).toBeGreaterThanOrEqual(4);
    let previousStart = -1;
    for (const segment of result.segments) {
      expect(segment.text).not.toBe('');
      expect(segment.startMs).toBeGreaterThanOrEqual(previousStart);
      expect(segment.endMs).toBeGreaterThan(segment.startMs);
      expect(segment.endMs).toBeLessThanOrEqual(Math.ceil(durationMs));
      previousStart = segment.startMs;
    }
    // Phrases of the second window are placed after the first one, not at zero.
    expect(result.segments.at(-1)!.startMs).toBeGreaterThan(29_000);
    const text = words(result.segments.map((segment) => segment.text).join(' '));
    const heard = text.split('bienvenidos').length - 1;
    expect(heard).toBeGreaterThanOrEqual(7); // the phrase was spoken ten times
  });
});
