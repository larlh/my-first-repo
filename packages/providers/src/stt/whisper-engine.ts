import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { WhisperDtype } from './whisper-models';

/* -------------------------------------------------------------------------------------------
 * Local Whisper engine: ONE worker thread per model, started on first use, that owns the ONNX
 * sessions. This side only queues jobs and hands them over one at a time, so:
 *
 *  - the event loop of the API / worker process never blocks (features and inference run in
 *    the worker thread; audio is transferred, not copied)
 *  - a single copy of the model is in memory however many providers were created
 *  - concurrency is 1: a CPU model already uses every core it is given, so running two
 *    segments at once only makes both slower. Callers bound how many may WAIT (`pending`).
 *  - after `idleUnloadMs` without work the thread is stopped and its memory returned
 *  - a crashed or stuck worker fails its job and is replaced on the next one
 * ----------------------------------------------------------------------------------------- */

export interface WhisperJob {
  /** Mono audio at 16 kHz, -1..1. Its buffer is TRANSFERRED to the worker (do not reuse it). */
  samples: Float32Array;
  /** Whisper language code; omitted ⇒ detected among the engine languages. */
  language?: string;
  /** Ask for phrase timestamps (`chunks`). */
  timestamps?: boolean;
  /** Aborting drops a job that is still waiting; a running one finishes and is discarded. */
  signal?: AbortSignal;
}

export interface WhisperChunk {
  startSec: number;
  /** Null when the phrase runs past the end of the audio window. */
  endSec: number | null;
  text: string;
}

export interface WhisperOutput {
  text: string;
  language: string | null;
  chunks: WhisperChunk[];
}

/** What went wrong inside the engine, for the provider to turn into an AppError. */
export class WhisperEngineError extends Error {
  constructor(
    message: string,
    /** `load`: the model could not be loaded; `run`: this segment failed; `aborted`. */
    readonly phase: 'load' | 'run' | 'aborted',
  ) {
    super(message);
    this.name = 'WhisperEngineError';
  }
}

export interface WhisperWorkerData {
  modelsDir: string;
  modelFolder: string;
  dtype: { encoder_model: WhisperDtype; decoder_model_merged: WhisperDtype };
  threads: number;
  languages: string[];
}

type WorkerReply =
  | { id: number; ok: true; result: WhisperOutput | null }
  | { id: number; ok: false; error: { message: string; phase: 'load' | 'run' } };

/** The part of `node:worker_threads` Worker the engine uses (tests pass a double). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  on(event: 'message', listener: (reply: WorkerReply) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number> | void;
  ref?(): void;
  unref?(): void;
}

export interface WhisperEngineOptions extends WhisperWorkerData {
  /** Stop the worker after this long without jobs (0 = keep it). */
  idleUnloadMs: number;
  /** A job that runs longer than this is failed and the worker replaced. */
  jobTimeoutMs?: number;
  createWorker?: (data: WhisperWorkerData) => WorkerLike;
}

interface QueuedJob {
  id: number;
  job: WhisperJob;
  resolve: (output: WhisperOutput) => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
  timer?: NodeJS.Timeout;
}

const DEFAULT_JOB_TIMEOUT_MS = 180_000;

/** Threads for inference: DICTATION_THREADS, or every core up to 4 when it is 0. */
export function resolveWhisperThreads(configured: number): number {
  return configured > 0 ? configured : Math.max(1, Math.min(4, os.availableParallelism()));
}

/**
 * ONNX Runtime ships with usage telemetry switched ON (measured with onnxruntime-node 1.30.0
 * on Linux: it connects to mobile.events.data.microsoft.com and keeps a device id and an
 * event queue under ~/.cache/Microsoft). Parlante promises that nothing leaves the machine,
 * so it is switched off through the variable the runtime reads when it starts.
 *
 * It has to be set HERE: in the real environment of the process (a worker thread's own
 * `process.env` is a copy that native code never sees) and before the worker loads the
 * native library.
 */
export function disableOnnxRuntimeTelemetry(): void {
  process.env.ORT_DISABLE_TELEMETRY = '1';
}

function spawnWorker(data: WhisperWorkerData): WorkerLike {
  disableOnnxRuntimeTelemetry();
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'whisper-worker.mjs');
  // The worker is plain JavaScript: it must not inherit a TypeScript loader from the parent.
  return new Worker(file, { workerData: data, execArgv: [] }) as unknown as WorkerLike;
}

export class WhisperEngine {
  private worker: WorkerLike | null = null;
  private readonly queue: QueuedJob[] = [];
  private current: QueuedJob | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private disposed = false;

  constructor(private readonly options: WhisperEngineOptions) {}

  /** Jobs waiting or running. */
  get pending(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  /** True while the worker thread (and so the model) is alive. */
  get loaded(): boolean {
    return this.worker !== null;
  }

  run(job: WhisperJob): Promise<WhisperOutput> {
    if (this.disposed) {
      return Promise.reject(new WhisperEngineError('The speech engine was shut down', 'load'));
    }
    if (job.signal?.aborted) {
      return Promise.reject(new WhisperEngineError('Aborted', 'aborted'));
    }
    return new Promise<WhisperOutput>((resolve, reject) => {
      const queued: QueuedJob = { id: this.nextId, job, resolve, reject };
      this.nextId += 1;
      if (job.signal) {
        queued.onAbort = () => {
          const index = this.queue.indexOf(queued);
          if (index >= 0) {
            this.queue.splice(index, 1);
            reject(new WhisperEngineError('Aborted', 'aborted'));
          }
        };
        job.signal.addEventListener('abort', queued.onAbort, { once: true });
      }
      this.queue.push(queued);
      this.pump();
    });
  }

  /** Stop the worker and fail whatever is queued. The engine cannot be used afterwards. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.failAll(new WhisperEngineError('The speech engine was shut down', 'load'));
    await this.stopWorker();
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) return;
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (err) {
      this.settle(next, new WhisperEngineError(messageOf(err), 'load'));
      return;
    }
    worker.ref?.();
    next.timer = setTimeout(() => {
      // Inference cannot be interrupted: replace the thread.
      void this.stopWorker();
      this.settle(next, new WhisperEngineError('The speech engine timed out', 'run'));
    }, this.options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
    const { samples, language, timestamps } = next.job;
    // Transfer only a buffer this view owns completely; otherwise send a copy.
    const own =
      samples.byteOffset === 0 &&
      samples.byteLength === samples.buffer.byteLength &&
      samples.buffer instanceof ArrayBuffer
        ? samples
        : samples.slice();
    worker.postMessage(
      { id: next.id, type: 'transcribe', samples: own, language, timestamps: timestamps === true },
      [own.buffer as ArrayBuffer],
    );
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const { idleUnloadMs: _idle, jobTimeoutMs: _timeout, createWorker, ...data } = this.options;
    const worker = (createWorker ?? spawnWorker)(data);
    this.worker = worker;
    worker.on('message', (reply) => {
      if (this.worker !== worker) return;
      const job = this.current;
      if (!job || reply.id !== job.id) return;
      if (reply.ok && reply.result) this.settle(job, null, reply.result);
      else if (reply.ok) this.settle(job, new WhisperEngineError('Empty engine reply', 'run'));
      else this.settle(job, new WhisperEngineError(reply.error.message, reply.error.phase));
    });
    const crashed = (reason: string) => {
      if (this.worker !== worker) return;
      this.worker = null;
      const job = this.current;
      if (job) this.settle(job, new WhisperEngineError(reason, 'load'));
    };
    worker.on('error', (err) => crashed(`The speech engine crashed: ${err.message}`));
    worker.on('exit', (code) => crashed(`The speech engine stopped unexpectedly (code ${code})`));
    return worker;
  }

  private settle(job: QueuedJob, error: Error | null, output?: WhisperOutput): void {
    if (this.current !== job) return;
    this.current = null;
    if (job.timer) clearTimeout(job.timer);
    if (job.onAbort) job.job.signal?.removeEventListener('abort', job.onAbort);
    if (error) job.reject(error);
    else if (output) job.resolve(output);
    if (this.queue.length > 0) {
      this.pump();
      return;
    }
    // Idle: do not keep the process alive, and give the memory back after a while.
    this.worker?.unref?.();
    if (this.options.idleUnloadMs > 0 && this.worker) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (!this.current && this.queue.length === 0) void this.stopWorker();
      }, this.options.idleUnloadMs);
      this.idleTimer.unref();
    }
  }

  private failAll(error: Error): void {
    const waiting = this.queue.splice(0);
    for (const job of waiting) {
      if (job.onAbort) job.job.signal?.removeEventListener('abort', job.onAbort);
      job.reject(error);
    }
    if (this.current) {
      const job = this.current;
      this.current = null;
      if (job.timer) clearTimeout(job.timer);
      if (job.onAbort) job.job.signal?.removeEventListener('abort', job.onAbort);
      job.reject(error);
    }
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (worker) await worker.terminate();
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- one engine per model per process ---------- */

const engines = new Map<string, WhisperEngine>();

/** The process-wide engine of a model (created on first call; the model loads on first job). */
export function sharedWhisperEngine(options: WhisperEngineOptions): WhisperEngine {
  const key = JSON.stringify([
    options.modelsDir,
    options.modelFolder,
    options.dtype,
    options.threads,
    options.languages,
  ]);
  let engine = engines.get(key);
  if (!engine) {
    engine = new WhisperEngine(options);
    engines.set(key, engine);
  }
  return engine;
}

/** Stop every engine of this process (tests, graceful shutdown). */
export async function disposeWhisperEngines(): Promise<void> {
  const all = [...engines.values()];
  engines.clear();
  await Promise.all(all.map((engine) => engine.dispose()));
}
