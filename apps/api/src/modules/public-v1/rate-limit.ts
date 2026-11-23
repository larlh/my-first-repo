import { AppError } from '@parlante/shared';
import type { PlanId } from '@parlante/shared';
import type { FastifyReply } from 'fastify';

/* -------------------------------------------------------------------------------------------
 * Request limit of the public API, PER API KEY (the global limiter of the app counts per IP,
 * which says nothing about who is calling: many keys can share one address and one key can
 * call from many). Fixed one-minute windows, counted in memory by this API process — with
 * several API instances each one enforces the limit on the requests it serves.
 * ----------------------------------------------------------------------------------------- */

export const V1_RATE_WINDOW_MS = 60_000;

/** Requests per minute and API key, by plan of the workspace. */
export const V1_RATE_LIMITS: Record<PlanId, number> = {
  free: 60,
  creator: 120,
  team: 300,
};

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window of this key starts again. */
  resetSec: number;
}

interface Window {
  startedAt: number;
  count: number;
}

export class KeyRateLimiter {
  private readonly windows = new Map<string, Window>();
  private lastSweepAt = 0;

  constructor(
    private readonly windowMs: number = V1_RATE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one request of `keyId` against `limit`. */
  take(keyId: string, limit: number): RateDecision {
    const now = this.now();
    this.sweep(now);
    let window = this.windows.get(keyId);
    if (!window || now - window.startedAt >= this.windowMs) {
      window = { startedAt: now, count: 0 };
      this.windows.set(keyId, window);
    }
    const resetSec = Math.max(1, Math.ceil((window.startedAt + this.windowMs - now) / 1000));
    if (window.count >= limit) return { allowed: false, limit, remaining: 0, resetSec };
    window.count += 1;
    return { allowed: true, limit, remaining: limit - window.count, resetSec };
  }

  /** Forget windows that ended, so keys that stopped calling do not accumulate. */
  private sweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs) return;
    this.lastSweepAt = now;
    for (const [keyId, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(keyId);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}

/**
 * Apply the decision to the response: `RateLimit-*` headers on every answer and, when the
 * key ran out, 429 RATE_LIMITED with `Retry-After`.
 */
export function enforceRateLimit(reply: FastifyReply, decision: RateDecision): void {
  void reply
    .header('RateLimit-Limit', decision.limit)
    .header('RateLimit-Remaining', decision.remaining)
    .header('RateLimit-Reset', decision.resetSec);
  if (decision.allowed) return;
  void reply.header('Retry-After', decision.resetSec);
  throw new AppError(
    'RATE_LIMITED',
    `This API key made too many requests. Try again in ${decision.resetSec} s`,
    {
      limit: decision.limit,
      windowSec: V1_RATE_WINDOW_MS / 1000,
      retryAfterSec: decision.resetSec,
    },
  );
}
