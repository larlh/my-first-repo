import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // One throw-away, migrated database per run (see @parlante/db/testing).
    globalSetup: ['@parlante/db/testing/global-setup'],
    // Test files share that database: run them one after another.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
