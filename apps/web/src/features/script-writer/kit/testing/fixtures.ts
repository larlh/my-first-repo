import {
  BatchJobDetailSchema,
  GeneratedScriptSchema,
  InteractiveMessageSchema,
  InteractiveReplySchema,
  InteractiveSessionSchema,
  TranslationJobSchema,
  sceneRuntimeFromTranscript,
} from '@parlante/shared';
import type {
  BatchItem,
  BatchJob,
  BatchJobDetail,
  GeneratedScript,
  InteractiveMessage,
  InteractiveReply,
  InteractiveSession,
  LanguageCode,
  TranslationJob,
  TranslationOutput,
} from '@parlante/shared';

/* Fixtures of the AI tools. Everything is parsed with the zod schema of the contract, so a
 * test cannot pass against a body the API would never send. */

export const NOW = '2026-11-20T10:00:00.000Z';
export const WS = 'ws_a1b2c3d4e5f6g7h8';
const API = 'http://localhost:4000';
const AUTHOR = { id: 'usr_a1b2c3d4e5f6g7h8', name: 'Lucía Ferrer' };

export const HEURISTIC = {
  id: 'heuristic',
  name: 'Heurística local',
  quality: 'basic' as const,
  local: true,
};
export const CLAUDE = {
  id: 'anthropic',
  name: 'Claude (Anthropic)',
  quality: 'premium' as const,
  local: false,
};
export const ESPEAK = {
  id: 'espeak',
  name: 'eSpeak NG (local)',
  quality: 'basic' as const,
  local: true,
};
export const GLOSSARY = {
  id: 'glossary',
  name: 'Traducción básica por glosario (local)',
  quality: 'basic' as const,
  local: true,
};
export const MANUAL_STT = {
  id: 'user',
  name: 'Transcripción aportada',
  quality: 'basic' as const,
  local: true,
};

export function file(key: string): string {
  return `${API}/api/files/${key}?exp=1999999999&sig=test`;
}

/* ---------- script writer ---------- */

export function makeScript(overrides: Partial<GeneratedScript> = {}): GeneratedScript {
  return GeneratedScriptSchema.parse({
    title: 'Reservas sin llamadas',
    language: 'es',
    scenes: [
      {
        title: 'Gancho',
        headline: 'Menos llamadas',
        text: 'Reservar una cita no debería costar una llamada.',
        estimatedSec: 4,
      },
      {
        title: 'Cómo funciona',
        headline: '',
        text: 'Tus pacientes eligen hora desde el móvil y reciben un recordatorio.',
        estimatedSec: 5,
      },
      { title: 'Cierre', headline: 'Pruébalo hoy', text: 'Empieza hoy mismo.', estimatedSec: 2 },
    ],
    provider: HEURISTIC,
    basicMode: true,
    sourceTitle: null,
    ...overrides,
  });
}

/* ---------- translation ---------- */

export function translationId(n: number): string {
  return `trj_${String(n).padStart(4, '0')}abcdefgh1234`;
}

export function makeOutput(
  language: LanguageCode,
  status: TranslationOutput['status'] = 'completed',
  overrides: Partial<TranslationOutput> = {},
): TranslationOutput {
  const done = status === 'completed';
  const base = `ws/${WS}/translations/job/${language}`;
  return {
    id: `tro_${language}00abcdefgh123456`.slice(0, 20),
    language,
    voiceId: `espeak:${language}-f1`,
    status,
    videoUrl: done ? file(`${base}/video.mp4`) : null,
    downloadUrl: done ? `${file(`${base}/video.mp4`)}&download=video.mp4` : null,
    srtUrl: done ? file(`${base}/subtitles.srt`) : null,
    vttUrl: done ? file(`${base}/subtitles.vtt`) : null,
    error:
      status === 'failed' ? { code: 'PROVIDER_ERROR', message: 'TTS provider timed out' } : null,
    ...overrides,
  };
}

export function makeTranslation(
  n: number,
  overrides: Partial<TranslationJob> = {},
): TranslationJob {
  const status = overrides.status ?? 'completed';
  const targets = overrides.targetLanguages ?? ['en'];
  const settled = status === 'completed' || status === 'partial' || status === 'failed';
  return TranslationJobSchema.parse({
    id: translationId(n),
    workspaceId: WS,
    name: `Presentación ${n}`,
    sourceAssetId: `ast_${String(n).padStart(4, '0')}abcdefgh1234`,
    sourceUrl: file(`ws/${WS}/assets/source-${n}.mp4`),
    sourceDurationMs: 95_000,
    sourceLanguage: 'es',
    targetLanguages: targets,
    status,
    stage: status === 'processing' ? 'dubbing' : null,
    progress: settled ? 100 : status === 'processing' ? 40 : 0,
    transcriptSource: 'user',
    options: { originalAudioVolume: 0.08, burnSubtitles: false },
    outputs: targets.map((language) =>
      makeOutput(language, status === 'completed' ? 'completed' : 'pending'),
    ),
    providers: status === 'queued' ? null : { stt: MANUAL_STT, translation: GLOSSARY, tts: ESPEAK },
    creditsCharged: 4 * targets.length,
    error: null,
    createdBy: AUTHOR,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

/* ---------- batch ---------- */

export function batchId(n: number): string {
  return `bat_${String(n).padStart(4, '0')}abcdefgh1234`;
}

export function makeItem(
  index: number,
  values: Record<string, string>,
  status: BatchItem['status'] = 'completed',
  overrides: Partial<BatchItem> = {},
): BatchItem {
  const done = status === 'completed';
  const videoId = `vid_${String(index + 100).padStart(4, '0')}abcdefgh1234`;
  const hasVideo = status !== 'pending';
  return {
    id: `bti_${String(index).padStart(4, '0')}abcdefgh1234`,
    index,
    values,
    status,
    videoId: hasVideo ? videoId : null,
    videoUrl: done ? file(`ws/${WS}/videos/${videoId}/video.mp4`) : null,
    downloadUrl: done ? `${file(`ws/${WS}/videos/${videoId}/video.mp4`)}&download=video.mp4` : null,
    thumbnailUrl: done ? file(`ws/${WS}/videos/${videoId}/thumb.jpg`) : null,
    error: status === 'failed' ? { code: 'PROVIDER_ERROR', message: 'TTS failed' } : null,
    ...overrides,
  };
}

export function makeBatch(
  n: number,
  items: BatchItem[] = [
    makeItem(0, { nombre: 'Lucía', empresa: 'Ferrer Asesores' }),
    makeItem(1, { nombre: 'Marc', empresa: 'Taller Riera' }),
  ],
  overrides: Partial<BatchJob> = {},
): BatchJobDetail {
  const completed = items.filter((item) => item.status === 'completed').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const settled = completed + failed === items.length;
  return BatchJobDetailSchema.parse({
    id: batchId(n),
    workspaceId: WS,
    name: `Bienvenida ${n}`,
    sourceVideoId: 'vid_0001abcdefgh1234',
    resolution: '720p',
    status: settled
      ? failed === 0
        ? 'completed'
        : completed > 0
          ? 'partial'
          : 'failed'
      : 'processing',
    total: items.length,
    completed,
    failed,
    progress: Math.round(((completed + failed) / Math.max(1, items.length)) * 100),
    creditsCharged: completed,
    error: null,
    createdBy: AUTHOR,
    createdAt: NOW,
    updatedAt: NOW,
    variables: Object.keys(items[0]?.values ?? {}),
    items,
    ...overrides,
  });
}

/* ---------- interactive ---------- */

export const SESSION_ID = 'ivs_a1b2c3d4e5f6g7h8';

export function makeTalk(overrides: Partial<InteractiveSession> = {}): InteractiveSession {
  return InteractiveSessionSchema.parse({
    id: SESSION_ID,
    workspaceId: WS,
    avatarId: 'stock_lucia',
    voiceId: 'espeak:es-f1',
    language: 'es',
    persona: { name: 'Lucía', instructions: 'Eres la recepcionista.', knowledge: '' },
    status: 'active',
    messageCount: 0,
    providers: { llm: HEURISTIC, tts: ESPEAK },
    createdAt: NOW,
    endedAt: null,
    ...overrides,
  });
}

export function makeMessage(
  n: number,
  role: InteractiveMessage['role'],
  text: string,
): InteractiveMessage {
  return InteractiveMessageSchema.parse({
    id: `ivm_${String(n).padStart(4, '0')}abcdefgh1234`,
    sessionId: SESSION_ID,
    role,
    text,
    createdAt: NOW,
  });
}

export function makeReply(
  n: number,
  question: string,
  answer: string,
  overrides: Partial<InteractiveReply> = {},
): InteractiveReply {
  return InteractiveReplySchema.parse({
    userMessage: makeMessage(n, 'user', question),
    assistantMessage: makeMessage(n + 1, 'assistant', answer),
    speech: {
      audioUrl: file(`cache/tts/reply-${n}.wav`),
      mimeType: 'audio/wav',
      runtime: sceneRuntimeFromTranscript(answer, 2400),
      provider: ESPEAK,
    },
    providers: { llm: HEURISTIC, tts: ESPEAK },
    ...overrides,
  });
}
