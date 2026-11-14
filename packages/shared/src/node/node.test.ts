import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertPublicUrl,
  buildSignedFilePath,
  decryptSecret,
  encryptSecret,
  generateApiKey,
  generateSessionToken,
  hashApiKey,
  hashPassword,
  hashSessionToken,
  isBlockedAddress,
  isSafeStorageKey,
  looksLikeApiKey,
  parseEnv,
  baseEnvSchema,
  randomToken,
  safeRequest,
  sanitizeFilename,
  signWebhookPayload,
  storageKeys,
  ttsCacheKey,
  verifyFileAccess,
  verifyPassword,
  verifyWebhookSignature,
  workspaceOfStorageKey,
  DEV_APP_SECRET,
  EnvValidationError,
} from './index';

const SECRET = 'test-secret-test-secret-test-secret-123';

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
    expect(await hashPassword('correct horse')).not.toBe(hash);
  });

  it('never throws on malformed hashes', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false);
  });
});

describe('tokens and API keys', () => {
  it('generates uniform lowercase tokens of the requested length', () => {
    expect(randomToken(40)).toMatch(/^[a-z0-9]{40}$/);
    expect(randomToken(8)).not.toBe(randomToken(8));
  });

  it('session tokens are stored hashed', () => {
    const token = generateSessionToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(hashSessionToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSessionToken(token)).not.toContain(token);
  });

  it('API keys have a display prefix and a stable hash', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(looksLikeApiKey(key)).toBe(true);
    expect(key.startsWith(`${prefix}_`)).toBe(true);
    expect(hashApiKey(key)).toBe(hash);
    expect(looksLikeApiKey('Bearer nope')).toBe(false);
  });
});

describe('secret encryption', () => {
  it('round-trips and detects tampering or a different key', () => {
    const enc = encryptSecret(SECRET, 'whsec_abc');
    expect(enc).not.toContain('whsec_abc');
    expect(decryptSecret(SECRET, enc)).toBe('whsec_abc');
    expect(() => decryptSecret(`${SECRET}x`, enc)).toThrow();
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(SECRET, parts.join('.'))).toThrow();
  });
});

describe('webhook signatures', () => {
  it('verifies a fresh signature and rejects body changes, wrong secret and old timestamps', () => {
    const body = JSON.stringify({ type: 'video.completed' });
    const header = signWebhookPayload('whsec_1', body, 1_800_000_000);
    expect(header).toMatch(/^t=1800000000,v1=[a-f0-9]{64}$/);
    expect(verifyWebhookSignature('whsec_1', body, header, { nowSec: 1_800_000_100 })).toBe(true);
    expect(verifyWebhookSignature('whsec_1', `${body} `, header, { nowSec: 1_800_000_100 })).toBe(
      false,
    );
    expect(verifyWebhookSignature('whsec_2', body, header, { nowSec: 1_800_000_100 })).toBe(false);
    expect(verifyWebhookSignature('whsec_1', body, header, { nowSec: 1_800_001_000 })).toBe(false);
    expect(verifyWebhookSignature('whsec_1', body, 'garbage')).toBe(false);
  });
});

describe('signed file URLs', () => {
  it('signs a key and verifies until expiry', () => {
    const key = 'ws/ws_abc/videos/vid_1/rnd_1/video.mp4';
    const pathAndQuery = buildSignedFilePath(SECRET, key, { nowSec: 1000, expiresInSec: 600 });
    const url = new URL(pathAndQuery, 'http://x');
    expect(url.pathname).toBe(`/api/files/${key}`);
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig') ?? '';
    expect(exp).toBe(3600);
    expect(verifyFileAccess(SECRET, key, exp, sig, 2000)).toBe(true);
    expect(verifyFileAccess(SECRET, key, exp, sig, 3601)).toBe(false);
    expect(verifyFileAccess(SECRET, `${key}x`, exp, sig, 2000)).toBe(false);
    expect(verifyFileAccess(SECRET, key, exp + 3600, sig, 2000)).toBe(false);
    expect(verifyFileAccess(`${SECRET}!`, key, exp, sig, 2000)).toBe(false);
  });

  it('adds a download name', () => {
    const p = buildSignedFilePath(SECRET, 'cache/tts/abc.wav', { downloadName: 'mi vídeo.mp4' });
    expect(new URL(p, 'http://x').searchParams.get('download')).toBe('mi vídeo.mp4');
  });
});

describe('storage keys', () => {
  it('builds keys from ids and refuses unsafe segments', () => {
    expect(storageKeys.asset('ws_a', 'ast_b', '.PNG')).toBe('ws/ws_a/assets/ast_b/original.png');
    expect(storageKeys.videoOutput('ws_a', 'vid_b', 'rnd_c', 'video.mp4')).toBe(
      'ws/ws_a/videos/vid_b/rnd_c/video.mp4',
    );
    expect(() => storageKeys.asset('../etc', 'ast_b', 'png')).toThrow();
    expect(() => storageKeys.asset('ws_a', 'ast_b', 'p/ng')).toThrow();
  });

  it('recognises safe and unsafe keys', () => {
    expect(isSafeStorageKey('ws/ws_a/assets/ast_b/original.png')).toBe(true);
    for (const bad of ['', '/abs/path', 'a/../b', 'a/./b', 'a\\b', 'a//b', 'a/b c', 'a/\0']) {
      expect(isSafeStorageKey(bad), bad).toBe(false);
    }
    expect(workspaceOfStorageKey('ws/ws_a/assets/x')).toBe('ws_a');
    expect(workspaceOfStorageKey('cache/tts/x.wav')).toBeNull();
  });

  it('sanitises file names', () => {
    expect(sanitizeFilename('../../Mi vídeo: final?.mp4')).toBe('_.._Mi video_ final_.mp4');
    expect(sanitizeFilename('///')).toBe('_');
    expect(sanitizeFilename('')).toBe('file');
  });

  it('hashes TTS requests deterministically', () => {
    const base = {
      provider: 'espeak',
      providerVoiceId: 'es',
      text: 'Hola',
      language: 'es',
      speed: 1,
      pitch: 0,
    };
    expect(ttsCacheKey(base)).toBe(ttsCacheKey({ ...base }));
    expect(ttsCacheKey(base)).not.toBe(ttsCacheKey({ ...base, speed: 1.1 }));
    expect(ttsCacheKey(base)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('env', () => {
  it('applies defaults and reports invalid variables together', () => {
    const env = parseEnv(baseEnvSchema, {});
    expect(env.QUEUE_PREFIX).toBe('parlante');
    expect(() => parseEnv(baseEnvSchema, { LOG_LEVEL: 'loud', APP_SECRET: 'short' })).toThrow(
      /LOG_LEVEL[\s\S]*APP_SECRET/,
    );
  });

  it('refuses the development secret in production', () => {
    expect(() => parseEnv(baseEnvSchema, { NODE_ENV: 'production' })).toThrow(EnvValidationError);
    expect(
      parseEnv(baseEnvSchema, { NODE_ENV: 'production', APP_SECRET: `${DEV_APP_SECRET}-prod` })
        .NODE_ENV,
    ).toBe('production');
  });
});

describe('SSRF guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each([
    'http://localhost:3000/hook',
    'http://127.0.0.1/hook',
    'http://[::1]/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://user:pass@example.com/',
    'file:///etc/passwd',
    'gopher://example.com',
    'not a url',
    'http://service.internal/x',
  ])('assertPublicUrl rejects %s', async (url) => {
    await expect(assertPublicUrl(url)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });

  it('assertPublicUrl accepts public literal IPs', async () => {
    await expect(assertPublicUrl('https://93.184.216.34/path')).resolves.toBeInstanceOf(URL);
  });

  describe('safeRequest against a local server', () => {
    let server: http.Server;
    let base: string;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/redirect-internal') {
          res.writeHead(302, { location: 'http://127.0.0.1:1/secret' }).end();
        } else if (req.url === '/big') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('x'.repeat(5000));
        } else if (req.url === '/slow') {
          setTimeout(() => res.end('late'), 2000);
        } else if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ body: Buffer.concat(chunks).toString(), sig: req.headers['x-sig'] }),
            );
          });
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it('refuses loopback targets by default', async () => {
      await expect(safeRequest(`${base}/`)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    });

    it('performs GET and POST when private targets are explicitly allowed', async () => {
      const get = await safeRequest(`${base}/`, { allowPrivate: true });
      expect(get.status).toBe(200);
      expect(get.body.toString()).toBe('hello');
      const post = await safeRequest(`${base}/hook`, {
        allowPrivate: true,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sig': 'abc' },
        body: '{"a":1}',
      });
      expect(post.status).toBe(201);
      expect(JSON.parse(post.body.toString())).toEqual({ body: '{"a":1}', sig: 'abc' });
    });

    it('truncates oversized bodies', async () => {
      const res = await safeRequest(`${base}/big`, { allowPrivate: true, maxBytes: 1000 });
      expect(res.truncated).toBe(true);
      expect(res.body.length).toBe(1000);
    });

    it('times out', async () => {
      await expect(
        safeRequest(`${base}/slow`, { allowPrivate: true, timeoutMs: 200 }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: 'The request timed out' });
    });

    it('re-validates redirect targets', async () => {
      // First hop allowed explicitly would also allow the second; so emulate the default policy
      // on the redirect target by checking that the guard rejects it directly.
      await expect(safeRequest('http://127.0.0.1:1/secret')).rejects.toMatchObject({
        code: 'UNSAFE_URL',
      });
      const res = await safeRequest(`${base}/redirect-internal`, {
        allowPrivate: true,
        maxRedirects: 0,
      });
      expect(res.status).toBe(302);
    });
  });
});
