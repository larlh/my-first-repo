import { AppError, VOICE_PREVIEW_TEXTS } from '@parlante/shared';
import type {
  ProviderRef,
  TTSProvider,
  VoiceCloneProvider,
  VoiceCloneRequest,
  VoiceCloneResult,
} from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { createEspeakProvider } from '../tts/espeak';
import { findEspeakVoice } from '../tts/espeak-voices';
import { createKokoroProvider, createPiperProvider } from '../tts/neural';
import { decodeWav, isWav, pcm16FromBytes } from '../tts/wav';
import { analyzeVoice, semitonesBetween } from './analysis';

/* -------------------------------------------------------------------------------------------
 * LOCAL voice "cloning" — basic mode, and it says so (`quality: 'basic'`).
 *
 * It does NOT reproduce a person's timbre. It measures two things in the sample — how high
 * the person speaks (median fundamental frequency) and how fast (syllables per second) — and
 * stores them as a `VoiceProfile` applied on top of a local stock voice of the same language:
 * the result is a synthetic voice with that person's pitch and pace. For a real clone the
 * product uses the ElevenLabs adapter.
 *
 * Which stock voice: the installed local NEURAL voice (Kokoro / Piper) of that language and
 * gender whose own pitch is closest to the person's — so the profile sounds like a human
 * voice near theirs, and the pitch has to be moved as little as possible (neural voices change
 * pitch by resampling, which is only clean for a few semitones). Without a neural voice for the
 * language, the eSpeak voice as before.
 *
 * The profile is relative to the base voice, so the base voice is measured with the very same
 * analyser (it is synthesised once per voice and cached): systematic errors of the analysis
 * cancel out.
 * ----------------------------------------------------------------------------------------- */

export const LOCAL_VOICE_CLONE_INFO: ProviderRef = {
  id: 'local',
  name: 'Perfil de voz (local)',
  quality: 'basic',
  local: true,
};

/** Shortest sample that gives a stable median pitch. */
const MIN_SAMPLE_SEC = 2;
const MIN_VOICED_SEC = 0.6;
/** Above this median pitch a voice is matched with the female base timbre. */
const FEMALE_F0_HZ = 165;
/** The pace estimate is coarse: never move the base voice's speed further than this. */
const MIN_SPEED = 0.8;
const MAX_SPEED = 1.25;

interface Baseline {
  f0Hz: number;
  syllablesPerSec: number | null;
}

export interface LocalVoiceCloneOptions {
  /** Local TTS used to measure the base voices (tests may inject one). */
  tts?: TTSProvider;
  /**
   * Local neural TTS providers whose installed voices are preferred as the base of a profile
   * (default: Kokoro and Piper of this server; tests inject doubles or none).
   */
  neural?: readonly TTSProvider[];
}

interface BaseCandidate {
  tts: TTSProvider;
  baseVoiceId: string;
  /** Semitones the pitch control of the voice can move it (profile is clamped to it). */
  minSemitones: number;
  maxSemitones: number;
}

export function createLocalVoiceCloneProvider(
  env: ProviderEnv,
  options: LocalVoiceCloneOptions = {},
): VoiceCloneProvider {
  const espeak = options.tts ?? createEspeakProvider(env);
  const neural =
    options.neural ?? (options.tts ? [] : [createKokoroProvider(env), createPiperProvider(env)]);
  const baselines = new Map<string, Promise<Baseline>>();

  /** Installed neural voices of a language and gender, as possible bases of a profile. */
  async function neuralCandidates(language: string, female: boolean): Promise<BaseCandidate[]> {
    const out: BaseCandidate[] = [];
    for (const tts of neural) {
      let voices: Awaited<ReturnType<TTSProvider['listVoices']>>;
      try {
        voices = await tts.listVoices();
      } catch {
        continue; // a provider that cannot list its voices offers none
      }
      for (const voice of voices) {
        if (voice.unavailable) continue;
        if (voice.language.slice(0, 2).toLowerCase() !== language) continue;
        if (voice.gender !== (female ? 'female' : 'male')) continue;
        out.push({
          tts,
          baseVoiceId: voice.providerVoiceId,
          minSemitones: voice.pitchRange?.minSemitones ?? -12,
          maxSemitones: voice.pitchRange?.maxSemitones ?? 12,
        });
      }
    }
    return out;
  }

  function baselineOf(tts: TTSProvider, baseVoiceId: string, language: string): Promise<Baseline> {
    const key = `${tts.info.id}:${baseVoiceId}`;
    let pending = baselines.get(key);
    if (!pending) {
      pending = (async () => {
        const text = VOICE_PREVIEW_TEXTS[language] ?? VOICE_PREVIEW_TEXTS.es ?? 'Hola.';
        const speech = await tts.synthesize({
          text: `${text} ${text}`,
          providerVoiceId: baseVoiceId,
          language,
          speed: 1,
          pitch: 0,
        });
        const pcm = decodeWav(speech.audio);
        const analysis = analyzeVoice(pcm.samples, pcm.sampleRate);
        if (analysis.medianF0Hz === null) {
          throw new AppError('PROVIDER_ERROR', 'The local base voice could not be measured', {
            baseVoiceId,
          });
        }
        return { f0Hz: analysis.medianF0Hz, syllablesPerSec: analysis.syllablesPerSec };
      })();
      baselines.set(key, pending);
      pending.catch(() => baselines.delete(key));
    }
    return pending;
  }

  /**
   * The base of a profile: among the installed neural voices of the language and gender, the
   * one whose pitch is closest to `f0`; the eSpeak voice when there is none (or none of them
   * can be measured right now).
   */
  async function chooseBase(
    language: string,
    female: boolean,
    f0: number,
  ): Promise<{ candidate: BaseCandidate; baseline: Baseline }> {
    let best: { candidate: BaseCandidate; baseline: Baseline; distance: number } | null = null;
    for (const candidate of await neuralCandidates(language, female)) {
      let baseline: Baseline;
      try {
        baseline = await baselineOf(candidate.tts, candidate.baseVoiceId, language);
      } catch {
        continue; // this voice cannot speak right now: try the next one
      }
      const distance = Math.abs(semitonesBetween(baseline.f0Hz, f0));
      if (!best || distance < best.distance) best = { candidate, baseline, distance };
    }
    if (best) return best;
    const baseVoiceId = `${language}-${female ? 'f1' : 'm1'}`;
    if (!findEspeakVoice(baseVoiceId)) {
      throw new AppError('UNPROCESSABLE', 'There is no local voice for this language', {
        language,
      });
    }
    const candidate = { tts: espeak, baseVoiceId, minSemitones: -12, maxSemitones: 12 };
    return { candidate, baseline: await baselineOf(espeak, baseVoiceId, language) };
  }

  async function createVoice(request: VoiceCloneRequest): Promise<VoiceCloneResult> {
    const pcm = isWav(request.sample)
      ? decodeWav(request.sample)
      : { samples: pcm16FromBytes(request.sample), sampleRate: request.sampleRate };
    const analysis = analyzeVoice(pcm.samples, pcm.sampleRate);
    if (analysis.durationSec < MIN_SAMPLE_SEC) {
      throw new AppError(
        'UNPROCESSABLE',
        `The voice sample is too short: at least ${MIN_SAMPLE_SEC} seconds of speech are needed`,
        { durationSec: Number(analysis.durationSec.toFixed(2)) },
      );
    }
    if (analysis.medianF0Hz === null || analysis.voicedSec < MIN_VOICED_SEC) {
      throw new AppError(
        'UNPROCESSABLE',
        'No voice could be detected in the sample: record clear speech without music or noise',
        { voicedSec: Number(analysis.voicedSec.toFixed(2)) },
      );
    }
    const f0 = analysis.medianF0Hz;
    const female = request.gender === 'female' || (request.gender !== 'male' && f0 >= FEMALE_F0_HZ);
    const { candidate, baseline } = await chooseBase(request.language, female, f0);
    const { tts, baseVoiceId } = candidate;
    // Never ask the base voice for more than its pitch control can do.
    const pitchSemitones = Math.min(
      candidate.maxSemitones,
      Math.max(candidate.minSemitones, semitonesBetween(baseline.f0Hz, f0)),
    );
    const speed =
      analysis.syllablesPerSec !== null && baseline.syllablesPerSec !== null
        ? Math.min(
            MAX_SPEED,
            Math.max(MIN_SPEED, analysis.syllablesPerSec / baseline.syllablesPerSec),
          )
        : 1;
    return {
      ttsProviderId: tts.info.id,
      providerVoiceId: baseVoiceId,
      profile: {
        baseVoiceId,
        pitchSemitones: Math.round(pitchSemitones * 10) / 10,
        speed: Math.round(speed * 100) / 100,
        // Median (not mean) of the voiced frames: robust against octave errors and creaks.
        meanF0Hz: Math.round(f0 * 10) / 10,
      },
      provider: LOCAL_VOICE_CLONE_INFO,
    };
  }

  return {
    info: LOCAL_VOICE_CLONE_INFO,
    createVoice,
    // Nothing exists outside the database row and its sample in storage.
    deleteVoice: async () => undefined,
  };
}
