import { PLANS } from '@parlante/shared';
import { and, creditLedger, eq, grantCredits, inArray, max } from '@parlante/db';
import type { CreditLedgerRow, Db, DbOrTx } from '@parlante/db';
import { lockWorkspace } from '../workspaces/service';
import { SIMULATED_CHECKOUT_LABEL } from './adapter';

/* -------------------------------------------------------------------------------------------
 * Monthly credit renewal (simulated — there is no payment provider and no scheduler).
 *
 * A plan grants its `monthlyCredits` when it starts and on each monthly renewal. The ledger
 * is the clock: the cycle starts at the last `signup_grant` / `plan_grant` entry and, once
 * RENEWAL_PERIOD_DAYS have passed, the next grant is written LAZILY the first time the
 * workspace is looked at (`GET /api/auth/me`, which the web shell calls on every load, and
 * `GET /api/billing`). One grant per check: cycles nobody used are not accumulated.
 * ----------------------------------------------------------------------------------------- */

export const RENEWAL_PERIOD_DAYS = 30;
const RENEWAL_PERIOD_MS = RENEWAL_PERIOD_DAYS * 24 * 3600 * 1000;

/** Start of the current cycle: the last plan grant (null when the ledger has none). */
async function lastPlanGrantAt(db: DbOrTx, workspaceId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: max(creditLedger.createdAt) })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.workspaceId, workspaceId),
        inArray(creditLedger.reason, ['signup_grant', 'plan_grant']),
      ),
    );
  return row?.at ?? null;
}

/** Date of the next renewal of a workspace. */
export async function nextRenewalAt(
  db: DbOrTx,
  workspace: { id: string; createdAt: Date },
): Promise<Date> {
  const anchor = (await lastPlanGrantAt(db, workspace.id)) ?? workspace.createdAt;
  return new Date(anchor.getTime() + RENEWAL_PERIOD_MS);
}

/**
 * Grant the monthly credits of the workspace plan when its cycle has ended. Idempotent and
 * safe under concurrency (re-checked under the workspace lock). Returns the ledger entry
 * written, or null when no renewal was due.
 */
export async function applyMonthlyRenewal(
  db: Db,
  workspace: { id: string; createdAt: Date },
  now: Date = new Date(),
): Promise<CreditLedgerRow | null> {
  // Unlocked fast path: almost every call ends here.
  if ((await nextRenewalAt(db, workspace)).getTime() > now.getTime()) return null;
  return db.transaction(async (tx) => {
    const locked = await lockWorkspace(tx, workspace.id);
    if ((await nextRenewalAt(tx, locked)).getTime() > now.getTime()) return null;
    const plan = PLANS[locked.plan];
    return grantCredits(tx, {
      workspaceId: locked.id,
      amount: plan.monthlyCredits,
      reason: 'plan_grant',
      description: `${plan.name} plan monthly credits (renewal; ${SIMULATED_CHECKOUT_LABEL})`,
    });
  });
}
