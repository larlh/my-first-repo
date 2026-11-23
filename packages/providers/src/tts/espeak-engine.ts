import { AppError } from '@parlante/shared';
import type { EspeakRawEvent, EspeakWorker } from '@echogarden/espeak-ng-emscripten';
import { concatPcm } from './wav';

/* -------------------------------------------------------------------------------------------
 * eSpeak NG (WebAssembly) — one lazily created instance per process.
 *
 * The engine is synchronous and stateful (voice, rate, pitch), so every call sets its whole
 * state and runs to completion: calls cannot interleave. It synthesises several hundred times
 * faster than real time (≈ 0.5 s of CPU for 200 s of speech on the build machine); callers
 * split long texts into segments and yield to the event loop between them.
 *
 * NOT bit-reproducible: eSpeak keeps its oscillator state (glottal phase, flutter) from one
 * utterance to the next, so the same request synthesised twice differs by a few milliseconds
 * in length and in its samples (measured: up to ±0.3 % of the duration). Each result is
 * self-consistent — audio and events come from the same run — and the TTS cache of
 * packages/jobs makes preview and export share one of them.
 * ----------------------------------------------------------------------------------------- */

export interface EspeakSettings {
  /** eSpeak voice, optionally with a variant: `es`, `en-us+f2`. */
  voice: string;
  /** Words per minute (clamped to eSpeak's 80..450). */
  rateWpm: number;
  /** eSpeak pitch parameter 0..99 (50 = the voice's own pitch). */
  pitch: number;
}

export interface EspeakEvent {
  type: 'word' | 'phoneme' | 'sentence' | 'end';
  /** Milliseconds from the start of the utterance. */
  tMs: number;
  /** 0-based code-point index in the synthesised text (word events). */
  textIndex: number;
  /** IPA of the phoneme (empty string = pause); empty for other events. */
  phoneme: string;
}

export interface EspeakUtterance {
  samples: Int16Array;
  events: EspeakEvent[];
}

export interface EspeakEngine {
  readonly sampleRate: number;
  /** True when eSpeak can load this voice name (`es`, `en-us`, `pt-br`…). */
  hasVoice(name: string): boolean;
  /** `text` is SSML-aware: callers must pass sanitised markup (see `prepareSpeech`). */
  synthesize(text: string, settings: EspeakSettings): EspeakUtterance;
}

export const ESPEAK_NORMAL_WPM = 175;
const MIN_WPM = 80;
const MAX_WPM = 450;

function createEngine(worker: EspeakWorker): EspeakEngine {
  const sampleRate = worker.get_samplerate();
  return {
    sampleRate,
    hasVoice: (name) => worker.set_voice(name) === 0,
    synthesize(text, settings) {
      if (worker.set_voice(settings.voice) !== 0) {
        throw new AppError('PROVIDER_ERROR', `eSpeak NG cannot load the voice "${settings.voice}"`);
      }
      worker.set_rate(Math.round(Math.min(MAX_WPM, Math.max(MIN_WPM, settings.rateWpm))));
      worker.set_pitch(Math.round(Math.min(99, Math.max(0, settings.pitch))));
      worker.set_range(50);
      const blocks: Int16Array[] = [];
      const events: EspeakEvent[] = [];
      worker.synthesize(text, (audio: Int16Array, raw: EspeakRawEvent[]) => {
        if (audio.length > 0) blocks.push(audio);
        for (const event of raw) {
          if (
            event.type !== 'word' &&
            event.type !== 'phoneme' &&
            event.type !== 'sentence' &&
            event.type !== 'end'
          ) {
            continue;
          }
          events.push({
            type: event.type,
            tMs: event.audio_position,
            textIndex: Math.max(0, event.text_position - 1),
            phoneme: event.type === 'phoneme' && typeof event.id === 'string' ? event.id : '',
          });
        }
        return false;
      });
      return { samples: concatPcm(blocks), events };
    },
  };
}

let enginePromise: Promise<EspeakEngine> | null = null;

/** The process-wide engine. A failed load is not cached: the next call tries again. */
export function getEspeakEngine(): Promise<EspeakEngine> {
  enginePromise ??= (async () => {
    try {
      const { default: createModule } = await import('@echogarden/espeak-ng-emscripten');
      const module = await createModule();
      return createEngine(new module.eSpeakNGWorker());
    } catch (err) {
      enginePromise = null;
      if (err instanceof AppError) throw err;
      throw new AppError(
        'PROVIDER_ERROR',
        'The local speech engine (eSpeak NG) could not be loaded',
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
  })();
  return enginePromise;
}

/** Forget the engine after a fatal error inside the WebAssembly module. */
export function resetEspeakEngine(): void {
  enginePromise = null;
}
