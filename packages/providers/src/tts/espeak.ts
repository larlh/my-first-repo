import type { ProviderRef, TTSProvider } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { notImplemented } from '../errors';

export const ESPEAK_INFO: ProviderRef = {
  id: 'espeak',
  name: 'eSpeak NG (local)',
  quality: 'basic',
  local: true,
};

/**
 * Local TTS: eSpeak NG compiled to WASM (`@echogarden/espeak-ng-emscripten`, already installed
 * and verified to load in Node 22). STUB — owner: providers-speech.
 *
 * Must: list voices in ≥ 8 languages, honour speed/pitch/profile, return WAV PCM16 mono plus
 * viseme (phoneme events → `phonemeToViseme`) and word timelines.
 */
export function createEspeakProvider(_env: ProviderEnv): TTSProvider {
  return {
    info: ESPEAK_INFO,
    listVoices: () => notImplemented('tts', 'espeak', 'listVoices'),
    synthesize: () => notImplemented('tts', 'espeak', 'synthesize'),
  };
}
