import type { Capabilities, EngineModelInfo, EngineOperations } from '@parlante/shared';

/* Reading the state of the local neural engine (`Capabilities.avatarEngine`, also sent with
 * `GET /api/avatars` as `engine`). Every number shown to the user comes from here and is a
 * figure the engine MEASURED on this machine — never an invented one (master prompt §2b). */

export type EngineStatus = Capabilities['avatarEngine'];
export type EngineOperation = keyof EngineOperations;

export const ENGINE_OPERATIONS: readonly EngineOperation[] = ['generate', 'prepare', 'animate'];

/** Command that installs, downloads the weights and starts the engine (root package.json). */
export const ENGINE_START_COMMAND = 'pnpm avatar-engine';
/** Where the licence of every model is documented. */
export const ENGINE_MODELS_DOC = 'docs/MODELS.md';

export type EngineHealth =
  /** The API did not report the engine (older producer / request failed). */
  | 'unknown'
  /** Not running or no operation usable. */
  | 'off'
  /** Running, but some operation is missing (weights not downloaded…). */
  | 'partial'
  /** Every operation usable. */
  | 'ready';

export function engineCan(
  engine: EngineStatus | null | undefined,
  operation: EngineOperation,
): boolean {
  if (!engine || !engine.available) return false;
  return engine.operations[operation];
}

export function engineHealth(engine: EngineStatus | null | undefined): EngineHealth {
  if (!engine) return 'unknown';
  const usable = ENGINE_OPERATIONS.filter((operation) => engineCan(engine, operation)).length;
  if (usable === 0) return 'off';
  return usable === ENGINE_OPERATIONS.length ? 'ready' : 'partial';
}

/** Downloaded models whose licence forbids commercial use (drives the visible notice). */
export function nonCommercialModels(engine: EngineStatus | null | undefined): EngineModelInfo[] {
  if (!engine) return [];
  return engine.models.filter((model) => model.downloaded && !model.commercialUse);
}

/** Models declared by the engine whose weights are not in the cache. */
export function missingModels(engine: EngineStatus | null | undefined): EngineModelInfo[] {
  if (!engine) return [];
  return engine.models.filter((model) => !model.downloaded);
}

/**
 * Measured seconds of computation to animate `videoSeconds` of photorealistic video on this
 * machine, or null while the engine has not measured its speed.
 */
export function animationSeconds(
  engine: EngineStatus | null | undefined,
  videoSeconds: number,
): number | null {
  const rate = engine?.secondsPerVideoSecond ?? null;
  if (rate === null || !(videoSeconds > 0)) return null;
  return Math.round(rate * videoSeconds);
}

/** Measured seconds to generate one portrait, or null when not measured. */
export function portraitSeconds(engine: EngineStatus | null | undefined): number | null {
  const value = engine?.secondsPerPortrait ?? null;
  return value === null ? null : Math.round(value);
}

/**
 * Seconds left of a job. The API value (measured by the engine, persisted by the job) wins;
 * before the first report, a portrait generation can fall back to the measured cost of one
 * portrait scaled by what is left. `estimated` tells the UI to mark it as approximate.
 */
export function remainingSeconds(input: {
  etaSec: number | null;
  progress: number;
  totalSec: number | null;
}): { seconds: number; estimated: boolean } | null {
  if (input.etaSec !== null) return { seconds: input.etaSec, estimated: false };
  if (input.totalSec === null) return null;
  const left = Math.max(0, 1 - Math.min(100, Math.max(0, input.progress)) / 100);
  return { seconds: Math.round(input.totalSec * left), estimated: true };
}
