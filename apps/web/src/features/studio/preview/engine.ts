import { AUDIO_MIX, duckingGainAt, mediaRefKey, sceneRuntimeFromAudio } from '@parlante/shared';
import type {
  Avatar,
  Composition,
  ProviderRef,
  RenderRuntime,
  Scene,
  SceneRuntime,
  SynthesizedSpeech,
} from '@parlante/shared';
import {
  computeTimeline,
  createPhotoAvatarRig,
  locateScene,
  renderFrame,
} from '@parlante/renderer';
import type { Timeline } from '@parlante/renderer';
import {
  BrowserRenderAssets,
  ensureBrowserFonts,
  ensureCompositionFonts,
  loadBrowserImage,
} from '@parlante/renderer/browser';
import { editInstantMs, previewVariableValues, spokenText } from '../model/timing';
import { SpeechCache, speechKey } from './speech';
import type { SpeechRequest } from './speech';

/* -------------------------------------------------------------------------------------------
 * Live preview of the Studio. It draws with `renderFrame` — the SAME function the export
 * worker runs — on the stage canvas, feeds it the runtime returned by POST /api/tts/synthesize
 * (visemes + words, so lips and subtitles are the real ones) and plays the audio with WebAudio
 * using the mix constants of the export (`AUDIO_MIX`, `duckingGainAt`).
 *
 * Not a React component: one instance per open Studio, driven by `useStudioPreview`.
 * ----------------------------------------------------------------------------------------- */

export interface MediaInfo {
  url: string;
  kind: 'image' | 'video' | 'audio';
  durationMs: number | null;
}
export type MediaResolver = (key: string) => MediaInfo | null;

export type NarrationStatus = 'none' | 'loading' | 'ready' | 'error';
export interface SceneNarration {
  status: NarrationStatus;
  provider: ProviderRef | null;
  error: unknown;
  /** True when playback will be silent for this scene although it has narration. */
  silent: boolean;
}

export interface PreviewState {
  playing: boolean;
  /** Waiting for narration audio before playback starts. */
  preparing: boolean;
  /** Scene under the playhead while playing. */
  playingSceneId: string | null;
  /** Bumped when the timeline, the runtime or loaded media change (thumbnails redraw on it). */
  version: number;
  timeline: Timeline;
  runtime: RenderRuntime;
}

export interface PreviewDeps {
  synthesize: (request: SpeechRequest) => Promise<SynthesizedSpeech>;
  /** Map an API file URL onto the app origin (`toAppUrl`). */
  toUrl: (url: string) => string;
  /** Draw the plan watermark, like the export of this workspace will. */
  watermark?: boolean;
  /** Pause before synthesising after an edit. */
  speechDelayMs?: number;
}

interface AudioNarration {
  status: 'loading' | 'ready' | 'error';
  runtime: SceneRuntime | null;
  buffer: AudioBuffer | null;
  error: unknown;
}

interface Playback {
  fromMs: number;
  untilMs: number;
  /** Clock origin: AudioContext seconds when audio drives the clock, else performance ms. */
  audioClock: boolean;
  origin: number;
  sources: AudioScheduledSourceNode[];
  musicGain: GainNode | null;
  musicVolume: number;
  onEnd: (() => void) | null;
}

/** 2D context of a canvas, or null where canvas is not implemented (tests, old browsers). */
export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

const EMPTY_TIMELINE: Timeline = { fps: 30, totalMs: 0, totalFrames: 0, scenes: [] };
const hasWindow = typeof window !== 'undefined';

export class PreviewEngine {
  readonly assets = new BrowserRenderAssets();
  private readonly speech: SpeechCache;
  private readonly audioNarrations = new Map<string, AudioNarration>();
  private readonly audioBuffers = new Map<string, Promise<AudioBuffer | null>>();
  private readonly decodedMusic = new Map<string, AudioBuffer | null>();
  private readonly avatarLoads = new Set<string>();
  private readonly watchedVideos = new WeakSet<HTMLVideoElement>();
  private readonly stateListeners = new Set<() => void>();
  private readonly timeListeners = new Set<() => void>();

  private composition: Composition | null = null;
  private media: MediaResolver = () => null;
  private avatars = new Map<string, Avatar>();
  private canvas: HTMLCanvasElement | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private state: PreviewState = {
    playing: false,
    preparing: false,
    playingSceneId: null,
    version: 0,
    timeline: EMPTY_TIMELINE,
    runtime: { scenes: {} },
  };
  private tMs = 0;
  /** Scene the paused playhead is parked on (follows the scene when the timeline shifts). */
  private parked: string | null = null;
  private playback: Playback | null = null;
  private playToken = 0;
  private raf = 0;
  private drawQueued = false;
  private speechTimer: ReturnType<typeof setTimeout> | null = null;
  private liveAudio: AudioContext | null = null;
  private decoder: OfflineAudioContext | null = null;
  private disposed = false;
  private mediaVersion = 0;
  private readonly thumbStamps = new WeakMap<
    HTMLCanvasElement,
    { scene: Scene; runtime: SceneRuntime | undefined; media: number; size: string }
  >();
  private readonly unsubscribeSpeech: () => void;

  constructor(private readonly deps: PreviewDeps) {
    this.speech = new SpeechCache({
      synthesize: deps.synthesize,
      decode: (url) => this.decodeUrl(deps.toUrl(url)),
    });
    this.unsubscribeSpeech = this.speech.subscribe(() => this.recompute());
    if (hasWindow && typeof document !== 'undefined' && 'fonts' in document) {
      void ensureBrowserFonts()
        .then(() => this.requestDraw())
        .catch(() => undefined);
    }
  }

  /* ---------- subscriptions ---------- */

  subscribe = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };
  getState = (): PreviewState => this.state;
  subscribeTime = (listener: () => void): (() => void) => {
    this.timeListeners.add(listener);
    return () => this.timeListeners.delete(listener);
  };
  getTime = (): number => this.tMs;

  private patch(patch: Partial<PreviewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.stateListeners]) listener();
  }

  private setTime(tMs: number): void {
    if (tMs === this.tMs) return;
    this.tMs = tMs;
    for (const listener of [...this.timeListeners]) listener();
  }

  /* ---------- inputs ---------- */

  /** The document to preview (already with preview variables applied). */
  setDocument(composition: Composition): void {
    if (this.disposed || composition === this.composition) return;
    const first = this.composition === null;
    this.composition = composition;
    // Edits during playback would desynchronise the scheduled audio: stop.
    if (!first && (this.playback || this.state.preparing)) this.pause();
    this.syncCanvasSize();
    this.recompute();
    this.loadMedia();
    this.scheduleSpeech();
    if (hasWindow && typeof document !== 'undefined' && 'fonts' in document) {
      void ensureCompositionFonts(composition)
        .then((changed) => {
          if (changed) this.bump();
        })
        .catch(() => undefined);
    }
  }

  setResources(media: MediaResolver, avatars: readonly Avatar[]): void {
    this.media = media;
    this.avatars = new Map(avatars.map((avatar) => [avatar.id, avatar]));
    this.loadMedia();
    this.recompute();
  }

  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
    this.ctx2d = null;
    if (canvas) {
      this.ctx2d = context2d(canvas);
      this.syncCanvasSize();
      this.requestDraw();
    }
  }

  /* ---------- narration ---------- */

  private requestOf(scene: Scene): SpeechRequest | null {
    if (scene.script.kind !== 'tts' || !this.composition) return null;
    const text = spokenText(scene.script.text, previewVariableValues(this.composition));
    if (text === '') return null;
    const { voiceId, speed, pitch, language } = scene.script;
    return { text, voiceId, speed, pitch, language };
  }

  private audioKeyOf(scene: Scene): string | null {
    if (scene.script.kind !== 'audio') return null;
    return `${scene.script.assetId}\n${scene.script.language ?? ''}\n${scene.script.transcript}`;
  }

  /** What the UI shows about a scene's narration (provider badge, spinner, error). */
  narrationOf(scene: Scene): SceneNarration {
    const request = this.requestOf(scene);
    if (request) {
      const entry = this.speech.get(speechKey(request));
      if (!entry) return { status: 'loading', provider: null, error: null, silent: false };
      return {
        status: entry.status,
        provider: entry.provider,
        error: entry.error,
        silent: entry.status === 'ready' && entry.buffer === null,
      };
    }
    const audioKey = this.audioKeyOf(scene);
    if (audioKey) {
      const entry = this.audioNarrations.get(audioKey);
      if (!entry) return { status: 'loading', provider: null, error: null, silent: false };
      return {
        status: entry.status,
        provider: null,
        error: entry.error,
        silent: entry.status === 'ready' && entry.buffer === null,
      };
    }
    return { status: 'none', provider: null, error: null, silent: false };
  }

  /** `narrationOf` / `retryNarration` by scene id (scenes of the previewed document). */
  narrationFor(sceneId: string): SceneNarration {
    const scene = this.composition?.scenes.find((s) => s.id === sceneId);
    return scene
      ? this.narrationOf(scene)
      : { status: 'none', provider: null, error: null, silent: false };
  }

  retryNarrationFor(sceneId: string): void {
    const scene = this.composition?.scenes.find((s) => s.id === sceneId);
    if (scene) this.retryNarration(scene);
  }

  /** Synthesise again a scene whose narration failed. */
  retryNarration(scene: Scene): void {
    const request = this.requestOf(scene);
    if (request) void this.speech.ensure(request, { retry: true });
    const audioKey = this.audioKeyOf(scene);
    if (audioKey) {
      this.audioNarrations.delete(audioKey);
      void this.ensureAudioNarration(scene);
    }
  }

  private narrationData(
    scene: Scene,
  ): { runtime: SceneRuntime; buffer: AudioBuffer | null } | null {
    const request = this.requestOf(scene);
    if (request) {
      const entry = this.speech.get(speechKey(request));
      return entry?.status === 'ready' && entry.runtime
        ? { runtime: entry.runtime, buffer: entry.buffer }
        : null;
    }
    const audioKey = this.audioKeyOf(scene);
    const entry = audioKey ? this.audioNarrations.get(audioKey) : undefined;
    return entry?.runtime ? { runtime: entry.runtime, buffer: entry.buffer } : null;
  }

  private ensureNarration(scene: Scene): Promise<unknown> {
    const request = this.requestOf(scene);
    if (request) return this.speech.ensure(request);
    return this.ensureAudioNarration(scene);
  }

  /** Uploaded narration: decode it and build the runtime with the shared estimator. */
  private async ensureAudioNarration(scene: Scene): Promise<void> {
    const key = this.audioKeyOf(scene);
    if (!key || scene.script.kind !== 'audio') return;
    const existing = this.audioNarrations.get(key);
    if (existing) return;
    const info = this.media(`asset:${scene.script.assetId}`);
    if (!info) return; // The asset is not known yet: retried when resources arrive.
    this.audioNarrations.set(key, { status: 'loading', runtime: null, buffer: null, error: null });
    const { transcript, language } = scene.script;
    try {
      const buffer = await this.decodeMedia(`asset:${scene.script.assetId}`, info.url);
      const audioDurationMs = info.durationMs ?? (buffer ? Math.round(buffer.duration * 1000) : 0);
      const runtime = sceneRuntimeFromAudio({
        audioDurationMs,
        transcript,
        language,
        samples: buffer?.getChannelData(0),
        sampleRate: buffer?.sampleRate,
      });
      this.audioNarrations.set(key, { status: 'ready', runtime, buffer, error: null });
    } catch (error) {
      this.audioNarrations.set(key, { status: 'error', runtime: null, buffer: null, error });
    }
    this.recompute();
  }

  private scheduleSpeech(): void {
    if (this.speechTimer !== null) clearTimeout(this.speechTimer);
    this.speechTimer = setTimeout(() => {
      this.speechTimer = null;
      for (const scene of this.composition?.scenes ?? []) void this.ensureNarration(scene);
    }, this.deps.speechDelayMs ?? 700);
  }

  /* ---------- timeline ---------- */

  private recompute(): void {
    const composition = this.composition;
    if (!composition || this.disposed) return;
    const scenes: Record<string, SceneRuntime> = {};
    for (const scene of composition.scenes) {
      const data = this.narrationData(scene);
      if (data) scenes[scene.id] = data.runtime;
    }
    const runtime: RenderRuntime = { scenes };
    const timeline = computeTimeline(composition, runtime, { estimateMissing: true });
    this.patch({ runtime, timeline, version: this.state.version + 1 });
    if (!this.playback) this.settlePlayhead();
    this.requestDraw();
  }

  private bump(): void {
    this.mediaVersion += 1;
    this.patch({ version: this.state.version + 1 });
    this.requestDraw();
  }

  private settlePlayhead(): void {
    const { timeline } = this.state;
    const composition = this.composition;
    if (!composition || timeline.scenes.length === 0) return;
    if (this.parked) {
      const index = composition.scenes.findIndex((scene) => scene.id === this.parked);
      const scene = composition.scenes[index];
      const timing = timeline.scenes[index];
      if (scene && timing) {
        this.setTime(editInstantMs(scene, timing));
        return;
      }
      this.parked = null;
    }
    this.setTime(Math.max(0, Math.min(this.tMs, timeline.totalMs - 1)));
  }

  /** Show a scene as it is edited: after its transition and layer entrances. */
  park(sceneId: string): void {
    if (this.playback || this.state.preparing) this.pause();
    this.parked = sceneId;
    this.settlePlayhead();
    this.requestDraw();
  }

  /** Move the playhead freely (scrubbing). */
  seek(tMs: number): void {
    if (this.playback || this.state.preparing) this.pause();
    this.parked = null;
    this.setTime(Math.max(0, Math.min(tMs, Math.max(0, this.state.timeline.totalMs - 1))));
    this.requestDraw();
  }

  /** True while the paused playhead rests on a scene's editing instant (not scrubbed). */
  isParked(): boolean {
    return this.parked !== null;
  }

  /** Scene under the playhead. */
  sceneAt(tMs: number = this.tMs): string | null {
    const { timeline } = this.state;
    if (timeline.scenes.length === 0) return null;
    return locateScene(timeline, tMs).timing.sceneId;
  }

  /* ---------- media ---------- */

  private loadMedia(): void {
    const composition = this.composition;
    if (!composition || this.disposed) return;
    const resolve = (key: string) => {
      const info = this.media(key);
      return info && info.kind !== 'audio' ? { url: info.url, kind: info.kind } : null;
    };
    void this.assets.loadComposition(composition, resolve).then(() => {
      if (this.disposed) return;
      for (const scene of composition.scenes) {
        const keys = [
          scene.background.type === 'video' ? mediaRefKey(scene.background.src) : null,
          ...scene.layers.map((l) => (l.type === 'video' ? mediaRefKey(l.src) : null)),
        ];
        for (const key of keys) {
          const video = key ? this.assets.videoElement(key) : null;
          if (!video || this.watchedVideos.has(video)) continue;
          this.watchedVideos.add(video);
          // A paused video only shows its new frame once the seek lands.
          video.addEventListener('seeked', () => this.requestDraw());
        }
      }
      this.bump();
    });
    for (const scene of composition.scenes) {
      for (const layer of scene.layers) {
        if (layer.type === 'avatar') this.loadAvatar(layer.avatarId);
      }
      if (
        scene.script.kind === 'audio' &&
        !this.audioNarrations.has(this.audioKeyOf(scene) ?? '')
      ) {
        void this.ensureAudioNarration(scene);
      }
    }
    if (composition.music) {
      const key = mediaRefKey(composition.music.src);
      const info = this.media(key);
      if (info && !this.decodedMusic.has(key)) {
        void this.decodeMedia(key, info.url).then((buffer) => this.decodedMusic.set(key, buffer));
      }
    }
  }

  /** Photorealistic avatars preview with the Canvas stand-in built from their cut-out. */
  private loadAvatar(avatarId: string): void {
    const avatar = this.avatars.get(avatarId);
    if (!avatar || avatar.rendering !== 'photoreal' || !avatar.cutoutUrl || !avatar.rig) return;
    if (this.avatarLoads.has(avatarId)) return;
    this.avatarLoads.add(avatarId);
    const rig = avatar.rig;
    void loadBrowserImage(this.deps.toUrl(avatar.cutoutUrl))
      .then((image) => {
        if (this.disposed) return;
        this.assets.setAvatar(avatarId, createPhotoAvatarRig(avatarId, image, rig));
        this.bump();
      })
      .catch(() => {
        this.avatarLoads.delete(avatarId);
      });
  }

  private decodeMedia(key: string, url: string): Promise<AudioBuffer | null> {
    let job = this.audioBuffers.get(key);
    if (!job) {
      job = this.decodeUrl(this.deps.toUrl(url)).catch(() => null);
      this.audioBuffers.set(key, job);
    }
    return job;
  }

  private async decodeUrl(url: string): Promise<AudioBuffer | null> {
    if (!hasWindow || typeof OfflineAudioContext === 'undefined') return null;
    this.decoder ??= new OfflineAudioContext(2, 1, AUDIO_MIX.sampleRate);
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`Audio request failed (${response.status})`);
    return this.decoder.decodeAudioData(await response.arrayBuffer());
  }

  /* ---------- drawing ---------- */

  private syncCanvasSize(): void {
    const { canvas, composition } = this;
    if (!canvas || !composition) return;
    if (canvas.width !== composition.canvas.width) canvas.width = composition.canvas.width;
    if (canvas.height !== composition.canvas.height) canvas.height = composition.canvas.height;
  }

  requestDraw(): void {
    if (this.drawQueued || this.disposed || !hasWindow) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      if (!this.playback) this.draw();
    });
  }

  private draw(): void {
    const { ctx2d, composition } = this;
    if (!ctx2d || !composition || this.disposed) return;
    const { timeline, runtime } = this.state;
    if (timeline.scenes.length === 0) return;
    this.assets.syncVideos(composition, timeline, this.tMs, { playing: this.playback !== null });
    renderFrame(ctx2d, composition, this.tMs, runtime, this.assets, {
      timeline,
      quality: 'preview',
      watermark: this.deps.watermark === true,
    });
  }

  /**
   * Draw one scene (at its editing instant) into a thumbnail canvas. Skips the work when
   * neither the scene, its narration nor the loaded media changed since the last call.
   */
  drawThumbnail(canvas: HTMLCanvasElement, sceneId: string): void {
    const composition = this.composition;
    const scene = composition?.scenes.find((s) => s.id === sceneId);
    if (!composition || !scene || this.disposed) return;
    const sceneRuntime = this.state.runtime.scenes[scene.id];
    const stamp = this.thumbStamps.get(canvas);
    const size = `${canvas.width}x${canvas.height}:${composition.subtitles.fontFamily}`;
    if (
      stamp &&
      stamp.scene === scene &&
      stamp.runtime === sceneRuntime &&
      stamp.media === this.mediaVersion &&
      stamp.size === size
    ) {
      return;
    }
    const ctx = context2d(canvas);
    if (!ctx) return;
    const single: Composition = {
      ...composition,
      scenes: [{ ...scene, transition: { ...scene.transition, type: 'none' } }],
    };
    const runtime: RenderRuntime = { scenes: sceneRuntime ? { [scene.id]: sceneRuntime } : {} };
    const timeline = computeTimeline(single, runtime, { estimateMissing: true });
    const timing = timeline.scenes[0];
    if (!timing) return;
    renderFrame(ctx, single, editInstantMs(scene, timing), runtime, this.assets, {
      width: canvas.width,
      height: canvas.height,
      timeline,
      subtitles: false,
      quality: 'preview',
    });
    this.thumbStamps.set(canvas, { scene, runtime: sceneRuntime, media: this.mediaVersion, size });
  }

  /* ---------- playback ---------- */

  /**
   * Play [fromMs, untilMs) of the video. Narration that is not synthesised yet is requested
   * first (`preparing`). `onEnd` runs when the range finishes by itself.
   */
  async play(fromMs: number, untilMs: number, onEnd?: () => void): Promise<void> {
    const composition = this.composition;
    if (!composition || this.disposed) return;
    this.pause();
    const token = ++this.playToken;
    this.parked = null;
    // Create / resume the audio context inside the user gesture that asked to play.
    const audio = this.audioContext();
    if (audio && audio.state === 'suspended') void audio.resume().catch(() => undefined);

    this.patch({ preparing: true });
    const before = this.state.timeline;
    const startScene = before.scenes.find((s) => fromMs < s.endMs)?.sceneId ?? null;
    const offsetInScene =
      fromMs - (before.scenes.find((s) => s.sceneId === startScene)?.startMs ?? 0);
    const wholeTail = untilMs >= before.totalMs;
    const endScene = [...before.scenes].reverse().find((s) => s.startMs < untilMs)?.sceneId ?? null;
    await Promise.all(composition.scenes.map((scene) => this.ensureNarration(scene)));
    if (composition.music) {
      const key = mediaRefKey(composition.music.src);
      const info = this.media(key);
      if (info) this.decodedMusic.set(key, await this.decodeMedia(key, info.url));
    }
    if (token !== this.playToken || this.disposed || this.composition !== composition) return;

    // Real audio lengths may have moved the scenes: keep the same scene-relative range.
    const { timeline } = this.state;
    const startTiming = timeline.scenes.find((s) => s.sceneId === startScene);
    const endTiming = timeline.scenes.find((s) => s.sceneId === endScene);
    const from = startTiming ? Math.min(startTiming.startMs + offsetInScene, timeline.totalMs) : 0;
    const until = wholeTail || !endTiming ? timeline.totalMs : endTiming.endMs;
    if (until - from < 1) {
      this.patch({ preparing: false });
      return;
    }

    const audioClock = audio !== null && audio.state === 'running';
    const playback: Playback = {
      fromMs: from,
      untilMs: until,
      audioClock,
      origin: audioClock && audio ? audio.currentTime + 0.06 : performance.now(),
      sources: [],
      musicGain: null,
      musicVolume: composition.music?.volume ?? 0,
      onEnd: onEnd ?? null,
    };
    if (audioClock && audio) this.scheduleAudio(audio, composition, timeline, playback);
    this.playback = playback;
    this.setTime(from);
    this.patch({ preparing: false, playing: true, playingSceneId: this.sceneAt(from) });
    this.raf = requestAnimationFrame(this.tick);
  }

  private audioContext(): AudioContext | null {
    if (!hasWindow || typeof AudioContext === 'undefined') return null;
    try {
      this.liveAudio ??= new AudioContext();
      return this.liveAudio;
    } catch {
      return null;
    }
  }

  private scheduleAudio(
    audio: AudioContext,
    composition: Composition,
    timeline: Timeline,
    playback: Playback,
  ): void {
    const at = (videoMs: number) => playback.origin + (videoMs - playback.fromMs) / 1000;
    const windows: { startMs: number; endMs: number }[] = [];
    for (const timing of timeline.scenes) {
      const scene = composition.scenes[timing.index];
      if (!scene || timing.speechDurationMs <= 0) continue;
      const speechEnd = timing.speechStartMs + timing.speechDurationMs;
      windows.push({ startMs: timing.speechStartMs, endMs: speechEnd });
      const buffer = this.narrationData(scene)?.buffer;
      if (!buffer) continue;
      const start = Math.max(timing.speechStartMs, playback.fromMs);
      const end = Math.min(speechEnd, playback.untilMs);
      if (end <= start) continue;
      const source = audio.createBufferSource();
      source.buffer = buffer;
      const gain = audio.createGain();
      // A fixed-length scene cuts its narration with the same short fade as the export.
      if (speechEnd < timing.speechStartMs + buffer.duration * 1000 - 1 && end === speechEnd) {
        const fadeStart = Math.max(start, speechEnd - AUDIO_MIX.narrationCutFadeMs);
        gain.gain.setValueAtTime(1, at(fadeStart));
        gain.gain.linearRampToValueAtTime(0, at(speechEnd));
      }
      source.connect(gain).connect(audio.destination);
      source.start(at(start), (start - timing.speechStartMs) / 1000, (end - start) / 1000);
      playback.sources.push(source);
    }
    const music = composition.music;
    const musicBuffer = music ? this.decodedMusic.get(mediaRefKey(music.src)) : null;
    if (music && musicBuffer) {
      const source = audio.createBufferSource();
      source.buffer = musicBuffer;
      source.loop = music.loop;
      const gain = audio.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(audio.destination);
      const offsetSec = playback.fromMs / 1000;
      const offset = music.loop ? offsetSec % musicBuffer.duration : offsetSec;
      if (music.loop || offset < musicBuffer.duration) {
        source.start(playback.origin, offset);
        playback.sources.push(source);
        playback.musicGain = gain;
      }
    }
    this.duckingWindows = windows;
  }

  private duckingWindows: { startMs: number; endMs: number }[] = [];

  /** Music gain at video time `tMs`: track volume × fades × ducking (same model as the export). */
  private musicGainAt(tMs: number): number {
    const music = this.composition?.music;
    if (!music) return 0;
    const total = this.state.timeline.totalMs;
    const fadeIn = music.fadeInMs > 0 ? Math.min(1, tMs / music.fadeInMs) : 1;
    const fadeOut = music.fadeOutMs > 0 ? Math.min(1, (total - tMs) / music.fadeOutMs) : 1;
    const duck = music.ducking ? duckingGainAt(this.duckingWindows, tMs) : 1;
    return music.volume * Math.max(0, fadeIn) * Math.max(0, fadeOut) * duck;
  }

  private tick = (): void => {
    const playback = this.playback;
    if (!playback || this.disposed) return;
    const elapsed =
      playback.audioClock && this.liveAudio
        ? (this.liveAudio.currentTime - playback.origin) * 1000
        : performance.now() - playback.origin;
    const tMs = playback.fromMs + Math.max(0, elapsed);
    if (tMs >= playback.untilMs) {
      const onEnd = playback.onEnd;
      this.pause();
      onEnd?.();
      return;
    }
    this.setTime(tMs);
    if (playback.musicGain) playback.musicGain.gain.value = this.musicGainAt(tMs);
    const sceneId = this.sceneAt(tMs);
    if (sceneId !== this.state.playingSceneId) this.patch({ playingSceneId: sceneId });
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Stop playback (or the wait for audio) leaving the playhead where it is. */
  pause(): void {
    this.playToken += 1;
    const playback = this.playback;
    this.playback = null;
    if (hasWindow) cancelAnimationFrame(this.raf);
    if (playback) {
      for (const source of playback.sources) {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      }
    }
    if (this.state.playing || this.state.preparing) {
      this.patch({ playing: false, preparing: false, playingSceneId: null });
    }
    this.requestDraw();
  }

  dispose(): void {
    this.pause();
    this.disposed = true;
    this.unsubscribeSpeech();
    if (this.speechTimer !== null) clearTimeout(this.speechTimer);
    this.assets.dispose();
    void this.liveAudio?.close().catch(() => undefined);
    this.stateListeners.clear();
    this.timeListeners.clear();
  }
}
