import { newId } from '../ids';
import {
  CANVAS_PRESETS,
  COMPOSITION_VERSION,
  CompositionSchema,
  LayerSchema,
  SceneSchema,
} from './schema';
import type { AspectRatio, Canvas, Composition, Layer, Scene } from './schema';
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
