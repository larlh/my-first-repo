import path from 'node:path';
import { AppError } from '@parlante/shared';
import type { RenderStage, StorageProvider } from '@parlante/shared';
import type { RenderRef } from '@parlante/jobs';
import type { WorkerContext } from '../../context';
import type { JobHandle } from '../../lib/job';
import { throttled } from '../../lib/progress';
import { isRenderCanceled, reportRenderProgress } from '../../lib/render-status';
import type { TempDir } from '../../lib/tmp';

/* -------------------------------------------------------------------------------------------
 * Plumbing shared by the stages of one render: cancellation, progress, local files.
 * ----------------------------------------------------------------------------------------- */

/** Thrown inside the pipeline when the user cancelled the render; the handler returns quietly. */
export class RenderCanceledError extends Error {
  constructor() {
    super('The render was cancelled');
    this.name = 'RenderCanceledError';
  }
}

/**
 * Watches the job row for a user cancellation (the API flips it to `canceled`). Stages call
 * `check()` at their boundaries; long awaits (ffmpeg, the avatar engine) are interrupted
 * through `signal`, which is aborted as soon as the background poll sees the cancellation.
 */
export class CancelWatch {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  canceled = false;

  constructor(
    private readonly ctx: WorkerContext,
    private readonly ref: RenderRef,
    private readonly intervalMs = 1000,
  ) {}

  /** Aborted when the render is cancelled. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.polling || this.canceled) return;
      this.polling = true;
      this.read()
        .catch(() => undefined) // a failed poll is retried on the next tick
        .finally(() => {
          this.polling = false;
        });
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async read(): Promise<boolean> {
    if (!this.canceled && (await isRenderCanceled(this.ctx, this.ref))) {
      this.canceled = true;
      this.controller.abort();
    }
    return this.canceled;
  }

  /** Throws `RenderCanceledError` when the render has been cancelled (reads the row now). */
  async check(): Promise<void> {
    if (await this.read()) throw new RenderCanceledError();
  }

  /** Same without touching the database: only what the background poll already knows. */
  throwIfCanceled(): void {
    if (this.canceled) throw new RenderCanceledError();
  }
}

/**
 * Overall percent of each stage (`from` → `to`). The slow part of a photorealistic render is
 * the neural animation, of an instant one the frames; the bar follows that.
 */
export function stageRanges(photoreal: boolean): Record<RenderStage, [number, number]> {
  return photoreal
    ? {
        prepare: [0, 3],
        audio: [3, 8],
        avatars: [8, 82],
        frames: [82, 95],
        encode: [95, 97],
        finalize: [97, 99],
      }
    : {
        prepare: [0, 4],
        audio: [4, 14],
        avatars: [14, 14],
        frames: [14, 94],
        encode: [94, 96],
        finalize: [96, 99],
      };
}

/**
 * Progress of the render, reported to BullMQ and PERSISTED on the job / video rows (what the
 * user sees). `begin` always writes (stage changes must be visible); `update` is throttled.
 */
export class StageProgress {
  private readonly ranges: Record<RenderStage, [number, number]>;
  private readonly persist: ReturnType<typeof throttled<[RenderStage, number, number | null]>>;

  constructor(
    private readonly ctx: WorkerContext,
    private readonly job: Pick<JobHandle<'render'>, 'progress'>,
    private readonly ref: RenderRef,
    photoreal: boolean,
    intervalMs = 1000,
  ) {
    this.ranges = stageRanges(photoreal);
    this.persist = throttled(
      (stage: RenderStage, percent: number, etaSec: number | null) =>
        reportRenderProgress(ctx, ref, stage, percent, etaSec),
      intervalMs,
    );
  }

  /** Overall percent for `fraction` (0..1) of a stage. */
  percent(stage: RenderStage, fraction: number): number {
    const [from, to] = this.ranges[stage];
    const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
    return from + (to - from) * f;
  }

  async begin(stage: RenderStage, etaSec: number | null = null): Promise<void> {
    const percent = this.percent(stage, 0);
    await reportRenderProgress(this.ctx, this.ref, stage, percent, etaSec);
    await this.emit(stage, percent, etaSec);
  }

  async update(stage: RenderStage, fraction: number, etaSec: number | null = null): Promise<void> {
    const percent = this.percent(stage, fraction);
    await this.persist(stage, percent, etaSec);
    await this.emit(stage, percent, etaSec);
  }

  private async emit(stage: RenderStage, percent: number, etaSec: number | null): Promise<void> {
    await this.job.progress({
      stage,
      percent: Math.min(99, Math.max(0, percent)),
      ...(etaSec === null ? {} : { etaSec: Math.max(0, Math.round(etaSec)) }),
    });
  }
}

/**
 * Storage objects as local files for ffmpeg and the decoders: the object itself when the
 * storage is the local disk (zero copy), otherwise a download into the job's temp directory.
 * Every temp name is generated here — nothing comes from user input.
 */
export class LocalFiles {
  private counter = 0;
  private readonly downloads = new Map<string, Promise<string>>();

  constructor(
    private readonly storage: StorageProvider,
    private readonly tmp: TempDir,
  ) {}

  /** A fresh file name inside the temp directory (`prefix-<n>.<ext>`). */
  temp(prefix: string, ext: string): string {
    this.counter += 1;
    const safePrefix = prefix.replace(/[^a-z0-9-]/gi, '') || 'file';
    const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
    return this.tmp.file(`${safePrefix}-${this.counter}.${safeExt}`);
  }

  /** Local path of the storage object `key`. Throws UNPROCESSABLE when it does not exist. */
  fromStorage(key: string): Promise<string> {
    let pending = this.downloads.get(key);
    if (!pending) {
      pending = this.resolve(key);
      this.downloads.set(key, pending);
      pending.catch(() => this.downloads.delete(key));
    }
    return pending;
  }

  private async resolve(key: string): Promise<string> {
    if (!(await this.storage.exists(key))) {
      throw new AppError('UNPROCESSABLE', 'A file used by this video no longer exists');
    }
    const local = this.storage.localPath(key);
    if (local) return local;
    const file = this.temp('dl', path.extname(key).slice(1));
    await this.storage.downloadTo(key, file);
    return file;
  }
}

/** Everything a stage needs about the render in progress. */
export interface RenderRun {
  ctx: WorkerContext;
  ref: RenderRef;
  log: JobHandle<'render'>['log'];
  tmp: TempDir;
  files: LocalFiles;
  /** Aborted when the worker shuts down OR the user cancels: pass it to every long operation. */
  signal: AbortSignal;
  cancel: CancelWatch;
  progress: StageProgress;
}
