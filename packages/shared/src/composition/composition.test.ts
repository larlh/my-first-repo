import { describe, expect, it } from 'vitest';
import { newId } from '../ids';
import {
  COMPOSITION_VERSION,
  CompositionMigrationError,
  CompositionSchema,
  applyBrandKit,
  applyVariables,
  checkVariableValues,
  cloneCompositionWithNewIds,
  collectAssetIds,
  collectAvatarIds,
  collectMediaRefs,
  collectVoiceIds,
  createComposition,
  createLayer,
  createScene,
  estimateCompositionDurationMs,
  extractPlaceholders,
  listUsedVariables,
  migrateComposition,
  resolutionSize,
  sceneDurationMs,
  syncVariableDefs,
  usesPhotorealAvatars,
  withAspect,
} from './index';
import type { Composition } from './index';

const ASSET_A = 'ast_aaaaaaaaaaaaaaaa';
const ASSET_B = 'ast_bbbbbbbbbbbbbbbb';

function fullComposition(): Composition {
  return createComposition({
    aspect: '16:9',
    scenes: [
      {
        name: 'Intro',
        script: {
          kind: 'tts',
          text: 'Hola {{nombre}}, bienvenido a {{empresa}}.',
          voiceId: 'espeak:es-f1',
          language: 'es',
        },
        background: { type: 'image', src: { source: 'asset', assetId: ASSET_A } },
        transition: { type: 'fade', durationMs: 400 },
        layers: [
          {
            type: 'avatar',
            avatarId: 'stock_lucia',
            box: { x: 0.55, y: 0.1, w: 0.4, h: 0.9 },
          },
          {
            type: 'text',
            text: 'Hola {{nombre}}',
            role: 'title',
            box: { x: 0.05, y: 0.1, w: 0.45, h: 0.2 },
            style: { background: { color: '#000000' } },
          },
          {
            type: 'image',
            role: 'logo',
            src: { source: 'stock', stockId: 'logo-placeholder' },
            box: { x: 0.05, y: 0.8, w: 0.1, h: 0.1 },
          },
          { type: 'shape', role: 'accent', box: { x: 0, y: 0.95, w: 1, h: 0.05 } },
          {
            type: 'video',
            src: { source: 'asset', assetId: ASSET_B },
            box: { x: 0.1, y: 0.4, w: 0.3, h: 0.3 },
          },
        ],
      },
      {
        name: 'Cierre',
        duration: { mode: 'fixed', seconds: 4 },
        background: { type: 'color', color: '#112233', brandRole: 'background' },
        script: { kind: 'audio', assetId: ASSET_B, transcript: 'Adiós {{nombre}}' },
      },
    ],
  });
}

describe('CompositionSchema', () => {
  it('accepts a minimal document and applies defaults', () => {
    const comp = CompositionSchema.parse({
      version: 1,
      canvas: { aspect: '9:16', width: 720, height: 1280 },
      scenes: [{ id: 's1' }],
    });
    expect(comp.canvas.fps).toBe(30);
    expect(comp.scenes[0]?.script).toEqual({ kind: 'none' });
    expect(comp.scenes[0]?.duration).toEqual({ mode: 'auto' });
    expect(comp.scenes[0]?.transition.type).toBe('none');
    expect(comp.subtitles.enabled).toBe(true);
    expect(comp.music).toBeNull();
    expect(comp.variables).toEqual([]);
  });

  it('accepts a full document with every layer type', () => {
    const comp = fullComposition();
    expect(comp.version).toBe(COMPOSITION_VERSION);
    expect(comp.scenes[0]?.layers.map((l) => l.type)).toEqual([
      'avatar',
      'text',
      'image',
      'shape',
      'video',
    ]);
    const text = comp.scenes[0]?.layers[1];
    expect(text?.type === 'text' && text.style.fontFamily).toBe('Inter');
    // Round-trips through JSON and re-validates unchanged.
    expect(CompositionSchema.parse(JSON.parse(JSON.stringify(comp)))).toEqual(comp);
  });

  it.each([
    ['no scenes', { version: 1, canvas: { aspect: '16:9', width: 1280, height: 720 }, scenes: [] }],
    [
      'wrong version',
      { version: 2, canvas: { aspect: '16:9', width: 1280, height: 720 }, scenes: [{ id: 'a' }] },
    ],
    [
      'canvas not matching aspect',
      { version: 1, canvas: { aspect: '16:9', width: 720, height: 720 }, scenes: [{ id: 'a' }] },
    ],
    [
      'fps other than 30',
      {
        version: 1,
        canvas: { aspect: '16:9', width: 1280, height: 720, fps: 25 },
        scenes: [{ id: 'a' }],
      },
    ],
    [
      'duplicate scene ids',
      {
        version: 1,
        canvas: { aspect: '16:9', width: 1280, height: 720 },
        scenes: [{ id: 'a' }, { id: 'a' }],
      },
    ],
    [
      'bad colour',
      {
        version: 1,
        canvas: { aspect: '16:9', width: 1280, height: 720 },
        scenes: [{ id: 'a', background: { type: 'color', color: 'red' } }],
      },
    ],
    [
      'free URL as media source',
      {
        version: 1,
        canvas: { aspect: '16:9', width: 1280, height: 720 },
        scenes: [
          {
            id: 'a',
            background: { type: 'image', src: { source: 'url', url: 'http://169.254.169.254/' } },
          },
        ],
      },
    ],
    [
      'unknown layer type',
      {
        version: 1,
        canvas: { aspect: '16:9', width: 1280, height: 720 },
        scenes: [
          { id: 'a', layers: [{ id: 'l', type: 'iframe', box: { x: 0, y: 0, w: 1, h: 1 } }] },
        ],
      },
    ],
    [
      'layer box with zero width',
      {
        version: 1,
        canvas: { aspect: '16:9', width: 1280, height: 720 },
        scenes: [
          {
            id: 'a',
            layers: [{ id: 'l', type: 'shape', box: { x: 0, y: 0, w: 0, h: 1 } }],
          },
        ],
      },
    ],
    [
      'invalid voice id',
      {
        version: 1,
        canvas: { aspect: '16:9', width: 1280, height: 720 },
        scenes: [
          { id: 'a', script: { kind: 'tts', text: 'hola', voiceId: 'nope', language: 'es' } },
        ],
      },
    ],
    [
      'unsupported language',
      {
        version: 1,
        canvas: { aspect: '16:9', width: 1280, height: 720 },
        scenes: [
          {
            id: 'a',
            script: { kind: 'tts', text: 'hola', voiceId: 'espeak:es', language: 'zz' },
          },
        ],
      },
    ],
    [
      'duplicate variables',
      {
        version: 1,
        canvas: { aspect: '16:9', width: 1280, height: 720 },
        scenes: [{ id: 'a' }],
        variables: [{ name: 'x' }, { name: 'x' }],
      },
    ],
  ])('rejects %s', (_name, doc) => {
    expect(CompositionSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects duplicate layer ids inside a scene and reports the path', () => {
    const result = CompositionSchema.safeParse({
      version: 1,
      canvas: { aspect: '1:1', width: 720, height: 720 },
      scenes: [
        {
          id: 'a',
          layers: [
            { id: 'l', type: 'shape', box: { x: 0, y: 0, w: 1, h: 1 } },
            { id: 'l', type: 'shape', box: { x: 0, y: 0, w: 1, h: 1 } },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['scenes', 0, 'layers', 1, 'id']);
  });
});

describe('migrateComposition', () => {
  it('returns current-version documents validated and defaulted', () => {
    const comp = fullComposition();
    expect(migrateComposition(JSON.parse(JSON.stringify(comp)))).toEqual(comp);
  });

  it('upgrades unversioned (v0) documents', () => {
    const migrated = migrateComposition({
      canvas: { format: '9:16' },
      scenes: [
        { id: 'a', script: 'Texto sin voz', durationSeconds: 5 },
        { id: 'b', script: { text: 'Hola', voiceId: 'espeak:es-f1' } },
      ],
    });
    expect(migrated.version).toBe(1);
    expect(migrated.canvas).toEqual({ aspect: '9:16', width: 720, height: 1280, fps: 30 });
    expect(migrated.scenes[0]?.duration).toEqual({ mode: 'fixed', seconds: 5 });
    expect(migrated.scenes[0]?.script).toEqual({ kind: 'none' });
    expect(migrated.scenes[0]?.name).toBe('Texto sin voz');
    expect(migrated.scenes[1]?.script).toMatchObject({
      kind: 'tts',
      text: 'Hola',
      voiceId: 'espeak:es-f1',
      language: 'es',
      speed: 1,
    });
  });

  it('refuses documents from a newer version', () => {
    expect(() => migrateComposition({ version: 99, scenes: [] })).toThrow(
      CompositionMigrationError,
    );
  });

  it('refuses non-objects and bad version values', () => {
    expect(() => migrateComposition(null)).toThrow(CompositionMigrationError);
    expect(() => migrateComposition({ version: 'one' })).toThrow(CompositionMigrationError);
  });

  it('still validates after migrating', () => {
    expect(() => migrateComposition({ canvas: { format: '16:9' }, scenes: [] })).toThrow();
  });
});

describe('factories', () => {
  it('createComposition builds a valid single-scene document per aspect', () => {
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      const comp = createComposition({ aspect });
      expect(comp.scenes).toHaveLength(1);
      expect(comp.canvas.aspect).toBe(aspect);
      expect(CompositionSchema.safeParse(comp).success).toBe(true);
    }
  });

  it('createScene / createLayer generate ids', () => {
    const scene = createScene({ layers: [{ type: 'shape', box: { x: 0, y: 0, w: 1, h: 1 } }] });
    expect(scene.id).toMatch(/^scn_/);
    expect(scene.layers[0]?.id).toMatch(/^lyr_/);
    const layer = createLayer({ type: 'text', text: 'x', box: { x: 0, y: 0, w: 1, h: 1 } });
    expect(layer.type === 'text' && layer.style.fontSize).toBeGreaterThan(0);
  });

  it('cloneCompositionWithNewIds changes every id but nothing else', () => {
    const comp = fullComposition();
    const clone = cloneCompositionWithNewIds(comp);
    expect(clone.scenes[0]?.id).not.toBe(comp.scenes[0]?.id);
    expect(clone.scenes[0]?.layers[0]?.id).not.toBe(comp.scenes[0]?.layers[0]?.id);
    expect(clone.scenes[0]?.name).toBe('Intro');
    expect(CompositionSchema.safeParse(clone).success).toBe(true);
  });

  it('withAspect swaps the canvas preset', () => {
    expect(withAspect(fullComposition(), '1:1').canvas).toMatchObject({ width: 720, height: 720 });
  });

  it('resolutionSize returns even output sizes', () => {
    expect(resolutionSize('16:9', '720p')).toEqual({ width: 1280, height: 720 });
    expect(resolutionSize('16:9', '1080p')).toEqual({ width: 1920, height: 1080 });
    expect(resolutionSize('9:16', '1080p')).toEqual({ width: 1080, height: 1920 });
    expect(resolutionSize('1:1', '1080p')).toEqual({ width: 1080, height: 1080 });
  });
});

describe('variables', () => {
  it('extracts placeholders tolerant to whitespace, unique, in order', () => {
    expect(extractPlaceholders('Hola {{ nombre }} de {{empresa}} y {{nombre}}')).toEqual([
      'nombre',
      'empresa',
    ]);
    expect(extractPlaceholders('sin variables { {x} }')).toEqual([]);
  });

  it('lists variables used in scripts, transcripts and text layers', () => {
    expect(listUsedVariables(fullComposition())).toEqual(['nombre', 'empresa']);
  });

  it('syncVariableDefs keeps declared defaults and adds missing ones', () => {
    const comp = fullComposition();
    comp.variables = [
      { name: 'nombre', label: 'Nombre', defaultValue: 'amiga' },
      { name: 'obsoleta', label: '', defaultValue: '' },
    ];
    expect(syncVariableDefs(comp)).toEqual([
      { name: 'nombre', label: 'Nombre', defaultValue: 'amiga' },
      { name: 'empresa', label: '', defaultValue: '' },
    ]);
  });

  it('checkVariableValues reports missing and unknown names', () => {
    const comp = fullComposition();
    comp.variables = [{ name: 'empresa', label: '', defaultValue: 'Parlante' }];
    expect(checkVariableValues(comp, { otra: 'x' })).toEqual({
      missing: ['nombre'],
      unknown: ['otra'],
    });
    expect(checkVariableValues(comp, { nombre: 'Ana' })).toEqual({ missing: [], unknown: [] });
  });

  it('applyVariables replaces everywhere, falls back to defaults, and does not mutate', () => {
    const comp = fullComposition();
    comp.variables = [{ name: 'empresa', label: '', defaultValue: 'Parlante' }];
    const out = applyVariables(comp, { nombre: 'Ana' });
    const script = out.scenes[0]?.script;
    expect(script?.kind === 'tts' && script.text).toBe('Hola Ana, bienvenido a Parlante.');
    const text = out.scenes[0]?.layers[1];
    expect(text?.type === 'text' && text.text).toBe('Hola Ana');
    const audio = out.scenes[1]?.script;
    expect(audio?.kind === 'audio' && audio.transcript).toBe('Adiós Ana');
    expect(out.variables).toEqual([]);
    expect(listUsedVariables(out)).toEqual([]);
    expect(listUsedVariables(comp)).toEqual(['nombre', 'empresa']);
  });

  it('applyVariables does not re-interpolate injected values', () => {
    const comp = fullComposition();
    const out = applyVariables(comp, { nombre: '{{empresa}}', empresa: 'X' });
    const script = out.scenes[0]?.script;
    expect(script?.kind === 'tts' && script.text).toBe('Hola {{empresa}}, bienvenido a X.');
  });
});

describe('references', () => {
  it('collects media refs with usage, de-duplicated', () => {
    const refs = collectMediaRefs(fullComposition());
    expect(refs.map((r) => `${r.usage}|${r.key}`).sort()).toEqual(
      [
        `image|asset:${ASSET_A}`,
        'image|stock:logo-placeholder',
        `video|asset:${ASSET_B}`,
        `audio|asset:${ASSET_B}`,
      ].sort(),
    );
  });

  it('collects asset, avatar and voice ids', () => {
    const comp = fullComposition();
    expect(collectAssetIds(comp).sort()).toEqual([ASSET_A, ASSET_B]);
    expect(collectAvatarIds(comp)).toEqual(['stock_lucia']);
    expect(collectVoiceIds(comp)).toEqual(['espeak:es-f1']);
    expect(usesPhotorealAvatars(comp)).toBe(false);
    const layer = comp.scenes[0]?.layers[0];
    if (layer?.type === 'avatar') layer.avatarId = 'real_ana';
    expect(usesPhotorealAvatars(comp)).toBe(true);
  });
});

describe('applyBrandKit', () => {
  it('restyles role-tagged layers only and records the kit id', () => {
    const comp = fullComposition();
    const brandId = newId('brandKit');
    const out = applyBrandKit(comp, {
      id: brandId,
      logoAssetId: ASSET_A,
      colors: {
        primary: '#ff0000',
        secondary: '#00ff00',
        accent: '#0000ff',
        background: '#111111',
        text: '#eeeeee',
      },
      fonts: { heading: 'Poppins', body: 'Montserrat' },
    });
    expect(out.brandKitId).toBe(brandId);
    const [avatar, title, logo, accent] = out.scenes[0]?.layers ?? [];
    expect(avatar).toEqual(comp.scenes[0]?.layers[0]);
    expect(title?.type === 'text' && title.style).toMatchObject({
      fontFamily: 'Poppins',
      color: '#eeeeee',
      background: { color: '#ff0000' },
    });
    expect(logo?.type === 'image' && logo.src).toEqual({ source: 'asset', assetId: ASSET_A });
    expect(accent?.type === 'shape' && accent.fill).toBe('#0000ff');
    expect(out.scenes[1]?.background).toMatchObject({ type: 'color', color: '#111111' });
    expect(out.subtitles.fontFamily).toBe('Montserrat');
    // input untouched
    expect(comp.brandKitId).toBeNull();
    expect(CompositionSchema.safeParse(out).success).toBe(true);
  });
});

describe('duration estimates', () => {
  it('applies the scene duration rule', () => {
    const comp = fullComposition();
    const [auto, fixed] = comp.scenes;
    if (!auto || !fixed) throw new Error('fixture');
    expect(sceneDurationMs(auto, 2000)).toBe(300 + 2000 + 500);
    expect(sceneDurationMs(auto, 0)).toBe(3000);
    expect(sceneDurationMs(fixed, 10_000)).toBe(4000);
  });

  it('estimates the total from text length and fixed scenes', () => {
    const comp = fullComposition();
    const total = estimateCompositionDurationMs(comp);
    expect(total).toBeGreaterThan(4000 + 1000);
    expect(total).toBeLessThan(4000 + 10_000);
  });
});
