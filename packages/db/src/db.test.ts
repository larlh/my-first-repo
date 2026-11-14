import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLANS, SIGNUP_CREDITS, buildPage, createComposition, newId } from '@parlante/shared';
import {
  assets,
  avatars,
  chargeCredits,
  creditLedger,
  cursorOrder,
  cursorWhere,
  getCreditBalance,
  grantCredits,
  members,
  netCharged,
  refundCredits,
  settleCredits,
  videos,
  workspaces,
} from './index';
import type { DbHandle } from './index';
import { connectTestDb, resetDatabase, seedAccount, seedMember } from './testing/index';

let handle: DbHandle;

beforeAll(() => {
  handle = connectTestDb();
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await resetDatabase(handle.db);
});

describe('migrations', () => {
  it('created every table in the per-run database', async () => {
    const res = await handle.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(res.rows.map((r) => r.tablename)).toEqual([
      'api_keys',
      'assets',
      'avatars',
      'batch_items',
      'batch_jobs',
      'brand_kits',
      'consent_records',
      'credit_ledger',
      'interactive_messages',
      'interactive_sessions',
      'invites',
      'members',
      'render_jobs',
      'sessions',
      'share_links',
      'templates',
      'translation_jobs',
      'translation_outputs',
      'users',
      'videos',
      'voices',
      'webhook_deliveries',
      'webhook_endpoints',
      'workspaces',
    ]);
    expect(process.env.DATABASE_URL).toContain('parlante_test_');
  });
});

describe('accounts', () => {
  it('creates user + personal workspace + owner membership + signup grant', async () => {
    const { user, workspace, member } = await seedAccount(handle.db, {
      email: 'Ana@Example.test',
      name: 'Ana García',
    });
    expect(user.email).toBe('ana@example.test');
    expect(workspace.name).toBe('Espacio de Ana');
    expect(workspace.plan).toBe('free');
    expect(workspace.credits).toBe(SIGNUP_CREDITS);
    expect(member.role).toBe('owner');
    const ledger = await handle.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.workspaceId, workspace.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      delta: SIGNUP_CREDITS,
      balanceAfter: SIGNUP_CREDITS,
      reason: 'signup_grant',
    });
  });

  it('grants plan credits for paid plans and enforces unique e-mail and membership', async () => {
    const a = await seedAccount(handle.db, { email: 'dup@example.test', plan: 'team' });
    expect(a.workspace.credits).toBe(PLANS.team.monthlyCredits);
    await expect(seedAccount(handle.db, { email: 'dup@example.test' })).rejects.toThrow();
    const m = await seedMember(handle.db, a.workspace.id, 'editor');
    await expect(
      handle.db.insert(members).values({
        id: newId('member'),
        workspaceId: a.workspace.id,
        userId: m.user.id,
        role: 'viewer',
      }),
    ).rejects.toThrow();
  });

  it('cascades workspace deletion to its content', async () => {
    const { workspace, user } = await seedAccount(handle.db);
    await handle.db.insert(videos).values({
      id: newId('video'),
      workspaceId: workspace.id,
      title: 'v',
      composition: createComposition(),
      aspect: '16:9',
      createdBy: user.id,
    });
    await handle.db.delete(workspaces).where(eq(workspaces.id, workspace.id));
    expect(await handle.db.select().from(videos)).toHaveLength(0);
    expect(await handle.db.select().from(creditLedger)).toHaveLength(0);
  });
});

describe('credits', () => {
  it('charges, refuses overdrafts, refunds idempotently and keeps ledger = balance', async () => {
    const { workspace } = await seedAccount(handle.db, { credits: 10 });
    const ref = { refType: 'renderJob', refId: newId('renderJob') };
    const entry = await chargeCredits(handle.db, {
      workspaceId: workspace.id,
      amount: 4,
      reason: 'render',
      ...ref,
    });
    expect(entry).toMatchObject({ delta: -4, balanceAfter: 6 });
    await expect(
      chargeCredits(handle.db, { workspaceId: workspace.id, amount: 7, reason: 'render' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS', status: 402 });
    expect(await getCreditBalance(handle.db, workspace.id)).toBe(6);
    expect(await netCharged(handle.db, workspace.id, ref)).toBe(4);

    const refund = await refundCredits(handle.db, { workspaceId: workspace.id, ...ref });
    expect(refund).toMatchObject({ delta: 4, balanceAfter: 10, reason: 'refund' });
    expect(await refundCredits(handle.db, { workspaceId: workspace.id, ...ref })).toBeNull();
    expect(await getCreditBalance(handle.db, workspace.id)).toBe(10);

    const rows = await handle.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.workspaceId, workspace.id));
    expect(rows.reduce((sum, r) => sum + r.delta, 0)).toBe(10);
  });

  it('settles a reservation up or down to the actual cost', async () => {
    const { workspace } = await seedAccount(handle.db, { credits: 10 });
    const ref = { refType: 'renderJob', refId: newId('renderJob') };
    await chargeCredits(handle.db, {
      workspaceId: workspace.id,
      amount: 3,
      reason: 'render',
      ...ref,
    });
    expect(
      await settleCredits(handle.db, { workspaceId: workspace.id, actualCost: 5, ...ref }),
    ).toBe(5);
    expect(await getCreditBalance(handle.db, workspace.id)).toBe(5);
    expect(
      await settleCredits(handle.db, { workspaceId: workspace.id, actualCost: 5, ...ref }),
    ).toBe(5);
    expect(
      await settleCredits(handle.db, { workspaceId: workspace.id, actualCost: 1, ...ref }),
    ).toBe(1);
    expect(await getCreditBalance(handle.db, workspace.id)).toBe(9);
    // Cannot take more than the balance when settling upwards: stops at zero.
    expect(
      await settleCredits(handle.db, { workspaceId: workspace.id, actualCost: 50, ...ref }),
    ).toBe(10);
    expect(await getCreditBalance(handle.db, workspace.id)).toBe(0);
  });

  it('labels settlements with the given reason (default render_adjustment)', async () => {
    const { workspace } = await seedAccount(handle.db, { credits: 20 });
    const render = { refType: 'renderJob', refId: newId('renderJob') };
    const translation = { refType: 'translationJob', refId: newId('translationJob') };
    for (const ref of [render, translation]) {
      await chargeCredits(handle.db, {
        workspaceId: workspace.id,
        amount: 6,
        reason: 'render',
        ...ref,
      });
    }
    await settleCredits(handle.db, { workspaceId: workspace.id, actualCost: 4, ...render });
    await settleCredits(handle.db, {
      workspaceId: workspace.id,
      actualCost: 2,
      reason: 'adjustment',
      ...translation,
    });
    const rows = await handle.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.workspaceId, workspace.id));
    const positive = rows.filter((r) => r.delta > 0 && r.refId !== null);
    expect(positive.find((r) => r.refId === render.refId)).toMatchObject({
      delta: 2,
      reason: 'render_adjustment',
    });
    expect(positive.find((r) => r.refId === translation.refId)).toMatchObject({
      delta: 4,
      reason: 'adjustment',
    });
  });

  it('serialises concurrent charges on one workspace', async () => {
    const { workspace } = await seedAccount(handle.db, { credits: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        chargeCredits(handle.db, { workspaceId: workspace.id, amount: 1, reason: 'render' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(await getCreditBalance(handle.db, workspace.id)).toBe(0);
    await grantCredits(handle.db, { workspaceId: workspace.id, amount: 2, reason: 'top_up' });
    expect(await getCreditBalance(handle.db, workspace.id)).toBe(2);
  });
});

describe('migration 0001 (contract closing)', () => {
  it('adds asset purpose and avatar progress / cut-out columns with safe defaults', async () => {
    const { workspace, user } = await seedAccount(handle.db);
    const [asset] = await handle.db
      .insert(assets)
      .values({
        id: newId('asset'),
        workspaceId: workspace.id,
        kind: 'image',
        name: 'foto.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        storageKey: 'ws/x/assets/y/original.png',
      })
      .returning();
    expect(asset?.purpose).toBe('library');
    const [avatar] = await handle.db
      .insert(avatars)
      .values({
        id: newId('avatar'),
        workspaceId: workspace.id,
        name: 'Persona sintética',
        origin: 'generated',
        prompt: 'mujer de unos 40 años',
        createdBy: user.id,
      })
      .returning();
    expect(avatar).toMatchObject({
      status: 'processing',
      progress: 0,
      etaSec: null,
      cutoutKey: null,
      model: null,
    });
    const [updated] = await handle.db
      .update(avatars)
      .set({ progress: 40, etaSec: 95, cutoutKey: 'k', model: 'rv6-lcm' })
      .where(eq(avatars.id, avatar?.id ?? ''))
      .returning();
    expect(updated).toMatchObject({ progress: 40, etaSec: 95, cutoutKey: 'k', model: 'rv6-lcm' });
  });
});

describe('cursor pagination', () => {
  it('walks pages newest-first without gaps or repeats, even with equal timestamps', async () => {
    const { workspace } = await seedAccount(handle.db);
    const same = new Date('2026-01-01T00:00:00.000Z');
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const id = newId('video');
      ids.push(id);
      await handle.db.insert(videos).values({
        id,
        workspaceId: workspace.id,
        title: `v${i}`,
        composition: createComposition(),
        aspect: '16:9',
        createdAt: i < 4 ? same : new Date(same.getTime() + i * 1000),
      });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const rows = await handle.db
        .select()
        .from(videos)
        .where(cursorWhere(videos.createdAt, videos.id, cursor))
        .orderBy(...cursorOrder(videos.createdAt, videos.id))
        .limit(3 + 1);
      const page = buildPage(rows, 3);
      seen.push(...page.items.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(() => cursorWhere(videos.createdAt, videos.id, 'garbage')).toThrow(/Invalid cursor/);
  });
});
