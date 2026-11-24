export * from './env';
export * from './errors';
export * from './engine';
export * from './registry';
export { LocalStorageProvider } from './storage/index';
// Speech helpers consumers need besides the provider objects (owner: providers-speech).
export { detectTranscriptFormat, parseUserTranscript } from './stt/index';
export type { ParsedTranscript, UserTranscriptInput } from './stt/index';
// Local speech recognition: dictation by microphone and keyless STT (owner: dictation-backend).
export {
  DEFAULT_WHISPER_MODEL,
  LOCAL_WHISPER_ID,
  WHISPER_MODELS,
  WHISPER_MODEL_IDS,
  WHISPER_SAMPLE_RATE,
  createLocalWhisperDictation,
  createLocalWhisperStt,
  disposeWhisperEngines,
  inspectWhisperInstall,
  installWhisperModel,
  isLocalWhisperInstalled,
  resolveDictationModelDir,
  whisperModel,
  whisperModelBytes,
  whisperModelFolder,
} from './stt/index';
export type {
  InstallProgress,
  InstallResult,
  LocalWhisperDeps,
  WhisperInstallState,
  WhisperModelDef,
  WhisperModelId,
  WhisperRunner,
} from './stt/index';
