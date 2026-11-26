import { PLANS, PlanLimitsSchema } from '@parlante/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { translations } from '../i18n';
import {
  COMPARISON_ROWS,
  comparisonValue,
  exceededLimits,
  isByteLimit,
  ledgerDetail,
  ledgerKind,
  planChange,
  signedAmount,
  usageLevel,
  usageLines,
  usagePercent,
} from './billing';

describe('plan changes', () => {
  it('orders plans free < creator < team', () => {
    expect(planChange('free', 'free')).toBe('current');
    expect(planChange('free', 'team')).toBe('upgrade');
    expect(planChange('team', 'creator')).toBe('downgrade');
  });

  it('reads the limits a refused downgrade exceeds', () => {
    const error = new ApiError('INVALID_STATE', 'too much', 409, {
      exceeded: [
        { limit: 'maxMembers', max: 2, value: 4 },
        { limit: 'maxStorageBytes', max: 1024, value: 4096 },
        { limit: 7 },
      ],
    });
    expect(exceededLimits(error)).toEqual([
      { limit: 'maxMembers', max: 2, value: 4 },
      { limit: 'maxStorageBytes', max: 1024, value: 4096 },
    ]);
    expect(exceededLimits(new ApiError('INVALID_STATE', 'same plan', 409))).toEqual([]);
    expect(exceededLimits(null)).toEqual([]);
    expect(isByteLimit('maxStorageBytes')).toBe(true);
    expect(isByteLimit('maxMembers')).toBe(false);
  });
});

describe('comparison table', () => {
  it('reads every row from the plan object', () => {
    expect(comparisonValue(PLANS.creator, 'monthlyCredits')).toBe(300);
    expect(comparisonValue(PLANS.free, 'maxResolution')).toBe('720p');
    expect(comparisonValue(PLANS.team, 'watermark')).toBe(false);
  });

  it('has a translated label for every plan limit of the contract', () => {
    const labels = (translations.es.billing as { compare: { rows: Record<string, string> } })
      .compare.rows;
    for (const key of Object.keys(PlanLimitsSchema.shape)) {
      expect(labels[key], `missing label for ${key}`).toBeTruthy();
    }
    for (const row of COMPARISON_ROWS) expect(labels[row.key]).toBeTruthy();
  });
});

describe('ledger', () => {
  it('classifies grants, spends and refunds', () => {
    expect(ledgerKind('signup_grant', 30)).toBe('grant');
    expect(ledgerKind('top_up', 50)).toBe('grant');
    expect(ledgerKind('render', -4)).toBe('spend');
    expect(ledgerKind('refund', 4)).toBe('refund');
    // A settlement below the reserved amount gives credits back.
    expect(ledgerKind('render_adjustment', 2)).toBe('refund');
    expect(ledgerKind('render_adjustment', -1)).toBe('spend');
  });

  it('prints explicit signs with a real minus', () => {
    const plain = (value: number) => String(value);
    expect(signedAmount(50, plain)).toBe('+50');
    expect(signedAmount(-12, plain)).toBe('−12');
    expect(signedAmount(0, plain)).toBe('0');
  });
});

describe('usage', () => {
  it('grades how full a limit is', () => {
    expect(usageLevel(1, 5)).toBe('ok');
    expect(usageLevel(4, 5)).toBe('high');
    expect(usageLevel(5, 5)).toBe('full');
    expect(usageLevel(0, 0)).toBe('full');
    expect(usagePercent(1, 3)).toBe(33);
    expect(usagePercent(9, 3)).toBe(100);
  });

  it('pairs each usage figure with its limit', () => {
    const lines = usageLines(
      {
        storageBytes: 512 * 1024 * 1024,
        members: 2,
        photoAvatars: 0,
        clonedVoices: 1,
        apiKeys: 1,
        webhookEndpoints: 2,
      },
      PLANS.free.limits,
    );
    expect(lines.map((line) => [line.key, line.percent, line.level])).toEqual([
      ['storage', 50, 'ok'],
      ['members', 100, 'full'],
      ['photoAvatars', 0, 'ok'],
      ['clonedVoices', 100, 'full'],
      ['apiKeys', 50, 'ok'],
      ['webhookEndpoints', 100, 'full'],
    ]);
  });
});

describe('ledgerDetail', () => {
  it('keeps the English sentence in English', () => {
    expect(ledgerDetail('Render "Bienvenida" (720p)', 'en')).toBe('Render "Bienvenida" (720p)');
  });

  it('keeps only what adds information in Spanish, never an English sentence', () => {
    expect(ledgerDetail('Render "Saludos — 02" (720p)', 'es')).toBe('«Saludos — 02» (720p)');
    expect(ledgerDetail('Translation "Saludo en inglés" → en', 'es')).toBe(
      '«Saludo en inglés» → en',
    );
    expect(ledgerDetail('Voice clone "Mi voz"', 'es')).toBe('«Mi voz»');
    expect(ledgerDetail('Translation failed — credits refunded', 'es')).toBe('Traducción fallida');
    expect(ledgerDetail('50 credit pack (simulated checkout, no payment taken)', 'es')).toBe(
      'Paquete de 50 créditos (pago simulado)',
    );
    // Nothing worth repeating under "Créditos de bienvenida" / "Créditos del plan".
    expect(ledgerDetail('Welcome credits', 'es')).toBe('');
    expect(ledgerDetail('Creator plan credits (simulated checkout, no payment taken)', 'es')).toBe(
      '',
    );
    expect(ledgerDetail(null, 'es')).toBe('');
  });
});
