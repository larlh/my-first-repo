import { describe, expect, it, vi } from 'vitest';
import { OrderedQueue } from './queue';
import { deferred, flush } from './testing';

function setup(concurrency = 2) {
  const jobs: { item: string; signal: AbortSignal; done: ReturnType<typeof deferred<string>> }[] =
    [];
  const results: string[] = [];
  const errors: [unknown, number][] = [];
  const pending: number[] = [];
  const queue = new OrderedQueue<string, string>({
    concurrency,
    run: (item, signal) => {
      const done = deferred<string>();
      jobs.push({ item, signal, done });
      return done.promise;
    },
    onResult: (result) => results.push(result),
    onError: (error, index) => errors.push([error, index]),
    onPendingChange: (count) => pending.push(count),
  });
  const job = (item: string) => {
    const found = jobs.find((entry) => entry.item === item);
    if (!found) throw new Error(`job ${item} has not started`);
    return found;
  };
  return { queue, jobs, job, results, errors, pending };
}

describe('OrderedQueue', () => {
  it('delivers results in push order even when a later job finishes first', async () => {
    const { queue, job, results } = setup(2);
    queue.push('a');
    queue.push('b');
    job('b').done.resolve('B');
    await flush();
    expect(results).toEqual([]); // B waits for A
    job('a').done.resolve('A');
    await flush();
    expect(results).toEqual(['A', 'B']);
    expect(queue.pending).toBe(0);
  });

  it('never runs more jobs at once than the concurrency allows', async () => {
    const { queue, jobs, job, results } = setup(2);
    for (const item of ['a', 'b', 'c', 'd']) queue.push(item);
    expect(jobs.map((entry) => entry.item)).toEqual(['a', 'b']);
    job('b').done.resolve('B');
    await flush();
    expect(jobs.map((entry) => entry.item)).toEqual(['a', 'b', 'c']);
    job('c').done.resolve('C');
    job('a').done.resolve('A');
    await flush();
    job('d').done.resolve('D');
    await flush();
    expect(results).toEqual(['A', 'B', 'C', 'D']);
  });

  it('reports how many phrases are still on their way', async () => {
    const { queue, job, pending } = setup(1);
    queue.push('a');
    queue.push('b');
    job('a').done.resolve('A');
    await flush();
    job('b').done.resolve('B');
    await flush();
    expect(pending).toEqual([1, 2, 1, 0]);
  });

  it('on a failure delivers what came before, drops what came after and stops', async () => {
    const { queue, jobs, job, results, errors } = setup(3);
    for (const item of ['a', 'b', 'c']) queue.push(item);
    const boom = new Error('boom');
    job('b').done.reject(boom);
    job('c').done.resolve('C');
    await flush();
    expect(results).toEqual([]);
    expect(errors).toEqual([]);
    job('a').done.resolve('A');
    await flush();
    expect(results).toEqual(['A']);
    expect(errors).toEqual([[boom, 1]]);
    expect(queue.accepting).toBe(false);
    expect(job('c').signal.aborted).toBe(true);
    queue.push('d');
    expect(jobs).toHaveLength(3);
  });

  it('abort() cancels running jobs and delivers nothing else', async () => {
    const { queue, job, results, errors } = setup(2);
    queue.push('a');
    queue.push('b');
    queue.abort();
    expect(job('a').signal.aborted).toBe(true);
    job('a').done.resolve('A');
    job('b').done.reject(new Error('aborted'));
    await flush();
    expect(results).toEqual([]);
    expect(errors).toEqual([]);
    expect(queue.pending).toBe(0);
  });

  it('whenIdle() resolves once everything pushed was delivered', async () => {
    const { queue, job } = setup(2);
    const idle = vi.fn();
    queue.push('a');
    void queue.whenIdle().then(idle);
    await flush();
    expect(idle).not.toHaveBeenCalled();
    job('a').done.resolve('A');
    await flush();
    expect(idle).toHaveBeenCalledTimes(1);
    await expect(queue.whenIdle()).resolves.toBeUndefined();
  });
});
