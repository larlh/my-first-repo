/**
 * Rate-limit a side effect (typically a DB progress update). Calls made while the previous one
 * is still inside the interval are dropped, except the most recent, which is delivered by
 * `flush()` — call it before writing the final state.
 */
export function throttled<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
  intervalMs: number,
): { (...args: A): Promise<void>; flush(): Promise<void> } {
  let last = 0;
  let pending: A | null = null;
  let running: Promise<void> = Promise.resolve();
  const call = async (...args: A): Promise<void> => {
    const now = Date.now();
    if (now - last < intervalMs) {
      pending = args;
      return;
    }
    last = now;
    pending = null;
    running = running.then(() => fn(...args)).catch(() => undefined);
    await running;
  };
  call.flush = async (): Promise<void> => {
    await running;
    if (pending) {
      const args = pending;
      pending = null;
      last = Date.now();
      await fn(...args);
    }
  };
  return call;
}

/** Map progress inside a stage to overall percent: `scale(0.5, 20, 80)` → 50. */
export function scale(fraction: number, from: number, to: number): number {
  const f = Math.min(1, Math.max(0, fraction));
  return Math.round(from + (to - from) * f);
}
