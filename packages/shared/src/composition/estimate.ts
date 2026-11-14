import type { Composition, Scene } from './schema';

/** Average speaking rate used for estimates before TTS has run (characters per second). */
export const ESTIMATED_CHARS_PER_SECOND = 15;
export const DEFAULT_SILENT_SCENE_MS = 3000;

/** Rough narration length for a text at a given speed (ms). 0 for empty text. */
export function estimateSpeechMs(text: string, speed = 1): number {
  const chars = text.replace(/\s+/g, ' ').trim().length;
  if (chars === 0) return 0;
  return Math.max(600, Math.round((chars / (ESTIMATED_CHARS_PER_SECOND * speed)) * 1000));
}

/**
 * Scene duration given the narration length (ms) — THE rule shared by the estimator and the
 * real timeline (packages/renderer `computeTimeline`):
 *  - fixed  → exactly `seconds`
 *  - auto   → paddingStart + narration + paddingEnd, or DEFAULT_SILENT_SCENE_MS without narration
 */
export function sceneDurationMs(scene: Scene, narrationMs: number): number {
  if (scene.duration.mode === 'fixed') return Math.round(scene.duration.seconds * 1000);
  if (narrationMs <= 0) return DEFAULT_SILENT_SCENE_MS;
  return scene.paddingStartMs + Math.round(narrationMs) + scene.paddingEndMs;
}

/**
 * Estimated total duration before rendering (used for credit reservation, plan-limit checks and
 * the Studio timeline while no audio has been synthesised). Uploaded-audio scenes need
 * `audioAssetDurations` (assetId → ms); missing entries count as 0.
 */
export function estimateCompositionDurationMs(
  composition: Composition,
  audioAssetDurations: Record<string, number> = {},
): number {
  let total = 0;
  for (const scene of composition.scenes) {
    let narration = 0;
    if (scene.script.kind === 'tts') {
      narration = estimateSpeechMs(scene.script.text, scene.script.speed);
    } else if (scene.script.kind === 'audio') {
      narration = audioAssetDurations[scene.script.assetId] ?? 0;
    }
    total += sceneDurationMs(scene, narration);
  }
  return total;
}
