import type { VoiceCloneProvider } from '@parlante/shared';
import { resolveChoice } from '../env';
import type { ProviderEnv } from '../env';
import { notConfigured, notImplemented } from '../errors';

/**
 * Local voice "cloning": estimates pitch/tempo of the sample and returns a VoiceProfile on top
 * of a local eSpeak voice. Honest about being basic. STUB — owner: providers-speech.
 */
export function createLocalVoiceCloneProvider(_env: ProviderEnv): VoiceCloneProvider {
  return {
    info: { id: 'local', name: 'Voice profile (local)', quality: 'basic', local: true },
    createVoice: () => notImplemented('voiceClone', 'local', 'createVoice'),
    deleteVoice: async () => undefined,
  };
}

/** ElevenLabs instant voice cloning. STUB — owner: providers-speech. */
export function createElevenLabsVoiceCloneProvider(env: ProviderEnv): VoiceCloneProvider {
  if (!env.ELEVENLABS_API_KEY) throw notConfigured('elevenlabs', 'ELEVENLABS_API_KEY');
  return {
    info: { id: 'elevenlabs', name: 'ElevenLabs', quality: 'premium', local: false },
    createVoice: () => notImplemented('voiceClone', 'elevenlabs', 'createVoice'),
    deleteVoice: () => notImplemented('voiceClone', 'elevenlabs', 'deleteVoice'),
  };
}

/** Owner: providers-speech. Selected by VOICE_CLONE_PROVIDER. */
export function createVoiceCloneProvider(env: ProviderEnv): VoiceCloneProvider {
  const id = resolveChoice(
    env.VOICE_CLONE_PROVIDER,
    [{ id: 'elevenlabs', available: Boolean(env.ELEVENLABS_API_KEY) }],
    'local',
  );
  return id === 'elevenlabs'
    ? createElevenLabsVoiceCloneProvider(env)
    : createLocalVoiceCloneProvider(env);
}
