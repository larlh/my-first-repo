import {
  AssetSchema,
  AvatarSchema,
  BrandKitSchema,
  CapabilitiesSchema,
  ConsentRecordSchema,
  SynthesizedSpeechSchema,
  TemplateDetailSchema,
  TemplateSchema,
  VoiceSchema,
  createComposition,
  estimateSpeechMs,
  sceneRuntimeFromTranscript,
} from '@parlante/shared';
import type {
  Asset,
  Avatar,
  BrandKit,
  Capabilities,
  ConsentRecord,
  SynthesizedSpeech,
  Template,
  TemplateDetail,
  Voice,
} from '@parlante/shared';
import { listStockAvatars } from '@parlante/renderer';

/* Fixtures of the library features. Every object is parsed with the zod schema of the
 * contract, so a test cannot pass against a body the API would never send. */

export const NOW = '2026-11-20T10:00:00.000Z';
export const WS = 'ws_a1b2c3d4e5f6g7h8';
const API = 'http://localhost:4000';

export type Engine = Capabilities['avatarEngine'];

const LOCAL = (id: string, name: string) => ({ id, name, quality: 'basic' as const, local: true });
export const CANVAS_PROVIDER = LOCAL('canvas2d', 'Avatar 2D (Canvas)');
export const NEURAL_PROVIDER = LOCAL('local-neural', 'Motor neuronal local');
export const ESPEAK_PROVIDER = LOCAL('espeak', 'eSpeak NG (local)');
export const PROFILE_PROVIDER = LOCAL('voice-profile', 'Voice profile (local)');
export const ELEVEN_PROVIDER = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  quality: 'premium' as const,
  local: false,
};

export function engineOff(reason = 'The local avatar engine is not reachable'): Engine {
  return CapabilitiesSchema.shape.avatarEngine.parse({
    available: false,
    reason,
    device: null,
    secondsPerVideoSecond: null,
  });
}

export function engineReady(overrides: Partial<Engine> = {}): Engine {
  return CapabilitiesSchema.shape.avatarEngine.parse({
    available: true,
    reason: null,
    device: 'cpu',
    secondsPerVideoSecond: 14.2,
    operations: { generate: true, prepare: true, animate: true },
    models: [
      {
        id: 'sd-turbo-portrait',
        role: 'portrait-generation',
        downloaded: true,
        license: 'OpenRAIL++-M',
        commercialUse: true,
      },
      {
        id: 'liveportrait-onnx',
        role: 'animation',
        downloaded: true,
        license: 'MIT',
        commercialUse: true,
      },
    ],
    nonCommercial: false,
    secondsPerPortrait: 95,
    ...overrides,
  });
}

/** The real instant catalogue of the renderer, as the API lists it. */
export function stockAvatars(): Avatar[] {
  return listStockAvatars().map((meta) =>
    AvatarSchema.parse({
      id: meta.id,
      kind: 'stock',
      rendering: 'instant',
      name: meta.name,
      gender: meta.gender,
      ageGroup: meta.ageGroup,
      style: meta.style,
      description: meta.description,
      tags: meta.tags,
      traits: meta.traits,
      status: 'ready',
      thumbnailUrl: null,
      imageUrl: null,
      maskUrl: null,
      rig: null,
      prompt: null,
      provider: CANVAS_PROVIDER,
      workspaceId: null,
      consentId: null,
      error: null,
      createdAt: null,
    }),
  );
}

const RIG = {
  imageWidth: 768,
  imageHeight: 960,
  landmarks: {
    leftEye: { x: 0.4, y: 0.36 },
    rightEye: { x: 0.6, y: 0.36 },
    mouthLeft: { x: 0.43, y: 0.56 },
    mouthRight: { x: 0.57, y: 0.56 },
    chin: { x: 0.5, y: 0.68 },
  },
  landmarksSource: 'detected' as const,
};

export function photorealStock(
  slug: string,
  name: string,
  overrides: Partial<Avatar> = {},
): Avatar {
  const id = `real_${slug}`;
  return AvatarSchema.parse({
    id,
    kind: 'stock',
    rendering: 'photoreal',
    name,
    gender: 'female',
    ageGroup: 'adult',
    style: 'professional',
    description: `Persona sintética: ${name}.`,
    tags: ['sintética', 'estudio'],
    traits: {},
    status: 'ready',
    thumbnailUrl: `${API}/api/stock-avatars/${id}/thumb`,
    imageUrl: `${API}/api/stock-avatars/${id}/portrait`,
    maskUrl: `${API}/api/stock-avatars/${id}/mask`,
    cutoutUrl: `${API}/api/stock-avatars/${id}/cutout`,
    rig: RIG,
    prompt: 'mujer de unos 35 años, chaqueta gris, fondo neutro',
    seed: 1234,
    model: 'sd-turbo-portrait',
    provider: NEURAL_PROVIDER,
    workspaceId: null,
    consentId: null,
    error: null,
    createdAt: null,
    ...overrides,
  });
}

/** A workspace avatar (`avt_…`): from a photo by default. */
export function ownAvatar(n: number, overrides: Partial<Avatar> = {}): Avatar {
  const id = `avt_${String(n).padStart(4, '0')}abcdefgh1234`;
  const status = overrides.status ?? 'ready';
  const ready = status === 'ready';
  const kind = overrides.kind ?? 'photo';
  const file = (name: string) => `${API}/api/files/ws/${WS}/avatars/${id}/${name}?exp=1&sig=t`;
  return AvatarSchema.parse({
    id,
    kind,
    rendering: 'photoreal',
    name: `Avatar ${n}`,
    gender: 'neutral',
    ageGroup: null,
    style: null,
    description: '',
    tags: [],
    traits: {},
    status,
    progress: ready ? 100 : status === 'processing' ? 40 : 0,
    etaSec: status === 'processing' ? 75 : null,
    thumbnailUrl: ready ? file('thumb.jpg') : null,
    imageUrl: ready ? file('image.png') : null,
    maskUrl: ready ? file('mask.png') : null,
    cutoutUrl: ready ? file('cutout.png') : null,
    rig: ready ? RIG : null,
    prompt: kind === 'generated' ? 'hombre de unos 45 años, barba corta, jersey verde' : null,
    seed: kind === 'generated' ? 77 : null,
    model: kind === 'generated' ? 'sd-turbo-portrait' : null,
    provider: NEURAL_PROVIDER,
    workspaceId: WS,
    consentId: kind === 'photo' ? 'cns_a1b2c3d4e5f6g7h8' : null,
    error: status === 'failed' ? { code: 'PROVIDER_ERROR', message: 'No face was found' } : null,
    createdAt: NOW,
    ...overrides,
  });
}

export function stockVoice(
  providerVoiceId: string,
  name: string,
  overrides: Partial<Voice> = {},
): Voice {
  return VoiceSchema.parse({
    id: `espeak:${providerVoiceId}`,
    kind: 'stock',
    name,
    provider: ESPEAK_PROVIDER,
    language: providerVoiceId.slice(0, 2),
    gender: providerVoiceId.includes('-f') ? 'female' : 'male',
    description: 'Voz sintética local',
    tags: [],
    status: 'ready',
    workspaceId: null,
    consentId: null,
    profile: null,
    error: null,
    createdAt: null,
    ...overrides,
  });
}

export function clonedVoice(n: number, overrides: Partial<Voice> = {}): Voice {
  const status = overrides.status ?? 'ready';
  return VoiceSchema.parse({
    id: `vcl_${String(n).padStart(4, '0')}abcdefgh1234`,
    kind: 'cloned',
    name: `Mi voz ${n}`,
    provider: PROFILE_PROVIDER,
    language: 'es',
    gender: 'female',
    description: '',
    tags: [],
    status,
    workspaceId: WS,
    consentId: 'cns_a1b2c3d4e5f6g7h8',
    profile:
      status === 'ready'
        ? { baseVoiceId: 'es-f1', pitchSemitones: 1.5, speed: 1.05, meanF0Hz: 212 }
        : null,
    error: status === 'failed' ? { code: 'PROVIDER_ERROR', message: 'Sample too noisy' } : null,
    createdAt: NOW,
    ...overrides,
  });
}

export function makeSpeech(text: string, provider = ESPEAK_PROVIDER): SynthesizedSpeech {
  return SynthesizedSpeechSchema.parse({
    audioUrl: `${API}/api/files/cache/tts/abc.wav?exp=1&sig=t`,
    mimeType: 'audio/wav',
    runtime: sceneRuntimeFromTranscript(text, estimateSpeechMs(text)),
    provider,
  });
}

export function makeTemplate(slug: string, overrides: Partial<Template> = {}): Template {
  const custom = overrides.kind === 'custom';
  const id = custom ? `tpl_${slug.padEnd(12, '0').slice(0, 12)}` : `builtin_${slug}`;
  return TemplateSchema.parse({
    id,
    kind: 'builtin',
    workspaceId: custom ? WS : null,
    name: `Plantilla ${slug}`,
    description: `Descripción de ${slug}`,
    category: 'explainer',
    aspect: '16:9',
    tags: ['demo'],
    sceneCount: 2,
    thumbnailUrl: custom ? null : `/api/templates/${id}/thumbnail`,
    createdAt: custom ? NOW : null,
    ...overrides,
  });
}

export function makeTemplateDetail(template: Template): TemplateDetail {
  return TemplateDetailSchema.parse({
    ...template,
    composition: createComposition({
      aspect: template.aspect,
      scenes: [
        {
          name: 'Apertura',
          script: {
            kind: 'tts',
            text: 'Hola, {{nombre}}. Esto es una plantilla.',
            voiceId: 'espeak:es-f1',
            language: 'es',
          },
        },
        { name: 'Cierre' },
      ],
    }),
  });
}

export function makeBrandKit(n: number, overrides: Partial<BrandKit> = {}): BrandKit {
  return BrandKitSchema.parse({
    id: `bk_${String(n).padStart(4, '0')}abcdefgh1234`,
    workspaceId: WS,
    name: `Marca ${n}`,
    logoAssetId: null,
    logoUrl: null,
    colors: {},
    fonts: {},
    isDefault: n === 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

export function makeAsset(n: number, overrides: Partial<Asset> = {}): Asset {
  const id = `ast_${String(n).padStart(4, '0')}abcdefgh1234`;
  return AssetSchema.parse({
    id,
    workspaceId: WS,
    kind: 'image',
    purpose: 'avatar_source',
    name: 'foto.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 120_000,
    width: 800,
    height: 1000,
    durationMs: null,
    url: `${API}/api/files/ws/${WS}/assets/${id}/file.jpg?exp=1&sig=t`,
    thumbnailUrl: null,
    createdBy: null,
    createdAt: NOW,
    ...overrides,
  });
}

export function makeConsent(
  kind: ConsentRecord['kind'],
  overrides: Partial<ConsentRecord> = {},
): ConsentRecord {
  return ConsentRecordSchema.parse({
    id: 'cns_a1b2c3d4e5f6g7h8',
    workspaceId: WS,
    user: { id: 'usr_a1b2c3d4e5f6g7h8', name: 'Lucía Ferrer' },
    kind,
    subjectName: 'Lucía Ferrer',
    relationship: 'self',
    statementVersion: '2026-01',
    statement: '…',
    resourceId: null,
    revokedAt: null,
    createdAt: NOW,
    ...overrides,
  });
}

/** Capabilities with a chosen voice-clone provider and engine state. */
export function makeLibraryCapabilities(
  options: { voiceClone?: Capabilities['active']['voiceClone']; engine?: Engine } = {},
): Capabilities {
  return CapabilitiesSchema.parse({
    active: {
      tts: ESPEAK_PROVIDER,
      stt: LOCAL('user', 'Transcripción aportada'),
      llm: LOCAL('heuristic', 'Heurística local'),
      translation: LOCAL('heuristic', 'Heurística local'),
      voiceClone: options.voiceClone ?? PROFILE_PROVIDER,
      lipsync: CANVAS_PROVIDER,
      portrait: NEURAL_PROVIDER,
      moderation: LOCAL('blocklist', 'Lista de bloqueo'),
      storage: LOCAL('disk', 'Disco local'),
    },
    ttsProviders: [ESPEAK_PROVIDER],
    sttRequiresTranscript: true,
    avatarEngine: options.engine ?? engineOff(),
  });
}
