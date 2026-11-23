import {
  COMPOSITION_LIMITS,
  createLayer,
  createScene,
  newId,
  syncVariableDefs,
  withAspect,
} from '@parlante/shared';
import type {
  AspectRatio,
  Background,
  Composition,
  Layer,
  MusicTrack,
  NewLayerInput,
  Scene,
  Script,
  SubtitleStyle,
  TextStyle,
  Transition,
  VariableDef,
} from '@parlante/shared';
import { produce } from 'immer';
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  sealHistory,
  undoHistory,
} from './history';
import type { History } from './history';

/* -------------------------------------------------------------------------------------------
 * Editing model of the Studio. Pure: (state, command) → state. The document is the video
 * title plus its Composition; every edit is an `EditorAction`, undo / redo is a history of
 * immutable documents (immer keeps untouched scenes identical, so thumbnails and memoised
 * panels do not redraw).
 * ----------------------------------------------------------------------------------------- */

export interface EditorDoc {
  title: string;
  composition: Composition;
}

export interface Selection {
  sceneId: string;
  layerId: string | null;
}

type PatchOf<T> = T extends unknown ? Partial<Omit<T, 'id' | 'type'>> : never;
/** Fields of any layer type; the reducer only assigns keys the layer already has. */
export type LayerPatch = PatchOf<Layer>;
export type ScenePatch = Partial<
  Pick<Scene, 'name' | 'duration' | 'paddingStartMs' | 'paddingEndMs'>
>;
type ScriptPatchOf<T> = T extends unknown ? Partial<Omit<T, 'kind'>> : never;
export type ScriptPatch = ScriptPatchOf<Script>;
export type LayerOrder = 'front' | 'forward' | 'backward' | 'back';

export type EditorAction =
  | { type: 'title.set'; title: string }
  | { type: 'aspect.set'; aspect: AspectRatio }
  | { type: 'scene.add'; afterSceneId: string | null; name: string }
  | { type: 'scene.duplicate'; sceneId: string; name: string }
  | { type: 'scene.remove'; sceneId: string }
  | { type: 'scene.move'; sceneId: string; toIndex: number }
  | { type: 'scene.patch'; sceneId: string; patch: ScenePatch }
  | { type: 'scene.script'; sceneId: string; script: Script }
  | { type: 'scene.scriptPatch'; sceneId: string; patch: ScriptPatch }
  | { type: 'scene.background'; sceneId: string; background: Background }
  | { type: 'scene.transition'; sceneId: string; patch: Partial<Transition> }
  | { type: 'voice.applyAll'; fromSceneId: string }
  | { type: 'layer.add'; sceneId: string; layer: NewLayerInput }
  | { type: 'layer.patch'; sceneId: string; layerId: string; patch: LayerPatch }
  | { type: 'layer.style'; sceneId: string; layerId: string; patch: Partial<TextStyle> }
  | { type: 'layer.remove'; sceneId: string; layerId: string }
  | { type: 'layer.duplicate'; sceneId: string; layerId: string; name: string }
  | { type: 'layer.order'; sceneId: string; layerId: string; order: LayerOrder }
  | { type: 'subtitles.patch'; patch: Partial<SubtitleStyle> }
  | { type: 'music.set'; music: MusicTrack | null }
  | { type: 'music.patch'; patch: Partial<MusicTrack> }
  | { type: 'variable.patch'; name: string; patch: Partial<Omit<VariableDef, 'name'>> }
  | { type: 'composition.replace'; composition: Composition };

export interface ActionResult {
  doc: EditorDoc;
  /** Selection the action asks for (new scene, new layer…). */
  select?: Partial<Selection>;
}

const clampIndex = (index: number, length: number) => Math.max(0, Math.min(length - 1, index));

/** Layers of a scene in paint order (z ascending, ties by array order). */
export function paintOrder(scene: Scene): Layer[] {
  return scene.layers
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => a.layer.z - b.layer.z || a.index - b.index)
    .map((entry) => entry.layer);
}

function sameVariables(a: readonly VariableDef[], b: readonly VariableDef[]): boolean {
  return (
    a.length === b.length &&
    a.every((v, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        v.name === other.name &&
        v.label === other.label &&
        v.defaultValue === other.defaultValue
      );
    })
  );
}

/** A new scene that continues `reference`: same voice, background and avatar, empty script. */
function sceneAfter(reference: Scene | undefined, name: string): Scene {
  if (!reference) return createScene({ name });
  const script: Script =
    reference.script.kind === 'tts' ? { ...reference.script, text: '' } : { kind: 'none' };
  const scene = createScene({
    name,
    script,
    background: structuredClone(reference.background),
    transition: { type: 'fade', durationMs: 400 },
  });
  scene.layers = reference.layers
    .filter((layer) => layer.type === 'avatar')
    .map((layer) => ({ ...structuredClone(layer), id: newId('layer') }));
  return scene;
}

const clampTo = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Change the format. Boxes are normalised, so the layout follows the canvas (`withAspect`).
 * Text sizes are fractions of the canvas HEIGHT: they are rescaled so every text keeps its
 * size in pixels. A box keeps its area in pixels when the canvas is rotated (narrower but
 * taller), so a headline made for 16:9 re-wraps and still fits in 9:16 instead of overflowing.
 */
export function retarget(composition: Composition, aspect: AspectRatio): Composition {
  const next = withAspect(composition, aspect);
  const k = composition.canvas.height / next.canvas.height;
  if (Math.abs(k - 1) < 1e-6) return next;
  return produce(next, (draft) => {
    for (const scene of draft.scenes) {
      for (const layer of scene.layers) {
        if (layer.type !== 'text') continue;
        const style = layer.style;
        style.fontSize = clampTo(style.fontSize * k, 0.005, 0.5);
        if (style.background) {
          style.background.padding = clampTo(style.background.padding * k, 0, 0.2);
          style.background.radius = clampTo(style.background.radius * k, 0, 0.5);
        }
        if (style.stroke) style.stroke.width = clampTo(style.stroke.width * k, 0, 0.05);
      }
    }
  });
}

/** Apply one edit. Invalid edits (unknown ids, limits reached) return the same document. */
export function applyAction(doc: EditorDoc, action: EditorAction): ActionResult {
  let select: Partial<Selection> | undefined;
  if (action.type === 'title.set') {
    return action.title === doc.title ? { doc } : { doc: { ...doc, title: action.title } };
  }
  if (action.type === 'composition.replace') {
    return { doc: { ...doc, composition: action.composition } };
  }
  if (action.type === 'aspect.set') {
    if (doc.composition.canvas.aspect === action.aspect) return { doc };
    return { doc: { ...doc, composition: retarget(doc.composition, action.aspect) } };
  }

  const composition = produce(doc.composition, (draft) => {
    const sceneOf = (sceneId: string) => draft.scenes.find((scene) => scene.id === sceneId);
    const layerOf = (sceneId: string, layerId: string) =>
      sceneOf(sceneId)?.layers.find((layer) => layer.id === layerId);

    switch (action.type) {
      case 'scene.add': {
        if (draft.scenes.length >= COMPOSITION_LIMITS.maxScenes) return;
        const at = draft.scenes.findIndex((scene) => scene.id === action.afterSceneId);
        const index = at === -1 ? draft.scenes.length : at + 1;
        // Read the reference from the original document: drafts cannot be structured-cloned.
        const scene = sceneAfter(doc.composition.scenes[index - 1], action.name);
        draft.scenes.splice(index, 0, scene);
        select = { sceneId: scene.id, layerId: null };
        return;
      }
      case 'scene.duplicate': {
        if (draft.scenes.length >= COMPOSITION_LIMITS.maxScenes) return;
        const index = draft.scenes.findIndex((scene) => scene.id === action.sceneId);
        const source = draft.scenes[index];
        if (!source) return;
        const copy = structuredClone(
          doc.composition.scenes.find((scene) => scene.id === action.sceneId) as Scene,
        );
        copy.id = newId('scene');
        copy.name = action.name.slice(0, 80);
        for (const layer of copy.layers) layer.id = newId('layer');
        draft.scenes.splice(index + 1, 0, copy);
        select = { sceneId: copy.id, layerId: null };
        return;
      }
      case 'scene.remove': {
        if (draft.scenes.length <= 1) return;
        const index = draft.scenes.findIndex((scene) => scene.id === action.sceneId);
        if (index === -1) return;
        draft.scenes.splice(index, 1);
        const neighbour = draft.scenes[clampIndex(index, draft.scenes.length)];
        if (neighbour) select = { sceneId: neighbour.id, layerId: null };
        return;
      }
      case 'scene.move': {
        const from = draft.scenes.findIndex((scene) => scene.id === action.sceneId);
        const to = clampIndex(action.toIndex, draft.scenes.length);
        if (from === -1 || from === to) return;
        const [moved] = draft.scenes.splice(from, 1);
        if (moved) draft.scenes.splice(to, 0, moved);
        return;
      }
      case 'scene.patch': {
        const scene = sceneOf(action.sceneId);
        if (scene) Object.assign(scene, action.patch);
        return;
      }
      case 'scene.script': {
        const scene = sceneOf(action.sceneId);
        if (scene) scene.script = action.script;
        return;
      }
      case 'scene.scriptPatch': {
        const scene = sceneOf(action.sceneId);
        if (!scene || scene.script.kind === 'none') return;
        const script = scene.script as Record<string, unknown>;
        for (const [key, value] of Object.entries(action.patch)) {
          if (key in script || key === 'language') script[key] = value;
        }
        return;
      }
      case 'scene.background': {
        const scene = sceneOf(action.sceneId);
        if (scene) scene.background = action.background;
        return;
      }
      case 'scene.transition': {
        const scene = sceneOf(action.sceneId);
        if (scene) Object.assign(scene.transition, action.patch);
        return;
      }
      case 'voice.applyAll': {
        const source = sceneOf(action.fromSceneId)?.script;
        if (!source || source.kind !== 'tts') return;
        for (const scene of draft.scenes) {
          if (scene.script.kind !== 'tts') continue;
          scene.script.voiceId = source.voiceId;
          scene.script.language = source.language;
          scene.script.speed = source.speed;
          scene.script.pitch = source.pitch;
        }
        return;
      }
      case 'layer.add': {
        const scene = sceneOf(action.sceneId);
        if (!scene || scene.layers.length >= COMPOSITION_LIMITS.maxLayersPerScene) return;
        const top = scene.layers.reduce((max, layer) => Math.max(max, layer.z), 0);
        const layer = createLayer({ ...action.layer, z: action.layer.z ?? top + 1 });
        scene.layers.push(layer);
        select = { sceneId: scene.id, layerId: layer.id };
        return;
      }
      case 'layer.patch': {
        const layer = layerOf(action.sceneId, action.layerId) as
          Record<string, unknown> | undefined;
        if (!layer) return;
        for (const [key, value] of Object.entries(action.patch)) {
          // Optional members (enter, exit, timing, role) may be absent; `undefined` removes them.
          if (value === undefined) delete layer[key];
          else if (key in layer || OPTIONAL_LAYER_KEYS.has(key)) layer[key] = value;
        }
        return;
      }
      case 'layer.style': {
        const layer = layerOf(action.sceneId, action.layerId);
        if (layer?.type === 'text') Object.assign(layer.style, action.patch);
        return;
      }
      case 'layer.remove': {
        const scene = sceneOf(action.sceneId);
        if (!scene) return;
        const index = scene.layers.findIndex((layer) => layer.id === action.layerId);
        if (index === -1) return;
        scene.layers.splice(index, 1);
        select = { layerId: null };
        return;
      }
      case 'layer.duplicate': {
        const scene = sceneOf(action.sceneId);
        const source = doc.composition.scenes
          .find((s) => s.id === action.sceneId)
          ?.layers.find((layer) => layer.id === action.layerId);
        if (!scene || !source) return;
        if (scene.layers.length >= COMPOSITION_LIMITS.maxLayersPerScene) return;
        const copy = structuredClone(source);
        copy.id = newId('layer');
        copy.name = action.name.slice(0, 80);
        copy.box = {
          ...copy.box,
          x: Math.min(3, copy.box.x + 0.03),
          y: Math.min(3, copy.box.y + 0.03),
        };
        copy.z = scene.layers.reduce((max, layer) => Math.max(max, layer.z), 0) + 1;
        scene.layers.push(copy);
        select = { sceneId: scene.id, layerId: copy.id };
        return;
      }
      case 'layer.order': {
        const scene = sceneOf(action.sceneId);
        if (!scene) return;
        const order = paintOrder(scene as Scene).map((layer) => layer.id);
        const from = order.indexOf(action.layerId);
        if (from === -1) return;
        const to =
          action.order === 'front'
            ? order.length - 1
            : action.order === 'back'
              ? 0
              : clampIndex(from + (action.order === 'forward' ? 1 : -1), order.length);
        if (to === from) return;
        order.splice(from, 1);
        order.splice(to, 0, action.layerId);
        // Normalise z to the position in paint order: stable and free of ties.
        for (const layer of scene.layers) layer.z = order.indexOf(layer.id);
        return;
      }
      case 'subtitles.patch':
        Object.assign(draft.subtitles, action.patch);
        return;
      case 'music.set':
        draft.music = action.music;
        return;
      case 'music.patch':
        if (draft.music) Object.assign(draft.music, action.patch);
        return;
      case 'variable.patch': {
        const variable = draft.variables.find((v) => v.name === action.name);
        if (variable) Object.assign(variable, action.patch);
        return;
      }
    }
  });

  if (composition === doc.composition) return { doc };
  // Keep the declared `{{variables}}` in step with the texts (batch and API v1 read them).
  const variables = syncVariableDefs(composition).slice(0, COMPOSITION_LIMITS.maxVariables);
  const synced = sameVariables(variables, composition.variables)
    ? composition
    : { ...composition, variables };
  return { doc: { ...doc, composition: synced }, select };
}

const OPTIONAL_LAYER_KEYS = new Set(['enter', 'exit', 'timing', 'role']);

/* ---------- editor state: document history + selection ---------- */

export interface EditorState {
  history: History<EditorDoc>;
  selection: Selection;
  /** Incremented on every document change (edit, undo, redo): drives autosave. */
  version: number;
}

export type EditorCommand =
  | { type: 'apply'; action: EditorAction; mergeKey?: string; now: number }
  | { type: 'undo' }
  | { type: 'redo' }
  /** End a gesture: the next edit with the same merge key becomes its own undo step. */
  | { type: 'seal' }
  | { type: 'select'; sceneId?: string; layerId?: string | null }
  /** Replace the document and drop the history (server version adopted after a conflict). */
  | { type: 'reset'; doc: EditorDoc };

export function createEditorState(doc: EditorDoc): EditorState {
  const first = doc.composition.scenes[0];
  return {
    history: createHistory(doc),
    selection: { sceneId: first?.id ?? '', layerId: null },
    version: 0,
  };
}

/** A selection that points at things that exist in `doc` (falls back to the nearest scene). */
export function normaliseSelection(
  doc: EditorDoc,
  selection: Selection,
  fallbackIndex = 0,
): Selection {
  const scenes = doc.composition.scenes;
  const scene =
    scenes.find((s) => s.id === selection.sceneId) ??
    scenes[clampIndex(fallbackIndex, scenes.length)];
  if (!scene) return { sceneId: '', layerId: null };
  const layerId =
    scene.id === selection.sceneId && scene.layers.some((layer) => layer.id === selection.layerId)
      ? selection.layerId
      : null;
  return { sceneId: scene.id, layerId };
}

export function editorReducer(state: EditorState, command: EditorCommand): EditorState {
  const doc = state.history.present;
  const sceneIndex = doc.composition.scenes.findIndex((s) => s.id === state.selection.sceneId);
  switch (command.type) {
    case 'apply': {
      const result = applyAction(doc, command.action);
      if (result.doc === doc) return state;
      return {
        history: pushHistory(state.history, result.doc, {
          mergeKey: command.mergeKey,
          now: command.now,
        }),
        selection: normaliseSelection(
          result.doc,
          { ...state.selection, ...result.select },
          sceneIndex,
        ),
        version: state.version + 1,
      };
    }
    case 'undo':
    case 'redo': {
      const able = command.type === 'undo' ? canUndo(state.history) : canRedo(state.history);
      if (!able) return state;
      const history =
        command.type === 'undo' ? undoHistory(state.history) : redoHistory(state.history);
      return {
        history,
        selection: normaliseSelection(history.present, state.selection, sceneIndex),
        version: state.version + 1,
      };
    }
    case 'seal': {
      const history = sealHistory(state.history);
      return history === state.history ? state : { ...state, history };
    }
    case 'select': {
      const selection = normaliseSelection(
        doc,
        {
          sceneId: command.sceneId ?? state.selection.sceneId,
          layerId:
            command.layerId !== undefined
              ? command.layerId
              : command.sceneId !== undefined && command.sceneId !== state.selection.sceneId
                ? null
                : state.selection.layerId,
        },
        sceneIndex,
      );
      if (
        selection.sceneId === state.selection.sceneId &&
        selection.layerId === state.selection.layerId
      ) {
        return state;
      }
      return { ...state, selection, history: sealHistory(state.history) };
    }
    case 'reset':
      return {
        history: createHistory(command.doc),
        selection: normaliseSelection(command.doc, state.selection, sceneIndex),
        version: state.version + 1,
      };
  }
}
