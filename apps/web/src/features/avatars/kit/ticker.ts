/* One requestAnimationFrame loop shared by every animated stage on the page. A library grid
 * mounts a dozen canvases: a loop each would wake the main thread a dozen times per frame.
 * Subscribers are called at most `fps` times per second with the page time in ms. */

type Tick = (nowMs: number) => void;

interface Subscriber {
  tick: Tick;
  intervalMs: number;
  lastMs: number;
}

const subscribers = new Set<Subscriber>();
let frame: number | null = null;

function loop(nowMs: number): void {
  frame = null;
  for (const subscriber of subscribers) {
    // Half a millisecond of slack so a 30 fps subscriber is not skipped on a 60 Hz display.
    if (nowMs - subscriber.lastMs + 0.5 >= subscriber.intervalMs) {
      subscriber.lastMs = nowMs;
      subscriber.tick(nowMs);
    }
  }
  if (subscribers.size > 0) frame = requestAnimationFrame(loop);
}

/** Call `tick` up to `fps` times per second until the returned function is called. */
export function subscribeTicker(tick: Tick, fps = 30): () => void {
  const subscriber: Subscriber = { tick, intervalMs: 1000 / fps, lastMs: -Infinity };
  subscribers.add(subscriber);
  if (frame === null && typeof requestAnimationFrame === 'function') {
    frame = requestAnimationFrame(loop);
  }
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0 && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  };
}

/** Number of live subscribers (tests). */
export function tickerSize(): number {
  return subscribers.size;
}
