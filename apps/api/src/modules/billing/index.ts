import { AppError, PLANS, PLAN_IDS, api, buildPage } from '@parlante/shared';
import type { CreditLedgerEntry, PlanId, PlanLimits, Usage } from '@parlante/shared';
import {
  and,
  apiKeys,
  assets,
  avatars,
  creditLedger,
  cursorOrder,
  cursorWhere,
  eq,
  grantCredits,
  gte,
  isNull,
  members,
  ne,
  notInArray,
  renderJobs,
  sum,
  voices,
  webhookEndpoints,
  workspaces,
} from '@parlante/db';
import type { CreditLedgerRow, DbOrTx } from '@parlante/db';
import { defineRoute } from '../../lib/define-route';
import { iso, toWorkspaceDto } from '../../lib/dto';
import { defineModule } from '../../lib/modules';
import { lockWorkspace } from '../workspaces/service';
import { SIMULATED_CHECKOUT_LABEL, createSimulatedBillingAdapter } from './adapter';
import { applyMonthlyRenewal } from './renewal';

function toLedgerDto(row: CreditLedgerRow): CreditLedgerEntry {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    delta: row.delta,
    balanceAfter: row.balanceAfter,
    reason: row.reason,
    refType: row.refType,
    refId: row.refId,
    description: row.description,
    createdAt: iso(row.createdAt),
  };
}

const USAGE_WINDOW_MS = 30 * 24 * 3600 * 1000;

/** What the workspace currently uses of each plan limit, plus 30-day activity. */
export async function computeUsage(
  db: DbOrTx,
  workspaceId: string,
  now = new Date(),
): Promise<Usage> {
  const since = new Date(now.getTime() - USAGE_WINDOW_MS);
  const [storage] = await db
    .select({ bytes: sum(assets.sizeBytes) })
    .from(assets)
    .where(eq(assets.workspaceId, workspaceId));
  // Net spend: charges minus refunds and adjustments. Grants and top-ups are income.
  const [spent] = await db
    .select({ delta: sum(creditLedger.delta) })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.workspaceId, workspaceId),
        gte(creditLedger.createdAt, since),
        notInArray(creditLedger.reason, ['signup_grant', 'plan_grant', 'top_up']),
      ),
    );
  return {
    storageBytes: Number(storage?.bytes ?? 0),
    members: await db.$count(members, eq(members.workspaceId, workspaceId)),
    // Same rule as the modules that enforce the allowance (photo-avatars, voice-clones): a
    // FAILED avatar / voice was refunded and does not take a place of the plan.
    photoAvatars: await db.$count(
      avatars,
      and(eq(avatars.workspaceId, workspaceId), ne(avatars.status, 'failed')),
    ),
    clonedVoices: await db.$count(
      voices,
      and(eq(voices.workspaceId, workspaceId), ne(voices.status, 'failed')),
    ),
    apiKeys: await db.$count(
      apiKeys,
      and(eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt)),
    ),
    webhookEndpoints: await db.$count(
      webhookEndpoints,
      eq(webhookEndpoints.workspaceId, workspaceId),
    ),
    creditsSpent30d: Math.max(0, -Number(spent?.delta ?? 0)),
    renders30d: await db.$count(
      renderJobs,
      and(
        eq(renderJobs.workspaceId, workspaceId),
        eq(renderJobs.status, 'completed'),
        gte(renderJobs.finishedAt, since),
      ),
    ),
  };
}

const planRank = (plan: PlanId): number => PLAN_IDS.indexOf(plan);

/** Limits of `plan` that the current usage would break (a downgrade must fit first). */
function exceededLimits(
  usage: Usage,
  limits: PlanLimits,
): { limit: keyof PlanLimits; max: number; value: number }[] {
  const checks: [keyof PlanLimits, number, number][] = [
    ['maxMembers', limits.maxMembers, usage.members],
    ['maxStorageBytes', limits.maxStorageBytes, usage.storageBytes],
    ['maxPhotoAvatars', limits.maxPhotoAvatars, usage.photoAvatars],
    ['maxClonedVoices', limits.maxClonedVoices, usage.clonedVoices],
    ['maxApiKeys', limits.maxApiKeys, usage.apiKeys],
    ['maxWebhookEndpoints', limits.maxWebhookEndpoints, usage.webhookEndpoints],
  ];
  return checks
    .filter(([, max, value]) => value > max)
    .map(([limit, max, value]) => ({ limit, max, value }));
}

export default defineModule({
  name: 'billing',
  register(app) {
    // Payments are out of scope: the only adapter approves every checkout without charging.
    const billing = createSimulatedBillingAdapter();

    defineRoute(app, api.billing.overview, async ({ auth, app: { db } }) => {
      await applyMonthlyRenewal(db, auth.workspace);
      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, auth.workspaceId));
      if (!workspace) throw AppError.notFound('Workspace');
      const plan = PLANS[workspace.plan];
      return {
        plan,
        plans: PLAN_IDS.map((id) => PLANS[id]),
        credits: workspace.credits,
        limits: plan.limits,
        usage: await computeUsage(db, workspace.id),
        simulated: billing.simulated,
      };
    });

    defineRoute(app, api.billing.ledger, async ({ auth, query, app: { db } }) => {
      const rows = await db
        .select()
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.workspaceId, auth.workspaceId),
            cursorWhere(creditLedger.createdAt, creditLedger.id, query.cursor),
          ),
        )
        .orderBy(...cursorOrder(creditLedger.createdAt, creditLedger.id))
        .limit(query.limit + 1);
      const page = buildPage(rows, query.limit);
      return { items: page.items.map(toLedgerDto), nextCursor: page.nextCursor };
    });

    defineRoute(app, api.billing.changePlan, async ({ auth, body, app: { db } }) => {
      return db.transaction(async (tx) => {
        const current = await lockWorkspace(tx, auth.workspaceId);
        if (current.plan === body.planId) {
          throw AppError.invalidState(
            `The workspace is already on the ${PLANS[body.planId].name} plan`,
          );
        }
        const target = PLANS[body.planId];
        const upgrade = planRank(body.planId) > planRank(current.plan);
        if (!upgrade) {
          const exceeded = exceededLimits(await computeUsage(tx, current.id), target.limits);
          if (exceeded.length > 0) {
            throw new AppError(
              'INVALID_STATE',
              `The workspace uses more than the ${target.name} plan allows. Reduce the usage before changing plan`,
              { exceeded },
            );
          }
        }
        const receipt = await billing.checkout({
          workspaceId: current.id,
          userId: auth.userId,
          item: { kind: 'plan', planId: target.id, priceCents: target.priceMonthlyCents },
        });
        await tx
          .update(workspaces)
          .set({ plan: target.id, updatedAt: new Date() })
          .where(eq(workspaces.id, current.id));
        // Upgrades start a new cycle with the credits of the new plan; downgrades keep the
        // balance and the cycle they had.
        const entry = upgrade
          ? await grantCredits(tx, {
              workspaceId: current.id,
              amount: target.monthlyCredits,
              reason: 'plan_grant',
              refType: 'checkout',
              refId: receipt.id,
              description: `${target.name} plan credits (${SIMULATED_CHECKOUT_LABEL})`,
              createdBy: auth.userId,
            })
          : null;
        const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, current.id));
        if (!workspace) throw AppError.notFound('Workspace');
        return {
          workspace: toWorkspaceDto(workspace),
          entry: entry ? toLedgerDto(entry) : null,
          simulated: receipt.simulated,
        };
      });
    });

    defineRoute(app, api.billing.topUp, async ({ auth, body, app: { db } }) => {
      const receipt = await billing.checkout({
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        item: { kind: 'credit_pack', credits: body.credits },
      });
      const entry = await grantCredits(db, {
        workspaceId: auth.workspaceId,
        amount: body.credits,
        reason: 'top_up',
        refType: 'checkout',
        refId: receipt.id,
        description: `${body.credits} credit pack (${SIMULATED_CHECKOUT_LABEL})`,
        createdBy: auth.userId,
      });
      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, auth.workspaceId));
      if (!workspace) throw AppError.notFound('Workspace');
      return {
        workspace: toWorkspaceDto(workspace),
        entry: entry ? toLedgerDto(entry) : null,
        simulated: receipt.simulated,
      };
    });
  },
});
