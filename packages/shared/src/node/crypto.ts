import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { API_KEY_PREFIX } from '../entities';

/* ---------- generic ---------- */

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(secret: string, data: string | Uint8Array): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** Constant-time comparison of two strings (false when lengths differ). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const TOKEN_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Cryptographically random lowercase alphanumeric token. */
export function randomToken(length = 32): string {
  const out: string[] = [];
  // Rejection sampling keeps the distribution uniform (252 = 7 * 36).
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte < 252 && out.length < length) out.push(TOKEN_ALPHABET[byte % 36] ?? '0');
    }
  }
  return out.join('');
}

/* ---------- passwords (scrypt) ---------- */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, SCRYPT_KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Hash a password. Format: `scrypt$N$r$p$<salt b64>$<hash b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Verify a password against a stored hash in constant time. Never throws. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(
      password.normalize('NFKC'),
      Buffer.from(saltB64, 'base64'),
      Number(n),
      Number(r),
      Number(p),
    );
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/* ---------- session tokens ---------- */

/** New opaque session token (goes in the cookie). Only `hashSessionToken(token)` is stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}
export function hashSessionToken(token: string): string {
  return sha256Hex(token);
}

/* ---------- API keys ---------- */

export interface GeneratedApiKey {
  /** Full key, shown to the user once: `plk_<prefix>_<secret>`. */
  key: string;
  /** Display prefix stored in clear: `plk_<prefix>`. */
  prefix: string;
  /** SHA-256 of the full key (stored, unique). */
  hash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = `${API_KEY_PREFIX}_${randomToken(8)}`;
  const key = `${prefix}_${randomToken(32)}`;
  return { key, prefix, hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return sha256Hex(key);
}

export function looksLikeApiKey(value: string): boolean {
  return new RegExp(`^${API_KEY_PREFIX}_[a-z0-9]{8}_[a-z0-9]{32}$`).test(value);
}

/* ---------- secret encryption at rest (webhook signing secrets) ---------- */

function deriveKey(appSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', appSecret, 'parlante', purpose, 32));
}

/** AES-256-GCM. Output: `v1.<iv b64url>.<tag b64url>.<ciphertext b64url>`. */
export function encryptSecret(appSecret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(appSecret, 'secret-encryption'), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${data.toString('base64url')}`;
}

/** Inverse of `encryptSecret`. Throws when the value was tampered with or the key differs. */
export function decryptSecret(appSecret: string, encrypted: string): string {
  const [version, ivB64, tagB64, dataB64] = encrypted.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error('Invalid encrypted secret format');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(appSecret, 'secret-encryption'),
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/* ---------- webhook signatures ---------- */

export const WEBHOOK_SIGNATURE_HEADER = 'Parlante-Signature';
export const WEBHOOK_EVENT_HEADER = 'Parlante-Event';
export const WEBHOOK_DELIVERY_HEADER = 'Parlante-Delivery';
export const WEBHOOK_TOLERANCE_SEC = 300;

/** New webhook signing secret: `whsec_<32 chars>`. */
export function generateWebhookSecret(): string {
  return `whsec_${randomToken(32)}`;
}

/**
 * Signature header value: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>`.
 * Sign the exact bytes that are sent as the request body.
 */
export function signWebhookPayload(
  secret: string,
  rawBody: string,
  timestampSec: number = Math.floor(Date.now() / 1000),
): string {
  return `t=${timestampSec},v1=${hmacSha256Hex(secret, `${timestampSec}.${rawBody}`)}`;
}

/** Receiver-side verification (also used by tests and documented for API consumers). */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string,
  options: { toleranceSec?: number; nowSec?: number } = {},
): boolean {
  const parts = new Map(
    header.split(',').map((part) => {
      const idx = part.indexOf('=');
      return [part.slice(0, idx).trim(), part.slice(idx + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isFinite(t) || !v1) return false;
  const now = options.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSec ?? WEBHOOK_TOLERANCE_SEC;
  if (Math.abs(now - t) > tolerance) return false;
  return safeEqual(hmacSha256Hex(secret, `${t}.${rawBody}`), v1);
}

/* ---------- signed file URLs ---------- */

/** Signature for `/api/files/<key>?exp=<unix>&sig=<sig>`. */
export function signFileAccess(appSecret: string, key: string, expSec: number): string {
  return createHmac('sha256', deriveKey(appSecret, 'file-url'))
    .update(`${key}\n${expSec}`)
    .digest('base64url');
}

export function verifyFileAccess(
  appSecret: string,
  key: string,
  expSec: number,
  signature: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!Number.isFinite(expSec) || expSec < nowSec) return false;
  return safeEqual(signFileAccess(appSecret, key, expSec), signature);
}

/** Path + query (no origin) of a signed file URL. */
export function buildSignedFilePath(
  appSecret: string,
  key: string,
  options: { expiresInSec?: number; downloadName?: string; nowSec?: number } = {},
): string {
  const now = options.nowSec ?? Math.floor(Date.now() / 1000);
  // Round the expiry up to the hour so URLs stay stable (browser/CDN cache friendly).
  const ttl = options.expiresInSec ?? 6 * 3600;
  const exp = Math.ceil((now + ttl) / 3600) * 3600;
  const sig = signFileAccess(appSecret, key, exp);
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const download = options.downloadName
    ? `&download=${encodeURIComponent(options.downloadName)}`
    : '';
  return `/api/files/${encodedKey}?exp=${exp}&sig=${sig}${download}`;
}
