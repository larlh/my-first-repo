import { estimateSpeechMs, interpolate, sceneDurationMs } from '@parlante/shared';
import type { Composition, RenderRuntime, Scene, SceneRuntime } from '@parlante/shared';
import type { SceneTiming } from '@parlante/renderer';

/* Durations and instants the Studio shows. The timeline itself is `computeTimeline` from the
 * renderer; these helpers only answer UI questions about it. Pure. */

export interface SceneDurationInfo {
  /** Scene length in ms. */
  durationMs: number;
  /** Narration length in ms (0 when silent). */
  narrationMs: number;
  /** True while the narration length is an estimate (the audio has not been synthesised). */
  estimated: boolean;
}

/** Length of a scene: measured when its audio exists, estimated from the text otherwise. */
export function sceneDurationInfo(
  scene: Scene,
  runtime: SceneRuntime | undefined,
): SceneDurationInfo {
  if (runtime) {
    return {
      durationMs: sceneDurationMs(scene, runtime.audioDurationMs),
      narrationMs: runtime.audioDurationMs,
      estimated: false,
    };
  }
  const narrationMs =
    scene.script.kind === 'tts' ? estimateSpeechMs(scene.script.text, scene.script.speed) : 0;
  return {
    durationMs: sceneDurationMs(scene, narrationMs),
    narrationMs,
    estimated: scene.script.kind === 'tts' && narrationMs > 0,
  };
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Instant of a scene shown while EDITING it: after its transition and the entrance of its
 * layers, so everything sits where the user placed it. Absolute video time.
 */
export function editInstantMs(scene: Scene, timing: SceneTiming): number {
  let settled = timing.transitionMs;
  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    const start = layer.timing?.startMs ?? 0;
    const enter = layer.enter && layer.enter.type !== 'none' ? layer.enter : null;
    settled = Math.max(settled, start + (enter ? enter.delayMs + enter.durationMs : 0));
  }
  const lastFrame = Math.max(0, timing.durationMs - 1000 / 30 - 1);
  return timing.startMs + Math.min(settled + 34, lastFrame);
}

/** Values the preview substitutes for `{{variables}}`: their non-empty defaults. */
export function previewVariableValues(composition: Composition): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of composition.variables) {
    if (variable.defaultValue.trim() !== '') values[variable.name] = variable.defaultValue;
  }
  return values;
}

/**
 * The document the preview draws: `{{variables}}` with a default show that default — what an
 * export without values would show; the others stay visible as placeholders. Scene and layer
 * ids are untouched, and the same object is returned when there is nothing to substitute.
 */
export function previewComposition(composition: Composition): Composition {
  const values = previewVariableValues(composition);
  if (Object.keys(values).length === 0) return composition;
  let changed = false;
  const scenes = composition.scenes.map((scene) => {
    let sceneChanged = false;
    const layers = scene.layers.map((layer) => {
      if (layer.type !== 'text') return layer;
      const text = interpolate(layer.text, values);
      if (text === layer.text) return layer;
      sceneChanged = true;
      return { ...layer, text };
    });
    if (!sceneChanged) return scene;
    changed = true;
    return { ...scene, layers };
  });
  return changed ? { ...composition, scenes } : composition;
}

/** Text actually sent to the TTS for a script: defaults applied, unknown variables spoken by name. */
export function spokenText(text: string, values: Record<string, string>): string {
  return interpolate(text, values, (name) => name).trim();
}

/** Total of the per-scene estimates, for the header and the render dialog. */
export function totalDurationMs(composition: Composition, runtime: RenderRuntime): number {
  return composition.scenes.reduce(
    (total, scene) => total + sceneDurationInfo(scene, runtime.scenes[scene.id]).durationMs,
    0,
  );
}
