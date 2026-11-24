/* Runs a job per item with bounded concurrency and hands the results over in the order the
 * items were pushed — whatever order the jobs finish in. The dictation uses it so a phrase
 * whose transcription is slow can never end up after the phrase that was spoken next. */

export interface OrderedQueueOptions<T, R> {
  /** How many jobs may run at the same time. */
  concurrency: number;
  run: (item: T, signal: AbortSignal) => Promise<R>;
  /** Called once per item, strictly in push order. */
  onResult: (result: R, index: number) => void;
  /**
   * A job failed. Results of earlier items have already been delivered; later items are
   * dropped (their jobs are aborted) and the queue accepts nothing else.
   */
  onError: (error: unknown, index: number) => void;
  /** Number of items pushed and not yet delivered (or dropped) changed. */
  onPendingChange?: (pending: number) => void;
}

type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown };

export class OrderedQueue<T, R> {
  private readonly options: OrderedQueueOptions<T, R>;
  private readonly waiting: { item: T; index: number }[] = [];
  private readonly settled = new Map<number, Settled<R>>();
  private readonly controller = new AbortController();
  private nextIndex = 0;
  private nextToDeliver = 0;
  private running = 0;
  private closed = false;
  private idleWaiters: (() => void)[] = [];

  constructor(options: OrderedQueueOptions<T, R>) {
    this.options = options;
  }

  /** Items pushed whose result has not been delivered yet. */
  get pending(): number {
    return this.closed ? 0 : this.nextIndex - this.nextToDeliver;
  }

  /** False once a job failed or `abort()` was called. */
  get accepting(): boolean {
    return !this.closed;
  }

  push(item: T): void {
    if (this.closed) return;
    this.waiting.push({ item, index: this.nextIndex });
    this.nextIndex += 1;
    this.options.onPendingChange?.(this.pending);
    this.pump();
  }

  /** Drop everything: running jobs are aborted and nothing else is delivered. */
  abort(): void {
    if (this.closed) return;
    this.close();
  }

  /** Resolves when every pushed item was delivered, or the queue was closed. */
  whenIdle(): Promise<void> {
    if (this.closed || this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private close(): void {
    this.closed = true;
    this.waiting.length = 0;
    this.settled.clear();
    this.controller.abort();
    this.options.onPendingChange?.(0);
    this.releaseIdle();
  }

  private releaseIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private pump(): void {
    while (!this.closed && this.running < this.options.concurrency) {
      const next = this.waiting.shift();
      if (!next) return;
      this.running += 1;
      this.options.run(next.item, this.controller.signal).then(
        (value) => this.settle(next.index, { ok: true, value }),
        (error: unknown) => this.settle(next.index, { ok: false, error }),
      );
    }
  }

  private settle(index: number, outcome: Settled<R>): void {
    this.running -= 1;
    if (this.closed) return;
    this.settled.set(index, outcome);
    while (!this.closed) {
      const head = this.settled.get(this.nextToDeliver);
      if (!head) break;
      this.settled.delete(this.nextToDeliver);
      const at = this.nextToDeliver;
      this.nextToDeliver += 1;
      if (head.ok) {
        this.options.onResult(head.value, at);
        this.options.onPendingChange?.(this.pending);
      } else {
        this.close();
        this.options.onError(head.error, at);
        return;
      }
    }
    if (this.closed) return;
    if (this.pending === 0) this.releaseIdle();
    this.pump();
  }
}
