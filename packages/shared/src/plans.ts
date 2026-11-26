import { z } from 'zod';
import { ResolutionSchema } from './composition/schema';
import type { Resolution } from './composition/schema';

/* ---------- roles ---------- */

export const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

/**
 * Role hierarchy: owner > admin > editor > viewer.
 *  - viewer: read everything in the workspace
 *  - editor: create/edit/render/delete content (videos, assets, templates, brand kits, AI tools)
 *  - admin:  + members & invites, API keys, webhooks, consent records, workspace settings
 *  - owner:  + billing/plan changes, delete workspace, change other owners/admin→owner
 */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/* ---------- plans ---------- */

export const PLAN_IDS = ['free', 'creator', 'team'] as const;
export const PlanIdSchema = z.enum(PLAN_IDS);
export type PlanId = z.infer<typeof PlanIdSchema>;

export const PlanLimitsSchema = z.object({
  maxVideoDurationSec: z.number().int(),
  maxScenesPerVideo: z.number().int(),
  maxResolution: ResolutionSchema,
  maxMembers: z.number().int(),
  maxStorageBytes: z.number().int(),
  maxUploadBytes: z.number().int(),
  maxPhotoAvatars: z.number().int(),
  maxClonedVoices: z.number().int(),
  maxBatchRows: z.number().int(),
  maxTranslationTargets: z.number().int(),
  /** Longest source video (seconds) accepted by `POST /api/translations`. */
  maxTranslationSourceSec: z.number().int(),
  /**
   * Renders a workspace may have queued or running AT ONCE when they are requested one by one
   * (Studio `POST /api/videos/:id/render` and public `POST /v1/videos`): one more is rejected
   * with PLAN_LIMIT_EXCEEDED. It counts `render_jobs` in `queued`/`running` whose video has no
   * `batch_job_id`. Batch fan-out is EXEMPT (a free plan may queue its 5 batch rows): those
   * renders are bounded by `maxBatchRows` and serialised by the render queue concurrency.
   * Enforced only by `startRender` in @parlante/jobs.
   */
  maxConcurrentRenders: z.number().int(),
  maxApiKeys: z.number().int(),
  maxWebhookEndpoints: z.number().int(),
  /** Public API v1 access. */
  apiAccess: z.boolean(),
  /** Exported videos carry a small "Parlante" watermark. */
  watermark: z.boolean(),
});
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

export const PlanSchema = z.object({
  id: PlanIdSchema,
  name: z.string(),
  /** Credits granted when the plan starts and on each (simulated) monthly renewal. */
  monthlyCredits: z.number().int(),
  /** Display only — payments are simulated. */
  priceMonthlyCents: z.number().int(),
  limits: PlanLimitsSchema,
});
export type Plan = z.infer<typeof PlanSchema>;

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    monthlyCredits: 30,
    priceMonthlyCents: 0,
    limits: {
      maxVideoDurationSec: 180,
      maxScenesPerVideo: 10,
      maxResolution: '720p',
      maxMembers: 2,
      maxStorageBytes: 1 * GB,
      maxUploadBytes: 100 * MB,
      maxPhotoAvatars: 1,
      maxClonedVoices: 1,
      maxBatchRows: 5,
      maxTranslationTargets: 1,
      maxTranslationSourceSec: 300,
      maxConcurrentRenders: 1,
      maxApiKeys: 2,
      maxWebhookEndpoints: 2,
      apiAccess: true,
      watermark: true,
    },
  },
  creator: {
    id: 'creator',
    name: 'Creator',
    monthlyCredits: 300,
    priceMonthlyCents: 2400,
    limits: {
      maxVideoDurationSec: 900,
      maxScenesPerVideo: 30,
      maxResolution: '1080p',
      maxMembers: 5,
      maxStorageBytes: 20 * GB,
      maxUploadBytes: 500 * MB,
      maxPhotoAvatars: 10,
      maxClonedVoices: 5,
      maxBatchRows: 50,
      maxTranslationTargets: 5,
      maxTranslationSourceSec: 1800,
      maxConcurrentRenders: 2,
      maxApiKeys: 10,
      maxWebhookEndpoints: 5,
      apiAccess: true,
      watermark: false,
    },
  },
  team: {
    id: 'team',
    name: 'Team',
    monthlyCredits: 1500,
    priceMonthlyCents: 8900,
    limits: {
      maxVideoDurationSec: 1800,
      maxScenesPerVideo: 50,
      maxResolution: '1080p',
      maxMembers: 25,
      maxStorageBytes: 100 * GB,
      maxUploadBytes: 1 * GB,
      maxPhotoAvatars: 50,
      maxClonedVoices: 25,
      maxBatchRows: 500,
      maxTranslationTargets: 13,
      maxTranslationSourceSec: 3600,
      maxConcurrentRenders: 4,
      maxApiKeys: 25,
      maxWebhookEndpoints: 10,
      apiAccess: true,
      watermark: false,
    },
  },
};

export const DEFAULT_PLAN: PlanId = 'free';
/** Credits granted to a new workspace (equals the free plan monthly grant). */
export const SIGNUP_CREDITS = PLANS.free.monthlyCredits;

export function getPlan(id: PlanId): Plan {
  return PLANS[id];
}

export function resolutionAllowed(plan: PlanId, resolution: Resolution): boolean {
  return resolution === '720p' || PLANS[plan].limits.maxResolution === '1080p';
}

/* ---------- credit costs ---------- */

export const CREDIT_COSTS = {
  /** Per started 30 s of rendered video at 720p; 1080p costs double. */
  renderPer30s: 1,
  render1080pMultiplier: 2,
  /** Per started minute of source video, per target language. */
  translationPerMinutePerLanguage: 2,
  /** Preparing a photoreal avatar from a photo. */
  photoAvatar: 5,
  /** Generating a synthetic photoreal avatar from text. */
  generatedAvatar: 8,
  /** Renders that animate photorealistic avatars (neural engine) cost this many times more. */
  renderPhotorealMultiplier: 2,
  voiceClone: 10,
  /** AI script generation: free in basic (local) mode, 1 credit with an external LLM. */
  scriptPremium: 1,
  /** Starting an interactive avatar session: free in basic mode, 2 credits with an external LLM. */
  interactiveSessionPremium: 2,
} as const;

export function creditsForRender(
  durationMs: number,
  resolution: Resolution,
  options: { photoreal?: boolean } = {},
): number {
  const units = Math.max(1, Math.ceil(durationMs / 30_000));
  return (
    units *
    CREDIT_COSTS.renderPer30s *
    (resolution === '1080p' ? CREDIT_COSTS.render1080pMultiplier : 1) *
    (options.photoreal ? CREDIT_COSTS.renderPhotorealMultiplier : 1)
  );
}

export function creditsForTranslation(sourceDurationMs: number, targetLanguages: number): number {
  const minutes = Math.max(1, Math.ceil(sourceDurationMs / 60_000));
  return minutes * CREDIT_COSTS.translationPerMinutePerLanguage * Math.max(1, targetLanguages);
}

/** Reasons recorded in the credit ledger. Positive delta = grant/refund, negative = spend. */
export const LEDGER_REASONS = [
  'signup_grant',
  'plan_grant',
  'top_up',
  'render',
  'render_adjustment',
  'translation',
  'photo_avatar',
  'generated_avatar',
  'voice_clone',
  'script',
  'interactive',
  'refund',
  'adjustment',
] as const;
export const LedgerReasonSchema = z.enum(LEDGER_REASONS);
export type LedgerReason = z.infer<typeof LedgerReasonSchema>;

/** Simulated top-up packs offered by the billing screen. */
export const TOP_UP_PACKS = [50, 200, 1000] as const;
