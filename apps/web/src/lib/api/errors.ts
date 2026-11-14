import { ApiErrorBodySchema } from '@parlante/shared';
import type { ErrorCode, ValidationIssue } from '@parlante/shared';

/**
 * Codes produced by the client itself, next to the server `ErrorCode`s:
 *  - NETWORK_ERROR:     the request never got an HTTP answer (offline, DNS, CORS, API down)
 *  - ABORTED:           cancelled through an AbortSignal
 *  - INVALID_RESPONSE:  the server answered with something that is not the contract (HTML, …)
 */
export type ClientErrorCode = 'NETWORK_ERROR' | 'ABORTED' | 'INVALID_RESPONSE';
export type ApiErrorCode = ErrorCode | ClientErrorCode;

/**
 * The only error type thrown by the API client. Mirrors the single error shape of the API
 * (`{ error: { code, message, details? } }`) plus the HTTP status (0 when there was none).
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, status = 0, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** Field issues of a VALIDATION_ERROR (`details.issues`), empty otherwise. */
  get issues(): ValidationIssue[] {
    const issues = (this.details as { issues?: unknown } | undefined)?.issues;
    if (!Array.isArray(issues)) return [];
    return issues.filter(
      (i): i is ValidationIssue =>
        typeof i === 'object' &&
        i !== null &&
        typeof (i as ValidationIssue).path === 'string' &&
        typeof (i as ValidationIssue).message === 'string',
    );
  }

  /** `{ fieldPath: message }` for forms (first issue per path wins). */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const issue of this.issues) {
      if (!(issue.path in out)) out[issue.path] = issue.message;
    }
    return out;
  }

  is(...codes: ApiErrorCode[]): boolean {
    return codes.includes(this.code);
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Fallback code when an error answer does not carry the contract body (proxy pages, …). */
function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 402:
      return 'INSUFFICIENT_CREDITS';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 422:
      return 'UNPROCESSABLE';
    case 429:
      return 'RATE_LIMITED';
    case 501:
      return 'NOT_IMPLEMENTED';
    case 502:
    case 503:
    case 504:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL' : 'BAD_REQUEST';
  }
}

/** Build an ApiError from a non-2xx answer (`body` = parsed JSON, or undefined). */
export function errorFromResponse(status: number, body: unknown): ApiError {
  const parsed = ApiErrorBodySchema.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(code, message, status, details);
  }
  // Tolerate unknown codes from a newer API: keep the message, map the code by status.
  const loose = (body as { error?: { message?: unknown; details?: unknown } } | undefined)?.error;
  const message = typeof loose?.message === 'string' ? loose.message : `HTTP ${status}`;
  return new ApiError(codeForStatus(status), message, status, loose?.details);
}

/** Normalise anything thrown while calling the API into an ApiError. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new ApiError('ABORTED', 'Request aborted');
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new ApiError('ABORTED', 'Request aborted');
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError('NETWORK_ERROR', message || 'Network error');
}
