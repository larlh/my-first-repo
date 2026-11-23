import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CREDIT_COSTS, api, isAppError } from '@parlante/shared';
import type { LLMProvider } from '@parlante/shared';
import { createTestApp } from '../../testing/index';
import type { TestApp } from '../../testing/index';
import { balanceOf, fakeLlm, ledgerOf } from '../interactive/test-doubles';
import type { FakeLlm } from '../interactive/test-doubles';
import { fetchReadablePage } from './fetch-page';
import { decodeEntities, extractReadableText } from './html-text';
import scriptWriterModule from './index';

/* -------------------------------------------------------------------------------------------
 * The LLM is the REAL local provider ("modo básico") unless a test installs the external
 * double. "URL → script" runs against a real HTTP server on an ephemeral loopback port and the
 * REAL SSRF guard of @parlante/shared/node.
 *
 * To exercise redirects and DNS rebinding end to end there has to be one address the guard
 * accepts as public: inside `asPublicInternet` (and only there) the guard's block list is told
 * that 127.0.0.1 is public. Every other address keeps its real verdict — in particular
 * 127.0.0.2, which Linux also routes to this machine, stays a blocked loopback address and
 * plays the part of "the internal network".
 * ----------------------------------------------------------------------------------------- */

const ARTICLE_SENTENCES = [
  'El compostaje doméstico convierte los restos de cocina en abono para las plantas.',
  'Basta un cubo ventilado, restos vegetales y un poco de paciencia para empezar.',
  'Conviene alternar capas húmedas, como las peladuras, con capas secas, como las hojas.',
  'En unos tres meses el material se transforma en una tierra oscura y sin olor.',
  'Ese abono mejora la estructura del suelo y reduce la basura que sale de casa.',
];

const ARTICLE_HTML = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<title>Gu&iacute;a de compostaje dom&eacute;stico &ndash; El Huerto</title>
<meta property="og:title" content="Gu&iacute;a de compostaje dom&eacute;stico">
<style>body { color: red; } .secreto-css { display: none; }</style>
<script>var secreto = "token-interno-js";</script>
</head><body>
<nav><a href="/">Inicio</a> <a href="/blog">Blog</a> <a href="/tienda">Tienda del huerto</a></nav>
<header><p>Suscríbete al boletín del huerto para recibir novedades cada semana.</p></header>
<article>
<h1>Guía de compostaje doméstico</h1>
${ARTICLE_SENTENCES.map((sentence) => `<p>${sentence}</p>`).join('\n')}
<script>trackPageView("no-debe-salir");</script>
</article>
<aside><p>Publicidad: compra ya la compostadora definitiva con un descuento increíble.</p></aside>
<footer><p>Copyright 2026 El Huerto. Todos los derechos reservados en este sitio.</p></footer>
</body></html>`;

interface Site {
  port: number;
  hits: Record<string, number>;
  close(): Promise<void>;
}

async function startSite(): Promise<Site> {
  const hits: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    hits[path] = (hits[path] ?? 0) + 1;
    const html = (body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    switch (path) {
      case '/article':
        return html(ARTICLE_HTML);
      case '/hop':
        res.writeHead(302, { location: '/article' });
        return res.end();
      case '/to-internal': {
        // A public page that redirects to an address of "the internal network".
        const port = (server.address() as AddressInfo).port;
        res.writeHead(302, { location: `http://127.0.0.2:${port}/secret` });
        return res.end();
      }
      case '/to-metadata':
        res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      case '/loop':
        res.writeHead(302, { location: '/loop' });
        return res.end();
      case '/secret':
        return html(
          '<html><body><article><p>Credenciales internas del servidor de administración: no deben salir nunca de aquí.</p></article></body></html>',
        );
      case '/missing':
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end(
          '<html><body><p>No existe la página que buscas en este sitio.</p></body></html>',
        );
      case '/image':
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case '/empty':
        return html(
          '<html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>',
        );
      case '/blocked':
        return html(
          '<html><body><article><p>Este artículo empieza con un párrafo de lo más corriente.</p><p>Después habla largo y tendido del término zzprohibido, que no debe pasar.</p></article></body></html>',
        );
      case '/latin1':
        res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
        return res.end(
          Buffer.from(
            '<html><head><title>Año de la piña</title></head><body><p>El año pasado la cosecha de piña en la región fue extraordinaria y creció muchísimo.</p></body></html>',
            'latin1',
          ),
        );
      case '/gzip':
        return html(zlib.gzipSync(Buffer.from(ARTICLE_HTML)), { 'content-encoding': 'gzip' });
      case '/big': {
        // ~6 MB of paragraphs: far beyond the byte limit and the text limit.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.write('<html><head><title>Página enorme</title></head><body><article>');
        let sent = 0;
        let count = 0;
        const pump = () => {
          while (sent < 6_000_000) {
            count += 1;
            const paragraph = `<p>Párrafo ${count}. ${ARTICLE_SENTENCES.join(' ')}</p>\n`;
            sent += paragraph.length;
            if (!res.write(paragraph)) {
              res.once('drain', pump);
              return;
            }
          }
          res.end('</article></body></html>');
        };
        res.on('error', () => undefined);
        pump();
        return undefined;
      }
      case '/slow':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<html><body><p>Empieza pero nunca termina');
        return undefined; // never ends
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Inside `fn`, the SSRF guard believes 127.0.0.1 (and only it) is a public address. */
async function asPublicInternet<T>(fn: () => Promise<T>): Promise<T> {
  const realCheck = net.BlockList.prototype.check;
  const spy = vi.spyOn(net.BlockList.prototype, 'check').mockImplementation(function (
    this: net.BlockList,
    address,
    family,
  ) {
    if (address === '127.0.0.1') return false;
    return realCheck.call(this, address as string, family as 'ipv4');
  });
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

/** Resolve test host names: `validation` answers the early check, `connection` the socket. */
function fakeDns(hosts: Record<string, { validation: string; connection: string }>) {
  const realLookup = dns.lookup;
  vi.spyOn(dns.promises, 'lookup').mockImplementation(((hostname: string) => {
    const entry = hosts[hostname];
    if (!entry) return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    return Promise.resolve([{ address: entry.validation, family: 4 }]);
  }) as unknown as typeof dns.promises.lookup);
  vi.spyOn(dns, 'lookup').mockImplementation(((
    hostname: string,
    options: unknown,
    callback: (err: Error | null, addresses: dns.LookupAddress[]) => void,
  ) => {
    const entry = hosts[hostname];
    if (!entry) {
      (realLookup as unknown as (h: string, o: unknown, c: unknown) => void)(
        hostname,
        options,
        callback,
      );
      return;
    }
    callback(null, [{ address: entry.connection, family: 4 }]);
  }) as unknown as typeof dns.lookup);
}

let t: TestApp;
let site: Site;
let localLlm: LLMProvider;

beforeAll(async () => {
  t = await createTestApp({
    modules: [scriptWriterModule],
    env: { MODERATION_EXTRA_BLOCKLIST: 'zzprohibido' },
  });
  localLlm = t.app.providers.llm;
  site = await startSite();
});
afterAll(async () => {
  await site.close();
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  t.app.providers.llm = localLlm;
  for (const key of Object.keys(site.hits)) delete site.hits[key];
});
afterEach(() => {
  vi.restoreAllMocks();
});

function useExternalLlm(): FakeLlm {
  const llm = fakeLlm();
  t.app.providers.llm = llm;
  return llm;
}

const topic = (text: string) => ({ kind: 'topic' as const, topic: text });
const url = (path: string, host = '127.0.0.1') => ({
  kind: 'url' as const,
  url: `http://${host}:${site.port}${path}`,
});

describe('POST /api/script-writer/generate — topic', () => {
  it('writes a script in basic mode for free and says so', async () => {
    const alice = await t.signUp();
    const before = await balanceOf(t, alice);
    const res = await t.call(api.scriptWriter.generate, {
      as: alice,
      body: {
        source: topic(
          'Ventajas del teletrabajo: menos desplazamientos, más concentración, mejor conciliación',
        ),
        tone: 'friendly',
        durationSec: 45,
        language: 'es',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.basicMode).toBe(true);
    expect(res.body.provider).toMatchObject({ id: 'local', quality: 'basic', local: true });
    expect(res.body.language).toBe('es');
    expect(res.body.sourceTitle).toBeNull();
    expect(res.body.title.length).toBeGreaterThan(0);
    expect(res.body.scenes.length).toBeGreaterThanOrEqual(2);
    for (const scene of res.body.scenes) {
      expect(scene.text.length).toBeGreaterThan(0);
      expect(scene.estimatedSec).toBeGreaterThan(0);
    }
    // The key points the user typed are what the scenes talk about.
    expect(
      res.body.scenes
        .map((scene) => scene.text)
        .join(' ')
        .toLowerCase(),
    ).toContain('concentración');
    // Basic mode costs nothing.
    expect(await balanceOf(t, alice)).toBe(before);
    expect((await ledgerOf(t, alice)).filter((entry) => entry.reason === 'script')).toEqual([]);
  });

  it('charges 1 credit only when an external LLM wrote the script', async () => {
    const llm = useExternalLlm();
    const alice = await t.signUp();
    const before = await balanceOf(t, alice);
    const res = await t.call(api.scriptWriter.generate, {
      as: alice,
      body: {
        source: topic('Cómo preparar una entrevista de trabajo'),
        tone: 'educational',
        durationSec: 90,
        language: 'en',
        sceneCount: 4,
        audience: 'recién graduados',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      basicMode: false,
      language: 'en',
      provider: { id: 'acme-llm', quality: 'premium', local: false },
    });
    expect(res.body.scenes).toHaveLength(4);
    expect(llm.scriptRequests).toEqual([
      {
        topic: 'Cómo preparar una entrevista de trabajo',
        tone: 'educational',
        durationSec: 90,
        language: 'en',
        sceneCount: 4,
        audience: 'recién graduados',
      },
    ]);
    expect(await balanceOf(t, alice)).toBe(before - CREDIT_COSTS.scriptPremium);
    const entries = (await ledgerOf(t, alice)).filter((entry) => entry.refType === 'script');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ delta: -1, reason: 'script', createdBy: alice.user.id });
  });

  it('refunds when the external LLM fails, answers in basic mode or its script is blocked', async () => {
    const llm = useExternalLlm();
    const alice = await t.signUp();
    const before = await balanceOf(t, alice);
    const body = { source: topic('Un tema cualquiera para el guion'), durationSec: 30 };

    llm.fail = new Error('upstream 529');
    const failed = await t.call(api.scriptWriter.generate, { as: alice, body });
    expect(failed.status).toBe(502);
    expect(failed.error).toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { provider: 'acme-llm' },
    });
    expect(await balanceOf(t, alice)).toBe(before);

    llm.fail = null;
    llm.nextScript = {
      basicMode: true,
      provider: { id: 'local', name: 'Modo básico (local)', quality: 'basic', local: true },
    };
    const fallback = await t.call(api.scriptWriter.generate, { as: alice, body });
    expect(fallback.status).toBe(200);
    expect(fallback.body.basicMode).toBe(true);
    expect(await balanceOf(t, alice)).toBe(before);

    llm.nextScript = {
      scenes: [
        { title: 'Uno', text: 'Compra zzprohibido ya.', headline: 'Oferta', estimatedSec: 5 },
      ],
    };
    const blocked = await t.call(api.scriptWriter.generate, { as: alice, body });
    expect(blocked.status).toBe(422);
    expect(blocked.error).toMatchObject({ code: 'CONTENT_BLOCKED', details: { stage: 'result' } });
    expect(await balanceOf(t, alice)).toBe(before);

    llm.nextScript = { scenes: [{ title: 'Vacía', text: '   ', headline: '', estimatedSec: 0 }] };
    const empty = await t.call(api.scriptWriter.generate, { as: alice, body });
    expect(empty.status).toBe(502);
    expect(await balanceOf(t, alice)).toBe(before);

    // Every reservation was given back: charges and refunds cancel out.
    const entries = (await ledgerOf(t, alice)).filter((entry) => entry.refType === 'script');
    expect(entries).toHaveLength(8);
    expect(entries.reduce((sum, entry) => sum + entry.delta, 0)).toBe(0);
  });

  it('answers 402 before calling the external LLM when there are no credits', async () => {
    const llm = useExternalLlm();
    const poor = await t.signUp({ credits: 0 });
    const res = await t.call(api.scriptWriter.generate, {
      as: poor,
      body: { source: topic('Un tema cualquiera') },
    });
    expect(res.status).toBe(402);
    expect(res.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(llm.scriptRequests).toHaveLength(0);

    // …but basic mode works with an empty balance.
    t.app.providers.llm = localLlm;
    expect(
      (
        await t.call(api.scriptWriter.generate, {
          as: poor,
          body: { source: topic('Un tema cualquiera') },
        })
      ).status,
    ).toBe(200);
  });

  it('moderates what the user supplies before any provider sees it', async () => {
    const llm = useExternalLlm();
    const alice = await t.signUp();
    const before = await balanceOf(t, alice);
    const badTopic = await t.call(api.scriptWriter.generate, {
      as: alice,
      body: { source: topic('Guion sobre zzprohibido') },
    });
    expect(badTopic.status).toBe(422);
    expect(badTopic.error).toMatchObject({ code: 'CONTENT_BLOCKED', details: { field: 'topic' } });
    const badAudience = await t.call(api.scriptWriter.generate, {
      as: alice,
      body: { source: topic('Un tema normal'), audience: 'fans de zzprohibido' },
    });
    expect(badAudience.error.details).toMatchObject({ field: 'audience' });
    expect(llm.scriptRequests).toHaveLength(0);
    expect(await balanceOf(t, alice)).toBe(before);
  });

  it('validates the body and applies the plan limits', async () => {
    const llm = useExternalLlm();
    const free = await t.signUp(); // free: 180 s, 10 scenes
    const call = (body: Record<string, unknown>, as = free) =>
      t.call(api.scriptWriter.generate, { as, body });

    expect((await call({ source: topic('ab') })).status).toBe(400);
    expect((await call({ source: topic('Tema válido'), durationSec: 5 })).status).toBe(400);
    expect((await call({ source: topic('Tema válido'), tone: 'sarcastic' })).status).toBe(400);
    expect((await call({ source: topic('Tema válido'), language: 'xx' })).status).toBe(400);
    expect((await call({ source: { kind: 'url', url: 'ftp://example.com/a.txt' } })).status).toBe(
      400,
    );
    expect((await call({ source: { kind: 'url', url: 'javascript:alert(1)' } })).status).toBe(400);
    expect((await call({})).status).toBe(400);

    const tooLong = await call({ source: topic('Tema válido'), durationSec: 300 });
    expect(tooLong.status).toBe(403);
    expect(tooLong.error).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      details: { limit: 'maxVideoDurationSec', max: 180, value: 300 },
    });
    const tooMany = await call({ source: topic('Tema válido'), sceneCount: 12 });
    expect(tooMany.error.details).toMatchObject({ limit: 'maxScenesPerVideo', max: 10, value: 12 });
    expect(llm.scriptRequests).toHaveLength(0);

    // A provider that returns more scenes than the plan renders: opening … closing are kept.
    llm.nextScript = {
      scenes: Array.from({ length: 12 }, (_, index) => ({
        title: `E${index + 1}`,
        text: `Texto ${index + 1}.`,
        headline: '',
        estimatedSec: 5,
      })),
    };
    const fitted = await call({ source: topic('Tema válido') });
    expect(fitted.status).toBe(200);
    expect(fitted.body.scenes.map((scene) => scene.title)).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
      'E5',
      'E6',
      'E7',
      'E8',
      'E9',
      'E12',
    ]);

    const creator = await t.signUp({ plan: 'creator' });
    llm.nextScript = null;
    expect(
      (await call({ source: topic('Tema válido'), durationSec: 300, sceneCount: 12 }, creator))
        .status,
    ).toBe(200);
  });

  it('requires a session and the editor role', async () => {
    const owner = await t.signUp();
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const editor = await t.addMember(owner.workspace, 'editor');
    const body = { source: topic('Un tema cualquiera') };
    expect((await t.call(api.scriptWriter.generate, { body })).status).toBe(401);
    expect((await t.call(api.scriptWriter.generate, { as: viewer, body })).status).toBe(403);
    expect((await t.call(api.scriptWriter.generate, { as: editor, body })).status).toBe(200);
  });
});

describe('POST /api/script-writer/generate — URL (SSRF guard, limits)', () => {
  it('refuses private, loopback, link-local and credentialed URLs without connecting', async () => {
    const llm = useExternalLlm();
    const alice = await t.signUp();
    const before = await balanceOf(t, alice);
    const targets = [
      `http://127.0.0.1:${site.port}/article`,
      `http://localhost:${site.port}/article`,
      `http://[::1]:${site.port}/article`,
      `http://[::ffff:127.0.0.1]:${site.port}/article`,
      `http://0.0.0.0:${site.port}/article`,
      `http://2130706433:${site.port}/article`, // 127.0.0.1 as a decimal integer
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://192.168.1.1/admin',
      'http://172.16.0.1/',
      'http://printer.internal/status',
      `http://user:secret@127.0.0.1:${site.port}/article`,
    ];
    for (const target of targets) {
      const res = await t.call(api.scriptWriter.generate, {
        as: alice,
        body: { source: { kind: 'url', url: target } },
      });
      expect(res.status, target).toBe(422);
      expect(res.error.code, target).toBe('UNSAFE_URL');
    }
    expect(site.hits).toEqual({});
    expect(llm.scriptRequests).toHaveLength(0);
    expect(await balanceOf(t, alice)).toBe(before);
  });

  it('reads a public page: article text only, title, and a basic-mode script built from it', async () => {
    const alice = await t.signUp();
    const res = await asPublicInternet(() =>
      t.call(api.scriptWriter.generate, {
        as: alice,
        body: { source: url('/article'), durationSec: 60, language: 'es' },
      }),
    );
    expect(res.status, res.raw.body).toBe(200);
    expect(res.body.sourceTitle).toBe('Guía de compostaje doméstico');
    expect(res.body.basicMode).toBe(true);
    expect(res.body.provider.id).toBe('local');
    // Basic mode summarises EXTRACTIVELY: the narration is made of sentences of the page.
    const narration = res.body.scenes.map((scene) => scene.text).join(' ');
    expect(ARTICLE_SENTENCES.some((sentence) => narration.includes(sentence))).toBe(true);
    expect(narration).not.toMatch(/token-interno|Publicidad|Copyright|Suscríbete/);
    expect(site.hits).toEqual({ '/article': 1 });
  });

  it('hands the LLM the readable text of the page and follows public redirects', async () => {
    const llm = useExternalLlm();
    const alice = await t.signUp();
    const res = await asPublicInternet(() =>
      t.call(api.scriptWriter.generate, { as: alice, body: { source: url('/hop') } }),
    );
    expect(res.status).toBe(200);
    expect(res.body.sourceTitle).toBe('Guía de compostaje doméstico');
    expect(site.hits).toEqual({ '/hop': 1, '/article': 1 });
    const request = llm.scriptRequests[0];
    expect(request?.topic).toBe('Guía de compostaje doméstico');
    expect(request?.sourceTitle).toBe('Guía de compostaje doméstico');
    expect(request?.sourceText?.split('\n')).toEqual(ARTICLE_SENTENCES);
  });

  it('blocks a redirect to an internal address (the internal page is never requested)', async () => {
    useExternalLlm();
    const alice = await t.signUp();
    const before = await balanceOf(t, alice);
    for (const path of ['/to-internal', '/to-metadata']) {
      const res = await asPublicInternet(() =>
        t.call(api.scriptWriter.generate, { as: alice, body: { source: url(path) } }),
      );
      expect(res.status, path).toBe(422);
      expect(res.error.code, path).toBe('UNSAFE_URL');
      expect(JSON.stringify(res.body)).not.toContain('Credenciales');
    }
    expect(site.hits).toEqual({ '/to-internal': 1, '/to-metadata': 1 });
    expect(await balanceOf(t, alice)).toBe(before);

    // Sanity: the internal page IS reachable when asked for directly without the guard…
    const direct = await fetchReadablePage(`http://127.0.0.2:${site.port}/secret`, {
      allowPrivate: true,
    });
    expect(direct.text).toContain('Credenciales internas');
    // …so what stopped the redirect above was the guard, not the network.
  });

  it('blocks host names that resolve to internal addresses, also when DNS changes its answer (rebinding)', async () => {
    useExternalLlm();
    const alice = await t.signUp();
    fakeDns({
      'intranet.test': { validation: '127.0.0.2', connection: '127.0.0.2' },
      'ten.test': { validation: '10.1.2.3', connection: '10.1.2.3' },
      // Public when the URL is validated, internal when the socket connects.
      'rebind.test': { validation: '127.0.0.1', connection: '127.0.0.2' },
      'public.test': { validation: '127.0.0.1', connection: '127.0.0.1' },
    });
    await asPublicInternet(async () => {
      for (const host of ['intranet.test', 'ten.test', 'rebind.test']) {
        const res = await t.call(api.scriptWriter.generate, {
          as: alice,
          body: { source: url('/secret', host) },
        });
        expect(res.status, host).toBe(422);
        expect(res.error.code, host).toBe('UNSAFE_URL');
      }
      expect(site.hits).toEqual({});
      // The same server through a host name that resolves to the "public" address works.
      const ok = await t.call(api.scriptWriter.generate, {
        as: alice,
        body: { source: url('/article', 'public.test') },
      });
      expect(ok.status).toBe(200);
      expect(site.hits).toEqual({ '/article': 1 });
    });
    const unresolved = await t.call(api.scriptWriter.generate, {
      as: alice,
      body: { source: url('/article', 'no-such-host.test') },
    });
    expect(unresolved.status).toBe(422);
    expect(unresolved.error.code).toBe('UNSAFE_URL');
  });

  it('reports sites that fail and pages without readable text', async () => {
    const llm = useExternalLlm();
    const alice = await t.signUp();
    const before = await balanceOf(t, alice);
    const call = (path: string) =>
      asPublicInternet(() =>
        t.call(api.scriptWriter.generate, { as: alice, body: { source: url(path) } }),
      );

    const missing = await call('/missing');
    expect(missing.status).toBe(502);
    expect(missing.error).toMatchObject({ code: 'PROVIDER_ERROR', details: { status: 404 } });
    const loop = await call('/loop');
    expect(loop.status).toBe(502);
    expect(site.hits['/loop']).toBe(4); // the first request + 3 redirects, then it gives up

    const image = await call('/image');
    expect(image.status).toBe(400);
    expect(image.error.details).toMatchObject({ contentType: 'image/png' });
    const empty = await call('/empty');
    expect(empty.status).toBe(400);
    expect(empty.error.message).toContain('No readable text');

    const blocked = await call('/blocked');
    expect(blocked.status).toBe(422);
    expect(blocked.error).toMatchObject({
      code: 'CONTENT_BLOCKED',
      details: { field: 'source.url' },
    });

    expect(llm.scriptRequests).toHaveLength(0);
    expect(await balanceOf(t, alice)).toBe(before);
  });

  it('bounds the size of what is read from a huge page', async () => {
    const llm = useExternalLlm();
    const alice = await t.signUp();
    const started = Date.now();
    const res = await asPublicInternet(() =>
      t.call(api.scriptWriter.generate, { as: alice, body: { source: url('/big') } }),
    );
    expect(res.status).toBe(200);
    expect(res.body.sourceTitle).toBe('Página enorme');
    const text = llm.scriptRequests[0]?.sourceText ?? '';
    expect(text.length).toBeGreaterThan(10_000);
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('fetchReadablePage (limits and decoding)', () => {
  const page = (path: string) => `http://127.0.0.1:${site.port}${path}`;

  it('stops reading at the byte limit and marks the page as truncated', async () => {
    const result = await fetchReadablePage(page('/big'), {
      allowPrivate: true,
      limits: { maxBytes: 50_000, maxTextChars: 3_000 },
    });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(3_000);
    expect(result.text.endsWith('.')).toBe(true);
  });

  it('gives up on a site that does not finish answering in time', async () => {
    const started = Date.now();
    const error = await fetchReadablePage(page('/slow'), {
      allowPrivate: true,
      limits: { timeoutMs: 300 },
    }).catch((err: unknown) => err);
    expect(isAppError(error) && error.code).toBe('PROVIDER_ERROR');
    expect((error as Error).message).toBe('The request timed out');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('decodes the declared charset and compressed bodies', async () => {
    const latin = await fetchReadablePage(page('/latin1'), { allowPrivate: true });
    expect(latin.title).toBe('Año de la piña');
    expect(latin.text).toContain('la cosecha de piña en la región');
    const gzip = await fetchReadablePage(page('/gzip'), { allowPrivate: true });
    expect(gzip.text.split('\n')).toEqual(ARTICLE_SENTENCES);
  });

  it('is refused for loopback unless private targets are explicitly allowed', async () => {
    const error = await fetchReadablePage(page('/article')).catch((err: unknown) => err);
    expect(isAppError(error) && error.code).toBe('UNSAFE_URL');
  });
});

describe('extractReadableText', () => {
  it('keeps prose and drops scripts, styles, comments and page chrome', () => {
    const page = extractReadableText(ARTICLE_HTML);
    expect(page.title).toBe('Guía de compostaje doméstico');
    expect(page.text.split('\n')).toEqual(ARTICLE_SENTENCES);
    const plain = extractReadableText(
      '<p>Tom &amp; Jerry dijeron &laquo;hola&raquo; &#8212; y 2 &lt; 3 siempre, &#xE9;so es todo.</p><!-- <p>comentario oculto que no debe salir nunca</p> -->',
    );
    expect(plain.text).toBe('Tom & Jerry dijeron «hola» — y 2 < 3 siempre, éso es todo.');
    expect(decodeEntities('&nbsp;&noexiste;&#0;&#x110000;')).toBe(' &noexiste;  ');
  });

  it('falls back to the whole body, to <title> and to <h1>', () => {
    const noArticle = extractReadableText(
      '<html><head><title>Solo título</title></head><body><div><p>Este párrafo vive en un div normal y corriente de la página.</p></div></body></html>',
    );
    expect(noArticle).toEqual({
      title: 'Solo título',
      text: 'Este párrafo vive en un div normal y corriente de la página.',
    });
    const h1Only = extractReadableText(
      '<h1>Encabezado <em>principal</em></h1><p>Una frase suficientemente larga para contar como texto.</p>',
    );
    expect(h1Only.title).toBe('Encabezado principal');
    // An unclosed <nav> must not swallow the page.
    const broken = extractReadableText(
      `<body><nav><a>Inicio</a><div>${'<p>Contenido real de la página que queda dentro de una etiqueta sin cerrar.</p>'.repeat(4)}</div></body>`,
    );
    expect(broken.text).toContain('Contenido real de la página');
  });

  it('runs in linear time on hostile markup', () => {
    const hostile = [
      '<script'.repeat(200_000),
      '<!--'.repeat(200_000),
      '<'.repeat(400_000),
      '<a '.repeat(200_000),
      `<div>${'<nav>'.repeat(100_000)}texto`,
      '&#'.repeat(300_000),
      `<title>${'x'.repeat(1_000_000)}`,
    ];
    const started = Date.now();
    for (const html of hostile) extractReadableText(html);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
