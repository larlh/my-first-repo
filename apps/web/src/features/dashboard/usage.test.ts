import { PLANS } from '@parlante/shared';
import { describe, expect, it } from 'vitest';
import { creditLevel, dayPart, firstName, usageMeters } from './usage';

const GB = 1024 ** 3;

describe('plan usage meters', () => {
  it('compares each counted usage with the limit of the plan', () => {
    const meters = usageMeters({
      limits: PLANS.creator.limits,
      usage: {
        storageBytes: 17 * GB,
        members: 5,
        photoAvatars: 3,
        clonedVoices: 0,
        apiKeys: 1,
        webhookEndpoints: 0,
        creditsSpent30d: 10,
        renders30d: 4,
      },
    });
    expect(meters.map((meter) => [meter.key, meter.level])).toEqual([
      ['storage', 'high'],
      ['members', 'full'],
      ['photoAvatars', 'ok'],
      ['clonedVoices', 'ok'],
    ]);
    expect(meters[0]?.ratio).toBeCloseTo(0.85);
    expect(meters[1]).toMatchObject({ used: 5, limit: 5, ratio: 1 });
  });

  it('clamps overuse and survives a zero limit', () => {
    const [storage] = usageMeters({
      limits: { ...PLANS.free.limits, maxStorageBytes: 0 },
      usage: {
        storageBytes: 10,
        members: 9,
        photoAvatars: 0,
        clonedVoices: 0,
        apiKeys: 0,
        webhookEndpoints: 0,
        creditsSpent30d: 0,
        renders30d: 0,
      },
    });
    expect(storage).toMatchObject({ ratio: 1, level: 'full' });
  });
});

describe('credit level', () => {
  it('warns at 10 % of the monthly grant or two credits', () => {
    expect(creditLevel(212, 300)).toEqual({ ratio: 212 / 300, low: false, empty: false });
    expect(creditLevel(30, 300)).toMatchObject({ low: true, empty: false });
    expect(creditLevel(2, 30)).toMatchObject({ low: true });
    expect(creditLevel(4, 30)).toMatchObject({ low: false });
    expect(creditLevel(0, 30)).toEqual({ ratio: 0, low: true, empty: true });
  });

  it('clamps a topped-up balance above the monthly grant', () => {
    expect(creditLevel(1000, 300).ratio).toBe(1);
  });
});

describe('greeting', () => {
  it('picks the part of the day', () => {
    expect([5, 6, 12, 13, 20, 21, 23, 0].map(dayPart)).toEqual([
      'evening',
      'morning',
      'morning',
      'afternoon',
      'afternoon',
      'evening',
      'evening',
      'evening',
    ]);
  });

  it('uses the first name', () => {
    expect(firstName('  Lucía Ferrer Gil ')).toBe('Lucía');
    expect(firstName('')).toBe('');
  });
});
