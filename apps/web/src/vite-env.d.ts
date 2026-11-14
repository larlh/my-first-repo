/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL for API calls; empty = same origin (see apps/web/.env.example). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Origin the dev server proxies API traffic to (injected by vite.config.ts). */
declare const __PARLANTE_API_PROXY_TARGET__: string | undefined;
