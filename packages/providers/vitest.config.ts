import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // A few tests move real data (a 70 MB multipart upload, a long ElevenLabs script stitched
    // from many requests) and take 11–13 s alone. With one worker per core on a 16-core machine
    // they went past 30 s under `pnpm -r test`. Capped at 4; `--maxWorkers` still overrides it.
    maxWorkers: Math.min(4, availableParallelism()),
  },
});
