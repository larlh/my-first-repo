import { AppError } from '@parlante/shared';
import type { Capability } from '@parlante/shared';

/**
 * Thrown by provider stubs that have not been implemented yet. It is an AppError with code
 * NOT_IMPLEMENTED (HTTP 501), so API and worker handle it like any other domain error.
 */
export class ProviderNotImplementedError extends AppError {
  readonly capability: Capability;
  readonly providerId: string;
  readonly method: string;

  constructor(capability: Capability, providerId: string, method: string) {
    super(
      'NOT_IMPLEMENTED',
      `Provider "${providerId}" (${capability}) does not implement ${method} yet`,
      { capability, providerId, method },
    );
    this.name = 'ProviderNotImplementedError';
    this.capability = capability;
    this.providerId = providerId;
    this.method = method;
  }
}

export function notImplemented(capability: Capability, providerId: string, method: string): never {
  throw new ProviderNotImplementedError(capability, providerId, method);
}

/** Thrown when an explicitly selected external provider lacks its key/endpoint. */
export function notConfigured(providerId: string, variable: string): AppError {
  return new AppError(
    'PROVIDER_NOT_CONFIGURED',
    `Provider "${providerId}" is selected but ${variable} is not set`,
    { providerId, variable },
  );
}
