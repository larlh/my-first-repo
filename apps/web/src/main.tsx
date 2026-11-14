import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

/**
 * Placeholder entry so the toolchain (Vite + React + Tailwind + TS) is verified end to end.
 * The application shell (router, providers, layout, features autoloaded by glob from
 * `src/features/*`) is built by the web-core agent — replace this file.
 */
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <main className="grid min-h-screen place-items-center bg-slate-950 text-slate-100">
        <h1 className="text-2xl font-semibold">Parlante</h1>
      </main>
    </StrictMode>,
  );
}
