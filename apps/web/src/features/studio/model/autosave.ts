import type { EditorDoc } from './editor';

/* -------------------------------------------------------------------------------------------
 * Autosave controller (no React, no network of its own).
 *
 * Contract (PATCH /api/videos/:id): every save sends `baseRevision`, the revision this editor
 * last saw. The API answers the new revision, or 409 REVISION_CONFLICT with
 * `details.currentRevision` when somebody else (another tab, a teammate, the public API)
 * changed the video in between. A conflict never overwrites silently: saving stops until the
 * user chooses to keep their version (`resolveConflict('overwrite')`) or to load the server's
 * (`adopt`).
 *
 * Edits are debounced; one request is in flight at a time and edits made meanwhile trigger
 * another save when it returns. Failures (offline, 5xx) are retried with back-off.
 * ----------------------------------------------------------------------------------------- */

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface SavePayload extends EditorDoc {
  baseRevision: number;
}

export interface AutosaveSnapshot {
  status: SaveStatus;
  /** Error of the last failed save (status `error`). */
  error: unknown;
  /** Revision the server holds for the last successful save. */
  baseRevision: number;
  /** Revision reported by the server when a conflict was detected. */
  conflictRevision: number | null;
  /** Epoch ms of the last successful save in this session. */
  savedAt: number | null;
}

export interface AutosaveOptions {
  baseRevision: number;
  /** Current document. Documents are immutable: identity tells whether it changed. */
  read: () => EditorDoc;
  save: (payload: SavePayload) => Promise<{ revision: number }>;
  /**
   * Classify a failed save: the server's current revision when it is a revision conflict
   * (`true` when the server did not say which), null for any other error.
   */
  conflictOf: (error: unknown) => number | true | null;
  onChange: (snapshot: AutosaveSnapshot) => void;
  delayMs?: number;
  retryMs?: number;
  maxRetryMs?: number;
  now?: () => number;
}

export class Autosaver {
  private status: SaveStatus = 'saved';
  private error: unknown = null;
  private baseRevision: number;
  private conflictRevision: number | null = null;
  private savedAt: number | null = null;
  /** The document the server has. */
  private savedDoc: EditorDoc;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<boolean> | null = null;
  private failures = 0;
  private disposed = false;
  private readonly delayMs: number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;

  constructor(private readonly options: AutosaveOptions) {
    this.baseRevision = options.baseRevision;
    this.savedDoc = options.read();
    this.delayMs = options.delayMs ?? 1200;
    this.retryMs = options.retryMs ?? 4000;
    this.maxRetryMs = options.maxRetryMs ?? 30_000;
  }

  snapshot(): AutosaveSnapshot {
    return {
      status: this.status,
      error: this.error,
      baseRevision: this.baseRevision,
      conflictRevision: this.conflictRevision,
      savedAt: this.savedAt,
    };
  }

  /** True when the server does not have the current document. */
  get dirty(): boolean {
    return this.options.read() !== this.savedDoc;
  }

  /** Call after every document change. */
  notifyChange(): void {
    if (this.disposed || this.status === 'conflict') return;
    if (!this.dirty) {
      // Undo back to the saved document while nothing is in flight.
      if (!this.inFlight && this.status !== 'saved') {
        this.clearTimer();
        this.set('saved');
      }
      return;
    }
    if (!this.inFlight) this.set('dirty');
    this.schedule(this.delayMs);
  }

  /** Save now (Ctrl+S, before a render). Resolves true when the server has the document. */
  async flush(): Promise<boolean> {
    if (this.disposed || this.status === 'conflict') return false;
    this.clearTimer();
    if (this.inFlight) await this.inFlight;
    // The awaited save may have ended in a conflict.
    if ((this.status as SaveStatus) === 'conflict') return false;
    if (!this.dirty) return true;
    return this.run();
  }

  /** Keep the local document: save it on top of the revision the server reported. */
  async resolveConflict(choice: 'overwrite', currentRevision?: number): Promise<boolean> {
    if (choice !== 'overwrite' || this.status !== 'conflict') return false;
    const revision = currentRevision ?? this.conflictRevision;
    if (revision === null || revision === undefined) return false;
    this.baseRevision = revision;
    this.conflictRevision = null;
    this.status = 'dirty';
    return this.run();
  }

  /**
   * The document now equals what the server holds at `revision` (server version loaded after
   * a conflict, or a server-side change applied to the editor).
   */
  adopt(revision: number): void {
    this.clearTimer();
    this.baseRevision = revision;
    this.conflictRevision = null;
    this.savedDoc = this.options.read();
    this.failures = 0;
    this.error = null;
    this.set('saved');
  }

  /**
   * Stop for good (the editor closed). Call `flush()` first to send pending edits: that last
   * request completes, but nothing is retried or scheduled afterwards.
   */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private schedule(ms: number): void {
    this.clearTimer();
    // A disposed saver finishes the request in flight but never starts another one.
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private set(status: SaveStatus): void {
    this.status = status;
    if (!this.disposed) this.options.onChange(this.snapshot());
  }

  private run(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    this.clearTimer();
    if (!this.dirty) {
      if (this.status !== 'saved') this.set('saved');
      return Promise.resolve(true);
    }
    const attempt = this.attempt().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = attempt;
    return attempt;
  }

  private async attempt(): Promise<boolean> {
    const doc = this.options.read();
    this.error = null;
    this.set('saving');
    try {
      const result = await this.options.save({ ...doc, baseRevision: this.baseRevision });
      this.baseRevision = result.revision;
      this.savedDoc = doc;
      this.savedAt = (this.options.now ?? Date.now)();
      this.failures = 0;
      if (this.dirty) {
        // Edited while the request was in flight: save again soon.
        this.set('dirty');
        this.schedule(this.delayMs);
        return false;
      }
      this.set('saved');
      return true;
    } catch (error) {
      const conflict = this.options.conflictOf(error);
      if (conflict !== null) {
        this.clearTimer();
        this.conflictRevision = conflict === true ? null : conflict;
        this.set('conflict');
        return false;
      }
      this.failures += 1;
      this.error = error;
      this.set('error');
      this.schedule(Math.min(this.maxRetryMs, this.retryMs * 2 ** (this.failures - 1)));
      return false;
    }
  }
}
