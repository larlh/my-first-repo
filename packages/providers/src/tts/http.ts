import { AppError } from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * HTTP plumbing shared by the external speech adapters (ElevenLabs, OpenAI): every request has
 * a time limit, a bounded number of retries for transient failures and one error shape —
 * `AppError('PROVIDER_ERROR')` with the upstream status and message, never the API key.
 * ----------------------------------------------------------------------------------------- */

export type SpeechFetch = typeof fetch;

export interface SpeechHttpOptions {
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: SpeechFetch;
  /** Injected in tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Attempts per request, including the first one. Default 3. */
  maxAttempts?: number;
}

export interface SpeechRequest {
  /** Service name for error messages: "ElevenLabs", "OpenAI". */
  service: string;
  url: string;
  /** Built anew for every attempt (bodies cannot always be re-sent). */
  init: () => RequestInit;
  timeoutMs: number;
  /** Statuses that are an answer, not an error (e.g. 404 when deleting). */
  acceptStatus?: readonly number[];
}

const DEFAULT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 10_000;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524, 529]);

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryDelayMs(response: Response | null, attempt: number): number {
  const header = response?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
    }
  }
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

/** Best-effort extraction of the upstream error message and code from a JSON error body. */
function describeUpstream(body: string): { message: string | null; code: string | null } {
  try {
    const json: unknown = JSON.parse(body);
    if (json && typeof json === 'object') {
      const record = json as Record<string, unknown>;
      // OpenAI: { error: { message, type, code } }
      const error = record.error;
      if (error && typeof error === 'object') {
        const e = error as Record<string, unknown>;
        return {
          message: typeof e.message === 'string' ? e.message : null,
          code: typeof e.code === 'string' ? e.code : typeof e.type === 'string' ? e.type : null,
        };
      }
      // ElevenLabs: { detail: { status, message } } or { detail: "…" }
      const detail = record.detail;
      if (typeof detail === 'string') return { message: detail, code: null };
      if (detail && typeof detail === 'object') {
        const d = detail as Record<string, unknown>;
        return {
          message: typeof d.message === 'string' ? d.message : null,
          code: typeof d.status === 'string' ? d.status : null,
        };
      }
      if (typeof record.message === 'string') return { message: record.message, code: null };
    }
  } catch {
    // not JSON
  }
  const text = body.trim();
  return { message: text !== '' && text.length <= 300 ? text : null, code: null };
}

/** Turn a non-successful upstream response into the AppError every adapter throws. */
export async function upstreamError(
  service: string,
  response: Response,
  attempts = 1,
): Promise<AppError> {
  const body = await response.text().catch(() => '');
  const { message, code } = describeUpstream(body);
  const status = response.status;
  const reason =
    status === 401 || status === 403
      ? 'rejected the API key or the account lacks access'
      : status === 429
        ? 'rate limit or quota exceeded'
        : status >= 500
          ? 'is failing'
          : 'rejected the request';
  const detail = message ? `: ${message.slice(0, 300)}` : '';
  return new AppError('PROVIDER_ERROR', `${service} ${reason} (HTTP ${status})${detail}`, {
    service,
    status,
    ...(code ? { upstreamCode: code } : {}),
    attempts,
  });
}

/**
 * `fetch` with a per-attempt time limit and bounded retries (network errors, timeouts, 429 and
 * 5xx). Returns the successful response (or one whose status is in `acceptStatus`); throws
 * `AppError('PROVIDER_ERROR')` otherwise.
 */
export async function speechFetch(
  options: SpeechHttpOptions,
  request: SpeechRequest,
): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? realSleep;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_ATTEMPTS);
  for (let attempt = 1; ; attempt += 1) {
    let response: Response | null = null;
    let failure: unknown = null;
    try {
      response = await doFetch(request.url, {
        ...request.init(),
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (err) {
      failure = err;
    }
    if (response && (response.ok || request.acceptStatus?.includes(response.status))) {
      return response;
    }
    const retryable = response ? RETRYABLE.has(response.status) : true;
    if (retryable && attempt < maxAttempts) {
      // Free the connection; not awaited (a cancelled body may settle late, or never).
      void response?.body?.cancel().catch(() => undefined);
      await sleep(retryDelayMs(response, attempt));
      continue;
    }
    if (response) throw await upstreamError(request.service, response, attempt);
    const timedOut =
      failure instanceof Error &&
      (failure.name === 'TimeoutError' || failure.name === 'AbortError');
    throw new AppError(
      'PROVIDER_ERROR',
      timedOut
        ? `${request.service} did not answer within ${Math.round(request.timeoutMs / 1000)} s`
        : `${request.service} could not be reached`,
      { service: request.service, attempts: attempt, timeout: timedOut },
    );
  }
}

/** Parse a JSON response body, failing with PROVIDER_ERROR when it is not JSON. */
export async function readJson(service: string, response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new AppError('PROVIDER_ERROR', `${service} returned an unreadable response`, {
      service,
      status: response.status,
    });
  }
}
