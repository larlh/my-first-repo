import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLANS, api, createComposition, newId } from '@parlante/shared';
import {
  apiKeys,
  assets,
  chargeCredits,
  creditLedger,
  eq,
  refundCredits,
  renderJobs,
  videos,
  webhookEndpoints,
  workspaces,
} from '@parlante/db';
import { createApiKey } from '../../lib/auth';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import billingModule from './index';
import { RENEWAL_PERIOD_DAYS, applyMonthlyRenewal, nextRenewalAt } from './renewal';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ modules: [billingModule] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

const DAY = 24 * 3600 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

async function balance(actor: TestActor): Promise<number> {
  const [row] = await t.db.select().from(workspaces).where(eq(workspaces.id, actor.workspace.id));
  return row?.credits ?? -1;
}

describe('billing overview', () => {
  it('reports plan, limits, balance and real usage, and says payments are simulated', async () => {
    const owner = await t.signUp();
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const ws = owner.workspace.id;

    await t.db.insert(assets).values(
      [1000, 234].map((sizeBytes) => ({
        id: newId('asset'),
        workspaceId: ws,
        kind: 'image' as const,
        name: 'a.png',
        mimeType: 'image/png',
        sizeBytes,
        storageKey: `ws/${ws}/assets/x/original.png`,
      })),
    );
    const live = await createApiKey(t.db, { workspaceId: ws, name: 'live', createdBy: null });
    const dead = await createApiKey(t.db, { workspaceId: ws, name: 'dead', createdBy: null });
    await t.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, dead.row.id));
    expect(live.row.revokedAt).toBeNull();
    await t.db.insert(webhookEndpoints).values({
      id: newId('webhookEndpoint'),
      workspaceId: ws,
      url: 'https://93.184.216.34/h',
      events: ['video.completed'],
      secretEncrypted: 'v1.x.y.z',
      secretPreview: 'abcd',
    });

    // Spend: 5 charged and 2 refunded now (net 3); 4 charged 40 days ago (outside the window).
    const recent = { refType: 'renderJob', refId: newId('renderJob') };
    await chargeCredits(t.db, { workspaceId: ws, amount: 5, reason: 'render', ...recent });
    await refundCredits(t.db, { workspaceId: ws, ...recent });
    await chargeCredits(t.db, { workspaceId: ws, amount: 3, reason: 'render', ...recent });
    const old = await chargeCredits(t.db, { workspaceId: ws, amount: 4, reason: 'translation' });
    await t.db
      .update(creditLedger)
      .set({ createdAt: daysAgo(40) })
      .where(eq(creditLedger.id, old?.id ?? ''));

    const videoId = newId('video');
    await t.db.insert(videos).values({
      id: videoId,
      workspaceId: ws,
      title: 'Demo',
      composition: createComposition(),
      aspect: '16:9',
    });
    await t.db.insert(renderJobs).values(
      (
        [
          ['completed', daysAgo(1)],
          ['completed', daysAgo(45)],
          ['failed', daysAgo(1)],
        ] as const
      ).map(([status, finishedAt]) => ({
        id: newId('renderJob'),
        workspaceId: ws,
        videoId,
        status,
        resolution: '720p' as const,
        composition: createComposition(),
        revision: 1,
        finishedAt,
      })),
    );

    const res = await t.call(api.billing.overview, { as: viewer });
    expect(res.status).toBe(200);
    expect(res.body.simulated).toBe(true);
    expect(res.body.plan).toEqual(PLANS.free);
    expect(res.body.plans.map((p) => p.id)).toEqual(['free', 'creator', 'team']);
    expect(res.body.limits).toEqual(PLANS.free.limits);
    expect(res.body.credits).toBe(30 - 5 + 5 - 3 - 4);
    expect(res.body.usage).toEqual({
      storageBytes: 1234,
      members: 2,
      photoAvatars: 0,
      clonedVoices: 0,
      apiKeys: 1,
      webhookEndpoints: 1,
      creditsSpent30d: 3,
      renders30d: 1,
    });

    // Another workspace sees only its own numbers.
    const other = await t.signUp();
    const theirs = await t.call(api.billing.overview, { as: other });
    expect(theirs.body.credits).toBe(30);
    expect(theirs.body.usage).toMatchObject({ storageBytes: 0, members: 1, creditsSpent30d: 0 });
    expect((await t.call(api.billing.overview)).status).toBe(401);
  });
});

describe('credit ledger', () => {
  it('lists the entries of the workspace newest first, paginated', async () => {
    const owner = await t.signUp();
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const other = await t.signUp();
    const ws = owner.workspace.id;
    await t.db.update(creditLedger).set({ createdAt: daysAgo(3) });
    const charge = await chargeCredits(t.db, {
      workspaceId: ws,
      amount: 2,
      reason: 'render',
      refType: 'renderJob',
      refId: 'rnd_1',
      description: 'Render',
    });
    await t.db
      .update(creditLedger)
      .set({ createdAt: daysAgo(2) })
      .where(eq(creditLedger.id, charge?.id ?? ''));
    await t.call(api.billing.topUp, { as: owner, body: { credits: 50 } });

    const all = await t.call(api.billing.ledger, { as: viewer });
    expect(all.status).toBe(200);
    expect(all.body.items.map((e) => [e.reason, e.delta, e.balanceAfter])).toEqual([
      ['top_up', 50, 78],
      ['render', -2, 28],
      ['signup_grant', 30, 30],
    ]);
    expect(all.body.items[1]).toMatchObject({ refType: 'renderJob', refId: 'rnd_1' });
    expect(all.body.nextCursor).toBeNull();
    expect(all.body.items.every((e) => e.workspaceId === ws)).toBe(true);

    const page1 = await t.call(api.billing.ledger, { as: owner, query: { limit: 2 } });
    expect(page1.body.items.map((e) => e.reason)).toEqual(['top_up', 'render']);
    const page2 = await t.call(api.billing.ledger, {
      as: owner,
      query: { limit: 2, cursor: page1.body.nextCursor ?? '' },
    });
    expect(page2.body.items.map((e) => e.reason)).toEqual(['signup_grant']);
    expect(page2.body.nextCursor).toBeNull();

    expect((await t.call(api.billing.ledger, { as: other })).body.items).toHaveLength(1);
    expect((await t.call(api.billing.ledger, { as: owner, query: { limit: 0 } })).status).toBe(400);
    expect((await t.call(api.billing.ledger, { as: owner, query: { cursor: '???' } })).status).toBe(
      400,
    );
    expect((await t.call(api.billing.ledger)).status).toBe(401);
  });
});

describe('plan changes (simulated checkout)', () => {
  it('upgrades: new limits and the monthly credits of the new plan', async () => {
    const owner = await t.signUp();
    const res = await t.call(api.billing.changePlan, { as: owner, body: { planId: 'creator' } });
    expect(res.status).toBe(200);
    expect(res.body.simulated).toBe(true);
    expect(res.body.workspace).toMatchObject({ plan: 'creator', credits: 30 + 300 });
    expect(res.body.entry).toMatchObject({
      reason: 'plan_grant',
      delta: 300,
      balanceAfter: 330,
      refType: 'checkout',
    });
    expect(res.body.entry?.description).toMatch(/simulated checkout/);
    expect(await balance(owner)).toBe(330);

    const overview = await t.call(api.billing.overview, { as: owner });
    expect(overview.body.plan.id).toBe('creator');
    expect(overview.body.limits.maxMembers).toBe(PLANS.creator.limits.maxMembers);

    const same = await t.call(api.billing.changePlan, { as: owner, body: { planId: 'creator' } });
    expect(same.status).toBe(409);
    expect(same.error.code).toBe('INVALID_STATE');
    const team = await t.call(api.billing.changePlan, { as: owner, body: { planId: 'team' } });
    expect(team.body.workspace).toMatchObject({ plan: 'team', credits: 330 + 1500 });
  });

  it('downgrades without credits, and only when the usage fits the smaller plan', async () => {
    const owner = await t.signUp({ plan: 'creator' });
    const extra = [
      await t.addMember(owner.workspace, 'editor'),
      await t.addMember(owner.workspace, 'viewer'),
    ];
    expect(extra).toHaveLength(2);

    const blocked = await t.call(api.billing.changePlan, { as: owner, body: { planId: 'free' } });
    expect(blocked.status).toBe(409);
    expect(blocked.error.code).toBe('INVALID_STATE');
    expect(blocked.error.details).toEqual({
      exceeded: [{ limit: 'maxMembers', max: PLANS.free.limits.maxMembers, value: 3 }],
    });
    const [still] = await t.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, owner.workspace.id));
    expect(still?.plan).toBe('creator');

    const other = await t.signUp({ plan: 'team' });
    const down = await t.call(api.billing.changePlan, { as: other, body: { planId: 'free' } });
    expect(down.status).toBe(200);
    expect(down.body).toMatchObject({
      workspace: { plan: 'free', credits: PLANS.team.monthlyCredits },
      entry: null,
      simulated: true,
    });
  });

  it('is reserved to owners and validated', async () => {
    const owner = await t.signUp();
    const admin = await t.addMember(owner.workspace, 'admin');
    expect((await t.call(api.billing.changePlan, { body: { planId: 'team' } })).status).toBe(401);
    expect(
      (await t.call(api.billing.changePlan, { as: admin, body: { planId: 'team' } })).status,
    ).toBe(403);
    expect((await t.call(api.billing.topUp, { as: admin, body: { credits: 50 } })).status).toBe(
      403,
    );
    expect(
      (await t.call(api.billing.changePlan, { as: owner, body: { planId: 'gold' } })).status,
    ).toBe(400);
    expect((await t.call(api.billing.changePlan, { as: owner, body: {} })).status).toBe(400);
    const [row] = await t.db.select().from(workspaces).where(eq(workspaces.id, owner.workspace.id));
    expect(row).toMatchObject({ plan: 'free', credits: 30 });
  });

  it('sells credit packs of the published sizes only', async () => {
    const owner = await t.signUp();
    const other = await t.signUp();
    const res = await t.call(api.billing.topUp, { as: owner, body: { credits: 200 } });
    expect(res.status).toBe(200);
    expect(res.body.simulated).toBe(true);
    expect(res.body.workspace.credits).toBe(230);
    expect(res.body.entry).toMatchObject({ reason: 'top_up', delta: 200, balanceAfter: 230 });
    expect(res.body.entry?.description).toMatch(/simulated checkout/);
    for (const credits of [75, -50, 0, 1_000_000, '50']) {
      expect((await t.call(api.billing.topUp, { as: owner, body: { credits } })).status).toBe(400);
    }
    expect(await balance(owner)).toBe(230);
    expect(await balance(other)).toBe(30);
  });
});

describe('monthly renewal (simulated)', () => {
  it('grants the plan credits when a cycle ends, once, and upgrades restart the cycle', async () => {
    const owner = await t.signUp();
    const due = await nextRenewalAt(t.db, owner.workspace);
    expect(Math.round((due.getTime() - Date.now()) / DAY)).toBe(RENEWAL_PERIOD_DAYS);
    expect(await applyMonthlyRenewal(t.db, owner.workspace)).toBeNull();

    // The cycle ended yesterday: the overview notices and the ledger records it.
    await t.db.update(creditLedger).set({ createdAt: daysAgo(RENEWAL_PERIOD_DAYS + 1) });
    const overview = await t.call(api.billing.overview, { as: owner });
    expect(overview.body.credits).toBe(60);
    expect((await t.call(api.billing.overview, { as: owner })).body.credits).toBe(60);
    const ledger = await t.call(api.billing.ledger, { as: owner });
    expect(ledger.body.items.map((e) => [e.reason, e.delta])).toEqual([
      ['plan_grant', 30],
      ['signup_grant', 30],
    ]);
    expect(ledger.body.items[0]?.description).toMatch(/renewal; simulated/);

    // An upgrade 20 days into the cycle starts a new one: no extra grant 15 days later.
    await t.db.update(creditLedger).set({ createdAt: daysAgo(20) });
    await t.call(api.billing.changePlan, { as: owner, body: { planId: 'creator' } });
    const in15Days = new Date(Date.now() + 15 * DAY);
    expect(await applyMonthlyRenewal(t.db, owner.workspace, in15Days)).toBeNull();
    const in31Days = new Date(Date.now() + 31 * DAY);
    const renewed = await applyMonthlyRenewal(t.db, owner.workspace, in31Days);
    expect(renewed).toMatchObject({ reason: 'plan_grant', delta: PLANS.creator.monthlyCredits });
    expect(await balance(owner)).toBe(60 + 300 + 300);
  });

  it('never renews twice under concurrency', async () => {
    const owner = await t.signUp({ plan: 'team' });
    await t.db.update(creditLedger).set({ createdAt: daysAgo(45) });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => applyMonthlyRenewal(t.db, owner.workspace)),
    );
    expect(results.filter((entry) => entry !== null)).toHaveLength(1);
    expect(await balance(owner)).toBe(2 * PLANS.team.monthlyCredits);
  });
});
