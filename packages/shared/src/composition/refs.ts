import { mediaRefKey } from './schema';
import type { Composition, MediaRef } from './schema';

export type MediaUsage = 'image' | 'video' | 'audio';

export interface MediaRefUse {
  ref: MediaRef;
  key: string;
  /** How the renderer/worker consumes the file. */
  usage: MediaUsage;
}

/**
 * Every media file a composition needs, de-duplicated by (key, usage).
 * Used by: the API (verify each `asset` belongs to the workspace), the worker (download before
 * rendering) and the web preview (preload).
 */
export function collectMediaRefs(composition: Composition): MediaRefUse[] {
  const out = new Map<string, MediaRefUse>();
  const add = (ref: MediaRef, usage: MediaUsage) => {
    const key = mediaRefKey(ref);
    out.set(`${usage}|${key}`, { ref, key, usage });
  };
  if (composition.music) add(composition.music.src, 'audio');
  for (const scene of composition.scenes) {
    if (scene.background.type === 'image') add(scene.background.src, 'image');
    if (scene.background.type === 'video') add(scene.background.src, 'video');
    if (scene.script.kind === 'audio') {
      add({ source: 'asset', assetId: scene.script.assetId }, 'audio');
    }
    for (const layer of scene.layers) {
      if (layer.type === 'image') add(layer.src, 'image');
      if (layer.type === 'video') add(layer.src, 'video');
    }
  }
  return [...out.values()];
}

/** Ids of uploaded Assets referenced by the composition (unique). */
export function collectAssetIds(composition: Composition): string[] {
  const ids = new Set<string>();
  for (const use of collectMediaRefs(composition)) {
    if (use.ref.source === 'asset') ids.add(use.ref.assetId);
  }
  return [...ids];
}

/** Avatar ids (stock and photo) used by the composition (unique). */
export function collectAvatarIds(composition: Composition): string[] {
  const ids = new Set<string>();
  for (const scene of composition.scenes) {
    for (const layer of scene.layers) if (layer.type === 'avatar') ids.add(layer.avatarId);
  }
  return [...ids];
}

/** True when any avatar layer uses a photorealistic avatar (`real_…` / `avt_…`). */
export function usesPhotorealAvatars(composition: Composition): boolean {
  return collectAvatarIds(composition).some((id) => !id.startsWith('stock_'));
}

/** Voice ids used by TTS scripts (unique). */
export function collectVoiceIds(composition: Composition): string[] {
  const ids = new Set<string>();
  for (const scene of composition.scenes) {
    if (scene.script.kind === 'tts') ids.add(scene.script.voiceId);
  }
  return [...ids];
}

/** All narration text of the document, one entry per scene with a non-empty TTS script. */
export function collectScriptTexts(
  composition: Composition,
): { sceneId: string; text: string; language: string }[] {
  const out: { sceneId: string; text: string; language: string }[] = [];
  for (const scene of composition.scenes) {
    if (scene.script.kind === 'tts' && scene.script.text.trim() !== '') {
      out.push({ sceneId: scene.id, text: scene.script.text, language: scene.script.language });
    }
  }
  return out;
}
