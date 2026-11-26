import { defineConfig } from 'drizzle-kit';

/** `pnpm db:generate` diffs src/schema.ts against ./drizzle and writes a new SQL migration. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://parlante:parlante@localhost:5432/parlante',
  },
});
