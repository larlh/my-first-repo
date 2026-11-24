import { describe, expect, it } from 'vitest';
import { WhisperEngine, WhisperEngineError, resolveWhisperThreads } from './whisper-engine';
import type { WhisperEngineOptions, WhisperOutput, WorkerLike } from './whisper-engine';

/*
 * The queue, hand-over and recovery logic of the engine, against a scripted double of the
 * worker thread. The real worker (with the real model) is covered by local-whisper.real.test.ts.
 */

type Listener = (value: never) => void;

interface Posted {
  id: number;
  type: string;
  samples: Float32Array;
  language?: string;
  timestamps: boolean;
}

class FakeWorker implements WorkerLike {
  readonly posted: Posted[] = [];
  readonly transfers: ArrayBuffer[][] = [];
  terminated = false;
  refs = 0;
  private readonly listeners = new Map<string, Listener[]>();

  postMessage(message: unknown, transfer: ArrayBuffer[] = []): void {
    this.posted.push(message as Posted);
    this.transfers.push(transfer);
  }
  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
  ref(): void {
    this.refs += 1;
  }
  unref(): void {
    this.refs -= 1;
  }
  emit(event: 'message' | 'error' | 'exit', value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }
  /** Answer the oldest unanswered job. */
  reply(result: WhisperOutput, index = this.posted.length - 1): void {
    this.emit('message', { id: this.posted[index]?.id, ok: true, result });
  }
  fail(phase: 'load' | 'run', message: string): void {
    this.emit('message', { id: this.posted.at(-1)?.id, ok: false, error: { message, phase } });
  }
}

function setup(overrides: Partial<WhisperEngineOptions> = {}) {
  const workers: FakeWorker[] = [];
  const engine = new WhisperEngine({
    modelsDir: '/models',
    modelFolder: 'org--model-abc',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
    threads: 2,
    languages: ['es', 'en'],
    idleUnloadMs: 0,
    createWorker: (data) => {
      const worker = new FakeWorker();
      workers.push(worker);
      expect(data).toEqual({
        modelsDir: '/models',
        modelFolder: 'org--model-abc',
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
        threads: 2,
        languages: ['es', 'en'],
      });
      return worker;
    },
    ...overrides,
  });
  return { engine, workers };
}

const out = (text: string): WhisperOutput => ({ text, language: 'es', chunks: [] });
const audio = (length = 16) => new Float32Array(length).fill(0.25);
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('WhisperEngine', () => {
  it('starts no worker until the first job and then runs jobs strictly one at a time', async () => {
    const { engine, workers } = setup();
    expect(workers).toHaveLength(0);
    expect(engine.loaded).toBe(false);

    const first = engine.run({ samples: audio(), language: 'es' });
    const second = engine.run({ samples: audio(), timestamps: true });
    expect(workers).toHaveLength(1);
    expect(engine.pending).toBe(2);
    const worker = workers[0]!;
    // Only the first job was handed over; the second waits for its answer.
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({ type: 'transcribe', language: 'es', timestamps: false });

    worker.reply(out('uno'));
    await expect(first).resolves.toEqual(out('uno'));
    expect(worker.posted).toHaveLength(2);
    expect(worker.posted[1]).toMatchObject({ language: undefined, timestamps: true });
    worker.reply(out('dos'));
    await expect(second).resolves.toEqual(out('dos'));
    expect(engine.pending).toBe(0);
    expect(workers).toHaveLength(1); // one worker, one copy of the model
  });

  it('transfers the audio buffer instead of copying it', async () => {
    const { engine, workers } = setup();
    const samples = audio(32);
    const job = engine.run({ samples });
    const worker = workers[0]!;
    expect(worker.transfers[0]).toEqual([worker.posted[0]!.samples.buffer]);
    expect(worker.posted[0]!.samples.buffer).toBe(samples.buffer);
    // A view into a larger buffer is copied first: the caller's buffer must survive.
    const shared = new Float32Array(64).fill(0.5);
    const view = shared.subarray(8, 24);
    worker.reply(out('a'));
    await job;
    const other = engine.run({ samples: view });
    expect(worker.posted[1]!.samples.buffer).not.toBe(shared.buffer);
    expect(worker.posted[1]!.samples).toHaveLength(16);
    worker.reply(out('b'));
    await other;
  });

  it('keeps the process alive only while a job runs', async () => {
    const { engine, workers } = setup();
    const job = engine.run({ samples: audio() });
    const worker = workers[0]!;
    expect(worker.refs).toBe(1);
    worker.reply(out('x'));
    await job;
    expect(worker.refs).toBe(0);
  });

  it('drops a job aborted while it waits, and never starts one already aborted', async () => {
    const { engine, workers } = setup();
    const running = engine.run({ samples: audio() });
    const controller = new AbortController();
    const waiting = engine.run({ samples: audio(), signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'WhisperEngineError', phase: 'aborted' });
    expect(engine.pending).toBe(1);
    await expect(
      engine.run({ samples: audio(), signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(WhisperEngineError);
    workers[0]!.reply(out('ok'));
    await expect(running).resolves.toEqual(out('ok'));
    expect(workers[0]!.posted).toHaveLength(1); // the aborted jobs never reached the worker
  });

  it('reports load and run failures with their phase and keeps serving', async () => {
    const { engine, workers } = setup();
    const broken = engine.run({ samples: audio() });
    workers[0]!.fail('load', 'model file is corrupt');
    await expect(broken).rejects.toMatchObject({ phase: 'load', message: 'model file is corrupt' });
    const failed = engine.run({ samples: audio() });
    workers[0]!.fail('run', 'bad segment');
    await expect(failed).rejects.toMatchObject({ phase: 'run' });
    const fine = engine.run({ samples: audio() });
    workers[0]!.reply(out('bien'));
    await expect(fine).resolves.toEqual(out('bien'));
  });

  it('replaces a crashed worker: the running job fails, the next one gets a new thread', async () => {
    const { engine, workers } = setup();
    const doomed = engine.run({ samples: audio() });
    const next = engine.run({ samples: audio() });
    workers[0]!.emit('error', new Error('out of memory'));
    workers[0]!.emit('exit', 1);
    await expect(doomed).rejects.toMatchObject({ phase: 'load' });
    await tick();
    expect(workers).toHaveLength(2);
    workers[1]!.reply(out('recuperado'));
    await expect(next).resolves.toEqual(out('recuperado'));
    // A late message of the dead worker is ignored.
    workers[0]!.reply(out('fantasma'), 0);
    expect(engine.pending).toBe(0);
  });

  it('fails a job that never answers and stops the stuck worker', async () => {
    const { engine, workers } = setup({ jobTimeoutMs: 20 });
    await expect(engine.run({ samples: audio() })).rejects.toMatchObject({
      phase: 'run',
      message: expect.stringMatching(/timed out/),
    });
    expect(workers[0]!.terminated).toBe(true);
    const again = engine.run({ samples: audio() });
    expect(workers).toHaveLength(2);
    workers[1]!.reply(out('ok'));
    await expect(again).resolves.toEqual(out('ok'));
  });

  it('unloads the model after the idle time and loads it again on demand', async () => {
    const { engine, workers } = setup({ idleUnloadMs: 15 });
    const job = engine.run({ samples: audio() });
    workers[0]!.reply(out('a'));
    await job;
    expect(engine.loaded).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(workers[0]!.terminated).toBe(true);
    expect(engine.loaded).toBe(false);
    const again = engine.run({ samples: audio() });
    expect(workers).toHaveLength(2);
    workers[1]!.reply(out('b'));
    await expect(again).resolves.toEqual(out('b'));
  });

  it('rejects everything on dispose and refuses new work', async () => {
    const { engine, workers } = setup();
    const running = engine.run({ samples: audio() });
    const waiting = engine.run({ samples: audio() });
    await engine.dispose();
    await expect(running).rejects.toBeInstanceOf(WhisperEngineError);
    await expect(waiting).rejects.toBeInstanceOf(WhisperEngineError);
    expect(workers[0]!.terminated).toBe(true);
    await expect(engine.run({ samples: audio() })).rejects.toMatchObject({ phase: 'load' });
  });

  it('uses the configured thread count, or every core up to four', () => {
    expect(resolveWhisperThreads(3)).toBe(3);
    const auto = resolveWhisperThreads(0);
    expect(auto).toBeGreaterThanOrEqual(1);
    expect(auto).toBeLessThanOrEqual(4);
  });
});
