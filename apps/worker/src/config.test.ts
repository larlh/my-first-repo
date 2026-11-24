import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot, parseDotEnv } from '@parlante/shared/node';
import { loadConfig, workerEnvSchema } from './config';

const example = fs.readFileSync(path.join(findRepoRoot(), '.env.example'), 'utf8');

/** Every variable the file names, active (`KEY=value`) or offered commented out (`# KEY=`). */
const documented = new Set(
  [...example.matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] as string),
);

describe('.env.example', () => {
  it('copied as is to .env, starts the worker with the documented defaults', () => {
    const config = loadConfig(parseDotEnv(example));
    expect(config.NODE_ENV).toBe('development');
    expect(config.QUEUE_PREFIX).toBe('parlante');
    expect(config.ALLOW_PRIVATE_URLS).toBe(false);
    expect(config.WORKER_KEEP_TMP).toBe(false);
    expect(config.STORAGE_PROVIDER).toBe('local');
    expect(config.LIPSYNC_PROVIDER).toBe('local-neural');
  });

  it('documents every variable the worker reads', () => {
    const missing = Object.keys(workerEnvSchema.shape).filter((name) => !documented.has(name));
    expect(missing).toEqual([]);
  });
});
