import { PLAN_IDS } from '@parlante/shared';
import type { LedgerReason, Plan, PlanId, PlanLimits } from '@parlante/shared';
import type { ApiError } from '@/lib/api';

/* Pure helpers of the billing screen: plan ordering, the comparison table and the meaning of
 * a refused downgrade. Formatting (bytes, minutes…) is applied by the component. */

export type PlanChange = 'current' | 'upgrade' | 'downgrade';

export function planRank(plan: PlanId): number {
  return PLAN_IDS.indexOf(plan);
}

export function planChange(current: PlanId, target: PlanId): PlanChange {
  if (current === target) return 'current';
  return planRank(target) > planRank(current) ? 'upgrade' : 'downgrade';
}

/** How a limit is shown in the comparison table. */
export type LimitFormat = 'count' | 'bytes' | 'minutes' | 'resolution' | 'watermark';

export interface ComparisonRow {
  /** i18n key suffix under `billing.compare.rows`. */
  key: keyof PlanLimits | 'monthlyCredits';
  format: LimitFormat;
}

/** Rows of the plan comparison, most decisive first. Every value comes from the API plans. */
export const COMPARISON_ROWS: readonly ComparisonRow[] = [
  { key: 'monthlyCredits', format: 'count' },
  { key: 'maxResolution', format: 'resolution' },
  { key: 'watermark', format: 'watermark' },
  { key: 'maxVideoDurationSec', format: 'minutes' },
  { key: 'maxScenesPerVideo', format: 'count' },
  { key: 'maxMembers', format: 'count' },
  { key: 'maxStorageBytes', format: 'bytes' },
  { key: 'maxUploadBytes', format: 'bytes' },
  { key: 'maxPhotoAvatars', format: 'count' },
  { key: 'maxClonedVoices', format: 'count' },
  { key: 'maxBatchRows', format: 'count' },
  { key: 'maxTranslationTargets', format: 'count' },
  { key: 'maxConcurrentRenders', format: 'count' },
  { key: 'maxApiKeys', format: 'count' },
  { key: 'maxWebhookEndpoints', format: 'count' },
];

export function comparisonValue(plan: Plan, key: ComparisonRow['key']): number | string | boolean {
  return key === 'monthlyCredits' ? plan.monthlyCredits : plan.limits[key];
}

/** The handful of limits printed on each plan card. */
export const HEADLINE_LIMITS = [
  'maxResolution',
  'maxVideoDurationSec',
  'maxMembers',
  'maxStorageBytes',
] as const satisfies readonly (keyof PlanLimits)[];

export interface ExceededLimit {
  limit: string;
  max: number;
  value: number;
}

/**
 * A downgrade is refused with INVALID_STATE and `details.exceeded` when the workspace uses
 * more than the target plan allows. Returns those limits (empty for any other error).
 */
export function exceededLimits(error: ApiError | null | undefined): ExceededLimit[] {
  const raw = (error?.details as { exceeded?: unknown } | undefined)?.exceeded;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is ExceededLimit =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as ExceededLimit).limit === 'string' &&
      typeof (item as ExceededLimit).max === 'number' &&
      typeof (item as ExceededLimit).value === 'number',
  );
}

/** Limits measured in bytes (shown with a size unit instead of a plain number). */
export function isByteLimit(limit: string): boolean {
  return limit === 'maxStorageBytes' || limit === 'maxUploadBytes';
}

export type LedgerKind = 'grant' | 'spend' | 'refund';

/** Visual family of a ledger line: what was added, what was spent, what came back. */
export function ledgerKind(reason: LedgerReason, delta: number): LedgerKind {
  if (reason === 'signup_grant' || reason === 'plan_grant' || reason === 'top_up') return 'grant';
  if (reason === 'refund') return 'refund';
  return delta > 0 ? 'refund' : 'spend';
}

/** "+50" / "−12": a real minus sign, never a hyphen, and an explicit plus. */
export function signedAmount(delta: number, format: (value: number) => string): string {
  if (delta > 0) return `+${format(delta)}`;
  if (delta < 0) return `−${format(Math.abs(delta))}`;
  return format(0);
}

export interface UsageLine {
  key: 'members' | 'storage' | 'photoAvatars' | 'clonedVoices' | 'apiKeys' | 'webhookEndpoints';
  used: number;
  limit: number;
  /** 0..100 */
  percent: number;
  level: 'ok' | 'high' | 'full';
}

export function usageLevel(used: number, limit: number): UsageLine['level'] {
  if (limit <= 0 || used >= limit) return 'full';
  return used / limit >= 0.8 ? 'high' : 'ok';
}

export function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

export function usageLines(
  usage: {
    storageBytes: number;
    members: number;
    photoAvatars: number;
    clonedVoices: number;
    apiKeys: number;
    webhookEndpoints: number;
  },
  limits: PlanLimits,
): UsageLine[] {
  const pairs: [UsageLine['key'], number, number][] = [
    ['storage', usage.storageBytes, limits.maxStorageBytes],
    ['members', usage.members, limits.maxMembers],
    ['photoAvatars', usage.photoAvatars, limits.maxPhotoAvatars],
    ['clonedVoices', usage.clonedVoices, limits.maxClonedVoices],
    ['apiKeys', usage.apiKeys, limits.maxApiKeys],
    ['webhookEndpoints', usage.webhookEndpoints, limits.maxWebhookEndpoints],
  ];
  return pairs.map(([key, used, limit]) => ({
    key,
    used,
    limit,
    percent: usagePercent(used, limit),
    level: usageLevel(used, limit),
  }));
}

/* ---------- ledger detail ---------- */

/** What the server writes next to a refund, in Spanish (the reason label says "Reembolso"). */
const LEDGER_DETAIL_ES: Readonly<Record<string, string>> = {
  'Render cancelled — credits refunded': 'Render cancelado',
  'Render failed — credits refunded': 'Render fallido',
  'Video deleted while rendering — credits refunded': 'Vídeo eliminado durante el render',
  'Translation cancelled — credits refunded': 'Traducción cancelada',
  'Translation could not be queued — credits refunded': 'La traducción no llegó a ponerse en cola',
  'Translation failed — credits refunded': 'Traducción fallida',
  'Avatar could not be queued — credits refunded': 'El avatar no llegó a ponerse en cola',
  'Avatar deleted before it was ready — credits refunded': 'Avatar eliminado antes de estar listo',
  'Voice cloning could not start — credits refunded': 'El clonado de voz no llegó a empezar',
  'Voice cloning failed — credits refunded': 'Clonado de voz fallido',
  'Voice deleted before it was ready — credits refunded': 'Voz eliminada antes de estar lista',
};

/**
 * Second line of a ledger row. The API describes every movement with an English sentence
 * (`Render "Bienvenida" (720p)`, `Translation failed — credits refunded`); the translated reason
 * is the first line, so in a non-English interface only what adds information is kept: the name
 * the person gave (with its resolution or target language) or the translated cause of a refund.
 */
export function ledgerDetail(description: string | null | undefined, locale: string): string {
  const raw = (description ?? '').trim();
  if (raw === '' || locale.toLowerCase().startsWith('en')) return raw;
  const known = LEDGER_DETAIL_ES[raw];
  if (known) return known;
  const pack = /^(\d+) credit pack\b/.exec(raw);
  if (pack) return `Paquete de ${pack[1]} créditos (pago simulado)`;
  const quoted = /"(.+)"(.*)$/.exec(raw);
  if (!quoted) return '';
  // Keep the tail only when it is language-neutral: "(720p)", "→ en", "→ en, fr".
  const tail = /^\s*(\((?:720p|1080p)\)|→\s*[a-z]{2}(?:-[A-Za-z]{2})?(?:,\s*[a-z]{2})*)\s*$/.exec(
    quoted[2] ?? '',
  );
  return `«${quoted[1]}»${tail ? ` ${tail[1]}` : ''}`;
}
