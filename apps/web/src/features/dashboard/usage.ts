import type { BillingOverview } from '@parlante/shared';

/* Pure helpers of the home page: plan usage meters, credit level and the greeting. */

export type UsageKey = 'storage' | 'members' | 'photoAvatars' | 'clonedVoices';
export type UsageLevel = 'ok' | 'high' | 'full';

export interface UsageMeter {
  key: UsageKey;
  used: number;
  limit: number;
  /** 0..1 (clamped). */
  ratio: number;
  level: UsageLevel;
}

function level(ratio: number): UsageLevel {
  if (ratio >= 1) return 'full';
  if (ratio >= 0.8) return 'high';
  return 'ok';
}

function meter(key: UsageKey, used: number, limit: number): UsageMeter {
  const ratio = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : used > 0 ? 1 : 0;
  return { key, used, limit, ratio, level: level(ratio) };
}

/** What the workspace has used of each counted limit of its plan. */
export function usageMeters(overview: Pick<BillingOverview, 'usage' | 'limits'>): UsageMeter[] {
  const { usage, limits } = overview;
  return [
    meter('storage', usage.storageBytes, limits.maxStorageBytes),
    meter('members', usage.members, limits.maxMembers),
    meter('photoAvatars', usage.photoAvatars, limits.maxPhotoAvatars),
    meter('clonedVoices', usage.clonedVoices, limits.maxClonedVoices),
  ];
}

export interface CreditLevel {
  /** 0..1 of the monthly grant (a top-up can push the balance above it: clamped). */
  ratio: number;
  /** At or below 10 % of the monthly grant (or two credits): worth a warning. */
  low: boolean;
  empty: boolean;
}

export function creditLevel(credits: number, monthlyCredits: number): CreditLevel {
  const ratio = monthlyCredits > 0 ? Math.min(1, Math.max(0, credits / monthlyCredits)) : 0;
  return {
    ratio,
    low: credits <= Math.max(2, monthlyCredits * 0.1),
    empty: credits <= 0,
  };
}

export type DayPart = 'morning' | 'afternoon' | 'evening';

/** Part of the day for the greeting, from a local hour (0..23). */
export function dayPart(hour: number): DayPart {
  if (hour >= 6 && hour < 13) return 'morning';
  if (hour >= 13 && hour < 21) return 'afternoon';
  return 'evening';
}

/** First word of a display name ("Lucía Ferrer" → "Lucía"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}
