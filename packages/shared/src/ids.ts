import { customAlphabet } from 'nanoid';
import { z } from 'zod';

/**
 * Every persisted entity uses a prefixed, URL-safe, random id: `<prefix>_<16 chars>`.
 * The prefix makes ids self-describing in logs and API payloads.
 */
export const ID_PREFIXES = {
  user: 'usr',
  session: 'ses',
  workspace: 'ws',
  member: 'mem',
  invite: 'inv',
  avatar: 'avt',
  voice: 'vcl',
  video: 'vid',
  renderJob: 'rnd',
  asset: 'ast',
  template: 'tpl',
  brandKit: 'bk',
  apiKey: 'key',
  webhookEndpoint: 'whe',
  webhookDelivery: 'whd',
  translationJob: 'trj',
  translationOutput: 'tro',
  batchJob: 'bat',
  batchItem: 'bti',
  consent: 'cns',
  ledgerEntry: 'led',
  shareLink: 'shr',
  interactiveSession: 'ivs',
  interactiveMessage: 'ivm',
  scene: 'scn',
  layer: 'lyr',
  event: 'evt',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const generate = customAlphabet(ALPHABET, 16);

/** Create a new random id for the given entity kind, e.g. `newId('video')` → `vid_k2j4…`. */
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${generate()}`;
}

/** Generic id schema: accepts any non-empty, reasonably short, URL-safe token. */
export const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_\-:.]+$/, 'Invalid id');

/** Schema for an id of a specific kind (checks the prefix). */
export function idOf(kind: IdKind) {
  const prefix = ID_PREFIXES[kind];
  return z
    .string()
    .max(64)
    .regex(new RegExp(`^${prefix}_[a-z0-9]{8,32}$`), `Expected a ${prefix}_… id`);
}

/**
 * Stock avatars live in code (packages/renderer), not in the DB. Their ids are `stock_<slug>`.
 * Photo avatars are DB rows with `avt_…` ids. A Composition stores either form in `avatarId`.
 */
export const STOCK_AVATAR_PREFIX = 'stock_';
export const AvatarIdSchema = z
  .string()
  .max(64)
  .regex(/^(stock_[a-z0-9-]{1,40}|avt_[a-z0-9]{8,32})$/, 'Invalid avatar id');
export function isStockAvatarId(id: string): boolean {
  return id.startsWith(STOCK_AVATAR_PREFIX);
}

/**
 * Voice ids:
 *  - stock voice:  `<provider>:<providerVoiceId>`, e.g. `espeak:es-female-1`, `elevenlabs:21m00Tcm…`
 *  - cloned voice: `vcl_…` (DB row that stores provider + providerVoiceId + local profile)
 */
export const VoiceIdSchema = z
  .string()
  .max(120)
  .regex(/^([a-z0-9-]{2,24}:[A-Za-z0-9_\-.+]{1,80}|vcl_[a-z0-9]{8,32})$/, 'Invalid voice id');

export function isClonedVoiceId(id: string): boolean {
  return id.startsWith(`${ID_PREFIXES.voice}_`);
}

export function makeStockVoiceId(provider: string, providerVoiceId: string): string {
  return `${provider}:${providerVoiceId}`;
}

/** Split a stock voice id into provider and provider-specific id. Returns null for cloned ids. */
export function parseStockVoiceId(
  id: string,
): { provider: string; providerVoiceId: string } | null {
  if (isClonedVoiceId(id)) return null;
  const idx = id.indexOf(':');
  if (idx <= 0) return null;
  return { provider: id.slice(0, idx), providerVoiceId: id.slice(idx + 1) };
}
