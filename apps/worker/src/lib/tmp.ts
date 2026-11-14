import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkerContext } from '../context';

export interface TempDir {
  path: string;
  /** Absolute path of a file inside the directory. `name` must be a plain file name. */
  file(name: string): string;
  remove(): Promise<void>;
}

/** Create a private temp directory for one job. Names are random: nothing comes from input. */
export async function createTempDir(
  ctx: Pick<WorkerContext, 'config'>,
  label: string,
): Promise<TempDir> {
  const base = ctx.config.WORKER_TMP_DIR ?? os.tmpdir();
  const safeLabel = label.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'job';
  const dir = path.join(base, `parlante-${safeLabel}-${randomBytes(8).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return {
    path: dir,
    file(name: string) {
      if (name !== path.basename(name) || name === '' || name.startsWith('.')) {
        throw new Error(`Invalid temp file name: ${JSON.stringify(name)}`);
      }
      return path.join(dir, name);
    },
    remove: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Run `fn` with a temp directory that is always removed afterwards (unless WORKER_KEEP_TMP).
 *   await withTempDir(ctx, 'render', async (tmp) => { await runFfmpeg(['-i', tmp.file('in.wav'), …]); });
 */
export async function withTempDir<T>(
  ctx: Pick<WorkerContext, 'config'>,
  label: string,
  fn: (tmp: TempDir) => Promise<T>,
): Promise<T> {
  const tmp = await createTempDir(ctx, label);
  try {
    return await fn(tmp);
  } finally {
    if (!ctx.config.WORKER_KEEP_TMP) await tmp.remove();
  }
}
