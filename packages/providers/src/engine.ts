import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EngineHealth, EngineStatus } from '@parlante/shared';
import { resolveEngineWorkDir } from './env';
import type { ProviderEnv } from './env';

/* -------------------------------------------------------------------------------------------
 * Shared plumbing of the two `local-neural` providers (lipsync, portrait) — the only clients
 * of services/avatar-engine. Contract: packages/shared/src/avatar-engine.ts.
 * ----------------------------------------------------------------------------------------- */

/** Headers of every engine request (`Authorization` when AVATAR_ENGINE_TOKEN is set). */
export function engineRequestHeaders(
  env: Pick<ProviderEnv, 'AVATAR_ENGINE_TOKEN'>,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(env.AVATAR_ENGINE_TOKEN ? { authorization: `Bearer ${env.AVATAR_ENGINE_TOKEN}` } : {}),
  };
}

export interface EngineJobDir {
  /** Absolute path inside AVATAR_ENGINE_WORK_DIR: pass it to the engine as `outputDir`. */
  readonly dir: string;
  /**
   * Copy a caller's file (any readable path) into the job dir under a fixed, safe name and
   * return the path to send to the engine. `name` is chosen by the provider, never by input.
   */
  importFile(sourcePath: string, name: string): Promise<string>;
  /**
   * Copy a file the engine reported back into the caller's `destDir` and return the new path.
   * Refuses paths outside the job dir (an engine answer is never trusted with arbitrary paths).
   */
  exportFile(enginePath: string, destDir: string, name?: string): Promise<string>;
  /** Delete the job dir. Call it in `finally`: nothing may be left in the shared volume. */
  remove(): Promise<void>;
}

function assertPlainName(name: string): void {
  if (name === '' || name !== path.basename(name) || name.startsWith('.')) {
    throw new Error(`Invalid engine file name: ${JSON.stringify(name)}`);
  }
}

/**
 * Private sub-directory of the engine work dir for ONE engine job. This is how the
 * `local-neural` providers honour "request paths may be anywhere, the engine only sees its
 * work dir" (providers.ts): import inputs → run the engine with `outputDir = dir` → export
 * results to `request.outputDir` → remove.
 */
export async function createEngineJobDir(
  env: Pick<ProviderEnv, 'AVATAR_ENGINE_WORK_DIR'>,
): Promise<EngineJobDir> {
  const root = resolveEngineWorkDir(env);
  const dir = path.join(root, `job-${randomBytes(8).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  return {
    dir,
    async importFile(sourcePath, name) {
      assertPlainName(name);
      const target = path.join(dir, name);
      await fs.copyFile(sourcePath, target);
      return target;
    },
    async exportFile(enginePath, destDir, name) {
      const resolved = path.resolve(enginePath);
      if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
        throw new Error('The avatar engine returned a path outside its job directory');
      }
      const fileName = name ?? path.basename(resolved);
      assertPlainName(fileName);
      await fs.mkdir(destDir, { recursive: true });
      const target = path.join(destDir, fileName);
      await fs.copyFile(resolved, target);
      return target;
    },
    async remove() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const WEIGHTS_HINT = 'download the model weights (see services/avatar-engine/README.md)';

/**
 * EngineStatus of one provider from the engine's `GET /health`. Both `local-neural` providers
 * use it so `/api/capabilities` is consistent:
 *  - lipsync:  available ⇔ `capabilities.animate`
 *  - portrait: available ⇔ `capabilities.prepare` (generation is optional: check
 *              `operations.generate` before accepting a text → avatar request)
 */
export function engineStatusFromHealth(
  health: EngineHealth,
  provider: 'lipsync' | 'portrait',
): EngineStatus {
  const operations = { ...health.capabilities };
  const available = provider === 'lipsync' ? operations.animate : operations.prepare;
  const missing = (Object.keys(operations) as (keyof typeof operations)[]).filter(
    (op) => !operations[op],
  );
  const reason = available
    ? missing.length > 0
      ? `Not available yet: ${missing.join(', ')} — ${WEIGHTS_HINT}`
      : null
    : `The avatar engine is running but cannot ${provider === 'lipsync' ? 'animate' : 'prepare portraits'} yet: ${WEIGHTS_HINT}`;
  return {
    available,
    reason,
    device: health.device,
    secondsPerVideoSecond: health.secondsPerVideoSecond,
    operations,
    models: health.models,
    nonCommercial: health.models.some((model) => model.downloaded && !model.commercialUse),
    secondsPerPortrait: health.secondsPerPortrait ?? null,
  };
}
