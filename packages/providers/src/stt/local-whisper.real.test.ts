import fs from 'node:fs/promises';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
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
 * The voice is the plain eSpeak one (`m1`), synthesized in a fixed order: that audio is
 * identical on every run (the variant voices, `f1`…, are not), and so is what the model
 * answers.
 */

const env = providerEnvSchema.parse({});
const installed = isLocalWhisperInstalled(env);
const RATE = 16_000;
const SPANISH = 'La semana que viene tenemos una reunión importante con todo el equipo.';
const ENGLISH = 'Next week we have an important meeting with the whole team.';

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
    providerVoiceId: `${language}-m1`,
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

  // "Nothing leaves the machine" is checked, not assumed: before the model is loaded, every
  // outbound HTTPS connection of this process is routed to a listener that only writes down
  // who was asked for, and the home directory is replaced by an empty one.
  const outbound: string[] = [];
  const savedEnv = new Map<string, string | undefined>();
  let sink: net.Server;
  let home: string;

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-speech-home-'));
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
    spanish = await speak(SPANISH, 'es');
    english = await speak(ENGLISH, 'en');
  });
  afterAll(async () => {
    await disposeWhisperEngines();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
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
    expect(
      (await dictation.transcribe({ samples: new Int16Array(RATE * 5), sampleRate: RATE })).text,
    ).toBe('');
    const hiss = Int16Array.from({ length: RATE * 3 }, (_, i) => ((i * 7919) % 61) - 30);
    expect(
      (await dictation.transcribe({ samples: hiss, sampleRate: RATE, language: 'es' })).text,
    ).toBe('');
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
    const result = await dictation.transcribe({
      samples: english,
      sampleRate: RATE,
      language: 'en',
    });
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
    const heard = text.split('reunión importante').length - 1;
    expect(heard).toBeGreaterThanOrEqual(7); // the phrase was spoken ten times
  });

  // LAST on purpose: by now the model has been loaded and used for a good while.
  it('sends nothing out and leaves nothing in the home directory (runtime telemetry is off)', async () => {
    // ONNX Runtime's own telemetry is on by default: without the switch this process asks for
    // `CONNECT mobile.events.data.microsoft.com:443` and writes a device id and an event
    // queue under ~/.cache/Microsoft within seconds of loading the model (measured).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const left = await fs.readdir(home, { recursive: true });
    expect({ outbound, left }).toEqual({ outbound: [], left: [] });
    expect(process.env.ORT_DISABLE_TELEMETRY).toBe('1');
  });
});
