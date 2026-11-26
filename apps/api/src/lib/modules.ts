import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';

/**
 * An API module: `apps/api/src/modules/<name>/index.ts` must default-export one of these.
 * Modules are discovered and registered automatically — nobody edits a shared file to add one.
 */
export interface ApiModule {
  /** Unique name (use the directory name). */
  name: string;
  /** Register the module's routes with `defineRoute(app, api.<group>.<route>, handler)`. */
  register(app: FastifyInstance): void | Promise<void>;
}

/** Type helper: `export default defineModule({ name: 'videos', register(app) { … } })`. */
export function defineModule(module: ApiModule): ApiModule {
  return module;
}

export const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../modules');

/**
 * Import every `modules/<dir>/index.ts`, sorted by name. Directories starting with `_` or `.`
 * are skipped (reference code such as `_template`).
 */
export async function loadModules(dir: string = MODULES_DIR): Promise<ApiModule[]> {
  if (!fs.existsSync(dir)) return [];
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'),
    )
    .map((entry) => entry.name)
    .sort();
  const modules: ApiModule[] = [];
  for (const name of names) {
    const file = ['index.ts', 'index.js']
      .map((candidate) => path.join(dir, name, candidate))
      .find((candidate) => fs.existsSync(candidate));
    if (!file) continue; // empty directory (work in progress)
    const imported = (await import(pathToFileURL(file).href)) as { default?: ApiModule };
    const mod = imported.default;
    if (!mod || typeof mod.register !== 'function' || typeof mod.name !== 'string') {
      throw new Error(
        `modules/${name}/index.ts must default-export defineModule({ name, register })`,
      );
    }
    modules.push(mod);
  }
  return modules;
}
