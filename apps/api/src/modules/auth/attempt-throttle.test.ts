import { describe, expect, it } from 'vitest';
import { AttemptThrottle, longestWaitMs } from './attempt-throttle';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('AttemptThrottle', () => {
  it('allows attempts until the limit of failures and says how long to wait after it', () => {
    const time = clock();
    const throttle = new AttemptThrottle({ windowMs: 60_000, now: time.now });
    for (let i = 0; i < 3; i += 1) {
      expect(throttle.retryAfterMs('k', 3)).toBe(0);
      throttle.recordFailure('k');
      time.advance(1_000);
    }
    // Failures at t=0, 1 s, 2 s; now t=3 s → the oldest leaves the window at t=60 s.
    expect(throttle.retryAfterMs('k', 3)).toBe(57_000);
    expect(throttle.retryAfterMs('other', 3)).toBe(0);
  });

  it('forgets failures once they leave the sliding window', () => {
    const time = clock();
    const throttle = new AttemptThrottle({ windowMs: 60_000, now: time.now });
    throttle.recordFailure('k');
    time.advance(30_000);
    throttle.recordFailure('k');
    expect(throttle.retryAfterMs('k', 2)).toBe(30_000);
    time.advance(30_000);
    expect(throttle.retryAfterMs('k', 2)).toBe(0); // only the second failure is left
    time.advance(60_000);
    expect(throttle.retryAfterMs('k', 1)).toBe(0);
    expect(throttle.size).toBe(0);
  });

  it('waits for as many failures to expire as exceed the limit', () => {
    const time = clock();
    const throttle = new AttemptThrottle({ windowMs: 60_000, now: time.now });
    for (let i = 0; i < 4; i += 1) {
      throttle.recordFailure('k');
      time.advance(10_000);
    }
    // 4 failures (t=0,10,20,30 s), limit 2, now t=40 s: free when 3 of them expired → t=80 s.
    expect(throttle.retryAfterMs('k', 2)).toBe(40_000);
  });

  it('resets a key and combines several limits', () => {
    const time = clock();
    const throttle = new AttemptThrottle({ windowMs: 60_000, now: time.now });
    throttle.recordFailure('pair');
    throttle.recordFailure('ip');
    time.advance(5_000);
    throttle.recordFailure('ip');
    const limits = [
      { key: 'pair', max: 1 },
      { key: 'ip', max: 2 },
    ];
    expect(longestWaitMs(throttle, limits)).toBe(55_000);
    throttle.reset('pair');
    expect(longestWaitMs(throttle, limits)).toBe(55_000); // the IP limit still holds
    throttle.reset('ip');
    expect(longestWaitMs(throttle, limits)).toBe(0);
  });

  it('bounds its memory by dropping the keys that failed longest ago', () => {
    const time = clock();
    const throttle = new AttemptThrottle({ windowMs: 60_000, maxKeys: 3, now: time.now });
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      throttle.recordFailure(key);
      time.advance(1);
    }
    expect(throttle.size).toBe(3);
    expect(throttle.retryAfterMs('a', 1)).toBe(0);
    expect(throttle.retryAfterMs('e', 1)).toBeGreaterThan(0);
  });
});
