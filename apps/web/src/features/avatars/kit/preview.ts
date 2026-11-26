import {
  collectAssetIds,
  collectAvatarIds,
  estimateSpeechMs,
  isStockAvatarId,
  sceneRuntimeFromTranscript,
} from '@parlante/shared';
import type { Composition, RenderRuntime } from '@parlante/shared';

/* Silent previews of a composition (template gallery, brand kit): there is no synthesized
 * audio yet, so the narration of each scene is ESTIMATED with the shared estimator — the one
 * the Studio uses before synthesis — which gives scene lengths and a plausible mouth track.
 * The UI labels these previews as silent and approximate. */

/** Estimated runtime of every scene narrated with TTS (other scenes are silent). */
export function estimatedRuntime(composition: Composition): RenderRuntime {
  const scenes: RenderRuntime['scenes'] = {};
  for (const scene of composition.scenes) {
    if (scene.script.kind !== 'tts') continue;
    const text = scene.script.text.trim();
    if (text === '') continue;
    scenes[scene.id] = sceneRuntimeFromTranscript(
      text,
      estimateSpeechMs(text, scene.script.speed),
      scene.script.language,
    );
  }
  return { scenes };
}

/** Ids of uploaded assets and workspace / photoreal avatars a preview has to fetch. */
export function previewDependencies(composition: Composition): {
  assetIds: string[];
  avatarIds: string[];
} {
  return {
    assetIds: collectAssetIds(composition),
    avatarIds: collectAvatarIds(composition).filter((id) => !isStockAvatarId(id)),
  };
}

/** Clamp a playhead into `[0, totalMs)` (the last frame is still inside the last scene). */
export function clampPlayhead(tMs: number, totalMs: number): number {
  if (!(totalMs > 0)) return 0;
  return Math.min(Math.max(0, tMs), totalMs - 1);
}
