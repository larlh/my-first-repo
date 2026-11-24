import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Settings of the dev / preview server. The shell environment wins; then `apps/web/.env*`; then
 * the `.env` at the repo root — the file the README tells people to create, and the one the API
 * and the worker read. Without the last step, changing API_PORT there left the web app
 * proxying to :4000.
 */
const fileEnv = {
  ...loadEnv('development', fileURLToPath(new URL('../..', import.meta.url)), ['VITE_', 'WEB_']),
  ...loadEnv('development', fileURLToPath(new URL('.', import.meta.url)), ['VITE_', 'WEB_']),
};
const setting = (name: string): string | undefined => {
  const value = (process.env[name] ?? fileEnv[name] ?? '').trim();
  return value === '' ? undefined : value;
};

/** Where the dev server forwards API traffic (see .env.example). */
const apiTarget = (setting('VITE_API_PROXY_TARGET') ?? 'http://localhost:4000').replace(/\/+$/, '');

/** Port of the dev / preview server (`WEB_PORT`, default 5173). */
const webPort = Number(setting('WEB_PORT') ?? 5173);
/**
 * Bind address of the dev / preview server (`WEB_HOST`). Unset = localhost only. `0.0.0.0` serves
 * other devices on the local network; their origin must then be listed in `WEB_ORIGIN`.
 */
const webHost = setting('WEB_HOST') || undefined;

/** Paths owned by the API: first-party API + signed files, public API v1, health and docs. */
const proxied = ['/api', '/v1', '/health', '/docs', '/openapi.json'];

/**
 * Dev server on :5173 (or WEB_PORT). API paths are proxied so the session cookie and media files are
 * same-origin in development (no CORS, canvas stays untainted).
 * Internal packages (@parlante/shared, @parlante/renderer, …) are consumed as TypeScript source.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    // Lets `toAppUrl()` map absolute API file URLs onto the dev proxy.
    __PARLANTE_API_PROXY_TARGET__: JSON.stringify(apiTarget),
  },
  server: {
    host: webHost,
    port: webPort,
    strictPort: true,
    proxy: Object.fromEntries(
      proxied.map((path) => [path, { target: apiTarget, changeOrigin: false }]),
    ),
  },
  preview: {
    host: webHost,
    port: webPort,
    proxy: Object.fromEntries(
      proxied.map((path) => [path, { target: apiTarget, changeOrigin: false }]),
    ),
  },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
    passWithNoTests: true,
    // These are integration tests: each one mounts the real shell in jsdom and types into it,
    // and some wait on real debounces (Studio autosave: 2 × 1.2 s). Measured alone on 4 cores the
    // slowest takes 4.5–6.1 s; while the API and worker suites run next to it (`pnpm -r test`)
    // everything takes 1.5–2× longer. vitest's default of 5 s is sized for unit tests — every
    // other package of the repo already sets its own.
    testTimeout: 20_000,
  },
});
