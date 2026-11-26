import {
  applyVariables,
  creditsForRender,
  estimateCompositionDurationMs,
  estimateSpeechMs,
  interpolate,
  sceneDurationMs,
  usesPhotorealAvatars,
} from '@parlante/shared';
import type { Composition, RenderRuntime, Resolution, Scene, SceneRuntime } from '@parlante/shared';
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

/**
 * Values the preview substitutes for `{{variables}}`: the declared defaults, empty ones
 * included — exactly what `applyVariables` (the export without values) uses.
 */
export function previewVariableValues(composition: Composition): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of composition.variables) values[variable.name] = variable.defaultValue;
  return values;
}

/** What an export without values puts in place of a placeholder that has no value: nothing. */
const missingValue = (): string => '';

/**
 * The document the preview draws: every `{{variable}}` replaced like the export does it
 * (`applyVariables` in @parlante/shared) — its default, or nothing when it has none — so the
 * canvas never shows a placeholder the MP4 will not have. Scene and layer ids are untouched,
 * and the same object is returned when there is nothing to substitute.
 */
export function previewComposition(composition: Composition): Composition {
  const values = previewVariableValues(composition);
  let changed = false;
  const scenes = composition.scenes.map((scene) => {
    let sceneChanged = false;
    const layers = scene.layers.map((layer) => {
      if (layer.type !== 'text') return layer;
      const text = interpolate(layer.text, values, missingValue);
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

/** Text actually sent to the TTS for a script: the same substitution as the export. */
export function spokenText(text: string, values: Record<string, string>): string {
  return interpolate(text, values, missingValue).trim();
}

/** Total of the per-scene estimates, for the header and the render dialog. */
export function totalDurationMs(composition: Composition, runtime: RenderRuntime): number {
  return composition.scenes.reduce(
    (total, scene) => total + sceneDurationInfo(scene, runtime.scenes[scene.id]).durationMs,
    0,
  );
}

export interface RenderQuote {
  /** What the render ends up costing: priced on the measured length of the preview. */
  cost: number;
  /**
   * What the API holds when the render starts. It has not synthesised the audio at that point,
   * so it prices its ESTIMATE of the length (`startRender` in @parlante/jobs: the same
   * `estimateCompositionDurationMs` on the document with its variables applied) and settles
   * to the real length at the end. Near a 30 s step the two can differ by one step.
   */
  reserve: number;
  /** Credits the balance must cover for the API to accept the render. */
  needed: number;
}

/**
 * Cost of rendering the document as the Studio shows it. `measuredMs` is the length of the
 * preview timeline; `audioDurations` maps the uploaded narrations to their length (asset → ms).
 */
export function quoteRender(
  composition: Composition,
  measuredMs: number,
  resolution: Resolution,
  audioDurations: Record<string, number> = {},
): RenderQuote {
  const photoreal = usesPhotorealAvatars(composition);
  const estimatedMs = estimateCompositionDurationMs(
    applyVariables(composition, {}),
    audioDurations,
  );
  const cost = creditsForRender(measuredMs, resolution, { photoreal });
  const reserve = creditsForRender(estimatedMs, resolution, { photoreal });
  return { cost, reserve, needed: Math.max(cost, reserve) };
}
