/* Why creating a photo avatar or cloning a voice failed, in terms a page can explain and act
 * on (start the engine, buy credits, renew the consent…). Derived from the API error code. */

export type CreationFailure =
  | 'consent'
  | 'credits'
  | 'limit'
  | 'blocked'
  | 'engine'
  | 'notConfigured'
  | 'sourceInUse'
  | 'tooLarge'
  | 'wrongFileType'
  | 'invalid'
  | 'network'
  | 'generic';

export function creationFailure(error: { code: string }): CreationFailure {
  switch (error.code) {
    case 'CONSENT_REQUIRED':
      return 'consent';
    case 'INSUFFICIENT_CREDITS':
      return 'credits';
    case 'PLAN_LIMIT_EXCEEDED':
      return 'limit';
    case 'CONTENT_BLOCKED':
      return 'blocked';
    case 'SERVICE_UNAVAILABLE':
      return 'engine';
    case 'PROVIDER_NOT_CONFIGURED':
      return 'notConfigured';
    case 'CONFLICT':
      return 'sourceInUse';
    case 'PAYLOAD_TOO_LARGE':
      return 'tooLarge';
    case 'UNSUPPORTED_MEDIA_TYPE':
      return 'wrongFileType';
    case 'VALIDATION_ERROR':
    case 'BAD_REQUEST':
      return 'invalid';
    case 'NETWORK_ERROR':
      return 'network';
    default:
      return 'generic';
  }
}

/** Failures answered by the engine panel (how to start it). */
export function isEngineFailure(failure: CreationFailure): boolean {
  return failure === 'engine' || failure === 'notConfigured';
}

/** Failures where nothing was charged and the same form can simply be sent again. */
export function isRetryable(failure: CreationFailure): boolean {
  return failure === 'network' || failure === 'engine' || failure === 'generic';
}
