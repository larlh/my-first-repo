import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { ERROR_CODES, isAppError } from '@parlante/shared';
import type { ApiErrorBody, ErrorCode, ValidationIssue, AppError } from '@parlante/shared';

function body(code: ErrorCode, message: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

function send(reply: FastifyReply, code: ErrorCode, message: string, details?: unknown) {
  return reply.status(ERROR_CODES[code]).send(body(code, message, details));
}

/** Map a framework status code to one of our error codes. */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
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
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL' : 'BAD_REQUEST';
  }
}

/**
 * Converts EVERY failure into the single error shape `{ error: { code, message, details? } }`.
 *  - AppError                → its code/status
 *  - request validation      → 400 VALIDATION_ERROR with `details.issues[{path, message}]`
 *  - framework errors        → mapped by status (404, 413, 415, 429…)
 *  - anything else           → 500 INTERNAL (logged with the stack; no internals leak out)
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    return send(
      reply,
      'NOT_FOUND',
      `Route ${request.method} ${request.url.split('?')[0]} not found`,
    );
  });

  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    if (isAppError(error)) {
      if (error.status >= 500) request.log.error({ err: error }, 'request failed');
      return reply.status(error.status).send(error.toBody());
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues: ValidationIssue[] = error.validation.map((issue) => ({
        path: [error.validationContext, issue.instancePath.replace(/^\//, '').replace(/\//g, '.')]
          .filter((part) => part)
          .join('.'),
        message: issue.message ?? 'Invalid value',
      }));
      return send(reply, 'VALIDATION_ERROR', 'The request is not valid', { issues });
    }

    if (error instanceof ZodError) {
      const issues: ValidationIssue[] = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      return send(reply, 'VALIDATION_ERROR', 'The request is not valid', { issues });
    }

    if (isResponseSerializationError(error)) {
      // A handler returned data that does not match its response schema: a server bug.
      request.log.error(
        { err: error, issues: error.cause.issues },
        'response does not match schema',
      );
      return send(reply, 'INTERNAL', 'Internal server error');
    }

    const fastifyError = error as FastifyError;
    const status = fastifyError.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = codeForStatus(status);
      const message =
        code === 'PAYLOAD_TOO_LARGE'
          ? 'The request body is too large'
          : code === 'RATE_LIMITED'
            ? 'Too many requests, please slow down'
            : fastifyError.message;
      return send(reply, code, message);
    }

    request.log.error({ err: error }, 'unhandled error');
    return send(reply, 'INTERNAL', 'Internal server error');
  });
}
