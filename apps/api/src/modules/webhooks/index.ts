import { AppError, OK, api, buildPage, newId } from '@parlante/shared';
import type { WebhookDelivery, WebhookEndpoint } from '@parlante/shared';
import { assertPublicUrl, encryptSecret, generateWebhookSecret } from '@parlante/shared/node';
import {
  and,
  cursorOrder,
  cursorWhere,
  desc,
  eq,
  webhookDeliveries,
  webhookEndpoints,
} from '@parlante/db';
import type { Db, WebhookDeliveryRow, WebhookEndpointRow } from '@parlante/db';
import { dispatchWebhookEvent, enqueueOrCompensate } from '@parlante/jobs';
import type { ApiConfig } from '../../config';
import { defineRoute } from '../../lib/define-route';
import { iso, isoOrNull } from '../../lib/dto';
import { assertWithinLimit } from '../../lib/limits';
import { defineModule } from '../../lib/modules';
import { lockWorkspace } from '../workspaces/service';

/* -------------------------------------------------------------------------------------------
 * Webhook endpoints (feature 9).
 *
 *  - Signing secret: generated here, returned ONCE (creation / rotation) and stored encrypted
 *    with APP_SECRET; lists only carry its last 4 characters. The worker decrypts it to sign
 *    each delivery (`Parlante-Signature: t=<s>,v1=<hmac>`).
 *  - SSRF: a URL is accepted only if it is http(s), carries no credentials and — after
 *    resolving DNS — points at no private, loopback, link-local or metadata address
 *    (`assertPublicUrl`). The delivery job checks again at connection time (`safeRequest`),
 *    which is what defeats DNS rebinding; this check gives the user an immediate answer.
 * ----------------------------------------------------------------------------------------- */

/** The DTO has no field for the secret: `secretEncrypted` never leaves the database. */
function toEndpointDto(row: WebhookEndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    url: row.url,
    description: row.description,
    events: row.events,
    enabled: row.enabled,
    secretPreview: row.secretPreview,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** The stored payload is not part of the DTO (its file URLs are capabilities). */
function toDeliveryDto(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    responseStatus: row.responseStatus,
    error: row.error,
    durationMs: row.durationMs,
    nextRetryAt: isoOrNull(row.nextRetryAt),
    deliveredAt: isoOrNull(row.deliveredAt),
    createdAt: iso(row.createdAt),
  };
}

/** An endpoint of THIS workspace or 404. */
async function findEndpoint(db: Db, workspaceId: string, webhookId: string) {
  const [row] = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, webhookId), eq(webhookEndpoints.workspaceId, workspaceId)));
  if (!row) throw AppError.notFound('Webhook endpoint');
  return row;
}

/** Validate a destination (UNSAFE_URL) and return it normalised. */
async function safeDestination(config: ApiConfig, rawUrl: string): Promise<string> {
  const url = await assertPublicUrl(rawUrl, { allowPrivate: config.ALLOW_PRIVATE_URLS });
  return url.toString();
}

function newSecret(config: ApiConfig) {
  const secret = generateWebhookSecret();
  return {
    secret,
    secretEncrypted: encryptSecret(config.APP_SECRET, secret),
    secretPreview: secret.slice(-4),
  };
}

export default defineModule({
  name: 'webhooks',
  register(app) {
    defineRoute(app, api.webhooks.list, async ({ auth, app: { db } }) => {
      const rows = await db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.workspaceId, auth.workspaceId))
        .orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id));
      return { items: rows.map(toEndpointDto) };
    });

    defineRoute(app, api.webhooks.create, async ({ auth, body, app: { db, config } }) => {
      const url = await safeDestination(config, body.url);
      const { secret, ...stored } = newSecret(config);
      const row = await db.transaction(async (tx) => {
        const workspace = await lockWorkspace(tx, auth.workspaceId);
        const existing = await tx.$count(
          webhookEndpoints,
          eq(webhookEndpoints.workspaceId, auth.workspaceId),
        );
        assertWithinLimit(workspace, 'maxWebhookEndpoints', existing + 1);
        const [created] = await tx
          .insert(webhookEndpoints)
          .values({
            id: newId('webhookEndpoint'),
            workspaceId: auth.workspaceId,
            url,
            description: body.description,
            events: [...new Set(body.events)],
            createdBy: auth.userId,
            ...stored,
          })
          .returning();
        if (!created) throw new Error('Insert returned no row');
        return created;
      });
      return { ...toEndpointDto(row), secret };
    });

    defineRoute(app, api.webhooks.update, async ({ auth, params, body, app: { db, config } }) => {
      await findEndpoint(db, auth.workspaceId, params.webhookId);
      const url = body.url !== undefined ? await safeDestination(config, body.url) : undefined;
      const [updated] = await db
        .update(webhookEndpoints)
        .set({
          ...(url !== undefined ? { url } : {}),
          ...(body.events !== undefined ? { events: [...new Set(body.events)] } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(webhookEndpoints.id, params.webhookId),
            eq(webhookEndpoints.workspaceId, auth.workspaceId),
          ),
        )
        .returning();
      if (!updated) throw AppError.notFound('Webhook endpoint');
      return toEndpointDto(updated);
    });

    defineRoute(app, api.webhooks.remove, async ({ auth, params, app: { db } }) => {
      // Deliveries go with the endpoint (ON DELETE CASCADE); queued jobs find no row and stop.
      const deleted = await db
        .delete(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.id, params.webhookId),
            eq(webhookEndpoints.workspaceId, auth.workspaceId),
          ),
        )
        .returning({ id: webhookEndpoints.id });
      if (deleted.length === 0) throw AppError.notFound('Webhook endpoint');
      return OK;
    });

    defineRoute(app, api.webhooks.rotateSecret, async ({ auth, params, app: { db, config } }) => {
      const { secret, ...stored } = newSecret(config);
      const [updated] = await db
        .update(webhookEndpoints)
        .set({ ...stored, updatedAt: new Date() })
        .where(
          and(
            eq(webhookEndpoints.id, params.webhookId),
            eq(webhookEndpoints.workspaceId, auth.workspaceId),
          ),
        )
        .returning();
      if (!updated) throw AppError.notFound('Webhook endpoint');
      // The previous secret stops signing immediately: deliveries read the secret when sent.
      return { ...toEndpointDto(updated), secret };
    });

    defineRoute(app, api.webhooks.test, async ({ auth, params, app: { db, queues } }) => {
      const endpoint = await findEndpoint(db, auth.workspaceId, params.webhookId);
      // Checked first so that a dead queue does not leave a delivery `pending` for ever.
      if (!(await queues.ping())) {
        throw new AppError(
          'SERVICE_UNAVAILABLE',
          'The job queue is not available right now. Try again',
        );
      }
      // `endpointId` targets this endpoint even when it is disabled or not subscribed to `ping`.
      const [delivery] = await dispatchWebhookEvent({
        db,
        queues,
        workspaceId: auth.workspaceId,
        type: 'ping',
        data: {},
        endpointId: endpoint.id,
      });
      if (!delivery) throw AppError.notFound('Webhook endpoint'); // deleted meanwhile
      return toDeliveryDto(delivery);
    });

    defineRoute(app, api.webhooks.listDeliveries, async ({ auth, params, query, app: { db } }) => {
      await findEndpoint(db, auth.workspaceId, params.webhookId);
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.endpointId, params.webhookId),
            eq(webhookDeliveries.workspaceId, auth.workspaceId),
            cursorWhere(webhookDeliveries.createdAt, webhookDeliveries.id, query.cursor),
          ),
        )
        .orderBy(...cursorOrder(webhookDeliveries.createdAt, webhookDeliveries.id))
        .limit(query.limit + 1);
      const page = buildPage(rows, query.limit);
      return { items: page.items.map(toDeliveryDto), nextCursor: page.nextCursor };
    });

    defineRoute(app, api.webhooks.retryDelivery, async ({ auth, params, app: { db, queues } }) => {
      const scope = and(
        eq(webhookDeliveries.id, params.deliveryId),
        eq(webhookDeliveries.workspaceId, auth.workspaceId),
      );
      const [existing] = await db.select().from(webhookDeliveries).where(scope);
      if (!existing) throw AppError.notFound('Webhook delivery');
      // Only a delivery that gave up can be sent again; the status test is part of the UPDATE
      // so two concurrent retries queue it once.
      const [requeued] = await db
        .update(webhookDeliveries)
        .set({
          status: 'pending',
          error: null,
          responseStatus: null,
          durationMs: null,
          nextRetryAt: null,
        })
        .where(and(scope, eq(webhookDeliveries.status, 'failed')))
        .returning();
      if (!requeued) {
        throw AppError.invalidState(
          existing.status === 'succeeded'
            ? 'This delivery already succeeded'
            : 'This delivery is still being attempted',
        );
      }
      await enqueueOrCompensate(
        queues,
        'webhookDelivery',
        { deliveryId: requeued.id, workspaceId: auth.workspaceId },
        { jobId: requeued.id },
        async (error) => {
          await db
            .update(webhookDeliveries)
            .set({ status: 'failed', error: error.message })
            .where(scope);
        },
      );
      return toDeliveryDto(requeued);
    });
  },
});
