import { and, eq, webhookDeliveries, webhookEndpoints } from '@parlante/db';
import { newId } from '@parlante/shared';
import type { WebhookEvent, WebhookEventType } from '@parlante/shared';
import type { DbOrTx, WebhookDeliveryRow } from '@parlante/db';
import type { QueueClient } from './queue-client';

export interface DispatchWebhookInput {
  db: DbOrTx;
  queues: QueueClient;
  workspaceId: string;
  type: WebhookEventType;
  data: WebhookEvent['data'];
  /**
   * Deliver only to this endpoint, even when it is not subscribed to `type` or is disabled
   * (used by the "send test event" action). Without it: every enabled, subscribed endpoint.
   */
  endpointId?: string;
}

/**
 * Create one `webhook_deliveries` row per target endpoint and queue its delivery job.
 * Call it AFTER the transaction that changed the resource has committed.
 * Returns the created rows (empty when nobody is subscribed).
 */
export async function dispatchWebhookEvent(
  input: DispatchWebhookInput,
): Promise<WebhookDeliveryRow[]> {
  const { db, queues, workspaceId, type, data } = input;
  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(
      input.endpointId
        ? and(
            eq(webhookEndpoints.workspaceId, workspaceId),
            eq(webhookEndpoints.id, input.endpointId),
          )
        : and(eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.enabled, true)),
    );
  const targets = input.endpointId ? endpoints : endpoints.filter((e) => e.events.includes(type));
  if (targets.length === 0) return [];

  const event: WebhookEvent = {
    id: newId('event'),
    type,
    createdAt: new Date().toISOString(),
    workspaceId,
    data,
  };
  const rows = await db
    .insert(webhookDeliveries)
    .values(
      targets.map((endpoint) => ({
        id: newId('webhookDelivery'),
        workspaceId,
        endpointId: endpoint.id,
        eventId: event.id,
        eventType: type,
        payload: event,
      })),
    )
    .returning();
  for (const row of rows) {
    await queues.enqueue('webhookDelivery', { deliveryId: row.id, workspaceId }, { jobId: row.id });
  }
  return rows;
}
