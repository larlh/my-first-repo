import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** Where the dev server forwards API traffic (see apps/web/.env.example). */
const apiTarget = (process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000').replace(
  /\/+$/,
  '',
);

/** Paths owned by the API: first-party API + signed files, public API v1, health and docs. */
const proxied = ['/api', '/v1', '/health', '/docs', '/openapi.json'];

/**
 * Dev server on :5173. API paths are proxied so the session cookie and media files are
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
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(
      proxied.map((path) => [path, { target: apiTarget, changeOrigin: false }]),
    ),
  },
  preview: {
    port: 5173,
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
  },
});
