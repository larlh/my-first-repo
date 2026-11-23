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
import { decodeWav, isWav, pcm16FromBytes } from '../tts/wav';
import { analyzeVoice, semitonesBetween } from './analysis';

/* -------------------------------------------------------------------------------------------
 * LOCAL voice "cloning" — basic mode, and it says so (`quality: 'basic'`).
 *
 * It does NOT reproduce a person's timbre. It measures two things in the sample — how high
 * the person speaks (median fundamental frequency) and how fast (syllables per second) — and
 * stores them as a `VoiceProfile` applied on top of a local eSpeak voice of the same language:
 * the result is a synthetic voice with that person's pitch and pace. For a real clone the
 * product uses the ElevenLabs adapter.
 *
 * The profile is relative to the base voice, so the base voice is measured with the very same
 * analyser (it is synthesised once per voice and cached): systematic errors of the analysis
 * cancel out.
 * ----------------------------------------------------------------------------------------- */

export const LOCAL_VOICE_CLONE_INFO: ProviderRef = {
  id: 'local',
  name: 'Voice profile (local)',
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
}

export function createLocalVoiceCloneProvider(
  env: ProviderEnv,
  options: LocalVoiceCloneOptions = {},
): VoiceCloneProvider {
  const tts = options.tts ?? createEspeakProvider(env);
  const baselines = new Map<string, Promise<Baseline>>();

  function baselineOf(baseVoiceId: string, language: string): Promise<Baseline> {
    let pending = baselines.get(baseVoiceId);
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
      baselines.set(baseVoiceId, pending);
      pending.catch(() => baselines.delete(baseVoiceId));
    }
    return pending;
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
    const baseVoiceId = `${request.language}-${female ? 'f1' : 'm1'}`;
    if (!findEspeakVoice(baseVoiceId)) {
      throw new AppError('UNPROCESSABLE', 'There is no local voice for this language', {
        language: request.language,
      });
    }
    const baseline = await baselineOf(baseVoiceId, request.language);
    const pitchSemitones = Math.min(12, Math.max(-12, semitonesBetween(baseline.f0Hz, f0)));
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
