import { describe, expect, it } from 'vitest';
import {
  AUDIO_MIX,
  AssetSchema,
  AvatarSchema,
  CapabilitiesSchema,
  CompositionSchema,
  CreateVideoBodySchema,
  PLANS,
  QUEUES,
  TtsCacheMetaSchema,
  VoiceSchema,
  api,
  applyVariables,
  collectModerationTexts,
  compositionFromScript,
  createComposition,
  duckingGainAt,
  localizeCatalogEntry,
  usesPhotorealAvatars,
} from './index';
import { avatarClipCacheKey, isSafeStorageKey, storageKeys } from './node/index';

describe('contract additions', () => {
  it('serves photorealistic stock avatar images through a dedicated public route', () => {
    const route = api.avatars.stockFile;
    expect(route.path).toBe('/api/stock-avatars/:avatarId/:file');
    expect(route.auth).toBe('public');
    expect(route.binary).toBe(true);
    expect(route.params.safeParse({ avatarId: 'real_ana', file: 'cutout' }).success).toBe(true);
    expect(route.params.safeParse({ avatarId: 'real_ana', file: 'other' }).success).toBe(false);
    expect(route.params.safeParse({ avatarId: 'stock_lucia', file: 'thumb' }).success).toBe(false);
    expect(route.params.safeParse({ avatarId: 'real_../x', file: 'thumb' }).success).toBe(false);
    expect(api.templates.thumbnail.params.safeParse({ templateId: 'tpl_abcdefgh' }).success).toBe(
      false,
    );
  });

  it('keeps the new DTO fields optional for producers and defaulted for consumers', () => {
    const avatar = AvatarSchema.parse({
      id: 'stock_lucia',
      kind: 'stock',
      rendering: 'instant',
      name: 'Lucía',
      gender: 'female',
      ageGroup: 'adult',
      style: 'professional',
      description: '',
      tags: [],
      traits: {},
      status: 'ready',
      thumbnailUrl: null,
      imageUrl: null,
      maskUrl: null,
      rig: null,
      prompt: null,
      provider: { id: 'canvas2d', name: 'Canvas', quality: 'basic', local: true },
      workspaceId: null,
      consentId: null,
      error: null,
      createdAt: null,
    });
    expect(avatar).toMatchObject({
      progress: 100,
      etaSec: null,
      cutoutUrl: null,
      seed: null,
      model: null,
    });
    const voice = VoiceSchema.parse({
      id: 'espeak:es-f1',
      kind: 'stock',
      name: 'Carmen',
      provider: { id: 'espeak', name: 'eSpeak', quality: 'basic', local: true },
      language: 'es',
      gender: 'female',
      description: '',
      tags: [],
      status: 'ready',
      workspaceId: null,
      consentId: null,
      profile: null,
      error: null,
      createdAt: null,
    });
    expect(voice.multilingual).toBe(false);
    const ref = { id: 'x', name: 'X', quality: 'basic' as const, local: true };
    const caps = CapabilitiesSchema.parse({
      active: {
        tts: ref,
        stt: ref,
        llm: ref,
        translation: ref,
        voiceClone: ref,
        lipsync: ref,
        portrait: ref,
        moderation: ref,
        storage: ref,
      },
      ttsProviders: [ref],
      sttRequiresTranscript: true,
      avatarEngine: {
        available: false,
        reason: 'stopped',
        device: null,
        secondsPerVideoSecond: null,
      },
    });
    expect(caps.avatarEngine).toMatchObject({
      operations: { generate: false, prepare: false, animate: false },
      models: [],
      nonCommercial: false,
      secondsPerPortrait: null,
    });
    expect(AssetSchema.shape.purpose.parse(undefined)).toBe('library');
    expect(
      TtsCacheMetaSchema.safeParse({ runtime: { visemes: [], words: [] }, provider: 'espeak' })
        .success,
    ).toBe(false);
  });

  it('lets a render job finish quietly when it was cancelled', () => {
    expect(
      QUEUES.render.result.safeParse({ canceled: true, videoId: 'vid_abcdefgh12345678' }).success,
    ).toBe(true);
    expect(QUEUES.render.result.safeParse({ canceled: true }).success).toBe(false);
  });

  it('accepts script as a client-settable video source only', () => {
    expect(CreateVideoBodySchema.safeParse({ source: 'script' }).success).toBe(true);
    expect(CreateVideoBodySchema.safeParse({ source: 'api' }).success).toBe(false);
    expect(CreateVideoBodySchema.safeParse({ source: 'batch' }).success).toBe(false);
  });

  it('bounds translation sources per plan and keeps limits ordered', () => {
    expect(PLANS.free.limits.maxTranslationSourceSec).toBeLessThan(
      PLANS.creator.limits.maxTranslationSourceSec,
    );
    expect(PLANS.creator.limits.maxTranslationSourceSec).toBeLessThan(
      PLANS.team.limits.maxTranslationSourceSec,
    );
  });

  it('localises catalogue entries', () => {
    const entry = {
      name: 'Aurora',
      description: 'Degradado violeta',
      tags: ['degradado'],
      en: { description: 'Violet gradient', tags: ['gradient'] },
    };
    expect(localizeCatalogEntry(entry, 'es')).toEqual({
      name: 'Aurora',
      description: 'Degradado violeta',
      tags: ['degradado'],
    });
    expect(localizeCatalogEntry(entry, 'en')).toEqual({
      name: 'Aurora',
      description: 'Violet gradient',
      tags: ['gradient'],
    });
  });
});

describe('compositionFromScript', () => {
  const options = { avatarId: 'stock_lucia', voiceId: 'espeak:es-f1', language: 'es' };

  it('builds one talking-avatar scene per entry for every aspect ratio', () => {
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      const comp = compositionFromScript(
        [
          { text: 'Hola {{nombre}}.', headline: 'Bienvenida', title: 'Intro' },
          { text: 'Segunda escena.' },
        ],
        { ...options, aspect },
      );
      expect(CompositionSchema.parse(comp)).toEqual(comp);
      expect(comp.canvas.aspect).toBe(aspect);
      expect(comp.scenes).toHaveLength(2);
      expect(comp.scenes[0]?.name).toBe('Intro');
      expect(comp.scenes[0]?.script).toMatchObject({ kind: 'tts', text: 'Hola {{nombre}}.' });
      expect(comp.scenes[0]?.layers.map((l) => l.type)).toEqual(['avatar', 'text']);
      expect(comp.scenes[1]?.layers.map((l) => l.type)).toEqual(['avatar']);
      expect(comp.scenes[1]?.transition.type).toBe('fade');
      for (const scene of comp.scenes) {
        for (const layer of scene.layers) {
          expect(layer.box.x).toBeGreaterThanOrEqual(0);
          expect(layer.box.x + layer.box.w).toBeLessThanOrEqual(1.0001);
          expect(layer.box.y + layer.box.h).toBeLessThanOrEqual(1.0001);
        }
      }
      expect(comp.subtitles.enabled).toBe(true);
    }
    expect(usesPhotorealAvatars(compositionFromScript([{ text: 'x' }], options))).toBe(false);
    const quiet = compositionFromScript([{ text: 'x' }], { ...options, subtitles: false });
    expect(quiet.subtitles.enabled).toBe(false);
  });
});

describe('collectModerationTexts', () => {
  it('returns scripts, transcripts and text layers with variables already applied', () => {
    const comp = createComposition({
      scenes: [
        {
          id: 's1',
          script: { kind: 'tts', text: 'Hola {{nombre}}', voiceId: 'espeak:es-f1', language: 'es' },
          layers: [
            {
              id: 'l1',
              type: 'text',
              text: 'Oferta para {{nombre}}',
              box: { x: 0, y: 0, w: 1, h: 0.2 },
            },
            { id: 'l2', type: 'text', text: '   ', box: { x: 0, y: 0, w: 1, h: 0.2 } },
          ],
        },
        {
          id: 's2',
          script: { kind: 'audio', assetId: 'ast_abcdefgh12345678', transcript: 'Texto del audio' },
        },
        { id: 's3', script: { kind: 'tts', text: '', voiceId: 'espeak:es-f1', language: 'es' } },
      ],
    });
    const texts = collectModerationTexts(applyVariables(comp, { nombre: 'Ana' }));
    expect(texts.map((t) => [t.sceneId, t.kind, t.layerId, t.text])).toEqual([
      ['s1', 'script', null, 'Hola Ana'],
      ['s1', 'text-layer', 'l1', 'Oferta para Ana'],
      ['s2', 'transcript', null, 'Texto del audio'],
    ]);
    expect(texts[0]?.language).toBe('es');
  });
});

describe('audio mix constants', () => {
  it('ducks the music around narration with linear ramps', () => {
    const windows = [{ startMs: 1000, endMs: 3000 }];
    expect(duckingGainAt(windows, 0)).toBe(1);
    expect(duckingGainAt(windows, 2000)).toBe(AUDIO_MIX.duckGain);
    const midAttack = duckingGainAt(windows, 1000 - AUDIO_MIX.duckAttackMs / 2);
    expect(midAttack).toBeGreaterThan(AUDIO_MIX.duckGain);
    expect(midAttack).toBeLessThan(1);
    const midRelease = duckingGainAt(windows, 3000 + AUDIO_MIX.duckReleaseMs / 2);
    expect(midRelease).toBeCloseTo((1 + AUDIO_MIX.duckGain) / 2, 5);
    expect(duckingGainAt(windows, 3000 + AUDIO_MIX.duckReleaseMs)).toBe(1);
    expect(duckingGainAt([], 500)).toBe(1);
  });
});

describe('storage keys (additions)', () => {
  it('types every avatar file and scopes neural clip caches', () => {
    const ws = 'ws_abcdefgh12345678';
    const avt = 'avt_abcdefgh12345678';
    for (const file of [
      'image.png',
      'mask.png',
      'cutout.png',
      'thumb.jpg',
      'source.png',
    ] as const) {
      const key = storageKeys.avatarFile(ws, avt, file);
      expect(key).toBe(`ws/${ws}/avatars/${avt}/${file}`);
      expect(isSafeStorageKey(key)).toBe(true);
    }
    const hash = avatarClipCacheKey({
      portraitSha: 'a'.repeat(64),
      maskSha: null,
      audioSha: 'b'.repeat(64),
      fps: 30,
      maxSize: 512,
      providerId: 'local-neural',
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      avatarClipCacheKey({
        portraitSha: 'a'.repeat(64),
        maskSha: null,
        audioSha: 'c'.repeat(64),
        fps: 30,
        maxSize: 512,
        providerId: 'local-neural',
      }),
    ).not.toBe(hash);
    const owned = storageKeys.avatarClipCache({ workspaceId: ws, avatarId: avt }, hash, 'clip.mp4');
    expect(owned.startsWith(storageKeys.avatarPrefix(ws, avt))).toBe(true);
    expect(storageKeys.avatarClipCache(null, hash, 'clip.json')).toBe(
      `cache/avatar-clips/${hash}/clip.json`,
    );
    expect(storageKeys.videoDraftThumb(ws, 'vid_abcdefgh12345678')).toBe(
      `ws/${ws}/videos/vid_abcdefgh12345678/draft-thumb.jpg`,
    );
    expect(
      storageKeys
        .templateThumb(ws, 'tpl_abcdefgh')
        .startsWith(storageKeys.templatePrefix(ws, 'tpl_abcdefgh')),
    ).toBe(true);
    expect(() => storageKeys.avatarClipCache(null, '../x', 'clip.mp4')).toThrow();
  });
});
