import { newId } from '@parlante/shared';
import type { PlanId } from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * Billing adapter. Real payments are out of scope for this product (master prompt §3.10), so
 * the only implementation is SIMULATED: it approves every checkout without charging anybody.
 * It exists as an interface so a real payment provider can replace it without touching the
 * routes, and every result says `simulated: true` so nothing downstream can mistake it for
 * a real payment (the API response and the ledger description repeat it).
 * ----------------------------------------------------------------------------------------- */

export type CheckoutItem =
  { kind: 'plan'; planId: PlanId; priceCents: number } | { kind: 'credit_pack'; credits: number };

export interface CheckoutRequest {
  workspaceId: string;
  userId: string;
  item: CheckoutItem;
}

export interface CheckoutReceipt {
  /** Reference stored on the ledger entry (`refType: 'checkout'`). */
  id: string;
  /** No money moved. */
  simulated: true;
  adapter: string;
}

export interface BillingAdapter {
  readonly id: string;
  readonly simulated: true;
  /** Approve (or reject, by throwing an AppError) a purchase. */
  checkout(request: CheckoutRequest): Promise<CheckoutReceipt>;
}

export const SIMULATED_CHECKOUT_LABEL = 'simulated checkout, no payment taken';

export function createSimulatedBillingAdapter(): BillingAdapter {
  return {
    id: 'simulated',
    simulated: true,
    async checkout() {
      // `evt_…` ids are free-form event references; nothing is sent anywhere.
      return { id: newId('event'), simulated: true, adapter: 'simulated' };
    },
  };
}
