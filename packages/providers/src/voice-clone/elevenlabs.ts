import { z } from 'zod';
import { AppError } from '@parlante/shared';
import type {
  ProviderRef,
  VoiceCloneProvider,
  VoiceCloneRequest,
  VoiceCloneResult,
} from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { notConfigured } from '../errors';
import { readJson, speechFetch, upstreamError } from '../tts/http';
import type { SpeechHttpOptions } from '../tts/http';
import { decodeWav, encodeWav, isWav, pcm16FromBytes } from '../tts/wav';

/* -------------------------------------------------------------------------------------------
 * ElevenLabs instant voice cloning (public REST API, written from its documentation):
 *
 *   POST   /v1/voices/add          multipart: name, files (audio), description, labels (JSON),
 *                                  remove_background_noise  → { voice_id }
 *   DELETE /v1/voices/{voice_id}                            → { status: "ok" }
 *
 * The cloned voice is spoken with the ElevenLabs TTS adapter (`ttsProviderId: 'elevenlabs'`).
 * The consent record id travels in the voice's labels for audit; the TTS adapter never lists
 * cloned voices as stock voices.
 * ----------------------------------------------------------------------------------------- */

export const ELEVENLABS_VOICE_CLONE_INFO: ProviderRef = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  quality: 'premium',
  local: false,
};

const SERVICE = 'ElevenLabs';
const CREATE_TIMEOUT_MS = 120_000;
const DELETE_TIMEOUT_MS = 20_000;
/** The service limits each uploaded sample; a longer recording is cut to its beginning. */
const MAX_UPLOAD_BYTES = 9.5 * 1024 * 1024;
const MIN_SAMPLE_SEC = 1;

const AddVoiceSchema = z.object({ voice_id: z.string().min(1) });

function sampleAsWav(request: VoiceCloneRequest): Uint8Array<ArrayBuffer> {
  const pcm = isWav(request.sample)
    ? decodeWav(request.sample)
    : { samples: pcm16FromBytes(request.sample), sampleRate: request.sampleRate };
  if (pcm.samples.length < pcm.sampleRate * MIN_SAMPLE_SEC) {
    throw new AppError('UNPROCESSABLE', 'The voice sample is too short to clone a voice');
  }
  const maxSamples = Math.floor((MAX_UPLOAD_BYTES - 44) / 2);
  return encodeWav(
    pcm.samples.length > maxSamples ? pcm.samples.subarray(0, maxSamples) : pcm.samples,
    pcm.sampleRate,
  );
}

/** ElevenLabs instant voice cloning. Requires ELEVENLABS_API_KEY. */
export function createElevenLabsVoiceCloneProvider(
  env: ProviderEnv,
  http: SpeechHttpOptions = {},
): VoiceCloneProvider {
  const configuredKey = env.ELEVENLABS_API_KEY;
  if (!configuredKey) throw notConfigured('elevenlabs', 'ELEVENLABS_API_KEY');
  const apiKey: string = configuredKey;
  const base = env.ELEVENLABS_BASE_URL.replace(/\/+$/, '');

  async function createVoice(request: VoiceCloneRequest): Promise<VoiceCloneResult> {
    const wav = sampleAsWav(request);
    const labels = {
      language: request.language,
      ...(request.gender && request.gender !== 'neutral' ? { gender: request.gender } : {}),
      parlante_consent: request.consentId,
    };
    const response = await speechFetch(http, {
      service: SERVICE,
      url: `${base}/v1/voices/add`,
      init: () => {
        const form = new FormData();
        form.append('name', request.name.slice(0, 100));
        form.append('files', new Blob([wav], { type: 'audio/wav' }), 'sample.wav');
        form.append('description', `Cloned with consent record ${request.consentId}`);
        form.append('labels', JSON.stringify(labels));
        form.append('remove_background_noise', 'false');
        return {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, accept: 'application/json' },
          body: form,
        };
      },
      timeoutMs: CREATE_TIMEOUT_MS,
    });
    const parsed = AddVoiceSchema.safeParse(await readJson(SERVICE, response));
    if (!parsed.success) {
      throw new AppError('PROVIDER_ERROR', 'ElevenLabs did not return the id of the new voice');
    }
    return {
      ttsProviderId: 'elevenlabs',
      providerVoiceId: parsed.data.voice_id,
      profile: null,
      provider: ELEVENLABS_VOICE_CLONE_INFO,
    };
  }

  /** Idempotent: a voice that no longer exists upstream counts as deleted. */
  async function deleteVoice(providerVoiceId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(providerVoiceId)) return; // never a voice of the service
    const response = await speechFetch(http, {
      service: SERVICE,
      url: `${base}/v1/voices/${encodeURIComponent(providerVoiceId)}`,
      init: () => ({
        method: 'DELETE',
        headers: { 'xi-api-key': apiKey, accept: 'application/json' },
      }),
      timeoutMs: DELETE_TIMEOUT_MS,
      acceptStatus: [400, 404],
    });
    if (response.ok || response.status === 404) return;
    // The service answers 400 `voice_does_not_exist` for unknown ids; other 400s are errors.
    const copy = response.clone();
    const body = await response.text().catch(() => '');
    if (/voice_does_not_exist|voice_not_found/.test(body)) return;
    throw await upstreamError(SERVICE, copy);
  }

  return { info: ELEVENLABS_VOICE_CLONE_INFO, createVoice, deleteVoice };
}
