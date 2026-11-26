import { baseEnvSchema, parseEnv } from '@parlante/shared/node';
import { runMigrations } from '../migrate';

/** `pnpm db:migrate` — applies pending migrations to DATABASE_URL. */
const env = parseEnv(baseEnvSchema.pick({ DATABASE_URL: true }));
const safeUrl = env.DATABASE_URL.replace(/:\/\/([^:/@]+):[^@]*@/, '://$1:***@');
console.log(`Applying migrations to ${safeUrl}`);
await runMigrations(env.DATABASE_URL);
console.log('Migrations applied.');
