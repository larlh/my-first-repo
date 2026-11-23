import { CompositionSchema, compositionFromScript, createComposition } from '@parlante/shared';
import type { Composition } from '@parlante/shared';
import { computeTimeline } from '@parlante/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Autosaver } from './autosave';
import type { AutosaveSnapshot, SavePayload } from './autosave';
import { applyAction, createEditorState, editorReducer, paintOrder } from './editor';
import type { EditorAction, EditorDoc, EditorState } from './editor';
import { clampBox, resizeBox, snapMove, snapResize } from './geometry';
import { createHistory, pushHistory, redoHistory, undoHistory } from './history';
import {
  editInstantMs,
  previewComposition,
  sceneDurationInfo,
  spokenText,
  wordCount,
} from './timing';

function sampleDoc(): EditorDoc {
  const composition = compositionFromScript(
    [
      { text: 'Hola, te doy la bienvenida.', headline: 'Bienvenida', title: 'Intro' },
      { text: 'Esto es la segunda escena.', headline: 'Segunda', title: 'Cuerpo' },
    ],
    { avatarId: 'stock_lucia', voiceId: 'espeak:es-f1', language: 'es' },
  );
  return { title: 'Demo', composition };
}

function run(state: EditorState, action: EditorAction, mergeKey?: string, now = 0): EditorState {
  return editorReducer(state, { type: 'apply', action, mergeKey, now });
}

const valid = (composition: Composition) => CompositionSchema.safeParse(composition).success;

describe('applyAction', () => {
  it('adds a scene after the given one that inherits voice, background and avatar', () => {
    const doc = sampleDoc();
    const first = doc.composition.scenes[0]!;
    const result = applyAction(doc, { type: 'scene.add', afterSceneId: first.id, name: 'Nueva' });
    const scenes = result.doc.composition.scenes;
    expect(scenes).toHaveLength(3);
    const added = scenes[1]!;
    expect(added.name).toBe('Nueva');
    expect(added.script).toMatchObject({ kind: 'tts', text: '', voiceId: 'espeak:es-f1' });
    expect(added.layers.map((l) => l.type)).toEqual(['avatar']);
    expect(added.layers[0]!.id).not.toBe(first.layers[0]!.id);
    expect(added.background).toEqual(first.background);
    expect(result.select).toEqual({ sceneId: added.id, layerId: null });
    expect(valid(result.doc.composition)).toBe(true);
    // Untouched scenes keep their identity (thumbnails are memoised on it).
    expect(scenes[0]).toBe(first);
  });

  it('duplicates a scene with fresh ids and removes scenes but never the last one', () => {
    const doc = sampleDoc();
    const first = doc.composition.scenes[0]!;
    const duplicated = applyAction(doc, {
      type: 'scene.duplicate',
      sceneId: first.id,
      name: 'Intro (copia)',
    }).doc;
    const copy = duplicated.composition.scenes[1]!;
    expect(copy.name).toBe('Intro (copia)');
    expect(copy.id).not.toBe(first.id);
    expect(copy.layers.map((l) => l.id)).not.toEqual(first.layers.map((l) => l.id));
    expect(copy.script).toEqual(first.script);
    expect(valid(duplicated.composition)).toBe(true);

    let current = duplicated;
    for (const scene of duplicated.composition.scenes) {
      current = applyAction(current, { type: 'scene.remove', sceneId: scene.id }).doc;
    }
    expect(current.composition.scenes).toHaveLength(1);
  });

  it('reorders scenes', () => {
    const doc = sampleDoc();
    const [a, b] = doc.composition.scenes.map((s) => s.id) as [string, string];
    const moved = applyAction(doc, { type: 'scene.move', sceneId: a, toIndex: 1 }).doc;
    expect(moved.composition.scenes.map((s) => s.id)).toEqual([b, a]);
    expect(applyAction(doc, { type: 'scene.move', sceneId: a, toIndex: 0 }).doc).toBe(doc);
  });

  it('patches script, layers and text style, ignoring unknown ids', () => {
    const doc = sampleDoc();
    const scene = doc.composition.scenes[0]!;
    const text = scene.layers.find((l) => l.type === 'text')!;
    let next = applyAction(doc, {
      type: 'scene.scriptPatch',
      sceneId: scene.id,
      patch: { text: 'Nuevo guion', speed: 1.25 },
    }).doc;
    next = applyAction(next, {
      type: 'layer.patch',
      sceneId: scene.id,
      layerId: text.id,
      patch: { box: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, opacity: 0.5, text: 'Hola' },
    }).doc;
    next = applyAction(next, {
      type: 'layer.style',
      sceneId: scene.id,
      layerId: text.id,
      patch: { color: '#ff0000', fontSize: 0.1 },
    }).doc;
    const edited = next.composition.scenes[0]!;
    expect(edited.script).toMatchObject({ text: 'Nuevo guion', speed: 1.25 });
    expect(edited.layers.find((l) => l.id === text.id)).toMatchObject({
      box: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 },
      opacity: 0.5,
      text: 'Hola',
      style: { color: '#ff0000', fontSize: 0.1 },
    });
    expect(valid(next.composition)).toBe(true);
    expect(applyAction(doc, { type: 'layer.remove', sceneId: scene.id, layerId: 'nope' }).doc).toBe(
      doc,
    );
  });

  it('adds, duplicates and reorders layers with normalised z', () => {
    const doc = sampleDoc();
    const scene = doc.composition.scenes[0]!;
    const added = applyAction(doc, {
      type: 'layer.add',
      sceneId: scene.id,
      layer: { type: 'shape', name: 'Forma', box: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 } },
    });
    const shapeId = added.select!.layerId!;
    let scene1 = added.doc.composition.scenes[0]!;
    expect(paintOrder(scene1).at(-1)!.id).toBe(shapeId);

    const back = applyAction(added.doc, {
      type: 'layer.order',
      sceneId: scene.id,
      layerId: shapeId,
      order: 'back',
    }).doc;
    scene1 = back.composition.scenes[0]!;
    expect(paintOrder(scene1)[0]!.id).toBe(shapeId);
    expect(scene1.layers.map((l) => l.z).sort()).toEqual([0, 1, 2]);

    const forward = applyAction(back, {
      type: 'layer.order',
      sceneId: scene.id,
      layerId: shapeId,
      order: 'forward',
    }).doc;
    expect(paintOrder(forward.composition.scenes[0]!)[1]!.id).toBe(shapeId);

    const copy = applyAction(forward, {
      type: 'layer.duplicate',
      sceneId: scene.id,
      layerId: shapeId,
      name: 'Forma (copia)',
    });
    const duplicated = copy.doc.composition.scenes[0]!;
    expect(duplicated.layers).toHaveLength(4);
    expect(paintOrder(duplicated).at(-1)!.name).toBe('Forma (copia)');
    expect(valid(copy.doc.composition)).toBe(true);
  });

  it('keeps declared variables in step with the texts', () => {
    const doc = sampleDoc();
    const scene = doc.composition.scenes[0]!;
    const withVar = applyAction(doc, {
      type: 'scene.scriptPatch',
      sceneId: scene.id,
      patch: { text: 'Hola {{nombre}}, bienvenida.' },
    }).doc;
    expect(withVar.composition.variables.map((v) => v.name)).toEqual(['nombre']);
    const defaulted = applyAction(withVar, {
      type: 'variable.patch',
      name: 'nombre',
      patch: { defaultValue: 'Marta' },
    }).doc;
    expect(defaulted.composition.variables[0]).toMatchObject({ defaultValue: 'Marta' });
    const without = applyAction(defaulted, {
      type: 'scene.scriptPatch',
      sceneId: scene.id,
      patch: { text: 'Hola.' },
    }).doc;
    expect(without.composition.variables).toEqual([]);
  });

  it('changes the format keeping the layout, applies a voice to every scene', () => {
    const doc = sampleDoc();
    const vertical = applyAction(doc, { type: 'aspect.set', aspect: '9:16' }).doc;
    expect(vertical.composition.canvas).toMatchObject({ aspect: '9:16', width: 720, height: 1280 });
    expect(valid(vertical.composition)).toBe(true);
    // Text keeps its size in pixels (font sizes are fractions of the canvas height).
    const headlinePx = (c: Composition) => {
      const layer = c.scenes[0]!.layers.find((l) => l.type === 'text')!;
      if (layer.type !== 'text') throw new Error('not a text layer');
      return layer.style.fontSize * c.canvas.height;
    };
    expect(headlinePx(vertical.composition)).toBeCloseTo(headlinePx(doc.composition), 6);
    const back = applyAction(vertical, { type: 'aspect.set', aspect: '16:9' }).doc;
    expect(headlinePx(back.composition)).toBeCloseTo(headlinePx(doc.composition), 6);
    const square = applyAction(doc, { type: 'aspect.set', aspect: '1:1' }).doc;
    expect(headlinePx(square.composition)).toBeCloseTo(headlinePx(doc.composition), 6);
    const scene = doc.composition.scenes[0]!;
    const changed = applyAction(doc, {
      type: 'scene.scriptPatch',
      sceneId: scene.id,
      patch: { voiceId: 'espeak:en-m1', language: 'en' },
    }).doc;
    const all = applyAction(changed, { type: 'voice.applyAll', fromSceneId: scene.id }).doc;
    expect(
      all.composition.scenes.map((s) => (s.script.kind === 'tts' ? s.script.voiceId : '')),
    ).toEqual(['espeak:en-m1', 'espeak:en-m1']);
  });
});

describe('history', () => {
  it('merges bursts with the same key into one step and undoes / redoes', () => {
    let history = createHistory('a');
    history = pushHistory(history, 'ab', { mergeKey: 'type', now: 0 });
    history = pushHistory(history, 'abc', { mergeKey: 'type', now: 500 });
    expect(history.past).toEqual(['a']);
    history = pushHistory(history, 'abcd', { mergeKey: 'type', now: 5000 });
    expect(history.past).toEqual(['a', 'abc']);
    history = pushHistory(history, 'x', { now: 5001 });
    expect(history.past).toEqual(['a', 'abc', 'abcd']);
    history = undoHistory(undoHistory(history));
    expect(history.present).toBe('abc');
    expect(history.future).toEqual(['abcd', 'x']);
    history = redoHistory(history);
    expect(history.present).toBe('abcd');
    // A new edit drops the redo branch.
    history = pushHistory(history, 'y', { now: 6000 });
    expect(history.future).toEqual([]);
  });

  it('caps the number of steps', () => {
    let history = createHistory(0);
    for (let i = 1; i <= 10; i += 1) history = pushHistory(history, i, { now: i, limit: 3 });
    expect(history.past).toEqual([7, 8, 9]);
  });
});

describe('editorReducer', () => {
  it('undoes and redoes edits, counts versions and follows the selection', () => {
    const doc = sampleDoc();
    let state = createEditorState(doc);
    const firstId = doc.composition.scenes[0]!.id;
    expect(state.selection).toEqual({ sceneId: firstId, layerId: null });

    state = run(state, { type: 'scene.add', afterSceneId: firstId, name: 'Nueva' });
    const addedId = state.selection.sceneId;
    expect(addedId).not.toBe(firstId);
    expect(state.version).toBe(1);

    state = editorReducer(state, { type: 'undo' });
    expect(state.history.present).toBe(doc);
    expect(state.version).toBe(2);
    // The selected scene no longer exists: the selection falls back to a real one.
    expect(doc.composition.scenes.some((s) => s.id === state.selection.sceneId)).toBe(true);

    state = editorReducer(state, { type: 'redo' });
    expect(state.history.present.composition.scenes).toHaveLength(3);
    expect(editorReducer(state, { type: 'redo' })).toBe(state);
  });

  it('collapses a drag into one undo step and seals it on release', () => {
    const doc = sampleDoc();
    const scene = doc.composition.scenes[0]!;
    const layer = scene.layers[0]!;
    let state = createEditorState(doc);
    const move = (x: number): EditorAction => ({
      type: 'layer.patch',
      sceneId: scene.id,
      layerId: layer.id,
      patch: { box: { ...layer.box, x } },
    });
    state = run(state, move(0.1), 'drag', 0);
    state = run(state, move(0.2), 'drag', 16);
    state = run(state, move(0.3), 'drag', 32);
    expect(state.history.past).toHaveLength(1);
    state = editorReducer(state, { type: 'seal' });
    state = run(state, move(0.4), 'drag', 48);
    expect(state.history.past).toHaveLength(2);
    state = editorReducer(state, { type: 'undo' });
    expect(state.history.present.composition.scenes[0]!.layers[0]!.box.x).toBe(0.3);
    state = editorReducer(state, { type: 'undo' });
    expect(state.history.present).toBe(doc);
  });

  it('selecting another scene clears the layer selection; reset drops the history', () => {
    const doc = sampleDoc();
    const [a, b] = doc.composition.scenes;
    let state = createEditorState(doc);
    state = editorReducer(state, { type: 'select', layerId: a!.layers[0]!.id });
    expect(state.selection.layerId).toBe(a!.layers[0]!.id);
    state = editorReducer(state, { type: 'select', sceneId: b!.id });
    expect(state.selection).toEqual({ sceneId: b!.id, layerId: null });
    state = run(state, { type: 'title.set', title: 'Otro' });
    state = editorReducer(state, {
      type: 'reset',
      doc: { title: 'Servidor', composition: createComposition() },
    });
    expect(state.history.past).toEqual([]);
    expect(state.history.present.title).toBe('Servidor');
    expect(state.selection.sceneId).toBe(state.history.present.composition.scenes[0]!.id);
  });
});

describe('geometry', () => {
  const canvas = { width: 1280, height: 720 };

  it('resizes from a corner keeping the opposite corner fixed', () => {
    const box = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    const grown = resizeBox(box, 'se', 0.1, 0.05, { canvas });
    expect(grown.x).toBeCloseTo(0.2);
    expect(grown.y).toBeCloseTo(0.2);
    expect(grown.w).toBeCloseTo(0.5);
    expect(grown.h).toBeCloseTo(0.45);
    const fromTopLeft = resizeBox(box, 'nw', 0.1, 0.1, { canvas });
    expect(fromTopLeft.x + fromTopLeft.w).toBeCloseTo(0.6);
    expect(fromTopLeft.y + fromTopLeft.h).toBeCloseTo(0.6);
    expect(fromTopLeft.w).toBeCloseTo(0.3);
  });

  it('keeps the ratio when asked and never collapses the box', () => {
    const box = { x: 0.2, y: 0.2, w: 0.4, h: 0.2 };
    const scaled = resizeBox(box, 'se', 0.2, 0, { canvas, keepRatio: true });
    expect(scaled.w / scaled.h).toBeCloseTo(2);
    const collapsed = resizeBox(box, 'e', -5, 0, { canvas });
    expect(collapsed.w).toBeGreaterThan(0);
  });

  it('keeps the anchor of a rotated layer in place', () => {
    const box = { x: 0.3, y: 0.3, w: 0.2, h: 0.2 };
    const rotation = 90;
    const corner = (b: typeof box, sx: number, sy: number) => {
      // World position (px) of a corner of the box rotated around its centre.
      const cx = (b.x + b.w / 2) * canvas.width;
      const cy = (b.y + b.h / 2) * canvas.height;
      const lx = (sx * b.w * canvas.width) / 2;
      const ly = (sy * b.h * canvas.height) / 2;
      const t = (rotation * Math.PI) / 180;
      return [cx + lx * Math.cos(t) - ly * Math.sin(t), cy + lx * Math.sin(t) + ly * Math.cos(t)];
    };
    const before = corner(box, -1, -1);
    const resized = resizeBox(box, 'se', 0.05, 0.08, { canvas, rotation });
    const after = corner(resized, -1, -1);
    expect(after[0]).toBeCloseTo(before[0]!, 4);
    expect(after[1]).toBeCloseTo(before[1]!, 4);
    expect(resized.w).not.toBeCloseTo(box.w);
  });

  it('snaps a moved box to the canvas centre and to other layers, reporting guides', () => {
    const threshold = { x: 0.01, y: 0.01 };
    const centred = snapMove({ x: 0.395, y: 0.1, w: 0.2, h: 0.2 }, [], threshold);
    expect(centred.box.x).toBeCloseTo(0.4);
    expect(centred.guides).toEqual([{ axis: 'x', at: 0.5 }]);
    const other = { x: 0.7, y: 0.305, w: 0.2, h: 0.3 };
    const aligned = snapMove({ x: 0.13, y: 0.31, w: 0.2, h: 0.17 }, [other], threshold);
    expect(aligned.box.y).toBeCloseTo(0.305);
    expect(aligned.guides).toEqual([{ axis: 'y', at: 0.305 }]);
    const free = snapMove({ x: 0.13, y: 0.33, w: 0.2, h: 0.21 }, [], threshold);
    expect(free.guides).toEqual([]);
  });

  it('snaps the dragged edge while resizing and clamps to the schema limits', () => {
    const snapped = snapResize({ x: 0.1, y: 0.1, w: 0.395, h: 0.2 }, 'e', [], { x: 0.01, y: 0.01 });
    expect(snapped.box.w).toBeCloseTo(0.4);
    expect(snapped.guides).toEqual([{ axis: 'x', at: 0.5 }]);
    expect(clampBox({ x: -9, y: 9, w: 0, h: 99 })).toEqual({ x: -2, y: 3, w: 0.01, h: 4 });
  });
});

describe('timing', () => {
  it('estimates the scene length until the audio exists, then uses the measured one', () => {
    const scene = sampleDoc().composition.scenes[0]!;
    const estimated = sceneDurationInfo(scene, undefined);
    expect(estimated.estimated).toBe(true);
    expect(estimated.durationMs).toBe(
      scene.paddingStartMs + estimated.narrationMs + scene.paddingEndMs,
    );
    const measured = sceneDurationInfo(scene, { audioDurationMs: 2000, visemes: [], words: [] });
    expect(measured).toEqual({ durationMs: 2800, narrationMs: 2000, estimated: false });
    expect(wordCount('  uno dos\ntres ')).toBe(3);
    expect(wordCount('')).toBe(0);
  });

  it('parks the playhead after transitions and entrances, inside the scene', () => {
    const { composition } = sampleDoc();
    const timeline = computeTimeline(composition, { scenes: {} }, { estimateMissing: true });
    const second = composition.scenes[1]!;
    const timing = timeline.scenes[1]!;
    const instant = editInstantMs(second, timing);
    expect(instant).toBeGreaterThanOrEqual(timing.startMs + 400);
    expect(instant).toBeLessThan(timing.endMs);
  });

  it('previews variables with their defaults and speaks the rest by name', () => {
    const doc = sampleDoc();
    const scene = doc.composition.scenes[0]!;
    const text = scene.layers.find((l) => l.type === 'text')!;
    let next = applyAction(doc, {
      type: 'layer.patch',
      sceneId: scene.id,
      layerId: text.id,
      patch: { text: 'Hola {{nombre}} de {{empresa}}' },
    }).doc;
    expect(previewComposition(next.composition)).toBe(next.composition);
    next = applyAction(next, {
      type: 'variable.patch',
      name: 'nombre',
      patch: { defaultValue: 'Marta' },
    }).doc;
    const preview = previewComposition(next.composition);
    const shown = preview.scenes[0]!.layers.find((l) => l.id === text.id);
    expect(shown).toMatchObject({ text: 'Hola Marta de {{empresa}}' });
    expect(preview.scenes[1]).toBe(next.composition.scenes[1]);
    expect(spokenText(' Hola {{nombre}} de {{empresa}} ', { nombre: 'Marta' })).toBe(
      'Hola Marta de empresa',
    );
  });
});

describe('Autosaver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(save: (payload: SavePayload) => Promise<{ revision: number }>) {
    const state = { doc: sampleDoc() };
    const snapshots: AutosaveSnapshot[] = [];
    const saver = new Autosaver({
      baseRevision: 3,
      read: () => state.doc,
      save,
      conflictOf: (error) =>
        error instanceof Error && error.message.startsWith('conflict')
          ? Number(error.message.split(':')[1]) || true
          : null,
      onChange: (snapshot) => snapshots.push(snapshot),
      delayMs: 1000,
      retryMs: 2000,
    });
    const edit = (title: string) => {
      state.doc = { ...state.doc, title };
      saver.notifyChange();
    };
    return { state, saver, snapshots, edit, statuses: () => snapshots.map((s) => s.status) };
  }

  it('debounces edits into one save that carries the base revision', async () => {
    const save = vi.fn(async (payload: SavePayload) => ({ revision: payload.baseRevision + 1 }));
    const { saver, edit, statuses } = setup(save);
    edit('a');
    edit('ab');
    edit('abc');
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({ title: 'abc', baseRevision: 3 });
    expect(saver.snapshot()).toMatchObject({ status: 'saved', baseRevision: 4 });
    expect(statuses()).toEqual(['dirty', 'dirty', 'dirty', 'saving', 'saved']);
  });

  it('saves again with the new revision when edited while a request is in flight', async () => {
    let release: (() => void) | null = null;
    const save = vi.fn(
      (payload: SavePayload) =>
        new Promise<{ revision: number }>((resolve) => {
          release = () => resolve({ revision: payload.baseRevision + 1 });
        }),
    );
    const { saver, edit } = setup(save);
    edit('a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(saver.snapshot().status).toBe('saving');
    edit('ab');
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.snapshot().status).toBe('dirty');
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0]).toMatchObject({ title: 'ab', baseRevision: 4 });
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.snapshot()).toMatchObject({ status: 'saved', baseRevision: 5 });
  });

  it('stops on a revision conflict until the user decides', async () => {
    const save = vi
      .fn<(payload: SavePayload) => Promise<{ revision: number }>>()
      .mockRejectedValueOnce(new Error('conflict:9'))
      .mockImplementation(async (payload) => ({ revision: payload.baseRevision + 1 }));
    const { saver, edit } = setup(save);
    edit('mío');
    await vi.advanceTimersByTimeAsync(1000);
    expect(saver.snapshot()).toMatchObject({ status: 'conflict', conflictRevision: 9 });
    // Further edits do not save and flushing refuses.
    edit('mío 2');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(await saver.flush()).toBe(false);

    await saver.resolveConflict('overwrite');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0]).toMatchObject({ title: 'mío 2', baseRevision: 9 });
    expect(saver.snapshot()).toMatchObject({ status: 'saved', baseRevision: 10 });
  });

  it('adopts the server version after a conflict without saving', async () => {
    const save = vi.fn().mockRejectedValue(new Error('conflict:7'));
    const { saver, edit, state } = setup(save);
    edit('mío');
    await vi.advanceTimersByTimeAsync(1000);
    expect(saver.snapshot().status).toBe('conflict');
    state.doc = { ...state.doc, title: 'del servidor' };
    saver.adopt(7);
    expect(saver.snapshot()).toMatchObject({ status: 'saved', baseRevision: 7 });
    expect(saver.dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('retries failed saves with back-off and recovers', async () => {
    const save = vi
      .fn<(payload: SavePayload) => Promise<{ revision: number }>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ revision: 4 });
    const { saver, edit } = setup(save);
    edit('a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(saver.snapshot().status).toBe('error');
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(3);
    expect(saver.snapshot()).toMatchObject({ status: 'saved', error: null });
  });

  it('sends pending edits when the editor closes, without retrying afterwards', async () => {
    const save = vi
      .fn<(payload: SavePayload) => Promise<{ revision: number }>>()
      .mockRejectedValue(new Error('offline'));
    const { saver, edit, snapshots } = setup(save);
    edit('último cambio');
    void saver.flush();
    saver.dispose();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({ title: 'último cambio', baseRevision: 3 });
    const notified = snapshots.length;
    await vi.advanceTimersByTimeAsync(60_000);
    // The failed request is not retried by a saver nobody is listening to.
    expect(save).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveLength(notified);
  });

  it('flushes immediately and reports clean when undo returns to the saved document', async () => {
    const save = vi.fn(async (payload: SavePayload) => ({ revision: payload.baseRevision + 1 }));
    const { saver, edit, state } = setup(save);
    edit('a');
    expect(await saver.flush()).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);

    // An edit followed by an undo to the saved version needs no request.
    const saved = state.doc;
    edit('b');
    expect(saver.snapshot().status).toBe('dirty');
    state.doc = saved;
    saver.notifyChange();
    expect(saver.snapshot().status).toBe('saved');
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
