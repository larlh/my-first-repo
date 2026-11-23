import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  VERIFY_SNIPPET,
  checkWebhookUrl,
  deliveryView,
  eventKey,
  hasActiveDeliveries,
} from './webhooks';

describe('deliveryView', () => {
  it('maps each delivery state to a label, a tone and its actions', () => {
    expect(deliveryView({ status: 'succeeded', attempts: 1, nextRetryAt: null })).toEqual({
      state: 'succeeded',
      tone: 'success',
      active: false,
      canRetry: false,
    });
    expect(deliveryView({ status: 'failed', attempts: 5, nextRetryAt: null })).toMatchObject({
      state: 'failed',
      canRetry: true,
      active: false,
    });
    expect(deliveryView({ status: 'pending', attempts: 0, nextRetryAt: null })).toMatchObject({
      state: 'pending',
      active: true,
      canRetry: false,
    });
    expect(
      deliveryView({ status: 'pending', attempts: 2, nextRetryAt: '2026-11-20T10:05:00.000Z' }),
    ).toMatchObject({ state: 'retrying', tone: 'warning', active: true });
  });

  it('keeps polling only while something is still being attempted', () => {
    const done = { status: 'succeeded', attempts: 1, nextRetryAt: null } as const;
    const waiting = { status: 'pending', attempts: 0, nextRetryAt: null } as const;
    expect(hasActiveDeliveries([done])).toBe(false);
    expect(hasActiveDeliveries([done, waiting])).toBe(true);
    expect(hasActiveDeliveries([])).toBe(false);
  });
});

describe('checkWebhookUrl', () => {
  it('accepts https, warns about http and rejects everything else', () => {
    expect(checkWebhookUrl(' https://ejemplo.com/hooks ')).toEqual({ error: null, warning: null });
    expect(checkWebhookUrl('http://ejemplo.com/hooks')).toEqual({
      error: null,
      warning: 'insecure',
    });
    expect(checkWebhookUrl('').error).toBe('required');
    expect(checkWebhookUrl('ejemplo.com/hooks').error).toBe('invalid');
    expect(checkWebhookUrl('ftp://ejemplo.com').error).toBe('invalid');
    expect(checkWebhookUrl('https://intranet').error).toBe('invalid');
    expect(checkWebhookUrl(`https://ejemplo.com/${'a'.repeat(500)}`).error).toBe('tooLong');
  });
});

describe('documentation helpers', () => {
  it('turns event types into i18n-safe keys', () => {
    expect(eventKey('video.completed')).toBe('video_completed');
    expect(eventKey('ping')).toBe('ping');
  });

  it('documents a verification that matches the signature scheme of the contract', async () => {
    // Evaluate the documented snippet and check it against an HMAC computed the way the
    // worker signs (`t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>`).
    const source = VERIFY_SNIPPET.replace(/^import .*$/m, '').replace(
      'export function',
      'function',
    );
    const { timingSafeEqual } = await import('node:crypto');
    const verify = new Function(
      'createHmac',
      'timingSafeEqual',
      'Buffer',
      `${source}; return verify;`,
    )(createHmac, timingSafeEqual, Buffer) as (h: string, b: string, s: string) => boolean;
    const secret = 'whsec_test';
    const body = JSON.stringify({ id: 'evt_1', type: 'ping' });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    expect(verify(`t=${t},v1=${v1}`, body, secret)).toBe(true);
    expect(verify(`t=${t},v1=${v1}`, `${body} `, secret)).toBe(false);
    expect(verify(`t=${t - 3600},v1=${v1}`, body, secret)).toBe(false);
  });
});
