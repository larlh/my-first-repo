import { z } from 'zod';

/**
 * Error codes shared by API, worker and web. The HTTP status for each code is fixed here so
 * every module answers consistently. Add new codes ADDITIVELY (never rename or reuse).
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  INVALID_API_KEY: 401,
  INSUFFICIENT_CREDITS: 402,
  FORBIDDEN: 403,
  PLAN_LIMIT_EXCEEDED: 403,
  CONSENT_REQUIRED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  EMAIL_TAKEN: 409,
  INVALID_STATE: 409,
  REVISION_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  CONTENT_BLOCKED: 422,
  TRANSCRIPT_REQUIRED: 422,
  UNSAFE_URL: 422,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
  PROVIDER_ERROR: 502,
  PROVIDER_NOT_CONFIGURED: 503,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ErrorCodeSchema = z.enum(
  Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]],
);

/** The single error body shape of the API: `{ error: { code, message, details? } }`. */
export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

/** One entry of `details.issues` for VALIDATION_ERROR. */
export const ValidationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

/**
 * Throw this anywhere (API handlers, services, worker jobs, providers). The API error handler
 * serialises it to the single error shape; the worker stores `{code, message}` on the failed row.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = details;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }

  static notFound(what = 'Resource'): AppError {
    return new AppError('NOT_FOUND', `${what} not found`);
  }
  static forbidden(message = 'You do not have permission to do this'): AppError {
    return new AppError('FORBIDDEN', message);
  }
  static unauthenticated(message = 'Authentication required'): AppError {
    return new AppError('UNAUTHENTICATED', message);
  }
  static validation(message: string, issues?: ValidationIssue[]): AppError {
    return new AppError('VALIDATION_ERROR', message, issues ? { issues } : undefined);
  }
  static conflict(message: string): AppError {
    return new AppError('CONFLICT', message);
  }
  static invalidState(message: string): AppError {
    return new AppError('INVALID_STATE', message);
  }
}

export function isAppError(err: unknown): err is AppError {
  return (
    err instanceof AppError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: unknown }).name === 'AppError' &&
      typeof (err as { code?: unknown }).code === 'string')
  );
}

/** Compact error stored on failed rows (videos, jobs, deliveries). */
export const StoredErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
});
export type StoredError = z.infer<typeof StoredErrorSchema>;

export function toStoredError(err: unknown): StoredError {
  if (isAppError(err)) return { code: err.code, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'INTERNAL', message: message.slice(0, 500) };
}
