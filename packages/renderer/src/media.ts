import { mediaRefKey } from '@parlante/shared';
import type { Background, Composition, Layer, Scene } from '@parlante/shared';
import { locateScene } from './timeline';
import type { SceneTiming, Timeline } from './timeline';
import type { AvatarClipSource } from './types';

/* -------------------------------------------------------------------------------------------
 * Media clock — which instant of every video (background, video layer, neural avatar clip) a
 * frame shows. `renderFrame` uses these functions itself, and exports them so that the two
 * things that FEED it frames stay in step with it by construction:
 *  - the Studio preview player seeks each HTMLVideoElement and sets its volume from
 *    `mediaPlaybackAt(composition, timeline, tMs)`
 *  - the render job decodes only the frames each output frame will ask for (never a whole
 *    video up front: 60 s of 720p RGBA is several GB)
 * ----------------------------------------------------------------------------------------- */

/** One scene being drawn at an instant, with its clocks. */
export interface SceneInstant {
  scene: Scene;
  timing: SceneTiming;
  /** Time since the start of the scene (ms). */
  localMs: number;
  /** Time since the start of the scene's narration (ms); negative before it starts. */
  speechMs: number;
  /**
   * True for the PREVIOUS scene while the transition into the current one plays: it is held
   * on its last frame underneath. Frozen scenes show a frame but play no audio.
   */
  frozen: boolean;
  /** 0..1 progress of the transition into this scene (1 when not transitioning or frozen). */
  transitionProgress: number;
}

/**
 * Scenes that contribute pixels at video time `tMs`, in paint order: normally one; during a
 * transition the frozen previous scene first, then the incoming one.
 */
export function sceneInstantsAt(
  composition: Composition,
  timeline: Timeline,
  tMs: number,
): SceneInstant[] {
  const { timing, localMs, speechMs } = locateScene(timeline, tMs);
  const scene = composition.scenes[timing.index];
  if (!scene) return [];
  const current: SceneInstant = {
    scene,
    timing,
    localMs,
    speechMs,
    frozen: false,
    transitionProgress: 1,
  };
  const inTransition = timing.transitionMs > 0 && localMs < timing.transitionMs;
  const previousTiming = timeline.scenes[timing.index - 1];
  const previousScene = composition.scenes[timing.index - 1];
  if (!inTransition || !previousTiming || !previousScene) return [current];
  const lastLocal = Math.max(0, previousTiming.durationMs - 1000 / timeline.fps);
  return [
    {
      scene: previousScene,
      timing: previousTiming,
      localMs: lastLocal,
      speechMs: lastLocal - (previousTiming.speechStartMs - previousTiming.startMs),
      frozen: true,
      transitionProgress: 1,
    },
    { ...current, transitionProgress: localMs / timing.transitionMs },
  ];
}

/** True when a layer is drawn at scene-local time `localMs` (visible and inside its window). */
export function layerActiveAt(layer: Layer, localMs: number): boolean {
  if (!layer.visible) return false;
  const timing = layer.timing;
  if (!timing) return true;
  return localMs >= timing.startMs && (timing.endMs === null || localMs < timing.endMs);
}

/** Position on a background video's clock, before looping / clamping to its length. */
export function backgroundVideoRawMs(
  background: Extract<Background, { type: 'video' }>,
  localMs: number,
): number {
  return background.trimStartMs + localMs;
}

/** Position on a video layer's clock (it starts when the layer appears), before looping. */
export function videoLayerRawMs(layer: Extract<Layer, { type: 'video' }>, localMs: number): number {
  return layer.trimStartMs + localMs - (layer.timing?.startMs ?? 0);
}

/** Apply loop / clamp once the media duration is known. */
export function mediaTimeMs(rawMs: number, loop: boolean, durationMs: number): number {
  const t = Math.max(0, rawMs);
  if (!(durationMs > 0)) return 0;
  return loop ? t % durationMs : Math.min(t, durationMs);
}

/**
 * Time of a neural avatar clip: measured from `clip.originMs` (scene-local) when set, else
 * from the start of the narration; the first / last frame is held outside the clip.
 */
export function avatarClipTimeMs(
  clip: Pick<AvatarClipSource, 'durationMs' | 'originMs'>,
  localMs: number,
  speechMs: number,
): number {
  const t = clip.originMs !== undefined ? localMs - clip.originMs : speechMs;
  return Math.min(Math.max(0, t), Math.max(0, clip.durationMs - 1));
}

export interface MediaPlayback {
  kind: 'background' | 'layer' | 'avatarClip';
  sceneId: string;
  /** null for backgrounds. */
  layerId: string | null;
  /**
   * How `RenderAssets` is asked for it: `mediaRefKey(src)` for `assets.video(key)`
   * (background / layer); `${sceneId}/${layerId}` for avatar clips
   * (`assets.avatarClip(sceneId, layerId)`).
   */
  key: string;
  /**
   * Position on the media clock BEFORE looping / clamping: the final time is
   * `mediaTimeMs(rawMs, loop, durationMs)` — or, for avatar clips,
   * `avatarClipTimeMs(clip, localMs, speechMs)` (here `rawMs` = `speechMs`).
   */
  rawMs: number;
  loop: boolean;
  /** Audio gain 0..1 (0 for frozen scenes and avatar clips: narration is mixed separately). */
  volume: number;
  /** Held frame of the previous scene under a transition: show it, do not advance or play it. */
  frozen: boolean;
  /** Scene clocks of this entry. */
  localMs: number;
  speechMs: number;
}

/**
 * Every video `renderFrame(…, tMs, …)` will ask `RenderAssets` for, and at which media time.
 * Same order as painting (frozen previous scene first). Avatar clips are listed for every
 * visible avatar layer whose avatar is photorealistic-capable — i.e. for all avatar layers;
 * consumers ignore the ones they have no clip for.
 */
export function mediaPlaybackAt(
  composition: Composition,
  timeline: Timeline,
  tMs: number,
): MediaPlayback[] {
  const out: MediaPlayback[] = [];
  for (const instant of sceneInstantsAt(composition, timeline, tMs)) {
    const { scene, localMs, speechMs, frozen } = instant;
    const base = { sceneId: scene.id, frozen, localMs, speechMs };
    if (scene.background.type === 'video') {
      out.push({
        ...base,
        kind: 'background',
        layerId: null,
        key: mediaRefKey(scene.background.src),
        rawMs: backgroundVideoRawMs(scene.background, localMs),
        loop: scene.background.loop,
        volume: frozen ? 0 : scene.background.volume,
      });
    }
    for (const layer of scene.layers) {
      if (!layerActiveAt(layer, localMs)) continue;
      if (layer.type === 'video') {
        out.push({
          ...base,
          kind: 'layer',
          layerId: layer.id,
          key: mediaRefKey(layer.src),
          rawMs: videoLayerRawMs(layer, localMs),
          loop: layer.loop,
          volume: frozen ? 0 : layer.volume,
        });
      } else if (layer.type === 'avatar') {
        out.push({
          ...base,
          kind: 'avatarClip',
          layerId: layer.id,
          key: `${scene.id}/${layer.id}`,
          rawMs: speechMs,
          loop: false,
          volume: 0,
        });
      }
    }
  }
  return out;
}
