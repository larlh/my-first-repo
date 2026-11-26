import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot, parseDotEnv } from '@parlante/shared/node';
import { apiEnvSchema, loadConfig } from './config';

const example = fs.readFileSync(path.join(findRepoRoot(), '.env.example'), 'utf8');

/** Every variable the file names, active (`KEY=value`) or offered commented out (`# KEY=`). */
const documented = new Set(
  [...example.matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] as string),
);

describe('.env.example', () => {
  it('copied as is to .env, starts the API with the documented defaults', () => {
    const config = loadConfig(parseDotEnv(example));
    expect(config.NODE_ENV).toBe('development');
    expect(config.API_PORT).toBe(4000);
    expect(config.PUBLIC_API_URL).toBe('http://localhost:4000');
    expect(config.WEB_ORIGIN).toContain('http://localhost:5173');
    expect(config.ALLOW_PRIVATE_URLS).toBe(false);
    expect(config.STORAGE_PROVIDER).toBe('local');
    expect(config.TTS_PROVIDER).toBe('auto');
    expect(config.AVATAR_ENGINE_URL).toBe('http://127.0.0.1:8090');
    // Keys left empty are "not set": no external provider is switched on by the example.
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
    expect(config.ELEVENLABS_API_KEY).toBeUndefined();
    expect(config.OPENAI_API_KEY).toBeUndefined();
  });

  it('documents every variable the API reads', () => {
    const missing = Object.keys(apiEnvSchema.shape).filter((name) => !documented.has(name));
    expect(missing).toEqual([]);
  });
});
