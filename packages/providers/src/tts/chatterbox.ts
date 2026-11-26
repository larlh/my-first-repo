import { estimateSpeechTimeline } from '@parlante/shared';
import type {
  ProviderVoice,
  TTSProvider,
  TTSRequest,
  TTSResult,
  VisemeCue,
} from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { CHATTERBOX_INFO, createVoiceEngineClient } from '../voice-clone/voice-engine';
import type { VoiceEngineClient } from '../voice-clone/voice-engine';
import { prepareSpeech } from './text';
import { clampWords, joinVisemes, shiftWords } from './timeline';
import { decodeWav, encodeWav, samplesToMs } from './wav';

/* -------------------------------------------------------------------------------------------
 * Speech with voices cloned by the local voice engine (Chatterbox es-ES). It has NO stock
 * voices: `providerVoiceId` is the engine's `cbx_…` id of a cloned voice, reached only through
 * `resolveVoice` (workspace-scoped `vcl_…` voices).
 *
 * Chatterbox gives no timing, so words are placed with THE shared estimator
 * (`estimateSpeechTimeline`) sentence by sentence: the engine reports where each chunk it
 * generated starts and ends in the audio, which keeps subtitles and the 2D mouth in step with
 * the pauses between sentences.
 * ----------------------------------------------------------------------------------------- */

const EMPTY_RATE = 24_000;

export function createChatterboxTtsProvider(
  env: Pick<ProviderEnv, 'VOICE_ENGINE_URL' | 'VOICE_ENGINE_TOKEN'>,
  client: VoiceEngineClient = createVoiceEngineClient(env),
): TTSProvider {
  async function synthesize(request: TTSRequest): Promise<TTSResult> {
    const spoken = prepareSpeech(request.text).spoken.replace(/\s+/g, ' ').trim();
    if (spoken === '') {
      return {
        audio: encodeWav(new Int16Array(0), EMPTY_RATE),
        format: 'wav',
        sampleRate: EMPTY_RATE,
        durationMs: 0,
        visemes: [],
        words: [],
        provider: CHATTERBOX_INFO,
      };
    }
    const language = request.language.slice(0, 2).toLowerCase();
    const speed = Math.min(2, Math.max(0.5, request.speed * (request.profile?.speed ?? 1)));
    const result = await client.speech({
      voiceId: request.providerVoiceId,
      text: spoken,
      language,
      speed,
      pitch: Math.min(12, Math.max(-12, request.pitch)),
    });
    const pcm = decodeWav(result.audio);
    const durationMs = samplesToMs(pcm.samples.length, pcm.sampleRate);
    const words: TTSResult['words'] = [];
    const visemes: { offsetMs: number; visemes: VisemeCue[] }[] = [];
    for (const segment of result.segments) {
      const estimate = estimateSpeechTimeline(
        segment.text,
        Math.max(1, segment.endMs - segment.startMs),
        language,
      );
      words.push(...shiftWords(estimate.words, segment.startMs));
      visemes.push({ offsetMs: segment.startMs, visemes: estimate.visemes });
    }
    return {
      audio: result.audio,
      format: 'wav',
      sampleRate: pcm.sampleRate,
      durationMs,
      visemes: durationMs > 0 ? joinVisemes(visemes, durationMs) : [],
      words: durationMs > 0 ? clampWords(words, durationMs) : [],
      provider: CHATTERBOX_INFO,
    };
  }

  return {
    info: CHATTERBOX_INFO,
    // Never offers stock voices; volatile so the capability list does not count it as a
    // provider "with voices" without asking.
    volatileVoices: true,
    listVoices: (): Promise<ProviderVoice[]> => Promise.resolve([]),
    synthesize,
  };
}
