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

export interface ModerationText {
  /** Where the text comes from (reported in CONTENT_BLOCKED details). */
  sceneId: string;
  kind: 'script' | 'transcript' | 'text-layer';
  /** Layer id for `text-layer`, null otherwise. */
  layerId: string | null;
  text: string;
  language: string | undefined;
}

/**
 * EVERY user-written text a video shows or speaks: TTS scripts, transcripts of uploaded
 * narration and text layers (empty ones skipped). This is the single definition of "what is
 * moderated before rendering": `startRender` in @parlante/jobs runs each entry through the
 * ModerationProvider (context `script`) for Studio renders, the public API and batch rows
 * alike. Call it on the composition AFTER `applyVariables`, so variable values (CSV cells, API
 * input) are moderated too.
 */
export function collectModerationTexts(composition: Composition): ModerationText[] {
  const out: ModerationText[] = [];
  for (const scene of composition.scenes) {
    const script = scene.script;
    const language = script.kind === 'none' ? undefined : script.language;
    if (script.kind === 'tts' && script.text.trim() !== '') {
      out.push({ sceneId: scene.id, kind: 'script', layerId: null, text: script.text, language });
    } else if (script.kind === 'audio' && script.transcript.trim() !== '') {
      out.push({
        sceneId: scene.id,
        kind: 'transcript',
        layerId: null,
        text: script.transcript,
        language,
      });
    }
    for (const layer of scene.layers) {
      if (layer.type === 'text' && layer.text.trim() !== '') {
        out.push({
          sceneId: scene.id,
          kind: 'text-layer',
          layerId: layer.id,
          text: layer.text,
          language,
        });
      }
    }
  }
  return out;
}
