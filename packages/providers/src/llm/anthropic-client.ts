import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { AppError } from '@parlante/shared';
import type { ProviderRef } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { notConfigured } from '../errors';

/* -------------------------------------------------------------------------------------------
 * Shared plumbing of the Anthropic adapters (LLM and translation): the official SDK client,
 * the request options every call carries and the mapping of SDK errors to AppErrors.
 * ----------------------------------------------------------------------------------------- */

export const ANTHROPIC_INFO: ProviderRef = {
  id: 'anthropic',
  name: 'Anthropic Claude',
  quality: 'premium',
  local: false,
};

export type AnthropicEnv = Pick<
  ProviderEnv,
  'ANTHROPIC_API_KEY' | 'ANTHROPIC_MODEL' | 'ANTHROPIC_FALLBACKS'
>;

export interface AnthropicAdapterOptions {
  /** Injected in tests (a client built with a stub `fetch`); defaults to a real client. */
  client?: Anthropic;
}

export function createAnthropicClient(env: AnthropicEnv): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw notConfigured('anthropic', 'ANTHROPIC_API_KEY');
  // The SDK retries 408 / 409 / 429 / 5xx and connection errors twice by default.
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

/**
 * Options shared by every request: the model and, unless disabled, server-side refusal
 * fallbacks — when the model's safety classifiers decline a request, the API re-runs it on
 * the model Anthropic recommends for that kind of refusal instead of returning the refusal.
 */
export function anthropicBaseParams(env: AnthropicEnv): {
  model: string;
  betas?: Anthropic.Beta.AnthropicBeta[];
  fallbacks?: 'default';
} {
  return {
    model: env.ANTHROPIC_MODEL,
    ...(env.ANTHROPIC_FALLBACKS
      ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
      : {}),
  };
}

/**
 * Check how a response ended BEFORE reading its content: a refusal (even after the fallback
 * chain) is a content decision; a response cut by `max_tokens` is incomplete.
 */
export function assertCompleted(
  message: Pick<Anthropic.Beta.BetaMessage, 'stop_reason' | 'stop_details'>,
  what: string,
): void {
  if (message.stop_reason === 'refusal') {
    throw new AppError(
      'CONTENT_BLOCKED',
      `The AI provider declined to ${what} for safety reasons`,
      { providerId: 'anthropic', category: message.stop_details?.category ?? null },
    );
  }
  if (message.stop_reason === 'max_tokens') {
    throw new AppError(
      'PROVIDER_ERROR',
      `Anthropic: the answer was cut off before it was complete (could not ${what})`,
      { providerId: 'anthropic', stopReason: 'max_tokens' },
    );
  }
}

/**
 * One request whose answer must match a schema (structured outputs: the API constrains the
 * model to the JSON schema derived from `schema`). The stop reason is checked BEFORE the text
 * is parsed — a refused or truncated answer is not valid JSON and must be reported as what it
 * is — which is why this uses `create` + the format's own parser instead of `parse()`.
 */
export async function requestStructured<Schema extends z.ZodType>(
  client: Anthropic,
  params: Omit<Anthropic.Beta.MessageCreateParamsNonStreaming, 'output_config'> & {
    effort: 'low' | 'medium' | 'high';
  },
  schema: Schema,
  what: string,
): Promise<z.infer<Schema>> {
  const { effort, ...rest } = params;
  const format = betaZodOutputFormat(schema);
  const message = await client.beta.messages.create({
    ...rest,
    output_config: { effort, format },
  });
  assertCompleted(message, what);
  const text = message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  try {
    return format.parse(text);
  } catch (err) {
    throw new AppError(
      'PROVIDER_ERROR',
      `Anthropic returned an answer in an unexpected format (could not ${what})`,
      { providerId: 'anthropic' },
      { cause: err },
    );
  }
}

/** Translate an SDK failure into the shared error shape. Never includes request content. */
export function mapAnthropicError(err: unknown, what: string): unknown {
  if (err instanceof AppError) return err;
  const details = (extra: Record<string, unknown> = {}) => ({ providerId: 'anthropic', ...extra });
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new AppError(
      'PROVIDER_NOT_CONFIGURED',
      'Anthropic rejected the API key (check ANTHROPIC_API_KEY)',
      details({ httpStatus: 401 }),
      { cause: err },
    );
  }
  if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) {
    return new AppError(
      'PROVIDER_NOT_CONFIGURED',
      'Anthropic: this API key cannot use the configured model (check ANTHROPIC_MODEL)',
      details({ httpStatus: err.status }),
      { cause: err },
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AppError(
      'PROVIDER_ERROR',
      `Anthropic is rate limiting requests; could not ${what}. Try again in a moment`,
      details({ httpStatus: 429, retryable: true }),
      { cause: err },
    );
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AppError(
      'PROVIDER_ERROR',
      `Anthropic rejected the request to ${what}`,
      details({ httpStatus: 400, reason: err.message.slice(0, 300) }),
      { cause: err },
    );
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AppError(
      'PROVIDER_ERROR',
      `Anthropic could not be reached to ${what}`,
      details({ retryable: true }),
      { cause: err },
    );
  }
  if (err instanceof Anthropic.APIError) {
    return new AppError(
      'PROVIDER_ERROR',
      `Anthropic failed to ${what} (HTTP ${err.status ?? 'unknown'})`,
      details({ httpStatus: err.status ?? null, retryable: (err.status ?? 0) >= 500 }),
      { cause: err },
    );
  }
  return err;
}
