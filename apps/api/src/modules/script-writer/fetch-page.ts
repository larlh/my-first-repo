import zlib from 'node:zlib';
import { AppError } from '@parlante/shared';
import { safeRequest } from '@parlante/shared/node';
import { extractReadableText, tidyPlainText } from './html-text';

/* -------------------------------------------------------------------------------------------
 * "URL → script": download a page chosen by the user and reduce it to readable text.
 *
 * The request goes through `safeRequest` (@parlante/shared/node), which is what enforces the
 * SSRF policy of master prompt §5: private, loopback, link-local and metadata addresses are
 * refused for literal IPs, for host names AT CONNECTION TIME (DNS rebinding) and for every
 * redirect hop. This file adds the limits: total time, response size, redirects, content type
 * and amount of text handed to the script writer.
 * ----------------------------------------------------------------------------------------- */

export const PAGE_LIMITS = {
  /** Whole request, redirects included. */
  timeoutMs: 8_000,
  /** Bytes read from the response; the rest of a longer page is ignored. */
  maxBytes: 1_500_000,
  maxRedirects: 3,
  /** Bytes accepted after decompression (a small gzip must not expand without bound). */
  maxDecodedBytes: 4_000_000,
  /** Characters of readable text passed on to the script writer. */
  maxTextChars: 20_000,
  /** Less text than this is not a readable article (login wall, page drawn by scripts…). */
  minTextChars: 80,
} as const;

export interface ReadablePage {
  /** Final URL after redirects. */
  url: string;
  title: string | null;
  text: string;
  /** True when the page was longer than the limits and only its beginning was read. */
  truncated: boolean;
}

export interface FetchPageOptions {
  /** `config.ALLOW_PRIVATE_URLS` — local development only. */
  allowPrivate?: boolean;
  /** Preferred language of the page (`Accept-Language`). */
  language?: string;
  /** Tighter limits than `PAGE_LIMITS` (tests). */
  limits?: { timeoutMs?: number; maxBytes?: number; maxTextChars?: number };
}

function unreadable(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: 'body.source.url', message }],
    ...details,
  });
}

function headerValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function decompress(body: Buffer, encoding: string): Buffer {
  const options = { maxOutputLength: PAGE_LIMITS.maxDecodedBytes };
  try {
    switch (encoding) {
      case '':
      case 'identity':
        return body;
      case 'gzip':
      case 'x-gzip':
        // SYNC_FLUSH: a body cut at `maxBytes` still yields what was received.
        return zlib.gunzipSync(body, { ...options, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      case 'deflate':
        return zlib.inflateSync(body, { ...options, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      case 'br':
        return zlib.brotliDecompressSync(body, {
          ...options,
          finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
        });
      default:
        throw unreadable('The page uses a compression this server cannot read', { encoding });
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw unreadable('The page is too large to read');
    }
    throw unreadable('The page could not be decoded');
  }
}

/** Charset of the response: header first, then a `<meta>` in the first bytes, then UTF-8. */
function detectCharset(contentType: string, body: Buffer): string {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  const head = body.subarray(0, 2048).toString('latin1');
  return /<meta[^>]{0,200}charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ?? 'utf-8';
}

function decodeText(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body); // unknown label
  }
}

/** Cut at the last sentence end before `max` characters. */
function clipText(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  const slice = text.slice(0, max);
  const lastStop = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('.\n'),
    slice.lastIndexOf('\n'),
  );
  return {
    text: (lastStop > max * 0.6 ? slice.slice(0, lastStop + 1) : slice).trim(),
    clipped: true,
  };
}

/**
 * Download `rawUrl` and return its readable text.
 *  - UNSAFE_URL        the URL (or a redirect, or what its host resolves to) is not public
 *  - PROVIDER_ERROR    the site could not be reached, timed out or answered with an error
 *  - VALIDATION_ERROR  the URL does not lead to a page with readable text
 */
export async function fetchReadablePage(
  rawUrl: string,
  options: FetchPageOptions = {},
): Promise<ReadablePage> {
  const limits = { ...PAGE_LIMITS, ...options.limits };
  const response = await safeRequest(rawUrl, {
    method: 'GET',
    timeoutMs: limits.timeoutMs,
    maxBytes: limits.maxBytes,
    maxRedirects: PAGE_LIMITS.maxRedirects,
    allowPrivate: options.allowPrivate ?? false,
    headers: {
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
      'accept-encoding': 'identity',
      'accept-language': options.language ? `${options.language},en;q=0.5` : 'en',
      'user-agent': 'ParlanteScriptWriter/1.0 (+page reader requested by a user)',
    },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new AppError('PROVIDER_ERROR', 'The page redirects too many times', {
      status: response.status,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new AppError(
      'PROVIDER_ERROR',
      `The site answered with an error (HTTP ${response.status})`,
      {
        status: response.status,
      },
    );
  }

  const contentType = headerValue(response.headers['content-type']).toLowerCase();
  const mime = contentType.split(';')[0]?.trim() ?? '';
  const body = decompress(
    response.body,
    headerValue(response.headers['content-encoding']).trim().toLowerCase(),
  );
  const isHtml = mime === 'text/html' || mime === 'application/xhtml+xml';
  const isPlain = mime === 'text/plain';
  // No declared type: accept it only when it starts like a document.
  const sniffedHtml =
    mime === '' &&
    /^\s*<(?:!doctype|html|head|body)/i.test(body.subarray(0, 512).toString('latin1'));
  if (!isHtml && !isPlain && !sniffedHtml) {
    throw unreadable('The URL does not point to a web page with text', { contentType: mime });
  }

  const decoded = decodeText(body, detectCharset(contentType, body));
  const page = isPlain
    ? { title: null, text: tidyPlainText(decoded) }
    : extractReadableText(decoded);
  if (page.text.length < PAGE_LIMITS.minTextChars) {
    throw unreadable(
      'No readable text was found on that page (it may need to log in or be drawn by scripts). Paste the text as the topic instead',
    );
  }
  const clipped = clipText(page.text, limits.maxTextChars);
  return {
    url: response.url,
    title: page.title,
    text: clipped.text,
    truncated: response.truncated || clipped.clipped,
  };
}
