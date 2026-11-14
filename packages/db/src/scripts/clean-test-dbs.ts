import { dropStaleTestDatabases } from '../testing/index';

/** `pnpm db:test:clean` — drops per-run test databases older than one hour. */
const dropped = await dropStaleTestDatabases();
console.log(
  dropped.length === 0
    ? 'No stale test databases.'
    : `Dropped ${dropped.length} stale test database(s):\n  ${dropped.join('\n  ')}`,
);
