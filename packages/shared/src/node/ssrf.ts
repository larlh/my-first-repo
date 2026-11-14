import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { AppError } from '../errors';

/* -------------------------------------------------------------------------------------------
 * SSRF guard for every outbound request to a user-supplied URL (webhook deliveries, "URL →
 * script"). Private, loopback, link-local, CGNAT, multicast and metadata addresses are blocked.
 * The check runs at CONNECTION time through a custom DNS lookup, so DNS rebinding and
 * redirects to internal hosts are blocked too.
 * ----------------------------------------------------------------------------------------- */

const blocked = new net.BlockList();
// IPv4
blocked.addSubnet('0.0.0.0', 8, 'ipv4');
blocked.addSubnet('10.0.0.0', 8, 'ipv4');
blocked.addSubnet('100.64.0.0', 10, 'ipv4');
blocked.addSubnet('127.0.0.0', 8, 'ipv4');
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('172.16.0.0', 12, 'ipv4');
blocked.addSubnet('192.0.0.0', 24, 'ipv4');
blocked.addSubnet('192.0.2.0', 24, 'ipv4');
blocked.addSubnet('192.168.0.0', 16, 'ipv4');
blocked.addSubnet('198.18.0.0', 15, 'ipv4');
blocked.addSubnet('198.51.100.0', 24, 'ipv4');
blocked.addSubnet('203.0.113.0', 24, 'ipv4');
blocked.addSubnet('224.0.0.0', 4, 'ipv4');
blocked.addSubnet('240.0.0.0', 4, 'ipv4');
// IPv6
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('64:ff9b::', 96, 'ipv6');

/** True for addresses that must never be reached from user-supplied URLs. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) → check the embedded IPv4.
    const mapped = /^::ffff:(.+)$/.exec(lower);
    if (mapped?.[1]) {
      const tail = mapped[1];
      if (net.isIP(tail) === 4) return blocked.check(tail, 'ipv4');
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
      if (hex?.[1] && hex[2]) {
        const hi = parseInt(hex[1], 16);
        const lo = parseInt(hex[2], 16);
        return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
      }
      return true;
    }
    return blocked.check(lower, 'ipv6');
  }
  return true; // not an IP at all
}

export interface UrlGuardOptions {
  /** Allow private/loopback targets (tests and explicit local development only). */
  allowPrivate?: boolean;
}

/**
 * Syntactic + DNS validation of a user-supplied URL. Throws AppError('UNSAFE_URL').
 * Use it when the URL is SAVED (e.g. creating a webhook endpoint) for early feedback; the
 * connection-time check in `safeRequest` is what actually enforces the policy.
 */
export async function assertPublicUrl(rawUrl: string, options: UrlGuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('UNSAFE_URL', 'The URL is not valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('UNSAFE_URL', 'Only http and https URLs are allowed');
  }
  if (url.username !== '' || url.password !== '') {
    throw new AppError('UNSAFE_URL', 'URLs with embedded credentials are not allowed');
  }
  if (options.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new AppError('UNSAFE_URL', 'The URL points to a private or local address');
  }
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new AppError('UNSAFE_URL', 'The URL points to a private or local address');
    }
    return url;
  }
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new AppError('UNSAFE_URL', 'The host of the URL could not be resolved');
  }
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
    throw new AppError('UNSAFE_URL', 'The URL points to a private or local address');
  }
  return url;
}

export interface SafeRequestOptions extends UrlGuardOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Whole-request timeout. Default 10 s. */
  timeoutMs?: number;
  /** Response bodies larger than this are truncated (`truncated: true`). Default 2 MiB. */
  maxBytes?: number;
  /** Redirects to follow (GET only; each hop is re-validated). Default 3; POST never follows. */
  maxRedirects?: number;
}

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  /** Final URL after redirects. */
  url: string;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/** DNS lookup that refuses blocked addresses — evaluated when the socket connects. */
function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', undefined);
      return;
    }
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      const blockedErr: NodeJS.ErrnoException = new Error(`Blocked address for host ${hostname}`);
      blockedErr.code = 'ESSRFBLOCKED';
      callback(blockedErr, '', undefined);
      return;
    }
    if (options.all) {
      callback(null, list);
    } else {
      const first = list[0] as dns.LookupAddress;
      callback(null, first.address, first.family);
    }
  });
}

function requestOnce(
  url: URL,
  options: SafeRequestOptions,
  deadline: number,
): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    const body =
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? Buffer.from(options.body, 'utf8')
          : Buffer.from(options.body);
    const headers: Record<string, string> = {
      'user-agent': 'Parlante/1.0',
      accept: '*/*',
      ...(options.headers ?? {}),
    };
    if (body) headers['content-length'] = String(body.length);
    const req = lib.request(
      url,
      {
        method: options.method ?? 'GET',
        headers,
        // The guard runs here, at connection time, unless private targets are allowed.
        ...(options.allowPrivate ? {} : { lookup: guardedLookup as unknown as net.LookupFunction }),
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
            res.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        const finish = () => {
          clearTimeout(timer);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            truncated,
            url: url.toString(),
          });
        };
        res.on('end', finish);
        res.on('error', (err) => {
          if (truncated) return;
          clearTimeout(timer);
          reject(err);
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })),
      Math.max(1, deadline - Date.now()),
    );
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * HTTP(S) request to a user-supplied URL with SSRF protection, timeout, response size cap and
 * validated redirects. Throws AppError('UNSAFE_URL') for blocked targets and
 * AppError('PROVIDER_ERROR') for network failures; HTTP error statuses are returned, not thrown.
 */
export async function safeRequest(
  rawUrl: string,
  options: SafeRequestOptions = {},
): Promise<SafeResponse> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  const method = options.method ?? 'GET';
  const maxRedirects = method === 'GET' ? (options.maxRedirects ?? 3) : 0;
  let current = rawUrl;
  for (let hop = 0; ; hop += 1) {
    const url = await assertPublicUrl(current, options);
    // Literal IPs never go through the lookup hook: assertPublicUrl has already checked them.
    let response: SafeResponse;
    try {
      response = await requestOnce(url, options, deadline);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESSRFBLOCKED') {
        throw new AppError('UNSAFE_URL', 'The URL points to a private or local address');
      }
      throw new AppError(
        'PROVIDER_ERROR',
        code === 'ETIMEDOUT' ? 'The request timed out' : 'The request failed',
        { reason: code ?? (err instanceof Error ? err.message : 'unknown') },
      );
    }
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location && hop < maxRedirects) {
      current = new URL(location, url).toString();
      continue;
    }
    return response;
  }
}
