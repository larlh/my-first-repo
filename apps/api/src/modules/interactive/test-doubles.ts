import { api, CONSENT_STATEMENT_VERSION, estimateSpeechTimeline, newId } from '@parlante/shared';
import type {
  AssetKind,
  AssetPurpose,
  ChatRequest,
  ConsentKind,
  GeneratedScript,
  LLMProvider,
  ProviderRef,
  ProviderVoice,
  ScriptGenerationRequest,
  TTSProvider,
  TTSRequest,
} from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { and, assets, creditLedger, desc, eq, getCreditBalance } from '@parlante/db';
import type { AssetRow, CreditLedgerRow } from '@parlante/db';
import type { TestActor, TestApp } from '../../testing/index';

/* -------------------------------------------------------------------------------------------
 * Test doubles and seeds shared by the integration tests of the AI modules (script-writer,
 * translations, batch, interactive, photo-avatars, voice-clones). Nothing here is used by the
 * application. The doubles honour the provider contracts (real WAV bytes, timeline from the
 * shared estimator); everything else in those tests is the real app on the test database.
 * ----------------------------------------------------------------------------------------- */

const SAMPLE_RATE = 16_000;

/** A valid RIFF/WAVE file (PCM 16-bit mono) with a quiet tone of the given length. */
export function wavBytes(durationMs: number, frequency = 220): Uint8Array {
  const samples = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const value = Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE) * 6000;
    buffer.writeInt16LE(Math.round(value), 44 + i * 2);
  }
  return buffer;
}

export interface FakeTts extends TTSProvider {
  requests: TTSRequest[];
  /** Make the next syntheses fail with this error. */
  failSynthesis: unknown;
}

export const FAKE_TTS_INFO: ProviderRef = {
  id: 'espeak',
  name: 'eSpeak NG (local)',
  quality: 'basic',
  local: true,
};

export const FAKE_TTS_VOICES: ProviderVoice[] = [
  {
    providerVoiceId: 'es-f1',
    name: 'Lucía',
    language: 'es',
    gender: 'female',
    description: 'Voz local',
    tags: [],
  },
  {
    providerVoiceId: 'en-m1',
    name: 'James',
    language: 'en-US',
    gender: 'male',
    description: 'Local voice',
    tags: [],
  },
  {
    providerVoiceId: 'fr-f1',
    name: 'Chloé',
    language: 'fr',
    gender: 'female',
    description: 'Voix locale',
    tags: [],
  },
  {
    providerVoiceId: 'de-m1',
    name: 'Jonas',
    language: 'de',
    gender: 'male',
    description: 'Lokale Stimme',
    tags: [],
  },
];

export function fakeTts(
  info: ProviderRef = FAKE_TTS_INFO,
  voices: ProviderVoice[] = FAKE_TTS_VOICES,
): FakeTts {
  const provider: FakeTts = {
    info,
    requests: [],
    failSynthesis: null,
    listVoices: () => Promise.resolve(voices),
    synthesize(request) {
      provider.requests.push(request);
      if (provider.failSynthesis) return Promise.reject(provider.failSynthesis as Error);
      const durationMs = Math.round((request.text.length * 60) / request.speed);
      return Promise.resolve({
        audio: wavBytes(durationMs, 220 + request.pitch * 10),
        format: 'wav',
        sampleRate: SAMPLE_RATE,
        durationMs,
        ...estimateSpeechTimeline(request.text, durationMs, request.language),
        provider: info,
      });
    },
  };
  return provider;
}

/** Replace the TTS registry of the app by one deterministic local provider (`espeak:…`). */
export function installFakeTts(t: TestApp, ...providers: FakeTts[]): FakeTts {
  const active = providers.length > 0 ? providers : [fakeTts()];
  const first = active[0] as FakeTts;
  t.app.providers.tts = {
    default: first,
    get: (id) => active.find((provider) => provider.info.id === id) ?? null,
    all: () => active,
  };
  return first;
}

export interface FakeLlm extends LLMProvider {
  scriptRequests: ScriptGenerationRequest[];
  chatRequests: ChatRequest[];
  /** Make the next calls fail with this error. */
  fail: unknown;
  /** Override what the next calls return. */
  nextScript: Partial<GeneratedScript> | null;
  nextReply: string | null;
}

export const EXTERNAL_LLM_INFO: ProviderRef = {
  id: 'acme-llm',
  name: 'Acme LLM',
  quality: 'premium',
  local: false,
};

/** An LLM double that looks like an EXTERNAL provider (premium, not local) by default. */
export function fakeLlm(info: ProviderRef = EXTERNAL_LLM_INFO): FakeLlm {
  const provider: FakeLlm = {
    info,
    scriptRequests: [],
    chatRequests: [],
    fail: null,
    nextScript: null,
    nextReply: null,
    generateScript(request) {
      provider.scriptRequests.push(request);
      if (provider.fail) return Promise.reject(provider.fail as Error);
      const count = request.sceneCount ?? 3;
      return Promise.resolve({
        title: `Guion: ${request.topic.slice(0, 40)}`,
        language: request.language,
        scenes: Array.from({ length: count }, (_, index) => ({
          title: `Escena ${index + 1}`,
          text: `Parte ${index + 1} sobre ${request.topic.slice(0, 60)}.`,
          headline: `Idea ${index + 1}`,
          estimatedSec: request.durationSec / count,
        })),
        provider: info,
        basicMode: info.quality === 'basic',
        sourceTitle: request.sourceTitle ?? null,
        ...(provider.nextScript ?? {}),
      });
    },
    chat(request) {
      provider.chatRequests.push(request);
      if (provider.fail) return Promise.reject(provider.fail as Error);
      const last = request.messages[request.messages.length - 1];
      return Promise.resolve({
        text: provider.nextReply ?? `Me preguntas: ${last?.text ?? ''}. Aquí tienes la respuesta.`,
        provider: info,
      });
    },
  };
  return provider;
}

/** Insert an asset row with a stored file (the bytes are not inspected by these modules). */
export async function seedAsset(
  t: TestApp,
  actor: TestActor,
  options: {
    kind: AssetKind;
    purpose?: AssetPurpose;
    durationMs?: number | null;
    name?: string;
    bytes?: Uint8Array;
  },
): Promise<AssetRow> {
  const id = newId('asset');
  const ext = options.kind === 'image' ? 'png' : options.kind === 'audio' ? 'wav' : 'mp4';
  const mimeType =
    options.kind === 'image' ? 'image/png' : options.kind === 'audio' ? 'audio/wav' : 'video/mp4';
  const storageKey = storageKeys.asset(actor.workspace.id, id, ext);
  const bytes = options.bytes ?? Buffer.from(`fake ${options.kind} bytes`);
  await t.app.providers.storage.put(storageKey, bytes, { contentType: mimeType });
  const [row] = await t.db
    .insert(assets)
    .values({
      id,
      workspaceId: actor.workspace.id,
      kind: options.kind,
      purpose: options.purpose ?? 'library',
      name: options.name ?? `archivo.${ext}`,
      mimeType,
      sizeBytes: bytes.length,
      width: options.kind === 'audio' ? null : 640,
      height: options.kind === 'audio' ? null : 360,
      durationMs:
        options.durationMs === undefined
          ? options.kind === 'image'
            ? null
            : 12_000
          : options.durationMs,
      storageKey,
      createdBy: actor.user.id,
    })
    .returning();
  if (!row) throw new Error('Asset seed failed');
  return row;
}

/** Record a consent declaration through the real route (the consent module must be loaded). */
export async function recordConsent(
  t: TestApp,
  actor: TestActor,
  kind: ConsentKind,
): Promise<string> {
  const res = await t.call(api.consents.create, {
    as: actor,
    body: {
      kind,
      subjectName: 'Ana García',
      relationship: 'self',
      statementVersion: CONSENT_STATEMENT_VERSION,
      locale: 'es',
      accepted: true,
    },
  });
  if (res.status !== 201) throw new Error(`Consent seed failed: ${res.raw.body}`);
  return res.body.id;
}

export function balanceOf(t: TestApp, actor: TestActor): Promise<number> {
  return getCreditBalance(t.db, actor.workspace.id);
}

/** Ledger entries of a workspace, newest first. */
export function ledgerOf(t: TestApp, actor: TestActor): Promise<CreditLedgerRow[]> {
  return t.db
    .select()
    .from(creditLedger)
    .where(and(eq(creditLedger.workspaceId, actor.workspace.id)))
    .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id));
}

/** Make the queue backend refuse the next enqueue calls (restore with the returned function). */
export function breakQueue(t: TestApp): () => void {
  const original = t.queues.enqueue.bind(t.queues);
  t.queues.enqueue = () => Promise.reject(new Error('redis is down'));
  return () => {
    t.queues.enqueue = original;
  };
}
