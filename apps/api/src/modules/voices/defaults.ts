import {
  LOCAL_TTS_PROVIDER_ID,
  LOCAL_VOICES,
  makeStockVoiceId,
  pickDefaultVoice,
} from '@parlante/shared';
import type { Composition, Voice } from '@parlante/shared';
import { listVoiceCatalog } from './catalog';
import type { VoiceCatalogDeps } from './catalog';

/* -------------------------------------------------------------------------------------------
 * Default voices on the server side.
 *
 * Content that ships with the product (the built-in templates) is written with the frozen
 * local voices (`espeak:<lang>-f1` / `-m1`), because those always exist. When a video is
 * CREATED from it, each of those is replaced by the voice this server recommends for the same
 * language and gender — an installed local neural voice under `TTS_PROVIDER=auto` — so new
 * videos start with the best voice available. Nothing saved is ever rewritten: a video keeps
 * the voices it was saved with, and so does a custom template.
 * ----------------------------------------------------------------------------------------- */

/** `espeak:<lang>-f1|m1` → its gender; undefined for any other voice id. */
const FROZEN_DEFAULTS = new Map(
  LOCAL_VOICES.filter((voice) => voice.gender === 'female' || voice.gender === 'male').map(
    (voice) => [
      makeStockVoiceId(LOCAL_TTS_PROVIDER_ID, voice.providerVoiceId),
      voice.gender === 'male' ? ('male' as const) : ('female' as const),
    ],
  ),
);

/** The same document with the frozen local default voices replaced by `voices`' defaults. */
export function replaceDefaultVoices(
  composition: Composition,
  voices: readonly Voice[],
): Composition {
  let changed = false;
  const scenes = composition.scenes.map((scene) => {
    if (scene.script.kind !== 'tts') return scene;
    const gender = FROZEN_DEFAULTS.get(scene.script.voiceId);
    if (!gender) return scene;
    const pick = pickDefaultVoice(voices, scene.script.language, gender);
    if (!pick || pick.id === scene.script.voiceId) return scene;
    changed = true;
    return { ...scene, script: { ...scene.script, voiceId: pick.id } };
  });
  return changed ? { ...composition, scenes } : composition;
}

/**
 * `replaceDefaultVoices` with the catalogue of this server. Never fails the caller: when the
 * catalogue cannot be read the document is returned as it is (its voices always exist).
 */
export async function withDefaultVoices(
  deps: VoiceCatalogDeps,
  workspaceId: string,
  composition: Composition,
): Promise<Composition> {
  if (
    !composition.scenes.some(
      (s) => s.script.kind === 'tts' && FROZEN_DEFAULTS.has(s.script.voiceId),
    )
  ) {
    return composition;
  }
  try {
    const voices = await listVoiceCatalog(deps, workspaceId, { kind: 'stock' });
    return replaceDefaultVoices(composition, voices);
  } catch (err) {
    deps.onProviderError?.('catalog', err);
    return composition;
  }
}
