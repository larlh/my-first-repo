import { z } from 'zod';
import { ConsentKindSchema, ConsentRelationshipSchema } from '../consent';
import {
  ApiKeyCreatedSchema,
  ApiKeySchema,
  ConsentRecordSchema,
  CreditLedgerEntrySchema,
  InviteCreatedSchema,
  InviteSchema,
  MemberSchema,
  SessionInfoSchema,
  UserSchema,
  WebhookDeliverySchema,
  WebhookEndpointCreatedSchema,
  WebhookEndpointSchema,
  WebhookEventTypeSchema,
  WorkspaceSchema,
  WorkspaceWithRoleSchema,
} from '../entities';
import { idOf } from '../ids';
import { UiLocaleSchema } from '../languages';
import { PaginationQuerySchema, paginated } from '../pagination';
import { PlanIdSchema, PlanLimitsSchema, PlanSchema, RoleSchema } from '../plans';
import { OkSchema, listOf, route } from './contract';

/* ============================== auth (feature 1) ============================== */

export const PasswordSchema = z.string().min(8).max(128);
export const EmailSchema = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());

export const RegisterBodySchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  name: z.string().trim().min(1).max(80),
  locale: UiLocaleSchema.default('es'),
  /** When present the new user also joins the inviting workspace. */
  inviteToken: z.string().max(100).optional(),
});
export const LoginBodySchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(128),
});
export const UpdateProfileBodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  locale: UiLocaleSchema.optional(),
});
export const ChangePasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: PasswordSchema,
});
export const SwitchWorkspaceBodySchema = z.object({ workspaceId: idOf('workspace') });

export const authRoutes = {
  register: route({
    method: 'POST',
    path: '/api/auth/register',
    auth: 'public',
    feature: 1,
    tag: 'Auth',
    summary: 'Create an account with a personal workspace and start a session (sets cookie)',
    body: RegisterBodySchema,
    response: SessionInfoSchema,
    status: 201,
    errors: ['EMAIL_TAKEN'],
    rateLimit: { max: 10, windowSec: 60 },
  }),
  login: route({
    method: 'POST',
    path: '/api/auth/login',
    auth: 'public',
    feature: 1,
    tag: 'Auth',
    summary: 'Start a session (sets cookie)',
    body: LoginBodySchema,
    response: SessionInfoSchema,
    errors: ['INVALID_CREDENTIALS'],
    rateLimit: { max: 10, windowSec: 60 },
  }),
  logout: route({
    method: 'POST',
    path: '/api/auth/logout',
    auth: 'session',
    feature: 1,
    tag: 'Auth',
    summary: 'End the current session (clears cookie)',
    response: OkSchema,
  }),
  me: route({
    method: 'GET',
    path: '/api/auth/me',
    auth: 'session',
    feature: 1,
    tag: 'Auth',
    summary: 'Current user, workspaces and active workspace',
    response: SessionInfoSchema,
  }),
  updateProfile: route({
    method: 'PATCH',
    path: '/api/auth/me',
    auth: 'session',
    feature: 1,
    tag: 'Auth',
    summary: 'Update name / UI language',
    body: UpdateProfileBodySchema,
    response: UserSchema,
  }),
  changePassword: route({
    method: 'POST',
    path: '/api/auth/change-password',
    auth: 'session',
    feature: 1,
    tag: 'Auth',
    summary: 'Change password (other sessions are revoked)',
    body: ChangePasswordBodySchema,
    response: OkSchema,
    errors: ['INVALID_CREDENTIALS'],
    rateLimit: { max: 10, windowSec: 60 },
  }),
  switchWorkspace: route({
    method: 'POST',
    path: '/api/auth/switch-workspace',
    auth: 'session',
    feature: 1,
    tag: 'Auth',
    summary: 'Change the active workspace of the session',
    body: SwitchWorkspaceBodySchema,
    response: SessionInfoSchema,
  }),
} as const;

/* ============================== workspaces (feature 1) ============================== */

export const WorkspaceNameSchema = z.string().trim().min(1).max(60);

export const workspaceRoutes = {
  list: route({
    method: 'GET',
    path: '/api/workspaces',
    auth: 'session',
    feature: 1,
    tag: 'Workspaces',
    summary: 'Workspaces the user belongs to',
    response: listOf(WorkspaceWithRoleSchema),
  }),
  create: route({
    method: 'POST',
    path: '/api/workspaces',
    auth: 'session',
    feature: 1,
    tag: 'Workspaces',
    summary: 'Create a workspace (caller becomes owner)',
    body: z.object({ name: WorkspaceNameSchema }),
    response: WorkspaceWithRoleSchema,
    status: 201,
  }),
  current: route({
    method: 'GET',
    path: '/api/workspaces/current',
    auth: 'session',
    feature: 1,
    tag: 'Workspaces',
    summary: 'Active workspace with the caller role',
    response: WorkspaceWithRoleSchema,
  }),
  update: route({
    method: 'PATCH',
    path: '/api/workspaces/current',
    auth: 'session',
    minRole: 'admin',
    feature: 1,
    tag: 'Workspaces',
    summary: 'Rename the active workspace',
    body: z.object({ name: WorkspaceNameSchema }),
    response: WorkspaceSchema,
  }),
  remove: route({
    method: 'DELETE',
    path: '/api/workspaces/current',
    auth: 'session',
    minRole: 'owner',
    feature: 1,
    tag: 'Workspaces',
    summary: 'Delete the active workspace and all its content (not allowed for the last one)',
    response: OkSchema,
    errors: ['INVALID_STATE'],
  }),
} as const;

/* ============================== members & invites (feature 1) ============================== */

const memberParams = z.object({ memberId: idOf('member') });
const inviteParams = z.object({ inviteId: idOf('invite') });
/** Roles that can be granted through invites / role changes (ownership is transferred apart). */
export const AssignableRoleSchema = RoleSchema;

export const InviteLookupSchema = z.object({
  workspaceName: z.string(),
  email: z.email(),
  role: RoleSchema,
  expired: z.boolean(),
  accepted: z.boolean(),
});

export const memberRoutes = {
  list: route({
    method: 'GET',
    path: '/api/members',
    auth: 'session',
    feature: 1,
    tag: 'Members',
    summary: 'Members of the active workspace',
    response: listOf(MemberSchema),
  }),
  updateRole: route({
    method: 'PATCH',
    path: '/api/members/:memberId',
    auth: 'session',
    minRole: 'admin',
    feature: 1,
    tag: 'Members',
    summary:
      'Change a member role. Only owners can grant/revoke owner or admin; the last owner cannot be demoted',
    params: memberParams,
    body: z.object({ role: AssignableRoleSchema }),
    response: MemberSchema,
    errors: ['INVALID_STATE'],
  }),
  remove: route({
    method: 'DELETE',
    path: '/api/members/:memberId',
    auth: 'session',
    feature: 1,
    tag: 'Members',
    summary: 'Remove a member (admin+) or leave the workspace (self). The last owner cannot leave',
    params: memberParams,
    response: OkSchema,
    errors: ['INVALID_STATE'],
  }),
  listInvites: route({
    method: 'GET',
    path: '/api/invites',
    auth: 'session',
    minRole: 'admin',
    feature: 1,
    tag: 'Members',
    summary: 'Pending invitations',
    response: listOf(InviteSchema),
  }),
  createInvite: route({
    method: 'POST',
    path: '/api/invites',
    auth: 'session',
    minRole: 'admin',
    feature: 1,
    tag: 'Members',
    summary: 'Invite a person by e-mail. Returns the accept link (no e-mail is sent)',
    body: z.object({ email: EmailSchema, role: AssignableRoleSchema.default('editor') }),
    response: InviteCreatedSchema,
    status: 201,
    errors: ['PLAN_LIMIT_EXCEEDED', 'CONFLICT'],
  }),
  revokeInvite: route({
    method: 'DELETE',
    path: '/api/invites/:inviteId',
    auth: 'session',
    minRole: 'admin',
    feature: 1,
    tag: 'Members',
    summary: 'Revoke a pending invitation',
    params: inviteParams,
    response: OkSchema,
  }),
  lookupInvite: route({
    method: 'GET',
    path: '/api/invites/lookup/:token',
    auth: 'public',
    feature: 1,
    tag: 'Members',
    summary: 'Public details of an invitation (shown on the accept page)',
    params: z.object({ token: z.string().min(10).max(100) }),
    response: InviteLookupSchema,
    rateLimit: { max: 30, windowSec: 60 },
  }),
  acceptInvite: route({
    method: 'POST',
    path: '/api/invites/accept',
    auth: 'session',
    feature: 1,
    tag: 'Members',
    summary: 'Join the inviting workspace and make it the active one',
    body: z.object({ token: z.string().min(10).max(100) }),
    response: SessionInfoSchema,
    errors: ['INVALID_STATE', 'PLAN_LIMIT_EXCEEDED'],
  }),
} as const;

/* ============================== API keys (feature 9) ============================== */

export const apiKeyRoutes = {
  list: route({
    method: 'GET',
    path: '/api/api-keys',
    auth: 'session',
    minRole: 'admin',
    feature: 9,
    tag: 'API keys',
    summary: 'API keys of the workspace (secrets are never returned)',
    response: listOf(ApiKeySchema),
  }),
  create: route({
    method: 'POST',
    path: '/api/api-keys',
    auth: 'session',
    minRole: 'admin',
    feature: 9,
    tag: 'API keys',
    summary: 'Create an API key. The plain key is returned only in this response',
    body: z.object({ name: z.string().trim().min(1).max(60) }),
    response: ApiKeyCreatedSchema,
    status: 201,
    errors: ['PLAN_LIMIT_EXCEEDED'],
  }),
  revoke: route({
    method: 'DELETE',
    path: '/api/api-keys/:apiKeyId',
    auth: 'session',
    minRole: 'admin',
    feature: 9,
    tag: 'API keys',
    summary: 'Revoke an API key',
    params: z.object({ apiKeyId: idOf('apiKey') }),
    response: OkSchema,
  }),
} as const;

/* ============================== webhooks (feature 9) ============================== */

const webhookParams = z.object({ webhookId: idOf('webhookEndpoint') });
/** http(s) URL; private/loopback hosts are rejected server side with UNSAFE_URL (SSRF guard). */
export const WebhookUrlSchema = z.url({ protocol: /^https?$/ }).max(500);
const subscribableEvents = z
  .array(WebhookEventTypeSchema)
  .min(1)
  .max(10)
  .default(['video.completed', 'video.failed']);

export const webhookRoutes = {
  list: route({
    method: 'GET',
    path: '/api/webhooks',
    auth: 'session',
    minRole: 'admin',
    feature: 9,
    tag: 'Webhooks',
    summary: 'Webhook endpoints of the workspace',
    response: listOf(WebhookEndpointSchema),
  }),
  create: route({
    method: 'POST',
    path: '/api/webhooks',
    auth: 'session',
    minRole: 'admin',
    feature: 9,
    tag: 'Webhooks',
    summary: 'Register an endpoint. The signing secret is returned only in this response',
    body: z.object({
      url: WebhookUrlSchema,
      events: subscribableEvents,
      description: z.string().max(200).default(''),
    }),
    response: WebhookEndpointCreatedSchema,
    status: 201,
    errors: ['UNSAFE_URL', 'PLAN_LIMIT_EXCEEDED'],
  }),
  update: route({
    method: 'PATCH',
    path: '/api/webhooks/:webhookId',
    auth: 'session',
    minRole: 'admin',
    feature: 9,
    tag: 'Webhooks',
    summary: 'Update URL, events, description or enabled flag',
    params: webhookParams,
    body: z.object({
      url: WebhookUrlSchema.optional(),
      events: z.array(WebhookEventTypeSchema).min(1).max(10).optional(),
      description: z.string().max(200).optional(),
      enabled: z.boolean().optional(),
    }),
    response: WebhookEndpointSchema,
    errors: ['UNSAFE_URL'],
  }),
  remove: route({
    method: 'DELETE',
    path: '/api/webhooks/:webhookId',
    auth: 'session',
    minRole: 'admin',
    feature: 9,
    tag: 'Webhooks',
    summary: 'Delete an endpoint and its delivery history',
    params: webhookParams,
    response: OkSchema,
  }),
  rotateSecret: route({
    method: 'POST',
    path: '/api/webhooks/:webhookId/rotate-secret',
    auth: 'session',
    minRole: 'admin',
    feature: 9,
    tag: 'Webhooks',
    summary: 'Generate a new signing secret (returned once)',
    params: webhookParams,
    response: WebhookEndpointCreatedSchema,
  }),
  test: route({
    method: 'POST',
    path: '/api/webhooks/:webhookId/test',
    auth: 'session',
    minRole: 'admin',
    feature: 9,
    tag: 'Webhooks',
    summary: 'Queue a signed `ping` event to the endpoint',
    params: webhookParams,
    response: WebhookDeliverySchema,
    status: 202,
  }),
  listDeliveries: route({
    method: 'GET',
    path: '/api/webhooks/:webhookId/deliveries',
    auth: 'session',
    minRole: 'admin',
    feature: 9,
    tag: 'Webhooks',
    summary: 'Delivery attempts, newest first',
    params: webhookParams,
    query: PaginationQuerySchema,
    response: paginated(WebhookDeliverySchema),
  }),
  retryDelivery: route({
    method: 'POST',
    path: '/api/webhooks/deliveries/:deliveryId/retry',
    auth: 'session',
    minRole: 'admin',
    feature: 9,
    tag: 'Webhooks',
    summary: 'Re-queue a failed delivery',
    params: z.object({ deliveryId: idOf('webhookDelivery') }),
    response: WebhookDeliverySchema,
    status: 202,
    errors: ['INVALID_STATE'],
  }),
} as const;

/* ============================== billing & credits (feature 10) ============================== */

export const UsageSchema = z.object({
  storageBytes: z.number().int(),
  members: z.number().int(),
  photoAvatars: z.number().int(),
  clonedVoices: z.number().int(),
  apiKeys: z.number().int(),
  webhookEndpoints: z.number().int(),
  /** Credits spent in the last 30 days. */
  creditsSpent30d: z.number().int(),
  /** Videos rendered in the last 30 days. */
  renders30d: z.number().int(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const BillingOverviewSchema = z.object({
  plan: PlanSchema,
  plans: z.array(PlanSchema),
  credits: z.number().int(),
  limits: PlanLimitsSchema,
  usage: UsageSchema,
  /** Always true: payments are simulated in this product. The UI must say so. */
  simulated: z.literal(true),
});
export type BillingOverview = z.infer<typeof BillingOverviewSchema>;

export const BillingChangeResultSchema = z.object({
  workspace: WorkspaceSchema,
  entry: CreditLedgerEntrySchema.nullable(),
  simulated: z.literal(true),
});

export const billingRoutes = {
  overview: route({
    method: 'GET',
    path: '/api/billing',
    auth: 'session',
    feature: 10,
    tag: 'Billing',
    summary: 'Plan, limits, credit balance and usage of the workspace',
    response: BillingOverviewSchema,
  }),
  ledger: route({
    method: 'GET',
    path: '/api/billing/ledger',
    auth: 'session',
    feature: 10,
    tag: 'Billing',
    summary: 'Credit ledger, newest first',
    query: PaginationQuerySchema,
    response: paginated(CreditLedgerEntrySchema),
  }),
  changePlan: route({
    method: 'POST',
    path: '/api/billing/change-plan',
    auth: 'session',
    minRole: 'owner',
    feature: 10,
    tag: 'Billing',
    summary: 'Switch plan (simulated checkout). Upgrades grant the new plan monthly credits',
    body: z.object({ planId: PlanIdSchema }),
    response: BillingChangeResultSchema,
    errors: ['INVALID_STATE'],
  }),
  topUp: route({
    method: 'POST',
    path: '/api/billing/top-up',
    auth: 'session',
    minRole: 'owner',
    feature: 10,
    tag: 'Billing',
    summary: 'Buy a credit pack (simulated checkout)',
    body: z.object({ credits: z.union([z.literal(50), z.literal(200), z.literal(1000)]) }),
    response: BillingChangeResultSchema,
  }),
} as const;

/* ============================== consent (feature 14) ============================== */

export const CreateConsentBodySchema = z.object({
  kind: ConsentKindSchema,
  /** Full name of the person giving consent. */
  subjectName: z.string().trim().min(2).max(120),
  relationship: ConsentRelationshipSchema,
  /** Version of the statement shown to the user (CONSENT_STATEMENT_VERSION). */
  statementVersion: z.string().max(20),
  /** Language in which the statement was shown. */
  locale: UiLocaleSchema.default('es'),
  /** Must be literally `true`: the checkbox was ticked. */
  accepted: z.literal(true),
});

export const consentRoutes = {
  create: route({
    method: 'POST',
    path: '/api/consents',
    auth: 'session',
    minRole: 'editor',
    feature: 14,
    tag: 'Consent',
    summary:
      'Record an explicit consent declaration (stores user, date and IP). Required before creating a photo avatar or cloning a voice; each record can be used once',
    body: CreateConsentBodySchema,
    response: ConsentRecordSchema,
    status: 201,
  }),
  list: route({
    method: 'GET',
    path: '/api/consents',
    auth: 'session',
    minRole: 'admin',
    feature: 14,
    tag: 'Consent',
    summary: 'Consent records of the workspace, newest first',
    query: PaginationQuerySchema.extend({ kind: ConsentKindSchema.optional() }),
    response: paginated(ConsentRecordSchema),
  }),
  revoke: route({
    method: 'POST',
    path: '/api/consents/:consentId/revoke',
    auth: 'session',
    minRole: 'admin',
    feature: 14,
    tag: 'Consent',
    /**
     * Revoking removes EVERYTHING derived from the person, exactly like deleting the resource
     * (`DELETE /api/photo-avatars/:id` / `DELETE /api/voice-clones/:id`): the avatar or voice
     * row, its storage prefix (portrait, matte, cut-out, cached clips / sample.wav), the voice
     * at the external provider, and the SOURCE ASSET (photo / voice sample) with its file.
     * The consent record itself is kept, with `revokedAt` set, as the audit trail. Videos
     * already rendered are not deleted; compositions that still reference the avatar / voice
     * fail validation in `startRender` (UNPROCESSABLE) until edited.
     */
    summary:
      'Revoke a consent: the avatar/voice created with it, its files and the source photo/sample are deleted',
    params: z.object({ consentId: idOf('consent') }),
    response: ConsentRecordSchema,
  }),
} as const;
