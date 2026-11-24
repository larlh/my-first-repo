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
// Local neural voices: Kokoro and Piper on the CPU (owner: voice-neural).
export {
  DEFAULT_KOKORO_VARIANT,
  KOKORO_INFO,
  KOKORO_SOURCE,
  KOKORO_VARIANTS,
  KOKORO_VARIANT_IDS,
  KOKORO_VOICES,
  NEURAL_PITCH_RANGE,
  NEURAL_VOICES,
  PIPER_INFO,
  PIPER_SOURCE,
  PIPER_VOICES,
  VoiceIntegrityError,
  createKokoroProvider,
  createPiperProvider,
  decodeWav,
  disposeNeuralEngines,
  encodeWav,
  findKokoroVoice,
  findPiperVoice,
  hasInstalledNeuralVoice,
  inspectNeuralVoice,
  installVoiceFiles,
  removeVoiceFiles,
  resolveVoiceModelDir,
  voiceInstallCommand,
} from './tts/index';
export type {
  KokoroVariant,
  KokoroVoiceDef,
  NeuralVoiceDef,
  NeuralVoiceDeps,
  NeuralVoiceEnv,
  PiperVoiceDef,
} from './tts/index';
