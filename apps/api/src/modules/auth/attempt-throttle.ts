/* -------------------------------------------------------------------------------------------
 * Failed-attempt limiter for credential checks (login, change password).
 *
 * It counts FAILURES per key in a sliding window and answers how long a key must wait once it
 * reaches its limit. Keys are opaque strings chosen by the caller (e-mail + IP, e-mail, IP…),
 * and unknown e-mails are counted exactly like real ones, so the limiter never reveals
 * whether an account exists.
 *
 * State lives in the memory of this API process: it resets on restart and is not shared
 * between instances. The per-IP route rate limit (`@fastify/rate-limit`) still applies on top.
 * ----------------------------------------------------------------------------------------- */

export interface AttemptThrottleOptions {
  /** Sliding window in milliseconds. */
  windowMs: number;
  /** Upper bound of tracked keys; the oldest are dropped beyond it. */
  maxKeys?: number;
  /** Clock (tests). */
  now?: () => number;
}

export class AttemptThrottle {
  private readonly failures = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: AttemptThrottleOptions) {
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 50_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Failures of `key` still inside the window, oldest first. */
  private recent(key: string): number[] {
    const list = this.failures.get(key);
    if (!list) return [];
    const cutoff = this.now() - this.windowMs;
    const live = list.filter((at) => at > cutoff);
    if (live.length === 0) this.failures.delete(key);
    else if (live.length !== list.length) this.failures.set(key, live);
    return live;
  }

  /**
   * Milliseconds until `key` may try again given a limit of `max` failures per window;
   * 0 when it is allowed now.
   */
  retryAfterMs(key: string, max: number): number {
    const live = this.recent(key);
    if (live.length < max) return 0;
    // Allowed again when enough of the oldest failures have left the window.
    const releasing = live[live.length - max];
    return releasing === undefined ? 0 : Math.max(1, releasing + this.windowMs - this.now());
  }

  recordFailure(key: string): void {
    const live = this.recent(key);
    live.push(this.now());
    // Re-insert so Map order is "least recently failed first" for eviction.
    this.failures.delete(key);
    this.failures.set(key, live);
    if (this.failures.size > this.maxKeys) this.evict();
  }

  /** Forget the failures of a key (after a successful check). */
  reset(key: string): void {
    this.failures.delete(key);
  }

  get size(): number {
    return this.failures.size;
  }

  private evict(): void {
    for (const key of [...this.failures.keys()]) this.recent(key);
    for (const key of this.failures.keys()) {
      if (this.failures.size <= this.maxKeys) break;
      this.failures.delete(key);
    }
  }
}

export interface AttemptLimit {
  key: string;
  max: number;
}

/** Longest wait among several limits (0 = every one of them allows the attempt). */
export function longestWaitMs(throttle: AttemptThrottle, limits: AttemptLimit[]): number {
  return limits.reduce(
    (wait, limit) => Math.max(wait, throttle.retryAfterMs(limit.key, limit.max)),
    0,
  );
}
