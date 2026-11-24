import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { api, route } from '@parlante/shared';
import { redactUrl } from '../app';
import { defineRoute } from '../lib/define-route';
import { defineModule } from '../lib/modules';
import { pngBytes } from '../modules/assets/test-fixtures';
import authModule from '../modules/auth/index';
import { downloadFilename } from '../plugins/core-routes';
import { createTestApp } from '../testing/index';
import type { TestActor, TestApp } from '../testing/index';

/* -------------------------------------------------------------------------------------------
 * Regression tests of the phase-3 security review (docs/SECURITY.md): one block per finding
 * that lives in the API. Workspace isolation has its own file (`isolation.test.ts`).
 * ----------------------------------------------------------------------------------------- */

const brokenDownload = route({
  method: 'GET',
  path: '/api/test/broken-download',
  auth: 'public',
  feature: 0,
  tag: 'Test',
  summary: 'A download whose stream dies after the first bytes',
  response: z.unknown(),
  binary: true,
});

let t: TestApp;
let sends = 0;

const probes = defineModule({
  name: 'security-probes',
  register(app) {
    app.addHook('onSend', async (request, _reply, payload) => {
      if (request.url.startsWith(brokenDownload.path)) sends += 1;
      return payload;
    });
    defineRoute(app, brokenDownload, async ({ reply }) => {
      async function* body() {
        yield Buffer.from('first bytes');
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('the client went away');
      }
      return reply.header('content-type', 'application/octet-stream').send(Readable.from(body()));
    });
  },
});

beforeAll(async () => {
  t = await createTestApp({ extraModules: [probes] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  sends = 0;
});

const WEB = 'http://web.test';
const EVIL = 'https://evil.example';

describe('CSRF: Origin is checked on every cookie route, public ones included', () => {
  it('refuses login and register from an unknown origin (login CSRF)', async () => {
    const account = await t.signUp();
    const credentials = { email: account.user.email, password: account.password };
    const login = (origin?: string) =>
      t.call(api.auth.login, { body: credentials, headers: origin ? { origin } : {} });

    const foreign = await login(EVIL);
    expect(foreign.status).toBe(403);
    expect(foreign.headers['set-cookie']).toBeUndefined();
    expect((await login('null')).status).toBe(403);
    expect((await login(`${WEB}.evil.example`)).status).toBe(403);
    // The web app itself, and clients that send no Origin (curl, servers), still sign in.
    expect((await login(WEB)).status).toBe(200);
    expect((await login()).status).toBe(200);

    const register = await t.call(api.auth.register, {
      body: { email: 'e2e-csrf@example.test', password: 'Una-clave-larga-1', name: 'X' },
      headers: { origin: EVIL },
    });
    expect(register.status).toBe(403);
    expect(register.headers['set-cookie']).toBeUndefined();
  });

  it('does not apply to API keys, which are not ambient credentials', async () => {
    const account = await t.signUp();
    const key = await t.apiKeyFor(account.workspace);
    const res = await t.call(api.v1.me, {
      as: key,
      headers: { origin: 'https://cliente.example' },
    });
    expect(res.status).toBe(200);
  });
});

describe('sessions', () => {
  it('rotates the session at login, ignores planted cookies and ends it at logout', async () => {
    const account = await t.signUp();
    const body = { email: account.user.email, password: account.password };
    const cookieOf = (res: { headers: Record<string, unknown> }) =>
      String(res.headers['set-cookie']).split(';')[0] ?? '';

    const first = await t.call(api.auth.login, { body });
    const firstCookie = cookieOf(first);
    // Signing in again while presenting the old cookie replaces it and kills the old session.
    const second = await t.call(api.auth.login, { body, headers: { cookie: firstCookie } });
    const secondCookie = cookieOf(second);
    expect(secondCookie).not.toBe(firstCookie);
    const me = (cookie: string) => t.call(api.auth.me, { headers: { cookie } });
    expect((await me(firstCookie)).status).toBe(401);
    expect((await me(secondCookie)).status).toBe(200);

    // A cookie value chosen by an attacker never becomes a session (fixation).
    const planted = `${t.config.SESSION_COOKIE_NAME}=${'A'.repeat(43)}`;
    const third = await t.call(api.auth.login, { body, headers: { cookie: planted } });
    expect(third.status).toBe(200);
    expect((await me(planted)).status).toBe(401);

    const flags = String(second.headers['set-cookie']);
    expect(flags).toMatch(/HttpOnly/i);
    expect(flags).toMatch(/SameSite=Lax/i);
    expect(flags).toMatch(/Path=\//i);

    expect(
      (await t.call(api.auth.logout, { headers: { cookie: secondCookie, origin: WEB } })).status,
    ).toBe(200);
    expect((await me(secondCookie)).status).toBe(401);
  });

  it('marks the cookie Secure in production', async () => {
    const app = await createTestApp({
      modules: [authModule],
      env: { NODE_ENV: 'production', APP_SECRET: 'rT9_kq2ZxV7mB4nLw8HcY1dPf6sJa3Ge0uQiOoXzNtE' },
    });
    try {
      const account = await app.signUp();
      const res = await app.call(api.auth.login, {
        body: { email: account.user.email, password: account.password },
      });
      expect(res.status).toBe(200);
      expect(String(res.headers['set-cookie'])).toMatch(/; Secure/i);
      expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/i);
    } finally {
      await app.close();
    }
  });
});

describe('uploads and stored files', () => {
  const upload = (as: TestActor, data: Buffer, filename: string, contentType: string) =>
    t.call(api.assets.upload, { as, multipart: { filename, contentType, data } });

  it('decides the type from the bytes: HTML, SVG and playlists are refused whatever they claim', async () => {
    const owner = await t.signUp();
    const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0, 0, 0, 0]);
    const playlist = Buffer.from(
      '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nhttp://127.0.0.1:4000/internal.mp3\n#EXT-X-ENDLIST\n',
    );
    const hostile: [string, Buffer, string, string][] = [
      ['html as png', Buffer.from('<html><script>alert(1)</script></html>'), 'a.png', 'image/png'],
      [
        'svg',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
        'a.svg',
        'image/svg+xml',
      ],
      [
        'svg as png',
        Buffer.from('<?xml version="1.0"?><svg onload="alert(1)"/>'),
        'a.png',
        'image/png',
      ],
      ['hls playlist', playlist, 'a.mp3', 'audio/mpeg'],
      // An ID3 tag in front of a playlist: "looks like MP3" to a naive sniffer, HLS to ffmpeg.
      ['id3 + hls playlist', Buffer.concat([id3, playlist]), 'a.mp3', 'audio/mpeg'],
      [
        'ffconcat script',
        Buffer.from("ffconcat version 1.0\nfile '/etc/passwd'\n"),
        'a.mp4',
        'video/mp4',
      ],
      [
        'gif header + html',
        Buffer.from('GIF89a<html><script>alert(1)</script>'),
        'a.gif',
        'image/gif',
      ],
    ];
    for (const [label, data, filename, contentType] of hostile) {
      const res = await upload(owner, data, filename, contentType);
      expect([400, 415], `${label} → ${res.status}`).toContain(res.status);
    }
    expect((await t.call(api.assets.list, { as: owner })).body.items).toEqual([]);
  });

  it('serves a picture with trailing HTML as a picture that cannot run: type, nosniff, sandbox', async () => {
    const owner = await t.signUp();
    const polyglot = Buffer.concat([
      pngBytes(),
      Buffer.from('<html><script>alert(document.domain)</script></html>'),
    ]);
    // The client lies about everything: name with a path and an .html extension, HTML type.
    const res = await upload(owner, polyglot, '../../etc/x.html', 'text/html');
    expect(res.status).toBe(201);
    expect(res.body.mimeType).toBe('image/png');
    expect(res.body.name).not.toMatch(/[\\/]/);
    const url = new URL(res.body.url);
    // The storage key comes from the server and the DETECTED type, never from the file name.
    expect(url.pathname).toMatch(/\/assets\/ast_[a-z0-9]+\/original\.png$/);

    const file = await t.inject({ method: 'GET', url: url.pathname + url.search });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(file.headers['content-disposition']).toBeUndefined();

    // `download` is not signed: it may rename the file but never change what it is.
    const renamed = await t.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}&download=factura.html`,
    });
    expect(renamed.headers['content-disposition']).toBe('attachment; filename="factura.html.png"');
    expect(renamed.headers['content-type']).toBe('image/png');
    const injected = await t.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}&download=${encodeURIComponent("a\"; filename*=UTF-8''x.exe\r\nSet-Cookie: a=b")}`,
    });
    expect(injected.statusCode).toBe(200);
    expect(injected.headers['set-cookie']).toBeUndefined();
    expect(String(injected.headers['content-disposition'])).toMatch(
      /^attachment; filename="[A-Za-z0-9 ._-]+\.png"$/,
    );
  });

  it('keeps the extension of the stored object in every download name', () => {
    const key = 'ws/ws_1/videos/vid_1/rnd_1/video.mp4';
    expect(downloadFilename('Mi vídeo.mp4', key)).toBe('Mi video.mp4');
    expect(downloadFilename('Mi vídeo.MP4', key)).toBe('Mi video.MP4');
    expect(downloadFilename('setup.exe', key)).toBe('setup.exe.mp4');
    expect(downloadFilename('page.html', 'ws/ws_1/assets/ast_1/original.png')).toBe(
      'page.html.png',
    );
    expect(downloadFilename(' .. ', key)).toBe('download.mp4');
    expect(downloadFilename('notes', 'cache/tts/abc')).toBe('notes');
  });

  it('does not send a second response when a download dies half-way', async () => {
    // What a video player does on every seek: the stream ends early, the headers are gone.
    const res = await t.inject({ method: 'GET', url: brokenDownload.path }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Exactly one response was started for the request (a second `send` would run onSend again
    // and fail with ERR_HTTP_HEADERS_SENT, which used to be logged as an unhandled error).
    expect(sends).toBe(1);
    if (res) expect(res.statusCode).toBe(200);
    // The server is still healthy afterwards.
    expect((await t.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});

describe('logs', () => {
  it('masks signatures and tokens in logged URLs', () => {
    expect(
      redactUrl(
        '/api/files/ws/ws_1/a/original.png?exp=1795546800&sig=COSB9CPvFYg5Uhxxh-lq&download=x.png',
      ),
    ).toBe('/api/files/ws/ws_1/a/original.png?exp=1795546800&sig=[redacted]&download=x.png');
    expect(redactUrl('/api/invites/lookup/abcdefghijklmnopqrstuvwxyz0123456789abcd')).toBe(
      '/api/invites/lookup/[redacted]',
    );
    expect(redactUrl('/api/public/shares/abcdefghijklmnopqrstuvwx?x=1')).toBe(
      '/api/public/shares/[redacted]?x=1',
    );
    expect(redactUrl('/x?token=abc&y=2&SIG=zzz')).toBe('/x?token=[redacted]&y=2&SIG=[redacted]');
    // Nothing else changes.
    expect(redactUrl('/api/videos?limit=5&q=signo')).toBe('/api/videos?limit=5&q=signo');
  });
});

describe('SSRF: addresses that hide a private IPv4 inside IPv6', () => {
  it('refuses them as webhook targets', async () => {
    const owner = await t.signUp();
    const targets = [
      'http://[::127.0.0.1]:4000/',
      'http://[::7f00:1]/',
      'http://[2002:7f00:1::]/',
      'http://[2002:a00:1::1]/',
      'http://[64:ff9b:1::7f00:1]/',
      'http://[2001:0:7f00:1::]/',
      'http://[fec0::1]/',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
    ];
    for (const url of targets) {
      const res = await t.call(api.webhooks.create, { as: owner, body: { url } });
      expect(res.status, url).toBe(422);
      expect(res.error.code, url).toBe('UNSAFE_URL');
    }
    expect((await t.call(api.webhooks.list, { as: owner })).body.items).toEqual([]);
  });
});

describe('security headers', () => {
  it('sends them on JSON, on errors and on unknown routes', async () => {
    for (const url of ['/health', '/api/videos', '/api/nope/<script>alert(1)</script>']) {
      const res = await t.inject({ method: 'GET', url });
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(String(res.headers['content-security-policy']), url).toContain("default-src 'none'");
      expect(String(res.headers['content-security-policy']), url).toContain(
        "frame-ancestors 'none'",
      );
      expect(res.headers['referrer-policy'], url).toBe('no-referrer');
      expect(String(res.headers['strict-transport-security']), url).toContain('max-age=');
      expect(String(res.headers['content-type']), url).toContain('application/json');
      expect(res.headers['x-powered-by'], url).toBeUndefined();
    }
    // An error never carries a stack or a path of the server.
    const broken = await t.inject({
      method: 'POST',
      url: api.auth.login.path,
      headers: { 'content-type': 'application/json' },
      payload: '{bad json',
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.body).not.toMatch(/node_modules|\/src\/|\.ts:|at Object\./);
  });
});
