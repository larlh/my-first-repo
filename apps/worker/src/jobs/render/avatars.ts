import fs from 'node:fs/promises';
import {
  AppError,
  AvatarClipCacheMetaSchema,
  avatarRenderingOf,
  isStockPhotorealAvatarId,
} from '@parlante/shared';
import type {
  AvatarClipCacheMeta,
  Composition,
  EngineStatus,
  Layer,
  PhotoAvatarRig,
  ProviderRef,
  RenderRuntime,
  VisemeCue,
  WordCue,
} from '@parlante/shared';
import { avatarClipCacheKey, sha256Hex, storageKeys } from '@parlante/shared/node';
import { and, avatars as avatarsTable, eq } from '@parlante/db';
import { createPhotoAvatarRig, photoAvatarPlacement } from '@parlante/renderer';
import type { MapRenderAssets, RenderImage, Timeline } from '@parlante/renderer';
import { cutoutPng, loadNodeImage, openAvatarClipSource } from '@parlante/renderer/node';
import type { PreparableVideoSource } from '@parlante/renderer/node';
import { getStockPhotorealAvatar } from '@parlante/stock-assets';
import {
  getStockPhotorealAvatarFile,
  stockPhotorealAvatarFiles,
} from '@parlante/stock-assets/node';
import { closeSources } from './media';
import type { SceneNarration } from './narration';
import type { RenderRun } from './run';
import { sceneAudioWav } from './wav';

/* -------------------------------------------------------------------------------------------
 * Stage `avatars`: one neural clip per photorealistic avatar layer per scene (ARCHITECTURE
 * §3.3). The clip covers the WHOLE scene (narration padded with silence, `originMs: 0`), is
 * looked up in the clip cache by content hash before the engine is asked for it, and is
 * registered together with the Canvas stand-in so an exported MP4 never shows a placeholder.
 * Animation is slow on CPU (about a second per frame): progress and the MEASURED time
 * remaining are persisted on the row all along.
 * ----------------------------------------------------------------------------------------- */

type AvatarLayer = Extract<Layer, { type: 'avatar' }>;

/** A photorealistic avatar resolved to files on disk. */
interface PhotorealAvatar {
  id: string;
  portraitPath: string;
  maskPath: string | null;
  portraitSha: string;
  maskSha: string | null;
  rig: PhotoAvatarRig;
  /** Workspace avatars keep their clips under their own prefix; stock ones share a cache. */
  owner: { workspaceId: string; avatarId: string } | null;
}

/** One clip to obtain: every layer that shows exactly the same avatar speaking the same audio. */
interface ClipJob {
  hash: string;
  avatar: PhotorealAvatar;
  audioPath: string;
  visemes: VisemeCue[];
  words: WordCue[];
  maxSize: number;
  frames: number;
  clientRef: string;
  targets: { sceneId: string; sceneIndex: number; layerId: string }[];
}

interface ClipFiles {
  videoPath: string;
  mattePath: string | null;
  meta: AvatarClipCacheMeta;
}

export interface AvatarClips {
  /** Lip-sync provider that produced (or had produced) the clips; null when there are none. */
  provider: ProviderRef | null;
  /** Clips reused from the cache / animated now (for logs and tests). */
  cached: number;
  animated: number;
  /** Close the decoders of every scene before `sceneIndex` (they are never drawn again). */
  releaseBefore(sceneIndex: number): Promise<void>;
  close(): Promise<void>;
}

const NO_CLIPS: AvatarClips = {
  provider: null,
  cached: 0,
  animated: 0,
  releaseBefore: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

/** Driver asked from the lip-sync provider: the best it has (audio-driven lips when it can). */
export const RENDER_LIPSYNC_DRIVER = 'auto' as const;

/**
 * What identifies HOW a clip is animated, for the clip cache key: the animation model, the
 * requested driver and the engine's own `animationKey` (which driver `auto` resolves to, its
 * tuning). Engines that do not report a key keep the model id alone, so their existing cache
 * entries stay valid.
 */
export function clipModelKey(
  status: Pick<EngineStatus, 'models' | 'animationKey'> | null,
): string | null {
  const model = status?.models?.find((m) => m.role === 'animation' && m.downloaded)?.id ?? null;
  const key = status?.animationKey ?? null;
  if (key === null) return model;
  return `${model ?? ''}|${RENDER_LIPSYNC_DRIVER}|${key}`;
}

/** Largest side asked from the engine: two buckets, so 720p and 1080p renders share clips. */
function clipSizeFor(neededPx: number): number {
  return neededPx <= 512 ? 512 : 1024;
}

async function fileSha(file: string): Promise<string> {
  return sha256Hex(await fs.readFile(file));
}

async function resolveAvatar(
  run: RenderRun,
  avatarId: string,
  assets: MapRenderAssets,
): Promise<PhotorealAvatar> {
  const { ctx, ref, files } = run;
  let avatar: Omit<PhotorealAvatar, 'portraitSha' | 'maskSha'>;
  let cutout: RenderImage;
  if (isStockPhotorealAvatarId(avatarId)) {
    const meta = getStockPhotorealAvatar(avatarId);
    if (!meta) {
      throw new AppError('UNPROCESSABLE', 'This video uses an avatar that does not exist', {
        avatarId,
      });
    }
    const stock = stockPhotorealAvatarFiles(avatarId);
    avatar = {
      id: avatarId,
      portraitPath: stock.portraitPath,
      maskPath: stock.maskPath,
      rig: meta.rig,
      owner: null,
    };
    cutout = await loadNodeImage((await getStockPhotorealAvatarFile(avatarId, 'cutout')).bytes);
  } else {
    const [row] = await ctx.db
      .select()
      .from(avatarsTable)
      .where(and(eq(avatarsTable.id, avatarId), eq(avatarsTable.workspaceId, ref.workspaceId)));
    if (!row || row.status !== 'ready' || !row.imageKey || !row.rig) {
      throw new AppError(
        'UNPROCESSABLE',
        'An avatar used by this video does not exist any more or is not ready',
        { avatarId },
      );
    }
    const portraitPath = await files.fromStorage(row.imageKey);
    const maskPath = row.maskKey ? await files.fromStorage(row.maskKey) : null;
    avatar = {
      id: avatarId,
      portraitPath,
      maskPath,
      rig: row.rig,
      owner: { workspaceId: ref.workspaceId, avatarId },
    };
    cutout = await loadNodeImage(
      row.cutoutKey
        ? await files.fromStorage(row.cutoutKey)
        : await cutoutPng(portraitPath, maskPath),
    );
  }
  // Stand-in rig: the safety net should a clip frame ever be missing.
  assets.setAvatar(avatarId, createPhotoAvatarRig(avatarId, cutout, avatar.rig));
  return {
    ...avatar,
    portraitSha: await fileSha(avatar.portraitPath),
    maskSha: avatar.maskPath ? await fileSha(avatar.maskPath) : null,
  };
}

/** Viseme hint for the padded scene audio: narration cues shifted to the scene clock. */
function sceneVisemes(
  runtime: RenderRuntime,
  sceneId: string,
  offsetMs: number,
  speechMs: number,
): VisemeCue[] {
  const cues = runtime.scenes[sceneId]?.visemes ?? [];
  if (cues.length === 0 || speechMs <= 0) return [];
  const out = cues
    .filter((cue) => cue.tMs < speechMs)
    .map((cue) => ({ tMs: Math.round(cue.tMs + offsetMs), viseme: cue.viseme }));
  const last = out[out.length - 1];
  // A narration cut by a fixed-duration scene must still close the mouth.
  if (last && last.viseme !== 'rest') {
    out.push({ tMs: Math.round(offsetMs + speechMs), viseme: 'rest' });
  }
  return out;
}

/** Word hint for the padded scene audio: narration words shifted to the scene clock. */
function sceneWords(
  runtime: RenderRuntime,
  sceneId: string,
  offsetMs: number,
  speechMs: number,
): WordCue[] {
  const words = runtime.scenes[sceneId]?.words ?? [];
  if (speechMs <= 0) return [];
  return words
    .filter((word) => word.tMs < speechMs)
    .map((word) => ({ ...word, tMs: Math.round(word.tMs + offsetMs) }));
}

async function readCachedClip(run: RenderRun, job: ClipJob): Promise<ClipFiles | null> {
  const { storage } = run.ctx.providers;
  const key = (file: 'clip.mp4' | 'mask.mp4' | 'mask.png' | 'clip.json') =>
    storageKeys.avatarClipCache(job.avatar.owner, job.hash, file);
  try {
    // `clip.json` is written last: an entry without it (or with a broken one) is a miss.
    if (!(await storage.exists(key('clip.json')))) return null;
    const parsed = AvatarClipCacheMetaSchema.safeParse(
      JSON.parse(new TextDecoder().decode(await storage.get(key('clip.json')))),
    );
    if (!parsed.success || !(await storage.exists(key('clip.mp4')))) return null;
    const meta = parsed.data;
    const matteFile =
      meta.alpha === 'mask-video' ? 'mask.mp4' : meta.alpha === 'mask-image' ? 'mask.png' : null;
    if (matteFile && !(await storage.exists(key(matteFile)))) return null;
    return {
      videoPath: await run.files.fromStorage(key('clip.mp4')),
      mattePath: matteFile ? await run.files.fromStorage(key(matteFile)) : null,
      meta,
    };
  } catch {
    return null; // unreadable entry = miss
  }
}

async function storeClip(run: RenderRun, job: ClipJob, clip: ClipFiles): Promise<void> {
  const { storage } = run.ctx.providers;
  const key = (file: 'clip.mp4' | 'mask.mp4' | 'mask.png' | 'clip.json') =>
    storageKeys.avatarClipCache(job.avatar.owner, job.hash, file);
  await storage.put(key('clip.mp4'), { filePath: clip.videoPath }, { contentType: 'video/mp4' });
  if (clip.mattePath && clip.meta.alpha === 'mask-video') {
    await storage.put(key('mask.mp4'), { filePath: clip.mattePath }, { contentType: 'video/mp4' });
  } else if (clip.mattePath && clip.meta.alpha === 'mask-image') {
    await storage.put(key('mask.png'), { filePath: clip.mattePath }, { contentType: 'image/png' });
  }
  await storage.put(key('clip.json'), new TextEncoder().encode(JSON.stringify(clip.meta)), {
    contentType: 'application/json',
  });
}

/**
 * The provider of a video with several clips: the one of its clips, saying `mixed` when the
 * lips of some were driven by the audio and of others by the viseme timeline.
 */
export function mergeClipProvider(current: ProviderRef | null, next: ProviderRef): ProviderRef {
  if (!current) return next;
  if (current.mode === next.mode) return current;
  return { ...current, mode: 'mixed' };
}

export interface AvatarStageInput {
  composition: Composition;
  timeline: Timeline;
  runtime: RenderRuntime;
  narrations: ReadonlyMap<string, SceneNarration>;
  assets: MapRenderAssets;
  size: { width: number; height: number };
}

export async function prepareAvatarClips(
  run: RenderRun,
  input: AvatarStageInput,
): Promise<AvatarClips> {
  const { composition, timeline, runtime, assets, size } = input;
  const { ctx, ref } = run;
  const lipsync = ctx.providers.lipsync;

  /* ---- what has to exist: one clip per photorealistic layer per scene ---- */
  const wanted: { sceneIndex: number; layer: AvatarLayer }[] = [];
  composition.scenes.forEach((scene, sceneIndex) => {
    for (const layer of scene.layers) {
      if (layer.type !== 'avatar' || !layer.visible) continue;
      if (avatarRenderingOf(layer.avatarId) === 'photoreal') wanted.push({ sceneIndex, layer });
    }
  });
  if (wanted.length === 0) return NO_CLIPS;

  // The animation model is part of the cache key: a model upgrade must not serve old clips.
  // Nor must a change of driver: the engine's `animationKey` says how `auto` animates today.
  const status = await lipsync.status().catch(() => null);
  const model = clipModelKey(status);

  const avatarsById = new Map<string, PhotorealAvatar>();
  const sceneAudio = new Map<number, { path: string; sha: string }>();
  const jobs = new Map<string, ClipJob>();
  for (const { sceneIndex, layer } of wanted) {
    run.cancel.throwIfCanceled();
    const scene = composition.scenes[sceneIndex];
    const timing = timeline.scenes[sceneIndex];
    if (!scene || !timing) continue;
    let avatar = avatarsById.get(layer.avatarId);
    if (!avatar) {
      avatar = await resolveAvatar(run, layer.avatarId, assets);
      avatarsById.set(layer.avatarId, avatar);
    }
    const offsetMs = timing.speechStartMs - timing.startMs;
    let audio = sceneAudio.get(sceneIndex);
    if (!audio) {
      const narration = input.narrations.get(scene.id);
      const wav = sceneAudioWav(narration ? await narration.pcm() : null, {
        sceneMs: timing.durationMs,
        offsetMs,
        speechMs: timing.speechDurationMs,
      });
      const file = run.files.temp('scene-audio', 'wav');
      await fs.writeFile(file, wav);
      audio = { path: file, sha: sha256Hex(wav) };
      sceneAudio.set(sceneIndex, audio);
    }
    const placed = photoAvatarPlacement(
      avatar.rig.imageWidth,
      avatar.rig.imageHeight,
      {
        x: layer.box.x * size.width,
        y: layer.box.y * size.height,
        w: layer.box.w * size.width,
        h: layer.box.h * size.height,
      },
      layer.framing,
      avatar.rig.landmarks,
    );
    const maxSize = clipSizeFor(Math.max(placed.w, placed.h));
    const hash = avatarClipCacheKey({
      portraitSha: avatar.portraitSha,
      maskSha: avatar.maskSha,
      audioSha: audio.sha,
      fps: timeline.fps,
      maxSize,
      providerId: lipsync.info.id,
      model,
    });
    const target = { sceneId: scene.id, sceneIndex, layerId: layer.id };
    const existing = jobs.get(hash);
    if (existing) {
      existing.targets.push(target);
    } else {
      jobs.set(hash, {
        hash,
        avatar,
        audioPath: audio.path,
        visemes: sceneVisemes(runtime, scene.id, offsetMs, timing.speechDurationMs),
        words: sceneWords(runtime, scene.id, offsetMs, timing.speechDurationMs),
        maxSize,
        frames: Math.max(1, Math.ceil((timing.durationMs * timeline.fps) / 1000)),
        clientRef: `${ref.renderJobId}:${scene.id}:${layer.id}`,
        targets: [target],
      });
    }
  }

  /* ---- cache first, then the engine for what is missing ---- */
  const clips = new Map<string, ClipFiles>();
  const pending: ClipJob[] = [];
  for (const job of jobs.values()) {
    const hit = await readCachedClip(run, job);
    if (hit) clips.set(job.hash, hit);
    else pending.push(job);
  }
  const cached = clips.size;
  const totalFrames = pending.reduce((sum, job) => sum + job.frames, 0);
  // Until this render has measured its own speed, the engine's benchmark gives the estimate.
  const benchmark = status?.secondsPerVideoSecond ?? null;
  const benchmarkSecPerFrame = benchmark === null ? null : benchmark / timeline.fps;
  // Speed measured on the clips this render has already animated.
  let framesDone = 0;
  let measuredSec = 0;
  /**
   * `current` frames of `job` are done. Time remaining = what the engine says about the clip
   * it is working on (its own moving average) + the clips still waiting at the speed measured
   * so far in this render (before the first clip finishes: at the engine's benchmark speed).
   */
  const report = (job: ClipJob | null, current: number, engineEtaSec?: number) => {
    const done = framesDone + current;
    const secPerFrame = framesDone > 0 ? measuredSec / framesDone : benchmarkSecPerFrame;
    const currentLeft = job ? job.frames - current : 0;
    const currentEta = engineEtaSec ?? (secPerFrame === null ? null : currentLeft * secPerFrame);
    const waiting = totalFrames - done - currentLeft;
    const perFrame =
      secPerFrame ?? (currentEta !== null && currentLeft > 0 ? currentEta / currentLeft : null);
    const etaSec =
      currentEta === null || (waiting > 0 && perFrame === null)
        ? null
        : currentEta + waiting * (perFrame ?? 0);
    void run.progress
      .update('avatars', totalFrames > 0 ? done / totalFrames : 1, etaSec)
      .catch(() => undefined);
  };
  if (pending.length > 0) {
    report(null, 0);
    run.log.info(
      { clips: pending.length, cached, frames: totalFrames, provider: lipsync.info.id },
      'animating photorealistic avatars',
    );
  }
  for (const [index, job] of pending.entries()) {
    await run.cancel.check();
    const outputDir = await fs.mkdtemp(`${run.tmp.path}/clip-${index}-`);
    const clipStartedAt = Date.now();
    let result;
    try {
      result = await lipsync.animate({
        portraitPath: job.avatar.portraitPath,
        maskPath: job.avatar.maskPath,
        // The REAL audio of the scene (narration padded with silence to the scene length): the
        // audio driver listens to it; the timelines are its hints (and the viseme driver's input).
        audioPath: job.audioPath,
        visemes: job.visemes,
        words: job.words,
        driver: RENDER_LIPSYNC_DRIVER,
        fps: timeline.fps,
        maxSize: job.maxSize,
        outputDir,
        clientRef: job.clientRef,
        onProgress: (progress) => report(job, progress.fraction * job.frames, progress.etaSec),
        signal: run.signal,
      });
    } catch (err) {
      // A cancellation aborts the engine job: that is not a failure of the render.
      run.cancel.throwIfCanceled();
      throw err;
    }
    run.log.info(
      {
        clip: index,
        frames: job.frames,
        driver: result.driver ?? null,
        model: result.model ?? null,
      },
      'photorealistic avatar animated',
    );
    const clip: ClipFiles = {
      videoPath: result.videoPath,
      mattePath: result.alpha === 'none' ? null : result.maskPath,
      meta: AvatarClipCacheMetaSchema.parse({
        v: 1,
        alpha: result.maskPath ? result.alpha : 'none',
        width: result.width,
        height: result.height,
        fps: result.fps,
        frameCount: result.frameCount,
        // Which driver moved the lips is part of who made the clip (shown with the video).
        provider: result.driver ? { ...result.provider, mode: result.driver } : result.provider,
      }),
    };
    await storeClip(run, job, clip);
    clips.set(job.hash, clip);
    framesDone += job.frames;
    measuredSec += (Date.now() - clipStartedAt) / 1000;
    report(null, 0);
  }

  /* ---- register a frame source per layer (each has its own decoder and playhead) ---- */
  const open: { sceneIndex: number; source: PreparableVideoSource }[] = [];
  let provider: ProviderRef | null = null;
  try {
    for (const job of jobs.values()) {
      const clip = clips.get(job.hash);
      if (!clip) continue;
      provider = mergeClipProvider(provider, clip.meta.provider);
      for (const target of job.targets) {
        const source = await openAvatarClipSource({
          path: clip.videoPath,
          mattePath: clip.mattePath,
          fps: timeline.fps,
          originMs: 0,
          landmarks: job.avatar.rig.landmarks,
          signal: run.signal,
        });
        open.push({ sceneIndex: target.sceneIndex, source });
        assets.setAvatarClip(target.sceneId, target.layerId, source);
      }
    }
  } catch (err) {
    await closeSources(open.map((entry) => entry.source));
    throw err;
  }

  let released = 0;
  return {
    provider,
    cached,
    animated: pending.length,
    async releaseBefore(sceneIndex) {
      if (sceneIndex <= released) return;
      released = sceneIndex;
      const done = open.filter((entry) => entry.sceneIndex < sceneIndex);
      await closeSources(done.map((entry) => entry.source));
    },
    close: () => closeSources(open.map((entry) => entry.source)),
  };
}
