import type { DictationProvider, STTProvider } from '@parlante/shared';
import { resolveChoice } from '../env';
import type { ProviderEnv } from '../env';
import {
  createLocalWhisperDictation,
  createLocalWhisperStt,
  isLocalWhisperInstalled,
} from './local-whisper';
import { createManualSttProvider } from './manual';
import { createOpenAiSttProvider } from './openai';

export { planAudioChunks } from './chunking';
export {
  LOCAL_WHISPER_ID,
  LOCAL_WHISPER_LANGUAGES,
  WHISPER_SAMPLE_RATE,
  cleanTranscript,
  collapseRepetitions,
  createLocalWhisperDictation,
  createLocalWhisperStt,
  hasSpeechEnergy,
  isLocalWhisperInstalled,
  pcm16ToFloat32,
} from './local-whisper';
export type { LocalWhisperDeps, WhisperRunner } from './local-whisper';
export { createManualSttProvider, detectTranscriptFormat, parseUserTranscript } from './manual';
export type { ParsedTranscript, UserTranscriptInput } from './manual';
export { createOpenAiSttProvider } from './openai';
export { WhisperEngine, WhisperEngineError, disposeWhisperEngines } from './whisper-engine';
export type { WhisperChunk, WhisperJob, WhisperOutput } from './whisper-engine';
export {
  DEFAULT_WHISPER_MODEL,
  WHISPER_MODELS,
  WHISPER_MODEL_IDS,
  inspectWhisperInstall,
  resolveDictationModelDir,
  whisperModel,
  whisperModelBytes,
  whisperModelFolder,
} from './whisper-models';
export type { WhisperInstallState, WhisperModelDef, WhisperModelId } from './whisper-models';
export { ModelIntegrityError, installWhisperModel } from './whisper-setup';
export type { InstallProgress, InstallResult } from './whisper-setup';

/**
 * Owner: providers-speech. Selected by STT_PROVIDER. `auto` → openai when keyed, else the
 * local Whisper model when it is installed (`pnpm dictation:setup`), else manual.
 */
export function createSttProvider(env: ProviderEnv): STTProvider {
  const id = resolveChoice(
    env.STT_PROVIDER,
    [
      { id: 'openai', available: Boolean(env.OPENAI_API_KEY) },
      { id: 'local-whisper', available: isLocalWhisperInstalled(env) },
    ],
    'manual',
  );
  if (id === 'openai') return createOpenAiSttProvider(env);
  if (id === 'local-whisper') return createLocalWhisperStt(env);
  return createManualSttProvider();
}

/**
 * Dictation is ALWAYS the local model, whatever STT_PROVIDER says and whatever keys are set:
 * the `local` dictation engine promises that the audio stays on this machine. Without the
 * model installed the provider exists and reports itself unavailable.
 */
export function createDictationProvider(env: ProviderEnv): DictationProvider {
  return createLocalWhisperDictation(env);
}
