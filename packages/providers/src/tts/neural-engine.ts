import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { disableOnnxRuntimeTelemetry } from '../stt/whisper-engine';

/* -------------------------------------------------------------------------------------------
 * Engine of the local neural voices: ONE worker thread per process, started on first use, that
 * owns the ONNX Runtime sessions (same pattern as the local Whisper engine):
 *
 *  - the event loop of the API / worker process never blocks: inference runs in the thread
 *  - one copy of each graph in memory however many providers were created
 *  - concurrency is 1: a CPU model already uses every core it is given. Long texts are sent
 *    chunk by chunk, so a short preview only waits for the chunk that is running
 *  - at most `maxModels` graphs stay loaded (least recently used goes first): Kokoro is one
 *    graph for every voice, each Piper voice is its own graph
 *  - after `idleUnloadMs` without work the thread is stopped and its memory returned
 *  - a crashed or stuck worker fails its job and is replaced on the next one
 *
 * The thread knows nothing about speech: a job is "run this graph with these tensors".
 * ----------------------------------------------------------------------------------------- */

export interface NeuralTensor {
  type: 'int64' | 'float32';
  data: BigInt64Array | Float32Array;
  dims: number[];
}

export interface NeuralOutput {
  data: Float32Array;
  dims: number[];
}

export interface NeuralModelSpec {
  /** Identity of the graph inside the engine (one session per key). */
  key: string;
  /** Absolute path of the .onnx file. */
  path: string;
  /**
   * Edit the file in memory before it is loaded (see onnx-graph.ts). Without it the thread
   * reads the file itself.
   */
  prepare?: (model: Uint8Array) => Uint8Array;
}

export interface NeuralJob {
  model: NeuralModelSpec;
  feeds: Record<string, NeuralTensor>;
  /** Names to return; a function is called once the graph is loaded (see `prepare`). */
  outputs: string[] | (() => string[]);
  /** Aborting drops a job that is still waiting; a running one finishes and is discarded. */
  signal?: AbortSignal;
}

/** What went wrong inside the engine, for the provider to turn into an AppError. */
export class NeuralEngineError extends Error {
  constructor(
    message: string,
    /** `load`: the graph could not be loaded; `run`: this job failed; `aborted`. */
    readonly phase: 'load' | 'run' | 'aborted',
  ) {
    super(message);
    this.name = 'NeuralEngineError';
  }
}

type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; phase: 'load' | 'run' } };

/** The part of `node:worker_threads` Worker the engine uses (tests pass a double). */
export interface NeuralWorkerLike {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  on(event: 'message', listener: (reply: WorkerReply) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number> | void;
  ref?(): void;
  unref?(): void;
}

export interface NeuralEngineOptions {
  /** CPU threads of one inference. */
  threads: number;
  /**
   * Execution provider asked of ONNX Runtime (`cpu`, `dml`, `cuda`). Anything but `cpu` is
   * tried first and silently replaced by the CPU when the machine cannot use it.
   */
  device?: string;
  /** Stop the worker after this long without jobs (0 = keep it). */
  idleUnloadMs: number;
  /** Graphs kept loaded at the same time. */
  maxModels?: number;
  /** A job that runs longer than this is failed and the worker replaced. */
  jobTimeoutMs?: number;
  createWorker?: () => NeuralWorkerLike;
  readFile?: (file: string) => Promise<Uint8Array>;
}

interface QueuedJob {
  job: NeuralJob;
  resolve: (outputs: Record<string, NeuralOutput>) => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

const DEFAULT_JOB_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_MODELS = 3;

/** Threads for inference: VOICE_THREADS, or every core up to 4 when it is 0. */
export function resolveVoiceThreads(configured: number): number {
  return configured > 0 ? configured : Math.max(1, Math.min(4, os.availableParallelism()));
}

function spawnWorker(): NeuralWorkerLike {
  // Before the thread loads the native library, and in the real process environment.
  disableOnnxRuntimeTelemetry();
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'neural-worker.mjs');
  // The worker is plain JavaScript: it must not inherit a TypeScript loader from the parent.
  return new Worker(file, { execArgv: [] }) as unknown as NeuralWorkerLike;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class NeuralEngine {
  private worker: NeuralWorkerLike | null = null;
  private readonly queue: QueuedJob[] = [];
  private running = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private disposed = false;
  /** Calls waiting for the reply of the current worker. */
  private readonly calls = new Map<number, PendingCall>();
  /** Keys loaded in the current worker, least recently used first. */
  private loadedKeys: string[] = [];
  /** Device each loaded graph really runs on (what the thread reported). */
  private readonly devices = new Map<string, string>();

  constructor(private readonly options: NeuralEngineOptions) {}

  /** Jobs waiting or running. */
  get pending(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /** True while the worker thread (and so at least one graph) is alive. */
  get loaded(): boolean {
    return this.worker !== null;
  }

  /** Graphs loaded right now, least recently used first. */
  get models(): readonly string[] {
    return this.loadedKeys;
  }

  /** Device a loaded graph runs on (`cpu` unless a GPU provider could be used). */
  deviceOf(key: string): string | null {
    return this.devices.get(key) ?? null;
  }

  run(job: NeuralJob): Promise<Record<string, NeuralOutput>> {
    if (this.disposed) {
      return Promise.reject(new NeuralEngineError('The voice engine was shut down', 'load'));
    }
    if (job.signal?.aborted) return Promise.reject(new NeuralEngineError('Aborted', 'aborted'));
    return new Promise((resolve, reject) => {
      const queued: QueuedJob = { job, resolve, reject };
      if (job.signal) {
        queued.onAbort = () => {
          const index = this.queue.indexOf(queued);
          if (index >= 0) {
            this.queue.splice(index, 1);
            reject(new NeuralEngineError('Aborted', 'aborted'));
          }
        };
        job.signal.addEventListener('abort', queued.onAbort, { once: true });
      }
      this.queue.push(queued);
      void this.pump();
    });
  }

  /** Stop the worker and fail whatever is queued. The engine cannot be used afterwards. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const error = new NeuralEngineError('The voice engine was shut down', 'load');
    for (const queued of this.queue.splice(0)) {
      if (queued.onAbort) queued.job.signal?.removeEventListener('abort', queued.onAbort);
      queued.reject(error);
    }
    await this.stopWorker(error);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        if (next.onAbort) next.job.signal?.removeEventListener('abort', next.onAbort);
        try {
          next.resolve(await this.execute(next.job));
        } catch (err) {
          next.reject(
            err instanceof NeuralEngineError ? err : new NeuralEngineError(messageOf(err), 'run'),
          );
        }
      }
    } finally {
      this.running = false;
    }
    // Idle: do not keep the process alive, and give the memory back after a while.
    this.worker?.unref?.();
    if (this.options.idleUnloadMs > 0 && this.worker) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (!this.running && this.queue.length === 0) void this.stopWorker(null);
      }, this.options.idleUnloadMs);
      this.idleTimer.unref();
    }
  }

  private async execute(job: NeuralJob): Promise<Record<string, NeuralOutput>> {
    const worker = this.ensureWorker();
    worker.ref?.();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Inference cannot be interrupted: replace the thread.
        const error = new NeuralEngineError('The voice engine timed out', 'run');
        void this.stopWorker(error);
        reject(error);
      }, this.options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.loadAndRun(job), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async loadAndRun(job: NeuralJob): Promise<Record<string, NeuralOutput>> {
    const { key } = job.model;
    if (!this.loadedKeys.includes(key)) {
      const limit = Math.max(1, this.options.maxModels ?? DEFAULT_MAX_MODELS);
      while (this.loadedKeys.length >= limit) {
        const evicted = this.loadedKeys.shift();
        if (evicted !== undefined) await this.call({ type: 'release', key: evicted });
      }
      await this.load(job.model);
      this.loadedKeys.push(key);
    } else {
      this.loadedKeys = [...this.loadedKeys.filter((loaded) => loaded !== key), key];
    }
    const transfer: ArrayBuffer[] = [];
    const feeds: Record<string, NeuralTensor> = {};
    for (const [name, tensor] of Object.entries(job.feeds)) {
      // Send a copy the engine owns: the caller keeps its arrays.
      const data = tensor.data.slice();
      feeds[name] = { type: tensor.type, data, dims: tensor.dims };
      transfer.push(data.buffer as ArrayBuffer);
    }
    const outputs = typeof job.outputs === 'function' ? job.outputs() : job.outputs;
    const result = await this.call({ type: 'run', key, feeds, outputs }, transfer);
    return result as Record<string, NeuralOutput>;
  }

  private async load(model: NeuralModelSpec): Promise<void> {
    const threads = this.options.threads;
    const device = this.options.device ?? 'cpu';
    const remember = (reply: unknown) => {
      const used = (reply as { device?: unknown } | null)?.device;
      this.devices.set(model.key, typeof used === 'string' ? used : 'cpu');
    };
    if (!model.prepare) {
      remember(
        await this.call(
          { type: 'load', key: model.key, path: model.path, threads, device },
          [],
          'load',
        ),
      );
      return;
    }
    let bytes: Uint8Array;
    try {
      const read = this.options.readFile ?? ((file: string) => fs.readFile(file));
      bytes = model.prepare(await read(model.path));
    } catch (err) {
      throw new NeuralEngineError(messageOf(err), 'load');
    }
    // Transfer only a buffer this view owns completely; otherwise send a copy.
    const own =
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength &&
      bytes.buffer instanceof ArrayBuffer
        ? bytes
        : bytes.slice();
    remember(
      await this.call(
        { type: 'load', key: model.key, bytes: own, threads, device },
        [own.buffer as ArrayBuffer],
        'load',
      ),
    );
  }

  private call(
    message: Record<string, unknown>,
    transfer: ArrayBuffer[] = [],
    phase: 'load' | 'run' = 'run',
  ): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new NeuralEngineError('The voice engine stopped', phase));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      worker.postMessage({ ...message, id }, transfer);
    });
  }

  private ensureWorker(): NeuralWorkerLike {
    if (this.worker) return this.worker;
    let worker: NeuralWorkerLike;
    try {
      worker = (this.options.createWorker ?? spawnWorker)();
    } catch (err) {
      throw new NeuralEngineError(messageOf(err), 'load');
    }
    this.worker = worker;
    this.loadedKeys = [];
    worker.on('message', (reply) => {
      if (this.worker !== worker) return;
      const pending = this.calls.get(reply.id);
      if (!pending) return;
      this.calls.delete(reply.id);
      if (reply.ok) pending.resolve(reply.result);
      else pending.reject(new NeuralEngineError(reply.error.message, reply.error.phase));
    });
    const crashed = (reason: string) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.loadedKeys = [];
      this.failCalls(new NeuralEngineError(reason, 'load'));
    };
    worker.on('error', (err) => crashed(`The voice engine crashed: ${err.message}`));
    worker.on('exit', (code) => crashed(`The voice engine stopped unexpectedly (code ${code})`));
    return worker;
  }

  private failCalls(error: Error): void {
    const waiting = [...this.calls.values()];
    this.calls.clear();
    for (const pending of waiting) pending.reject(error);
  }

  private async stopWorker(error: Error | null): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.loadedKeys = [];
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.failCalls(error ?? new NeuralEngineError('The voice engine stopped', 'load'));
    if (worker) await worker.terminate();
  }
}

/* ---------- one engine per configuration per process ---------- */

const engines = new Map<string, NeuralEngine>();

/** The process-wide engine (created on first call; graphs load on the first job). */
export function sharedNeuralEngine(options: NeuralEngineOptions): NeuralEngine {
  const key = JSON.stringify([
    options.threads,
    options.idleUnloadMs,
    options.maxModels ?? null,
    options.device ?? 'cpu',
  ]);
  let engine = engines.get(key);
  if (!engine) {
    engine = new NeuralEngine(options);
    engines.set(key, engine);
  }
  return engine;
}

/** Stop every voice engine of this process (tests, graceful shutdown). */
export async function disposeNeuralEngines(): Promise<void> {
  const all = [...engines.values()];
  engines.clear();
  await Promise.all(all.map((engine) => engine.dispose()));
}
