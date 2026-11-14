import { FPS, estimateSpeechMs, sceneDurationMs } from '@parlante/shared';
import type { Composition, RenderRuntime, Scene } from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * Timeline: where each scene sits on the video clock. Shared by the renderer (which scene to
 * draw), the worker (audio placement, frame count, subtitles) and the Studio (scrubber).
 *
 * Rules (see also `sceneDurationMs` in @parlante/shared):
 *  - Scenes play back to back; transitions never change the total length.
 *  - A scene's narration starts `paddingStartMs` after the scene starts.
 *  - The transition INTO scene i plays during its first `transitionMs` (clamped to half of the
 *    shorter of the two scenes), with scene i-1 frozen on its last frame underneath.
 * ----------------------------------------------------------------------------------------- */

export interface SceneTiming {
  sceneId: string;
  index: number;
  /** Absolute times on the video clock (ms). `endMs` is exclusive. */
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Absolute time at which the narration audio starts. */
  speechStartMs: number;
  /** Narration length actually played (truncated when a fixed scene is too short). */
  speechDurationMs: number;
  /** Effective duration of the transition into this scene (0 for the first scene / none). */
  transitionMs: number;
}

export interface Timeline {
  fps: number;
  totalMs: number;
  /** Number of frames to render: ceil(totalMs / 1000 * fps). */
  totalFrames: number;
  scenes: SceneTiming[];
}

export interface TimelineOptions {
  /**
   * When a TTS scene has no runtime yet (Studio before synthesis), estimate its narration
   * length from the text instead of treating it as silent. Default false (exports always have
   * runtimes).
   */
  estimateMissing?: boolean;
}

function narrationMs(scene: Scene, runtime: RenderRuntime, options: TimelineOptions): number {
  const sceneRuntime = runtime.scenes[scene.id];
  if (sceneRuntime) return sceneRuntime.audioDurationMs;
  if (options.estimateMissing && scene.script.kind === 'tts') {
    return estimateSpeechMs(scene.script.text, scene.script.speed);
  }
  return 0;
}

export function computeTimeline(
  composition: Composition,
  runtime: RenderRuntime,
  options: TimelineOptions = {},
): Timeline {
  const fps = composition.canvas.fps ?? FPS;
  const scenes: SceneTiming[] = [];
  let cursor = 0;
  composition.scenes.forEach((scene, index) => {
    const narration = narrationMs(scene, runtime, options);
    const durationMs = sceneDurationMs(scene, narration);
    const speechOffset = Math.min(scene.paddingStartMs, durationMs);
    const previous = scenes[index - 1];
    const wantsTransition = index > 0 && scene.transition.type !== 'none';
    const transitionMs =
      wantsTransition && previous
        ? Math.max(
            0,
            Math.min(scene.transition.durationMs, durationMs / 2, previous.durationMs / 2),
          )
        : 0;
    scenes.push({
      sceneId: scene.id,
      index,
      startMs: cursor,
      endMs: cursor + durationMs,
      durationMs,
      speechStartMs: cursor + speechOffset,
      speechDurationMs: Math.max(0, Math.min(narration, durationMs - speechOffset)),
      transitionMs: Math.round(transitionMs),
    });
    cursor += durationMs;
  });
  return { fps, totalMs: cursor, totalFrames: Math.ceil((cursor / 1000) * fps), scenes };
}

export interface SceneLocation {
  timing: SceneTiming;
  /** Time since the start of the scene (ms). */
  localMs: number;
  /** Time since the start of the narration audio (ms); negative before it starts. */
  speechMs: number;
}

/** Scene active at `tMs` (clamped to the first/last scene outside the timeline). */
export function locateScene(timeline: Timeline, tMs: number): SceneLocation {
  const scenes = timeline.scenes;
  const first = scenes[0];
  if (!first) throw new Error('Timeline has no scenes');
  const t = Math.max(0, Math.min(tMs, Math.max(0, timeline.totalMs - 1e-6)));
  let lo = 0;
  let hi = scenes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = scenes[mid];
    if (candidate && candidate.startMs <= t) lo = mid;
    else hi = mid - 1;
  }
  const timing = scenes[lo] ?? first;
  return { timing, localMs: t - timing.startMs, speechMs: t - timing.speechStartMs };
}

/** Timestamp of a frame index (frame centres are not used: frame n shows time n / fps). */
export function frameToMs(frame: number, fps: number = FPS): number {
  return (frame * 1000) / fps;
}

export function msToFrame(ms: number, fps: number = FPS): number {
  return Math.floor((ms * fps) / 1000 + 1e-6);
}
