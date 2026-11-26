import { eq } from 'drizzle-orm';
import { baseEnvSchema, hashPassword, parseEnv } from '@parlante/shared/node';
import { createUserWithWorkspace } from '../accounts';
import { createDb } from '../client';
import { members, users, workspaces } from '../schema';

/**
 * `pnpm db:seed` — idempotent demo data for local development:
 *   user  demo@parlante.local / parlante-demo   (owner of "Demo Studio", creator plan)
 * Refuses to run in production.
 */
export const DEMO_EMAIL = 'demo@parlante.local';
export const DEMO_PASSWORD = 'parlante-demo';

const env = parseEnv(baseEnvSchema.pick({ DATABASE_URL: true, NODE_ENV: true }));
if (env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}

const handle = createDb(env.DATABASE_URL, { max: 1, applicationName: 'parlante-seed' });
try {
  const [existing] = await handle.db.select().from(users).where(eq(users.email, DEMO_EMAIL));
  if (existing) {
    const rows = await handle.db
      .select({ name: workspaces.name })
      .from(members)
      .innerJoin(workspaces, eq(members.workspaceId, workspaces.id))
      .where(eq(members.userId, existing.id));
    console.log(
      `Demo user already exists (${DEMO_EMAIL}); workspaces: ${rows.map((r) => r.name).join(', ')}`,
    );
  } else {
    const { user, workspace } = await createUserWithWorkspace(handle.db, {
      email: DEMO_EMAIL,
      name: 'Demo',
      passwordHash: await hashPassword(DEMO_PASSWORD),
      locale: 'es',
      workspaceName: 'Demo Studio',
      plan: 'creator',
    });
    console.log(`Created demo user ${user.email} (password: ${DEMO_PASSWORD})`);
    console.log(`Created workspace "${workspace.name}" with ${workspace.credits} credits`);
  }
} finally {
  await handle.close();
}
