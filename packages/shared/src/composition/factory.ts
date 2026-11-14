import { newId } from '../ids';
import {
  CANVAS_PRESETS,
  COMPOSITION_VERSION,
  CompositionSchema,
  LayerSchema,
  SceneSchema,
} from './schema';
import type { AspectRatio, Canvas, Composition, Layer, Scene } from './schema';
import type { BrandColorRole } from './schema';
import type { z } from 'zod';

export function canvasForAspect(aspect: AspectRatio): Canvas {
  return { aspect, ...CANVAS_PRESETS[aspect], fps: 30 };
}

/** Distributive Omit so each member of the Layer union keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewLayerInput = DistributiveOmit<z.input<typeof LayerSchema>, 'id'> & { id?: string };
export type NewSceneInput = Omit<z.input<typeof SceneSchema>, 'id' | 'layers'> & {
  id?: string;
  layers?: NewLayerInput[];
};

/** Build a fully-defaulted layer; generates an id when missing. */
export function createLayer(input: NewLayerInput): Layer {
  return LayerSchema.parse({ ...input, id: input.id ?? newId('layer') });
}

/** Build a fully-defaulted scene; generates ids when missing. */
export function createScene(input: NewSceneInput = {}): Scene {
  return SceneSchema.parse({
    ...input,
    id: input.id ?? newId('scene'),
    layers: (input.layers ?? []).map((l) => ({ ...l, id: l.id ?? newId('layer') })),
  });
}

export interface NewCompositionInput {
  aspect?: AspectRatio;
  scenes?: NewSceneInput[];
}

/** A valid one-scene (or given scenes) composition with every default applied. */
export function createComposition(input: NewCompositionInput = {}): Composition {
  const aspect = input.aspect ?? '16:9';
  const scenes = input.scenes && input.scenes.length > 0 ? input.scenes : [{ name: 'Escena 1' }];
  return CompositionSchema.parse({
    version: COMPOSITION_VERSION,
    canvas: canvasForAspect(aspect),
    scenes: scenes.map((s) => createScene(s)),
  });
}

/**
 * Deep-clone a composition assigning fresh scene and layer ids (used by "duplicate video",
 * "use template" and batch personalisation so documents never share ids).
 */
export function cloneCompositionWithNewIds(composition: Composition): Composition {
  const copy = structuredClone(composition);
  for (const scene of copy.scenes) {
    scene.id = newId('scene');
    for (const layer of scene.layers) layer.id = newId('layer');
  }
  return copy;
}

/**
 * Re-target a composition to another aspect ratio. Layer boxes are normalised so they keep
 * their relative placement; only the canvas changes. (The Studio lets the user fix the layout.)
 */
export function withAspect(composition: Composition, aspect: AspectRatio): Composition {
  return { ...composition, canvas: canvasForAspect(aspect) };
}

export interface ScriptSceneInput {
  /** Narration of the scene. */
  text: string;
  /** Optional on-screen headline (text layer with role `title`). */
  headline?: string;
  /** Scene name shown in the Studio. */
  title?: string;
}

export interface CompositionFromScriptOptions {
  avatarId: string;
  voiceId: string;
  /** Locale of the narration. */
  language: string;
  aspect?: AspectRatio;
  backgroundColor?: string;
  /** Burned-in subtitles on/off (default on). */
  subtitles?: boolean;
  speed?: number;
  pitch?: number;
}

const SCRIPT_LAYOUT: Record<
  AspectRatio,
  {
    avatar: { x: number; y: number; w: number; h: number };
    headline: { x: number; y: number; w: number; h: number };
    headlineSize: number;
    align: 'left' | 'center';
  }
> = {
  '16:9': {
    avatar: { x: 0.52, y: 0.14, w: 0.4, h: 0.86 },
    headline: { x: 0.07, y: 0.22, w: 0.42, h: 0.4 },
    headlineSize: 0.075,
    align: 'left',
  },
  '9:16': {
    avatar: { x: 0.1, y: 0.36, w: 0.8, h: 0.64 },
    headline: { x: 0.08, y: 0.08, w: 0.84, h: 0.22 },
    headlineSize: 0.042,
    align: 'center',
  },
  '1:1': {
    avatar: { x: 0.2, y: 0.3, w: 0.6, h: 0.7 },
    headline: { x: 0.08, y: 0.06, w: 0.84, h: 0.2 },
    headlineSize: 0.06,
    align: 'center',
  },
};

/**
 * THE script → Composition layout: one scene per entry with the talking avatar, an optional
 * headline and the narration. Used by BOTH the AI script writer screen (web, before
 * `POST /api/videos` with `source: 'script'`) and the public API (`POST /v1/videos` with
 * `input.type: 'script'`), so a script produces the same video whichever way it arrives.
 * Without headlines the avatar is centred.
 */
export function compositionFromScript(
  scenes: readonly ScriptSceneInput[],
  options: CompositionFromScriptOptions,
): Composition {
  const aspect = options.aspect ?? '16:9';
  const layout = SCRIPT_LAYOUT[aspect];
  const backgroundRole: BrandColorRole = 'background';
  const built = (scenes.length > 0 ? scenes : [{ text: '' }]).map((scene, index) => {
    const headline = scene.headline?.trim() ?? '';
    const avatarBox =
      headline === '' && aspect === '16:9' ? { x: 0.3, y: 0.14, w: 0.4, h: 0.86 } : layout.avatar;
    const layers: NewLayerInput[] = [
      {
        type: 'avatar',
        name: 'Avatar',
        avatarId: options.avatarId,
        box: avatarBox,
        framing: 'bust',
        z: 1,
      },
    ];
    if (headline !== '') {
      layers.push({
        type: 'text',
        name: 'Titular',
        role: 'title',
        text: headline,
        box: layout.headline,
        z: 2,
        style: {
          fontFamily: 'Poppins',
          fontSize: layout.headlineSize,
          fontWeight: 700,
          align: layout.align,
          verticalAlign: 'middle',
          color: '#ffffff',
        },
        enter: { type: 'fade', durationMs: 400 },
      });
    }
    return createScene({
      name: scene.title?.trim() || `Escena ${index + 1}`,
      script: {
        kind: 'tts',
        text: scene.text,
        voiceId: options.voiceId,
        language: options.language,
        speed: options.speed ?? 1,
        pitch: options.pitch ?? 0,
      },
      background: {
        type: 'color',
        color: options.backgroundColor ?? '#101322',
        brandRole: backgroundRole,
      },
      transition: { type: index === 0 ? 'none' : 'fade', durationMs: 400 },
      layers,
    });
  });
  return CompositionSchema.parse({
    version: COMPOSITION_VERSION,
    canvas: canvasForAspect(aspect),
    scenes: built,
    subtitles: { enabled: options.subtitles ?? true },
  });
}
