import type {
  EngineModelInfo,
  EngineOperations,
  GeneratedScript,
  PhotoLandmarks,
  ProviderRef,
  ScriptTone,
  VoiceProfile,
} from './entities';
import type { Gender } from './entities';
import type { LanguageCode } from './languages';
import type { VisemeCue, WordCue } from './runtime';
import type { TimedText } from './subtitles';

/* -------------------------------------------------------------------------------------------
 * Provider interfaces. Every AI capability has (a) a LOCAL implementation that works offline
 * with no keys and (b) optional external adapters selected by environment variables.
 * Implementations live in packages/providers; these types are isomorphic (no Node imports).
 *
 * Rules for implementers
 *  - `info` must be truthful: `quality: 'basic'` for local heuristics. Results are stamped with
 *    `info` so UI and API can always tell which provider produced them (honesty rule).
 *  - Throw `AppError('PROVIDER_ERROR', …)` for upstream failures and
 *    `AppError('PROVIDER_NOT_CONFIGURED', …)` when a required key is missing.
 *  - Never log secrets or full user content.
 * ----------------------------------------------------------------------------------------- */

export interface BaseProvider {
  readonly info: ProviderRef;
}

/* ---------- TTS ---------- */

export interface ProviderVoice {
  /** Provider-specific id (the part after `<provider>:` in a stock voice id). */
  providerVoiceId: string;
  name: string;
  /** Primary locale: `es`, `es-MX`, `en-US`… */
  language: string;
  /**
   * Set (to every supported locale) by providers whose voices speak ALL their languages
   * (OpenAI TTS, ElevenLabs multilingual models). The API then exposes the voice ONCE with
   * `multilingual: true` — never duplicate a voice per language with invented ids.
   */
  languages?: string[];
  gender: Gender;
  description: string;
  tags: string[];
}

export interface TTSRequest {
  text: string;
  /** Provider-specific voice id. */
  providerVoiceId: string;
  /** Locale of the text. */
  language: string;
  /** Rate multiplier 0.5..2 (1 = normal). */
  speed: number;
  /** Pitch shift in semitones -12..12 (0 = normal). */
  pitch: number;
  /** Local cloned voices: profile applied on top of speed/pitch. */
  profile?: VoiceProfile | null;
}

export interface TTSResult {
  /** RIFF/WAVE, PCM 16-bit, mono. Any sample rate (the worker resamples to 48 kHz). */
  audio: Uint8Array;
  format: 'wav';
  sampleRate: number;
  durationMs: number;
  /** Viseme timeline relative to the start of `audio`, sorted, starting and ending in `rest`. */
  visemes: VisemeCue[];
  /** Word timeline relative to the start of `audio`, sorted. */
  words: WordCue[];
  provider: ProviderRef;
}

export interface TTSProvider extends BaseProvider {
  listVoices(): Promise<ProviderVoice[]>;
  /**
   * Synthesize speech. Providers without native phoneme timing MUST still return visemes and
   * words so lip-sync and subtitles always work: they call `estimateSpeechTimeline(text,
   * durationMs, language)` from @parlante/shared (THE shared estimator — do not write another;
   * adapters with word-level timestamps keep their real `words` and only take `visemes`).
   * Empty/whitespace text ⇒ `durationMs: 0`, empty timelines and a valid empty WAV.
   */
  synthesize(request: TTSRequest): Promise<TTSResult>;
}

/* ---------- STT ---------- */

export interface STTRequest {
  /**
   * WAV PCM 16-bit mono 16 kHz (the worker converts with ffmpeg before calling). About
   * 115 MB per hour: adapters whose upstream limits the upload size (Whisper API: 25 MB) MUST
   * split the audio into chunks at silences, transcribe each and re-offset the segments —
   * callers never chunk. The source length is bounded by `PlanLimits.maxTranslationSourceSec`.
   */
  audio: Uint8Array;
  /** The same audio as a local file, when the caller has one (lets adapters stream/slice it). */
  audioPath?: string;
  /** Hint; providers may auto-detect when omitted. */
  language?: LanguageCode;
}

export interface STTResult {
  segments: TimedText[];
  language: LanguageCode | null;
  provider: ProviderRef;
}

export interface STTProvider extends BaseProvider {
  /**
   * True for the local provider: it cannot transcribe, the user must supply the transcript
   * (SRT / VTT / plain text) and `transcribe` throws `TRANSCRIPT_REQUIRED`.
   */
  readonly requiresUserTranscript: boolean;
  transcribe(request: STTRequest): Promise<STTResult>;
}

/* ---------- LLM (task-level: each task has a deterministic local fallback) ---------- */

export interface ScriptGenerationRequest {
  /** Topic typed by the user, or the readable text extracted from a URL. */
  topic: string;
  /** Extra source material (page text) when generating from a URL. */
  sourceText?: string;
  sourceTitle?: string;
  tone: ScriptTone;
  /** Target total duration in seconds. */
  durationSec: number;
  language: LanguageCode;
  /** Preferred number of scenes (the provider may adjust ±1). */
  sceneCount?: number;
  audience?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatRequest {
  /** Persona name, instructions and knowledge of the interactive avatar. */
  persona: { name: string; instructions: string; knowledge: string };
  language: LanguageCode;
  /** Conversation so far, oldest first; the last message is the user's turn. */
  messages: ChatMessage[];
  /** Replies are spoken: keep them short. */
  maxSentences?: number;
}

export interface ChatReply {
  text: string;
  provider: ProviderRef;
}

export interface LLMProvider extends BaseProvider {
  /** `basicMode` must be true for the local heuristic implementation. */
  generateScript(request: ScriptGenerationRequest): Promise<GeneratedScript>;
  chat(request: ChatRequest): Promise<ChatReply>;
}

/* ---------- translation ---------- */

export interface TranslationRequest {
  /** Texts to translate, order preserved (segments of a transcript or UI strings). */
  texts: string[];
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  /** Optional context to improve consistency (e.g. the video title). */
  context?: string;
}

export interface TranslationResult {
  /** Same length and order as the request. */
  texts: string[];
  provider: ProviderRef;
}

export interface TranslationProvider extends BaseProvider {
  translate(request: TranslationRequest): Promise<TranslationResult>;
}

/* ---------- photorealistic avatars: animation (lip-sync) and portraits ---------- */

/**
 * Availability of a neural provider. The local engine may be stopped or missing its weights;
 * callers check this BEFORE accepting work and report `reason` to the user verbatim.
 */
export interface EngineStatus {
  /** True when the operations THIS provider offers are usable right now. */
  available: boolean;
  reason: string | null;
  device: 'cpu' | 'gpu' | null;
  /** Measured seconds of computation per second of animated video, or null if unknown. */
  secondsPerVideoSecond: number | null;
  /**
   * Per-operation availability from the engine's `GET /health` (`capabilities`). The
   * `local-neural` providers always fill it; when absent, `available` applies to everything
   * the provider does (lip-sync: animate; portrait: generate + prepare).
   */
  operations?: EngineOperations;
  /** Models of the engine with licence and download state (`GET /health` → `models`). */
  models?: EngineModelInfo[];
  /** True when any downloaded model forbids commercial use (the UI shows a visible notice). */
  nonCommercial?: boolean;
  /** Measured seconds to generate one portrait, or null if unknown. */
  secondsPerPortrait?: number | null;
}

export interface EngineProgress {
  /** 0..1 */
  fraction: number;
  /** Estimated seconds remaining, when known. */
  etaSec?: number;
}

/*
 * FILE PATHS in the three request types below: ANY local path readable (inputs) / writable
 * (`outputDir`) by the Node process — the worker's temp dir, the local storage dir, a file of
 * packages/stock-assets. Callers do NOT need to know about AVATAR_ENGINE_WORK_DIR: the
 * `local-neural` provider copies inputs into a private sub-directory of the engine work dir,
 * runs the engine there, copies the results into `request.outputDir` and deletes the
 * sub-directory (helper `createEngineJobDir` in packages/providers). Result paths are always
 * inside `request.outputDir`. Callers own `outputDir` (create it before, remove it after).
 * When `signal` aborts, the provider cancels the engine job (DELETE /v1/jobs/:id) and throws.
 */

export interface LipSyncRequest {
  /** Prepared portrait (PNG) of the avatar: local file path readable by the provider. */
  portraitPath: string;
  /** Alpha matte of the portrait (PNG, same size), or null when the portrait has none. */
  maskPath: string | null;
  /** Narration (WAV PCM 16-bit mono): local file path. */
  audioPath: string;
  /** Viseme timeline of the narration (optional hint; engines may work from audio alone). */
  visemes?: VisemeCue[];
  /** Frames per second of the clip (30). */
  fps: number;
  /** Largest side of the output frames in pixels (the engine may clamp it). */
  maxSize: number;
  /** Directory (server-generated) where the provider writes its output files. */
  outputDir: string;
  /**
   * Stable reference of this piece of work, e.g. `${renderJobId}:${sceneId}:${layerId}`: lets
   * the engine hand back a still-running job after a worker restart instead of starting an
   * identical one.
   */
  clientRef?: string;
  onProgress?: (progress: EngineProgress) => void;
  signal?: AbortSignal;
}

export interface LipSyncResult {
  /**
   * Clip of the talking avatar, exactly as long as the audio: local file path. Its frames
   * have THE SAME FRAMING AND ASPECT RATIO as `portraitPath` (possibly scaled down to
   * `maxSize`), so the renderer places them with `photoAvatarPlacement` and the avatar's
   * landmarks exactly like the Canvas stand-in.
   */
  videoPath: string;
  /**
   * Matte for compositing over any background:
   *  - `none`:        opaque clip (drawn as a rectangle)
   *  - `mask-video`:  `maskPath` is a second, greyscale clip (white = avatar), same size/frames
   *  - `mask-image`:  `maskPath` is ONE greyscale PNG valid for every frame (static framing)
   */
  alpha: 'none' | 'mask-video' | 'mask-image';
  maskPath: string | null;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  provider: ProviderRef;
}

/**
 * Animates a photorealistic portrait: portrait + audio → clip with synchronised lips, blinking
 * and natural head motion. Implementations: `local-neural` (services/avatar-engine, open-source
 * models, no paid service — the default) and `external` (optional HTTP endpoint).
 * NOT used for "instant" 2D avatars, which the Canvas rigs of packages/renderer animate.
 */
export interface LipSyncProvider extends BaseProvider {
  status(): Promise<EngineStatus>;
  animate(request: LipSyncRequest): Promise<LipSyncResult>;
}

export interface PortraitGenerationRequest {
  /** Description of the synthetic person (already moderated). */
  prompt: string;
  /** Same prompt + seed ⇒ same portrait. */
  seed: number;
  gender?: Gender;
  outputDir: string;
  clientRef?: string;
  onProgress?: (progress: EngineProgress) => void;
  signal?: AbortSignal;
}

export interface PortraitPreparationRequest {
  /** Source image (uploaded photo or generated portrait): local file path. */
  imagePath: string;
  /** Landmarks marked by the user ON `imagePath`; skips face detection when given. */
  landmarks?: PhotoLandmarks;
  outputDir: string;
  clientRef?: string;
  onProgress?: (progress: EngineProgress) => void;
  signal?: AbortSignal;
}

export interface PreparedPortrait {
  /** Cropped, upright, normalised portrait (PNG): local file path. */
  portraitPath: string;
  /** Alpha matte separating the person from the background (PNG), or null if unavailable. */
  maskPath: string | null;
  width: number;
  height: number;
  /** Landmarks on the PREPARED portrait (normalised 0..1). */
  landmarks: PhotoLandmarks;
  landmarksSource: 'detected' | 'user' | 'estimated';
  provider: ProviderRef;
}

/**
 * Creates and prepares photorealistic portraits with the local engine:
 *  - `generate`: text → portrait of a SYNTHETIC person (then call `prepare` on the result)
 *  - `prepare`:  face detection, crop and background matte. Throws AppError('UNPROCESSABLE')
 *                when no single, clearly visible face is found.
 */
export interface PortraitProvider extends BaseProvider {
  status(): Promise<EngineStatus>;
  generate(request: PortraitGenerationRequest): Promise<{
    imagePath: string;
    provider: ProviderRef;
    /** Model that drew it → stored in `avatars.model` / `Avatar.model`. */
    model?: string;
    /**
     * Seed of the portrait actually kept (engines may retry with derived seeds when their
     * quality checks fail) → stored in `avatars.seed` / `Avatar.seed`. Absent = `request.seed`.
     */
    seed?: number;
  }>;
  prepare(request: PortraitPreparationRequest): Promise<PreparedPortrait>;
}

/* ---------- voice cloning ---------- */

export interface VoiceCloneRequest {
  name: string;
  /** WAV PCM 16-bit mono sample of the voice (the worker converts with ffmpeg). */
  sample: Uint8Array;
  sampleRate: number;
  language: LanguageCode;
  gender?: Gender;
  /** ConsentRecord id authorising the clone (providers may forward it for audit). */
  consentId: string;
}

export interface VoiceCloneResult {
  /** TTS provider that must be used to speak with the cloned voice. */
  ttsProviderId: string;
  /** Voice id inside that provider (external) or the local base voice id. */
  providerVoiceId: string;
  /** Local cloning only: parameters estimated from the sample. */
  profile: VoiceProfile | null;
  provider: ProviderRef;
}

export interface VoiceCloneProvider extends BaseProvider {
  createVoice(request: VoiceCloneRequest): Promise<VoiceCloneResult>;
  /** Remove the voice from the external service (no-op locally). */
  deleteVoice(providerVoiceId: string): Promise<void>;
}

/* ---------- moderation ---------- */

/**
 * What kind of text is being checked, so providers can apply context-specific rules:
 *  - script:        narration, on-screen text and transcripts of a video (before rendering)
 *  - chat:          a user turn of the interactive avatar
 *  - name:          names of avatars / voices / resources
 *  - translation:   transcript of a video to translate
 *  - avatar_prompt: description of a synthetic person to generate. On top of the general
 *                   rules, prompts that name or describe REAL, identifiable people
 *                   (celebrities, politicians, "looks like <person>") or minors are blocked.
 */
export type ModerationContext = 'script' | 'chat' | 'name' | 'translation' | 'avatar_prompt';

export interface ModerationRequest {
  text: string;
  language?: string;
  context: ModerationContext;
}

export interface ModerationFlag {
  category: string;
  /** Short, user-presentable reason. Never echoes the offending text in full. */
  reason: string;
}

export interface ModerationResult {
  allowed: boolean;
  flags: ModerationFlag[];
  provider: ProviderRef;
}

export interface ModerationProvider extends BaseProvider {
  check(request: ModerationRequest): Promise<ModerationResult>;
}

/* ---------- storage ---------- */

export interface StoragePutOptions {
  contentType: string;
}

export interface StorageObjectInfo {
  key: string;
  size: number;
  contentType: string | null;
  lastModified: Date | null;
}

export interface StorageRange {
  /** Inclusive byte offsets. */
  start: number;
  end: number;
}

/** Bytes, a local file path to copy/upload from, or a stream of chunks. */
export type StorageBody = Uint8Array | { filePath: string } | AsyncIterable<Uint8Array>;

export interface StorageProvider extends BaseProvider {
  /**
   * Keys are server-generated, `/`-separated, never derived from raw user input
   * (see `storageKeys` in @parlante/shared/node). Implementations must reject keys with `..`,
   * leading `/` or backslashes.
   */
  put(key: string, body: StorageBody, options: StoragePutOptions): Promise<StorageObjectInfo>;
  get(key: string): Promise<Uint8Array>;
  /** Stream an object (optionally a byte range, for HTTP Range requests). */
  getStream(key: string, range?: StorageRange): Promise<AsyncIterable<Uint8Array>>;
  stat(key: string): Promise<StorageObjectInfo | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Delete every object under a prefix (e.g. all files of a video). */
  deletePrefix(prefix: string): Promise<void>;
  /** Copy an object to a local file (used by the worker before ffmpeg). */
  downloadTo(key: string, filePath: string): Promise<void>;
  /**
   * Local storage: absolute path of the object for zero-copy reads (ffmpeg input), or null.
   * Remote storage always returns null — callers must fall back to `downloadTo`.
   */
  localPath(key: string): string | null;
  /**
   * Remote storage: a time-limited URL that serves the object directly, or null when the
   * provider cannot sign URLs (local disk) — the API then serves the file itself through its
   * own signed `/api/files/*` route.
   */
  signedUrl(
    key: string,
    options: { expiresInSec: number; downloadName?: string },
  ): Promise<string | null>;
}

/* ---------- registry shape ---------- */

/** What `createProviders(env)` in packages/providers returns. */
export interface Providers {
  tts: {
    /** Provider used when a request does not name one (new voices, previews). */
    readonly default: TTSProvider;
    /** Resolve the provider of a stock voice id prefix (`espeak`, `elevenlabs`…). */
    get(providerId: string): TTSProvider | null;
    all(): TTSProvider[];
  };
  stt: STTProvider;
  llm: LLMProvider;
  translation: TranslationProvider;
  voiceClone: VoiceCloneProvider;
  /** Animation of photorealistic avatars (neural). Instant 2D avatars never go through it. */
  lipsync: LipSyncProvider;
  /** Generation and preparation of photorealistic portraits. */
  portrait: PortraitProvider;
  moderation: ModerationProvider;
  storage: StorageProvider;
}
