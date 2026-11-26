import { and, eq, sql } from 'drizzle-orm';
import { AppError, newId } from '@parlante/shared';
import type { LedgerReason } from '@parlante/shared';
import type { Db, DbOrTx } from './client';
import { creditLedger, workspaces } from './schema';
import type { CreditLedgerRow } from './schema';

/* -------------------------------------------------------------------------------------------
 * Credit ledger. The balance (`workspaces.credits`) and the ledger change together, atomically.
 * NEVER update `workspaces.credits` directly.
 *
 * Typical flow for an asynchronous job:
 *   API      chargeCredits({ refType: 'renderJob', refId, amount: estimate })      (reserve)
 *   worker   settleCredits({ refType: 'renderJob', refId, actualCost })            (on success)
 *   worker   refundCredits({ refType: 'renderJob', refId })                        (on failure)
 * `settle` and `refund` are idempotent: they look at what the ledger already holds for the ref.
 * ----------------------------------------------------------------------------------------- */

export interface LedgerRef {
  /** Kind of entity the movement belongs to, e.g. `renderJob`, `translationJob`, `avatar`. */
  refType: string;
  refId: string;
}

export interface CreditMovement extends Partial<LedgerRef> {
  workspaceId: string;
  reason: LedgerReason;
  description?: string;
  createdBy?: string | null;
}

async function inTransaction<T>(db: DbOrTx, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  // Both Db and Tx expose `transaction` (nested = savepoint).
  return (db as Db).transaction((tx) => fn(tx));
}

async function applyDelta(
  db: DbOrTx,
  movement: CreditMovement,
  delta: number,
  allowPartial = false,
): Promise<CreditLedgerRow | null> {
  if (!Number.isInteger(delta)) throw new Error('Credit delta must be an integer');
  if (delta === 0) return null;
  return inTransaction(db, async (tx) => {
    // Row lock serialises concurrent movements on the same workspace.
    const [ws] = await tx
      .select({ credits: workspaces.credits })
      .from(workspaces)
      .where(eq(workspaces.id, movement.workspaceId))
      .for('update');
    if (!ws) throw AppError.notFound('Workspace');
    let applied = delta;
    if (delta < 0 && ws.credits + delta < 0) {
      if (!allowPartial) {
        throw new AppError('INSUFFICIENT_CREDITS', 'Not enough credits for this operation', {
          required: -delta,
          available: ws.credits,
        });
      }
      applied = -ws.credits;
      if (applied === 0) return null;
    }
    const balanceAfter = ws.credits + applied;
    await tx
      .update(workspaces)
      .set({ credits: balanceAfter, updatedAt: new Date() })
      .where(eq(workspaces.id, movement.workspaceId));
    const [entry] = await tx
      .insert(creditLedger)
      .values({
        id: newId('ledgerEntry'),
        workspaceId: movement.workspaceId,
        delta: applied,
        balanceAfter,
        reason: movement.reason,
        refType: movement.refType ?? null,
        refId: movement.refId ?? null,
        description: movement.description ?? '',
        createdBy: movement.createdBy ?? null,
      })
      .returning();
    return entry ?? null;
  });
}

/** Spend `amount` credits. Throws INSUFFICIENT_CREDITS (402) when the balance is too low. */
export async function chargeCredits(
  db: DbOrTx,
  movement: CreditMovement & { amount: number },
): Promise<CreditLedgerRow | null> {
  if (movement.amount < 0) throw new Error('amount must be >= 0');
  return applyDelta(db, movement, -movement.amount);
}

/** Add `amount` credits (signup grant, plan grant, top-up, manual adjustment). */
export async function grantCredits(
  db: DbOrTx,
  movement: CreditMovement & { amount: number },
): Promise<CreditLedgerRow | null> {
  if (movement.amount < 0) throw new Error('amount must be >= 0');
  return applyDelta(db, movement, movement.amount);
}

/** Net credits currently charged for a ref (≥ 0 normally): charges minus refunds. */
export async function netCharged(db: DbOrTx, workspaceId: string, ref: LedgerRef): Promise<number> {
  const [row] = await db
    .select({ total: sql<string | null>`sum(${creditLedger.delta})` })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.workspaceId, workspaceId),
        eq(creditLedger.refType, ref.refType),
        eq(creditLedger.refId, ref.refId),
      ),
    );
  return -Number(row?.total ?? 0);
}

/**
 * Give back everything still charged for a ref (job failed or was cancelled). Idempotent:
 * a second call finds nothing left to refund and returns null.
 */
export async function refundCredits(
  db: DbOrTx,
  input: { workspaceId: string; description?: string } & LedgerRef,
): Promise<CreditLedgerRow | null> {
  return inTransaction(db, async (tx) => {
    const charged = await netCharged(tx, input.workspaceId, input);
    if (charged <= 0) return null;
    return applyDelta(
      tx,
      {
        workspaceId: input.workspaceId,
        reason: 'refund',
        refType: input.refType,
        refId: input.refId,
        description: input.description ?? 'Refund',
      },
      charged,
    );
  });
}

/**
 * Adjust the reservation of a ref to its real cost once known. Charges the difference when the
 * job cost more (never below a zero balance) or refunds it when it cost less. Idempotent.
 * Returns the net amount charged for the ref after settling.
 * `reason` labels the ledger entry: `render_adjustment` (default) for renders; other jobs pass
 * `adjustment` (e.g. a translation that finished `partial` and is settled to the languages
 * that completed) so the ledger never shows render adjustments on non-render work.
 */
export async function settleCredits(
  db: DbOrTx,
  input: {
    workspaceId: string;
    actualCost: number;
    description?: string;
    reason?: LedgerReason;
  } & LedgerRef,
): Promise<number> {
  return inTransaction(db, async (tx) => {
    const charged = await netCharged(tx, input.workspaceId, input);
    const diff = input.actualCost - charged;
    if (diff === 0) return charged;
    const entry = await applyDelta(
      tx,
      {
        workspaceId: input.workspaceId,
        reason: input.reason ?? 'render_adjustment',
        refType: input.refType,
        refId: input.refId,
        description: input.description ?? 'Adjustment to actual cost',
      },
      -diff,
      true,
    );
    return charged - (entry?.delta ?? 0);
  });
}

export async function getCreditBalance(db: DbOrTx, workspaceId: string): Promise<number> {
  const [ws] = await db
    .select({ credits: workspaces.credits })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws) throw AppError.notFound('Workspace');
  return ws.credits;
}
