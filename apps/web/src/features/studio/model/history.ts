/* Linear undo / redo history of immutable snapshots. Pure: time is passed in. */

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** Key and time of the last pushed change, used to merge a burst of edits into one step. */
  mergeKey: string | null;
  mergeAt: number;
}

export interface PushOptions {
  /**
   * Consecutive pushes with the same key within `windowMs` collapse into ONE undo step
   * (typing in a field, dragging a layer, moving a slider).
   */
  mergeKey?: string;
  now: number;
  windowMs?: number;
  /** Maximum number of undo steps kept. */
  limit?: number;
}

export const HISTORY_LIMIT = 100;
export const MERGE_WINDOW_MS = 900;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], mergeKey: null, mergeAt: 0 };
}

export function pushHistory<T>(history: History<T>, next: T, options: PushOptions): History<T> {
  if (next === history.present) return history;
  const windowMs = options.windowMs ?? MERGE_WINDOW_MS;
  const merges =
    options.mergeKey !== undefined &&
    options.mergeKey === history.mergeKey &&
    options.now - history.mergeAt <= windowMs &&
    history.past.length > 0;
  if (merges) {
    return { ...history, present: next, future: [], mergeAt: options.now };
  }
  const limit = options.limit ?? HISTORY_LIMIT;
  return {
    past: [...history.past, history.present].slice(-limit),
    present: next,
    future: [],
    mergeKey: options.mergeKey ?? null,
    mergeAt: options.now,
  };
}

/** End the current merge burst: the next push starts a new undo step even with the same key. */
export function sealHistory<T>(history: History<T>): History<T> {
  return history.mergeKey === null ? history : { ...history, mergeKey: null };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undoHistory<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    mergeKey: null,
    mergeAt: 0,
  };
}

export function redoHistory<T>(history: History<T>): History<T> {
  const next = history.future[0];
  if (next === undefined) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
    mergeKey: null,
    mergeAt: 0,
  };
}
