import type { WebhookDelivery, WebhookEventType } from '@parlante/shared';

/* Pure helpers of the webhooks screen. */

/** Events a customer can subscribe to (`ping` is only sent by the test action). */
export const SUBSCRIBABLE_EVENTS = [
  'video.completed',
  'video.failed',
] as const satisfies readonly WebhookEventType[];
export type SubscribableEvent = (typeof SUBSCRIBABLE_EVENTS)[number];

/** i18n-safe key of an event type (`video.completed` → `video_completed`). */
export function eventKey(type: WebhookEventType): string {
  return type.replace('.', '_');
}

export type DeliveryTone = 'success' | 'danger' | 'warning' | 'neutral';

export interface DeliveryView {
  /** i18n key suffix under `webhooks.deliveries.state`. */
  state: 'succeeded' | 'failed' | 'retrying' | 'pending';
  tone: DeliveryTone;
  /** Still being attempted: the list keeps polling. */
  active: boolean;
  canRetry: boolean;
}

export function deliveryView(
  delivery: Pick<WebhookDelivery, 'status' | 'attempts' | 'nextRetryAt'>,
): DeliveryView {
  if (delivery.status === 'succeeded') {
    return { state: 'succeeded', tone: 'success', active: false, canRetry: false };
  }
  if (delivery.status === 'failed') {
    return { state: 'failed', tone: 'danger', active: false, canRetry: true };
  }
  // pending: either waiting for its first attempt or between automatic retries.
  return delivery.attempts > 0
    ? { state: 'retrying', tone: 'warning', active: true, canRetry: false }
    : { state: 'pending', tone: 'neutral', active: true, canRetry: false };
}

export function hasActiveDeliveries(
  deliveries: readonly Pick<WebhookDelivery, 'status' | 'attempts' | 'nextRetryAt'>[],
): boolean {
  return deliveries.some((delivery) => deliveryView(delivery).active);
}

export type UrlProblem = 'required' | 'invalid' | 'tooLong' | 'insecure';

/**
 * Client-side check of an endpoint URL (the server also rejects private / loopback hosts with
 * UNSAFE_URL). `insecure` is a warning, not an error: http works but is not recommended.
 */
export function checkWebhookUrl(raw: string): {
  error: UrlProblem | null;
  warning: UrlProblem | null;
} {
  const value = raw.trim();
  if (value === '') return { error: 'required', warning: null };
  if (value.length > 500) return { error: 'tooLong', warning: null };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: 'invalid', warning: null };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'invalid', warning: null };
  }
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') {
    return { error: 'invalid', warning: null };
  }
  return { error: null, warning: url.protocol === 'http:' ? 'insecure' : null };
}

/** Node snippet that verifies `Parlante-Signature` (documented next to the secret). */
export const VERIFY_SNIPPET = `import { createHmac, timingSafeEqual } from 'node:crypto';

// header: "t=<unix seconds>,v1=<hex>"   rawBody: the request body exactly as received
export function verify(header, rawBody, secret) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const expected = createHmac('sha256', secret).update(\`\${parts.t}.\${rawBody}\`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
  return fresh && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 ?? ''));
}`;
