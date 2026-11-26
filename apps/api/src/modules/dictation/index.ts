import type { FastifyRequest } from 'fastify';
import { AppError, DICTATION_MAX_UPLOAD_BYTES, api } from '@parlante/shared';
import type { DictationReasonCode, RouteDef } from '@parlante/shared';
import { defineRoute } from '../../lib/define-route';
import { defineModule } from '../../lib/modules';
import { KeyRateLimiter } from '../public-v1/rate-limit';
import { audioTooLong, parseDictationWav } from './wav';

/* -------------------------------------------------------------------------------------------
 * Dictation by microphone, local engine. The web app posts one spoken phrase at a time:
 *
 *   POST /api/dictation/transcribe   multipart: audio (WAV PCM16 mono 16 kHz ≤ 30 s), language?
 *        → { text, language, provider, audioMs, processingMs }
 *
 * Privacy (docs/SECURITY.md): the audio is read into memory, handed to the local speech
 * model and dropped with the request. It is never written to disk, storage, the database or
 * the log — and neither is the recognised text. No credits are charged.
 *
 * Load: a CPU model transcribes one segment at a time, so the module bounds what can pile up:
 *   - per user:  DICTATION_RATE_LIMIT_PER_MIN segments a minute        → 429 + Retry-After
 *   - globally:  DICTATION_MAX_PENDING segments running or waiting      → 429 + Retry-After
 * Both are counted in this API process.
 * ----------------------------------------------------------------------------------------- */

const ROUTE: RouteDef = api.dictation.transcribe;
const FILE_FIELD = ROUTE.multipart?.fileField ?? 'audio';
const RATE_WINDOW_MS = 60_000;

function unavailable(reason: DictationReasonCode, message: string): AppError {
  return new AppError('SERVICE_UNAVAILABLE', message, { reason });
}

/**
 * Read the multipart body INTO MEMORY (never a temp file): the audio part, capped at the
 * size of 30 s of PCM, and the text fields next to it.
 */
async function receiveAudio(
  request: FastifyRequest,
): Promise<{ bytes: Buffer; fields: Record<string, string> }> {
  if (!request.isMultipart()) {
    throw new AppError('BAD_REQUEST', 'Expected a multipart/form-data request');
  }
  const fields: Record<string, string> = {};
  let bytes: Buffer | null = null;
  try {
    const parts = request.parts({
      limits: { fileSize: DICTATION_MAX_UPLOAD_BYTES, files: 1, fields: 4, fieldSize: 64 },
    });
    for await (const part of parts) {
      if (part.type === 'file') {
        if (part.fieldname !== FILE_FIELD || bytes) {
          part.file.resume(); // drain what we did not ask for
          continue;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        if (part.file.truncated) throw audioTooLong(null);
        bytes = Buffer.concat(chunks);
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw audioTooLong(null);
    throw err;
  }
  if (!bytes) {
    throw AppError.validation('An audio file is required', [
      { path: FILE_FIELD, message: 'Required' },
    ]);
  }
  return { bytes, fields };
}

export default defineModule({
  name: 'dictation',
  register(app) {
    const { config } = app;
    const limiter = new KeyRateLimiter(RATE_WINDOW_MS);
    /** Segments being transcribed or waiting for the model, across all users. */
    let pending = 0;
    /** Smoothed time one segment takes, to tell callers when to come back. */
    let typicalMs = 2000;

    defineRoute(app, api.dictation.transcribe, async ({ auth, request, reply, app: instance }) => {
      const startedAt = performance.now();

      /* ---- per-user request limit ---- */
      if (config.RATE_LIMIT_ENABLED) {
        const decision = limiter.take(auth.userId, config.DICTATION_RATE_LIMIT_PER_MIN);
        void reply
          .header('RateLimit-Limit', decision.limit)
          .header('RateLimit-Remaining', decision.remaining)
          .header('RateLimit-Reset', decision.resetSec);
        if (!decision.allowed) {
          void reply.header('Retry-After', decision.resetSec);
          throw new AppError(
            'RATE_LIMITED',
            `Too many dictation requests. Try again in ${decision.resetSec} s`,
            {
              reason: 'user_rate_limit',
              limit: decision.limit,
              windowSec: RATE_WINDOW_MS / 1000,
              retryAfterSec: decision.resetSec,
            },
          );
        }
      }

      /* ---- is the local model there? (before reading any audio) ---- */
      // Read at request time: the model can be installed while the API runs.
      const provider = instance.providers.dictation;
      if (!provider) {
        throw unavailable('not_configured', 'This server has no local dictation provider');
      }
      const status = await provider.status();
      if (!status.available) {
        throw unavailable(
          status.reasonCode ?? 'unknown',
          status.reason ?? 'Local dictation is not available',
        );
      }

      /* ---- global bound on waiting work ---- */
      if (pending >= config.DICTATION_MAX_PENDING) {
        const retryAfterSec = Math.max(1, Math.ceil((typicalMs * pending) / 1000));
        void reply.header('Retry-After', retryAfterSec);
        throw new AppError('RATE_LIMITED', 'The speech model is busy. Try again in a moment', {
          reason: 'busy',
          pending,
          retryAfterSec,
        });
      }
      pending += 1;
      try {
        const upload = await receiveAudio(request);
        const fields = api.dictation.transcribe.multipart.fields.parse(upload.fields);
        const audio = parseDictationWav(upload.bytes);

        // A client that went away does not need its turn any more.
        const abort = new AbortController();
        const onClose = () => {
          if (!reply.raw.writableFinished) abort.abort();
        };
        reply.raw.once('close', onClose);
        try {
          const result = await provider.transcribe({
            samples: audio.samples,
            sampleRate: audio.sampleRate,
            language: fields.language,
            signal: abort.signal,
          });
          const processingMs = Math.round(performance.now() - startedAt);
          typicalMs = Math.round(typicalMs * 0.8 + processingMs * 0.2);
          return {
            text: result.text,
            language: result.language,
            provider: result.provider,
            audioMs: audio.durationMs,
            processingMs,
          };
        } finally {
          reply.raw.off('close', onClose);
        }
      } finally {
        pending -= 1;
      }
    });
  },
});
