import type { Composition, Layer, Scene, Video } from '@parlante/shared';
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { createStore, useStore } from 'zustand';
import type { StoreApi } from 'zustand';
import type { Autosaver, AutosaveSnapshot } from '../model/autosave';
import { createEditorState, editorReducer } from '../model/editor';
import type { EditorAction, EditorDoc, EditorState } from '../model/editor';
import { canRedo, canUndo } from '../model/history';
import type { PreviewEngine, PreviewState } from '../preview/engine';
import type { StudioLibrary } from './library';

/* The Studio keeps its document in one store per open video: the pure `editorReducer` wrapped
 * in zustand, so panels subscribe to exactly the slice they show. */

export interface StudioStore extends EditorState {
  apply: (action: EditorAction, mergeKey?: string) => void;
  undo: () => void;
  redo: () => void;
  /** End a gesture (pointer released, field blurred): the next edit is a new undo step. */
  seal: () => void;
  select: (target: { sceneId?: string; layerId?: string | null }) => void;
  reset: (doc: EditorDoc) => void;
}

export function createStudioStore(doc: EditorDoc): StoreApi<StudioStore> {
  return createStore<StudioStore>((set) => {
    const run = (command: Parameters<typeof editorReducer>[1]) =>
      set((state) => {
        const next = editorReducer(state, command);
        return next === state ? state : next;
      });
    return {
      ...createEditorState(doc),
      apply: (action, mergeKey) => run({ type: 'apply', action, mergeKey, now: Date.now() }),
      undo: () => run({ type: 'undo' }),
      redo: () => run({ type: 'redo' }),
      seal: () => run({ type: 'seal' }),
      select: (target) => run({ type: 'select', ...target }),
      reset: (next) => run({ type: 'reset', doc: next }),
    };
  });
}

export type StudioDialog = 'render' | 'template' | 'shortcuts' | null;

export interface StudioContextValue {
  /** Latest server copy of the video (status, outputs, revision). */
  video: Video;
  store: StoreApi<StudioStore>;
  engine: PreviewEngine;
  saver: Autosaver;
  save: AutosaveSnapshot;
  library: StudioLibrary;
  openDialog: (dialog: StudioDialog) => void;
  /** Play the selected scene / the whole video / from the playhead; pause when playing. */
  playScene: () => void;
  playAll: () => void;
  togglePlay: () => void;
  /** Move the playhead freely; the scene under it becomes the selected one. */
  scrub: (tMs: number) => void;
}

export const StudioContext = createContext<StudioContextValue | null>(null);

export function useStudio(): StudioContextValue {
  const value = useContext(StudioContext);
  if (!value) throw new Error('useStudio must be used inside the Studio editor');
  return value;
}

export function useEditor<T>(selector: (state: StudioStore) => T): T {
  return useStore(useStudio().store, selector);
}

export const selectDoc = (state: StudioStore): EditorDoc => state.history.present;
export const selectComposition = (state: StudioStore): Composition =>
  state.history.present.composition;
export const selectScene = (state: StudioStore): Scene | undefined =>
  state.history.present.composition.scenes.find((s) => s.id === state.selection.sceneId);
export const selectLayer = (state: StudioStore): Layer | undefined =>
  selectScene(state)?.layers.find((layer) => layer.id === state.selection.layerId);
export const selectCanUndo = (state: StudioStore): boolean => canUndo(state.history);
export const selectCanRedo = (state: StudioStore): boolean => canRedo(state.history);

/** The selected scene and helpers to edit it. */
export function useSceneEditing() {
  const { store } = useStudio();
  const scene = useEditor(selectScene);
  const apply = store.getState().apply;
  const seal = store.getState().seal;
  const sceneId = scene?.id ?? '';
  const patchLayer = useCallback(
    (
      layerId: string,
      patch: Extract<EditorAction, { type: 'layer.patch' }>['patch'],
      key?: string,
    ) =>
      apply(
        { type: 'layer.patch', sceneId, layerId, patch },
        key ? `${layerId}:${key}` : undefined,
      ),
    [apply, sceneId],
  );
  return { scene, apply, seal, patchLayer };
}

export function usePreviewState(): PreviewState {
  const { engine } = useStudio();
  return useSyncExternalStore(engine.subscribe, engine.getState, engine.getState);
}

/** Playhead in ms. Re-renders on every frame while playing: use it in small components. */
export function usePlayhead(): number {
  const { engine } = useStudio();
  return useSyncExternalStore(engine.subscribeTime, engine.getTime, engine.getTime);
}
