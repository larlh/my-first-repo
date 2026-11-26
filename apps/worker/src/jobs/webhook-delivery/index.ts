import { AppError, QUEUES, WEBHOOK_TIMEOUT_MS, isAppError } from '@parlante/shared';
import type { StoredError } from '@parlante/shared';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  decryptSecret,
  safeRequest,
  signWebhookPayload,
} from '@parlante/shared/node';
import { and, eq, sql, webhookDeliveries, webhookEndpoints } from '@parlante/db';
import type { WorkerContext } from '../../context';
import { defineJob } from '../../lib/job';

/* -------------------------------------------------------------------------------------------
 * Webhook delivery (feature 9). One `webhook_deliveries` row = one event for one endpoint;
 * every run of this job is ONE attempt:
 *
 *   POST <endpoint.url>
 *     Content-Type: application/json
 *     Parlante-Event: <type>            Parlante-Delivery: <delivery id>
 *     Parlante-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>
 *     body = the stored event, byte for byte what was signed
 *
 *  - SSRF: the URL was checked when the endpoint was saved, but DNS can change afterwards, so
 *    `safeRequest` checks it again here, at connection time, and never follows redirects.
 *  - Time limit `WEBHOOK_TIMEOUT_MS`; the response body is read only up to a small cap.
 *  - 2xx = delivered. Anything else is recorded on the row (attempt number, status, error,
 *    duration, when the next attempt is due) and thrown, so BullMQ retries with the backoff
 *    of the queue; the last attempt leaves the row `failed` (it can be retried from the API).
 *  - Errors nobody can fix by waiting are final at once: unsafe URL, endpoint disabled,
 *    unreadable signing secret, `410 Gone`.
 *
 * The contract defines no automatic deactivation of an endpoint after repeated failures
 * (`webhook_endpoints` has no failure counter), so none is done: the owner sees every failed
 * delivery in the list and disables or fixes the endpoint.
 * ----------------------------------------------------------------------------------------- */

interface DeliveryRef {
  deliveryId: string;
  workspaceId: string;
}

/** Response bodies are only read to show a hint of what the receiver answered. */
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_ERROR_CHARS = 300;

const deliveryWhere = (ref: DeliveryRef) =>
  and(eq(webhookDeliveries.id, ref.deliveryId), eq(webhookDeliveries.workspaceId, ref.workspaceId));

/** Delay BullMQ applies before attempt `attempt + 1` (exponential backoff of the queue). */
export function retryDelayMs(attempt: number): number {
  return QUEUES.webhookDelivery.backoffMs * 2 ** Math.max(0, attempt - 1);
}

/** Short, single-line description of a failed attempt, safe to show in the UI. */
function describeFailure(err: unknown): string {
  if (isAppError(err)) {
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    const suffix = typeof reason === 'string' && reason !== '' ? ` (${reason})` : '';
    return `${err.message}${suffix}`.slice(0, MAX_ERROR_CHARS);
  }
  return (err instanceof Error ? err.message : 'The request failed').slice(0, MAX_ERROR_CHARS);
}

function responseHint(body: Buffer): string {
  const text = body
    .toString('utf8')
    // Control characters (and the replacement character of invalid UTF-8) never reach the UI.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f�]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? '' : `: ${text.slice(0, 120)}`;
}

/** Terminal failure, idempotent: only a delivery still `pending` is failed. */
async function markDeliveryFailed(
  ctx: Pick<WorkerContext, 'db'>,
  ref: DeliveryRef,
  message: string,
): Promise<void> {
  await ctx.db
    .update(webhookDeliveries)
    .set({
      status: 'failed',
      nextRetryAt: null,
      // Keep the error of the last real attempt when there is one (it says more).
      error: sql`coalesce(${webhookDeliveries.error}, ${message.slice(0, MAX_ERROR_CHARS)})`,
    })
    .where(and(deliveryWhere(ref), eq(webhookDeliveries.status, 'pending')));
}

export default defineJob({
  queue: 'webhookDelivery',
  async handler(ctx, job) {
    const ref = job.payload;
    const [delivery] = await ctx.db.select().from(webhookDeliveries).where(deliveryWhere(ref));
    // The endpoint (and its deliveries) was deleted: nothing to send, nothing to retry.
    if (!delivery) throw new AppError('NOT_FOUND', 'Webhook delivery not found');
    // Idempotency: a duplicate run never sends an event that was already accepted.
    if (delivery.status === 'succeeded') {
      return {
        deliveryId: delivery.id,
        eventType: delivery.eventType,
        responseStatus: delivery.responseStatus ?? 200,
      };
    }
    if (delivery.status === 'failed') {
      throw new AppError('INVALID_STATE', 'This delivery already failed; retry it from the API');
    }
    const [endpoint] = await ctx.db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, delivery.endpointId),
          eq(webhookEndpoints.workspaceId, ref.workspaceId),
        ),
      );
    if (!endpoint) throw new AppError('NOT_FOUND', 'Webhook endpoint not found');

    const attempt = delivery.attempts + 1;
    await job.progress({ attempt });
    const started = Date.now();
    let responseStatus: number | null = null;
    let failure: unknown = null;
    try {
      // A disabled endpoint receives nothing — except the `ping` of "send test event", which
      // exists precisely to try an endpoint before enabling it.
      if (!endpoint.enabled && delivery.eventType !== 'ping') {
        throw new AppError('INVALID_STATE', 'The endpoint is disabled');
      }
      let secret: string;
      try {
        secret = decryptSecret(ctx.config.APP_SECRET, endpoint.secretEncrypted);
      } catch {
        // Never retried and never sent unsigned.
        throw new AppError(
          'UNPROCESSABLE',
          'The signing secret of this endpoint cannot be read; rotate it',
        );
      }
      const rawBody = JSON.stringify(delivery.payload);
      const response = await safeRequest(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'user-agent': 'Parlante-Webhooks/1.0',
          [WEBHOOK_EVENT_HEADER]: delivery.eventType,
          [WEBHOOK_DELIVERY_HEADER]: delivery.id,
          [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(secret, rawBody),
        },
        body: rawBody,
        timeoutMs: WEBHOOK_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        allowPrivate: ctx.config.ALLOW_PRIVATE_URLS,
      });
      responseStatus = response.status;
      if (response.status < 200 || response.status >= 300) {
        const message = `The endpoint answered HTTP ${response.status}${responseHint(response.body)}`;
        // 410 Gone = "stop sending": final. Every other status may be temporary.
        throw response.status === 410
          ? new AppError('UNPROCESSABLE', message)
          : new AppError('PROVIDER_ERROR', message);
      }
    } catch (err) {
      failure = err;
    }
    const durationMs = Date.now() - started;

    if (failure === null && responseStatus !== null) {
      await ctx.db
        .update(webhookDeliveries)
        .set({
          status: 'succeeded',
          attempts: attempt,
          responseStatus,
          error: null,
          durationMs,
          nextRetryAt: null,
          deliveredAt: new Date(),
        })
        .where(and(deliveryWhere(ref), eq(webhookDeliveries.status, 'pending')));
      return { deliveryId: delivery.id, eventType: delivery.eventType, responseStatus };
    }

    // Failed attempt: record it. Final (no attempts left, or an error waiting cannot fix)
    // → `failed`; otherwise it stays `pending` with the time of the next attempt.
    const final = job.isLastAttempt || (isAppError(failure) && failure.status < 500);
    await ctx.db
      .update(webhookDeliveries)
      .set({
        status: final ? 'failed' : 'pending',
        attempts: attempt,
        responseStatus,
        error: describeFailure(failure),
        durationMs,
        nextRetryAt: final ? null : new Date(Date.now() + retryDelayMs(job.attempt)),
      })
      .where(and(deliveryWhere(ref), eq(webhookDeliveries.status, 'pending')));
    job.log.warn(
      { attempt, responseStatus, final, endpointId: endpoint.id },
      'webhook delivery attempt failed',
    );
    throw failure;
  },
  // A delivery whose worker died mid-request (or that ran out of attempts without reaching
  // the code above) must not stay `pending` forever.
  onFinalFailure: async (ctx, payload, error: StoredError) => {
    await markDeliveryFailed(ctx, payload, error.message);
  },
});
