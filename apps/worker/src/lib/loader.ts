import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { QUEUES } from '@parlante/shared';
import type { JobDefinition } from './job';

export const JOBS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../jobs');

/**
 * Import every `jobs/<dir>/index.ts`, sorted by name (directories starting with `_` or `.` are
 * skipped). Fails when two jobs claim the same queue.
 */
export async function loadJobs(dir: string = JOBS_DIR): Promise<JobDefinition[]> {
  if (!fs.existsSync(dir)) return [];
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'),
    )
    .map((entry) => entry.name)
    .sort();
  const jobs: JobDefinition[] = [];
  const claimed = new Map<string, string>();
  for (const name of names) {
    const file = ['index.ts', 'index.js']
      .map((candidate) => path.join(dir, name, candidate))
      .find((candidate) => fs.existsSync(candidate));
    if (!file) continue;
    const imported = (await import(pathToFileURL(file).href)) as { default?: JobDefinition };
    const job = imported.default;
    if (!job || typeof job.handler !== 'function' || !(job.queue in QUEUES)) {
      throw new Error(`jobs/${name}/index.ts must default-export defineJob({ queue, handler })`);
    }
    const other = claimed.get(job.queue);
    if (other)
      throw new Error(`Queue "${job.queue}" is processed by both jobs/${other} and jobs/${name}`);
    claimed.set(job.queue, name);
    jobs.push(job);
  }
  return jobs;
}
