import { describe, expect, it, vi } from 'vitest';
import { NeuralEngine, NeuralEngineError, resolveVoiceThreads } from './neural-engine';
import type { NeuralJob, NeuralWorkerLike } from './neural-engine';

/* The engine with a DOUBLE of its worker thread: queueing, which graphs stay loaded, what
 * happens when the thread fails. The real thread is exercised by the [slow] tests. */

type Listener = (payload: never) => void;

class FakeWorker implements NeuralWorkerLike {
  readonly messages: Record<string, unknown>[] = [];
  readonly listeners = new Map<string, Listener>();
  terminated = false;
  /** Replies automatically unless a test takes over. */
  auto = true;
  failLoad: string | null = null;
  /** Device the "runtime" ends up using, whatever was asked. */
  device = 'cpu';

  postMessage(message: unknown): void {
    const m = message as Record<string, unknown>;
    this.messages.push(m);
    if (!this.auto) return;
    queueMicrotask(() => this.reply(m));
  }
  reply(message: Record<string, unknown>): void {
    const id = message.id as number;
    if (message.type === 'load' && this.failLoad !== null) {
      this.emit('message', { id, ok: false, error: { message: this.failLoad, phase: 'load' } });
      return;
    }
    const result =
      message.type === 'run'
        ? { out: { data: Float32Array.of(message.id as number), dims: [1] } }
        : message.type === 'load'
          ? { device: this.device }
          : null;
    this.emit('message', { id, ok: true, result });
  }
  on(event: string, listener: Listener): this {
    this.listeners.set(event, listener);
    return this;
  }
  emit(event: string, payload: unknown): void {
    this.listeners.get(event)?.(payload as never);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
  types(): string[] {
    return this.messages.map((m) => `${String(m.type)}:${String(m.key)}`);
  }
}

function setup(
  options: Partial<ConstructorParameters<typeof NeuralEngine>[0]> = {},
  onWorker: (worker: FakeWorker) => void = () => undefined,
) {
  const workers: FakeWorker[] = [];
  const engine = new NeuralEngine({
    threads: 2,
    idleUnloadMs: 0,
    createWorker: () => {
      const worker = new FakeWorker();
      onWorker(worker);
      workers.push(worker);
      return worker;
    },
    readFile: async (file) => new TextEncoder().encode(`bytes of ${file}`),
    ...options,
  });
  return { engine, workers };
}

const job = (key: string, extra: Partial<NeuralJob> = {}): NeuralJob => ({
  model: { key, path: `/models/${key}.onnx` },
  feeds: { x: { type: 'float32', data: Float32Array.of(1, 2), dims: [2] } },
  outputs: ['out'],
  ...extra,
});

describe('neural voice engine', () => {
  it('starts no thread until the first job, then loads a graph once', async () => {
    const { engine, workers } = setup();
    expect(engine.loaded).toBe(false);
    expect(workers).toHaveLength(0);
    await engine.run(job('kokoro'));
    await engine.run(job('kokoro'));
    expect(workers).toHaveLength(1);
    expect(workers[0]?.types()).toEqual(['load:kokoro', 'run:kokoro', 'run:kokoro']);
    expect(workers[0]?.messages[0]).toMatchObject({ path: '/models/kokoro.onnx', threads: 2 });
    expect(engine.models).toEqual(['kokoro']);
  });

  it('runs jobs one at a time, in order', async () => {
    const { engine, workers } = setup();
    const results = await Promise.all([
      engine.run(job('a')),
      engine.run(job('a')),
      engine.run(job('a')),
    ]);
    const ids = results.map((result) => result.out?.data[0]);
    expect(ids).toEqual([...ids].sort((x, y) => (x ?? 0) - (y ?? 0)));
    expect(workers[0]?.types()).toEqual(['load:a', 'run:a', 'run:a', 'run:a']);
    expect(engine.pending).toBe(0);
  });

  it('keeps at most `maxModels` graphs and drops the least recently used', async () => {
    const { engine, workers } = setup({ maxModels: 2 });
    await engine.run(job('a'));
    await engine.run(job('b'));
    await engine.run(job('a')); // a is now the most recent
    await engine.run(job('c')); // b goes
    expect(workers[0]?.types()).toEqual([
      'load:a',
      'run:a',
      'load:b',
      'run:b',
      'run:a',
      'release:b',
      'load:c',
      'run:c',
    ]);
    expect(engine.models).toEqual(['a', 'c']);
  });

  it('edits a graph in memory when the model asks for it and sends the bytes', async () => {
    const { engine, workers } = setup();
    const prepare = vi.fn((bytes: Uint8Array) => Uint8Array.from([...bytes, 33]));
    await engine.run(job('piper', { model: { key: 'piper', path: '/v.onnx', prepare } }));
    expect(prepare).toHaveBeenCalledTimes(1);
    const load = workers[0]?.messages[0] as { bytes?: Uint8Array; path?: string };
    expect(load.path).toBeUndefined();
    expect(new TextDecoder().decode(load.bytes)).toBe('bytes of /v.onnx!');
  });

  it('asks for the outputs only after the graph is loaded', async () => {
    const { engine, workers } = setup();
    let loaded = false;
    const prepare = (bytes: Uint8Array) => {
      loaded = true;
      return bytes;
    };
    await engine.run(
      job('piper', {
        model: { key: 'piper', path: '/v.onnx', prepare },
        outputs: () => (loaded ? ['out', 'durations'] : ['too-early']),
      }),
    );
    expect(workers[0]?.messages[1]).toMatchObject({ type: 'run', outputs: ['out', 'durations'] });
  });

  it('does not let a caller change tensors that were already sent', async () => {
    const { engine, workers } = setup();
    const data = Float32Array.of(5, 6);
    await engine.run(job('a', { feeds: { x: { type: 'float32', data, dims: [2] } } }));
    const sent = (workers[0]?.messages[1] as { feeds: { x: { data: Float32Array } } }).feeds.x.data;
    expect([...sent]).toEqual([5, 6]);
    expect(sent).not.toBe(data);
    expect(data.length).toBe(2); // the caller's array was not transferred away
  });

  it('reports a graph that cannot be loaded and tries again on the next job', async () => {
    const { engine, workers } = setup({}, (created) => {
      created.failLoad = 'bad model';
    });
    const worker = () => workers[0] as FakeWorker;
    await expect(engine.run(job('a'))).rejects.toMatchObject({
      name: 'NeuralEngineError',
      phase: 'load',
      message: 'bad model',
    });
    expect(engine.models).toEqual([]);
    worker().failLoad = null;
    await expect(engine.run(job('a'))).resolves.toBeDefined();
    expect(engine.models).toEqual(['a']);
  });

  it('fails a job whose file cannot be read or prepared as a load error', async () => {
    const { engine } = setup({
      readFile: async () => {
        throw new Error('ENOENT');
      },
    });
    const prepare = (bytes: Uint8Array) => bytes;
    await expect(
      engine.run(job('p', { model: { key: 'p', path: '/missing.onnx', prepare } })),
    ).rejects.toMatchObject({ phase: 'load', message: 'ENOENT' });
  });

  it('replaces a worker that crashes and forgets what it had loaded', async () => {
    const { engine, workers } = setup();
    await engine.run(job('a'));
    (workers[0] as FakeWorker).auto = false;
    const doomed = engine.run(job('a'));
    await Promise.resolve();
    (workers[0] as FakeWorker).emit('error', new Error('out of memory'));
    await expect(doomed).rejects.toThrow(/crashed: out of memory/);
    expect(engine.loaded).toBe(false);
    await engine.run(job('a'));
    expect(workers).toHaveLength(2);
    expect(workers[1]?.types()).toEqual(['load:a', 'run:a']);
  });

  it('fails a job that never answers and replaces the thread', async () => {
    const { engine, workers } = setup({ jobTimeoutMs: 30 });
    await engine.run(job('a'));
    (workers[0] as FakeWorker).auto = false;
    await expect(engine.run(job('a'))).rejects.toThrow(/timed out/);
    expect(workers[0]?.terminated).toBe(true);
    await engine.run(job('a'));
    expect(workers).toHaveLength(2);
  });

  it('drops a waiting job that is aborted, and refuses one aborted beforehand', async () => {
    const { engine, workers } = setup();
    const controller = new AbortController();
    const first = engine.run(job('a'));
    const second = engine.run(job('a', { signal: controller.signal }));
    controller.abort();
    await expect(second).rejects.toMatchObject({ phase: 'aborted' });
    await first;
    expect(workers[0]?.types()).toEqual(['load:a', 'run:a']);
    await expect(engine.run(job('a', { signal: controller.signal }))).rejects.toBeInstanceOf(
      NeuralEngineError,
    );
  });

  it('unloads everything after the idle time and loads again on demand', async () => {
    vi.useFakeTimers();
    try {
      const { engine, workers } = setup({ idleUnloadMs: 1000 });
      const pending = engine.run(job('a'));
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(engine.loaded).toBe(true);
      await vi.advanceTimersByTimeAsync(1001);
      expect(engine.loaded).toBe(false);
      expect(workers[0]?.terminated).toBe(true);
      const again = engine.run(job('a'));
      await vi.advanceTimersByTimeAsync(0);
      await again;
      expect(workers).toHaveLength(2);
      expect(workers[1]?.types()).toEqual(['load:a', 'run:a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the thread and refuses new work once disposed', async () => {
    const { engine, workers } = setup();
    await engine.run(job('a'));
    await engine.dispose();
    expect(workers[0]?.terminated).toBe(true);
    await expect(engine.run(job('a'))).rejects.toThrow(/shut down/);
  });

  it('asks the runtime for the configured device and reports the one it really got', async () => {
    const cpu = setup();
    await cpu.engine.run(job('a'));
    expect(cpu.workers[0]?.messages[0]).toMatchObject({ type: 'load', device: 'cpu' });
    expect(cpu.engine.deviceOf('a')).toBe('cpu');
    expect(cpu.engine.deviceOf('never-loaded')).toBeNull();
    // A GPU is asked for; this "machine" has none and the thread falls back to the CPU.
    const gpu = setup({ device: 'dml' });
    await gpu.engine.run(job('a'));
    expect(gpu.workers[0]?.messages[0]).toMatchObject({ type: 'load', device: 'dml' });
    expect(gpu.engine.deviceOf('a')).toBe('cpu');
    // …and one that has it.
    const real = setup({ device: 'cuda' }, (worker) => {
      worker.device = 'cuda';
    });
    await real.engine.run(job('a'));
    expect(real.engine.deviceOf('a')).toBe('cuda');
  });

  it('uses every core up to four unless told otherwise', () => {
    expect(resolveVoiceThreads(3)).toBe(3);
    expect(resolveVoiceThreads(0)).toBeGreaterThanOrEqual(1);
    expect(resolveVoiceThreads(0)).toBeLessThanOrEqual(4);
  });
});
