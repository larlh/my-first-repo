import {
  ApiKeyCreatedSchema,
  ApiKeySchema,
  ConsentRecordSchema,
  CreditLedgerEntrySchema,
  InviteCreatedSchema,
  InviteSchema,
  MemberSchema,
  WebhookDeliverySchema,
  WebhookEndpointCreatedSchema,
  WebhookEndpointSchema,
  getConsentStatement,
} from '@parlante/shared';
import type {
  ApiKey,
  ApiKeyCreated,
  ConsentRecord,
  CreditLedgerEntry,
  Invite,
  InviteCreated,
  Member,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointCreated,
} from '@parlante/shared';
import { NOW, WS_A } from '../../videos/testing/harness';

/* Fixtures of the settings tests. Everything is parsed with the contract schemas, so a test
 * can never pass against a body the API would not send. */

/** The signed-in user of `makeSession()` in the shared harness. */
export const ME = { id: 'usr_a1b2c3d4e5f6g7h8', name: 'Lucía Ferrer', email: 'lucia@ejemplo.com' };

const pad = (n: number) => String(n).padStart(4, '0');

export function makeMember(n: number, overrides: Partial<Member> = {}): Member {
  return MemberSchema.parse({
    id: `mem_${pad(n)}abcdefgh1234`,
    workspaceId: WS_A,
    userId: `usr_${pad(n)}abcdefgh1234`,
    name: `Persona ${n}`,
    email: `persona${n}@ejemplo.com`,
    role: 'editor',
    createdAt: NOW,
    ...overrides,
  });
}

/** Lucía (the caller, with `role`) plus an admin, an editor and a viewer. */
export function makeTeam(role: Member['role'] = 'owner'): Member[] {
  return [
    makeMember(1, { userId: ME.id, name: ME.name, email: ME.email, role }),
    makeMember(2, { name: 'Marcos Vidal', email: 'marcos@ejemplo.com', role: 'admin' }),
    makeMember(3, { name: 'Irene Sanz', email: 'irene@ejemplo.com', role: 'editor' }),
    makeMember(4, { name: 'Pau Roca', email: 'pau@ejemplo.com', role: 'viewer' }),
  ];
}

export function makeInvite(n: number, overrides: Partial<Invite> = {}): Invite {
  return InviteSchema.parse({
    id: `inv_${pad(n)}abcdefgh1234`,
    workspaceId: WS_A,
    email: `invitada${n}@ejemplo.com`,
    role: 'editor',
    invitedBy: { id: ME.id, name: ME.name },
    expiresAt: '2099-01-01T00:00:00.000Z',
    acceptedAt: null,
    createdAt: NOW,
    ...overrides,
  });
}

export function makeInviteCreated(overrides: Partial<InviteCreated> = {}): InviteCreated {
  return InviteCreatedSchema.parse({
    ...makeInvite(9),
    token: 'tok_0123456789abcdefghij',
    acceptUrl: 'http://localhost:5173/invite/tok_0123456789abcdefghij',
    ...overrides,
  });
}

export function makeApiKey(n: number, overrides: Partial<ApiKey> = {}): ApiKey {
  return ApiKeySchema.parse({
    id: `key_${pad(n)}abcdefgh1234`,
    workspaceId: WS_A,
    name: `Clave ${n}`,
    prefix: `plk_ab12cd3${n}`,
    createdBy: { id: ME.id, name: ME.name },
    lastUsedAt: null,
    revokedAt: null,
    createdAt: NOW,
    ...overrides,
  });
}

export const PLAIN_KEY = 'plk_ab12cd39_0123456789abcdef0123456789abcdef';

export function makeApiKeyCreated(overrides: Partial<ApiKeyCreated> = {}): ApiKeyCreated {
  return ApiKeyCreatedSchema.parse({ ...makeApiKey(9), key: PLAIN_KEY, ...overrides });
}

export function makeEndpoint(n: number, overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return WebhookEndpointSchema.parse({
    id: `whe_${pad(n)}abcdefgh1234`,
    workspaceId: WS_A,
    url: `https://hooks.ejemplo.com/parlante/${n}`,
    description: '',
    events: ['video.completed', 'video.failed'],
    enabled: true,
    secretPreview: 'c0de',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

export const PLAIN_SECRET = 'whsec_0123456789abcdef0123456789abc0de';

export function makeEndpointCreated(
  overrides: Partial<WebhookEndpointCreated> = {},
): WebhookEndpointCreated {
  return WebhookEndpointCreatedSchema.parse({
    ...makeEndpoint(9),
    secret: PLAIN_SECRET,
    ...overrides,
  });
}

export function makeDelivery(n: number, overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return WebhookDeliverySchema.parse({
    id: `whd_${pad(n)}abcdefgh1234`,
    endpointId: 'whe_0001abcdefgh1234',
    eventId: `evt_${pad(n)}abcdefgh1234`,
    eventType: 'video.completed',
    status: 'succeeded',
    attempts: 1,
    responseStatus: 200,
    error: null,
    durationMs: 184,
    nextRetryAt: null,
    deliveredAt: NOW,
    createdAt: NOW,
    ...overrides,
  });
}

export function makeLedgerEntry(
  n: number,
  overrides: Partial<CreditLedgerEntry> = {},
): CreditLedgerEntry {
  return CreditLedgerEntrySchema.parse({
    id: `led_${pad(n)}abcdefgh1234`,
    workspaceId: WS_A,
    delta: -4,
    balanceAfter: 212,
    reason: 'render',
    refType: 'renderJob',
    refId: `rnd_${pad(n)}abcdefgh1234`,
    description: 'Render 720p',
    createdAt: NOW,
    ...overrides,
  });
}

export function makeConsent(n: number, overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  const kind = overrides.kind ?? 'photo_avatar';
  return ConsentRecordSchema.parse({
    id: `cns_${pad(n)}abcdefgh1234`,
    workspaceId: WS_A,
    user: { id: ME.id, name: ME.name },
    kind,
    subjectName: `Sujeto ${n}`,
    relationship: 'self',
    statementVersion: '2026-01',
    statement: getConsentStatement(kind)?.es ?? '',
    resourceId: kind === 'photo_avatar' ? `avt_${pad(n)}abcdefgh1234` : `vcl_${pad(n)}abcdefgh1234`,
    revokedAt: null,
    createdAt: NOW,
    ...overrides,
  });
}
