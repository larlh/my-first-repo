import type { ShareLink } from '@parlante/shared';

/* Pure helpers of the share panel. */

export type ExpiryChoice = 'never' | 'day' | 'week' | 'month' | 'custom';
export const EXPIRY_CHOICES: readonly Exclude<ExpiryChoice, 'custom'>[] = [
  'never',
  'day',
  'week',
  'month',
];

const DAY_MS = 86_400_000;
const EXPIRY_MS: Record<Exclude<ExpiryChoice, 'never' | 'custom'>, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};

/** ISO date a choice stands for, counted from `now` (null = never expires). */
export function expiryToDate(
  choice: Exclude<ExpiryChoice, 'custom'>,
  now: number = Date.now(),
): string | null {
  return choice === 'never' ? null : new Date(now + EXPIRY_MS[choice]).toISOString();
}

export function isExpired(share: Pick<ShareLink, 'expiresAt'>, now: number = Date.now()): boolean {
  return share.expiresAt !== null && new Date(share.expiresAt).getTime() <= now;
}

/** The public page answers for this link right now. */
export function isShareLive(
  share: Pick<ShareLink, 'enabled' | 'expiresAt'> | null | undefined,
  now: number = Date.now(),
): boolean {
  return Boolean(share && share.enabled && !isExpired(share, now));
}
