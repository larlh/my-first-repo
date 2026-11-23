import { describe, expect, it } from 'vitest';
import {
  BrandStyleSchema,
  COMPOSITION_LIMITS,
  CompositionSchema,
  LOCAL_VOICES,
  TEMPLATE_CATEGORIES,
  TemplateDetailSchema,
  TemplateSchema,
  api,
  applyBrandKit,
  applyVariables,
  checkVariableValues,
  cloneCompositionWithNewIds,
  collectAssetIds,
  collectAvatarIds,
  collectMediaRefs,
  collectModerationTexts,
  collectVoiceIds,
  estimateCompositionDurationMs,
  listUsedVariables,
  newId,
} from '@parlante/shared';
import type { Composition, RenderRuntime } from '@parlante/shared';
import { MapRenderAssets, computeTimeline, listStockAvatars } from '@parlante/renderer';
import { loadNodeImage, renderFrameToPng } from '@parlante/renderer/node';
import { getStockAssetDetails, getStockAssetMeta } from '@parlante/stock-assets';
import { getStockAssetData } from '@parlante/stock-assets/node';
import {
  BUILTIN_TEMPLATE_IDS,
  TEMPLATE_LOCALES,
  getBuiltinTemplate,
  getBuiltinTemplateMeta,
  listBuiltinTemplateMeta,
  listBuiltinTemplates,
  toTemplateDetailDto,
  toTemplateDto,
  validateBuiltinTemplates,
} from './index';

const REQUIRED_CATEGORIES = ['explainer', 'ad', 'training', 'news', 'product', 'greeting'] as const;

/** Every (template, language) pair. */
const all = TEMPLATE_LOCALES.flatMap((locale) =>
  listBuiltinTemplates(locale).map((template) => ({
    locale,
    template,
    label: `${template.id} [${locale}]`,
  })),
);

describe('built-in template catalogue', () => {
  it('is valid, uniquely identified and covers the six required kinds', () => {
    expect(() => validateBuiltinTemplates()).not.toThrow();
    const templates = listBuiltinTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(6);
    expect(templates.map((t) => t.id)).toEqual([...BUILTIN_TEMPLATE_IDS]);
    expect(new Set(BUILTIN_TEMPLATE_IDS).size).toBe(BUILTIN_TEMPLATE_IDS.length);
    const categories = new Set(templates.map((t) => t.category));
    for (const category of REQUIRED_CATEGORIES) expect(categories, category).toContain(category);
    for (const template of templates) {
      expect(TEMPLATE_CATEGORIES).toContain(template.category);
      expect(api.templates.thumbnail.params.safeParse({ templateId: template.id }).success).toBe(
        true,
      );
    }
    // Most templates carry brandable colour backgrounds (the rest are built on stock pictures).
    const brandable = templates.filter((t) =>
      t.composition.scenes.some((s) => s.background.type === 'color' && s.background.brandRole),
    );
    expect(brandable.length).toBeGreaterThanOrEqual(6);
    // The vertical ad really is vertical, and the three formats are represented.
    const ad = templates.find((t) => t.category === 'ad');
    expect(ad?.composition.canvas.aspect).toBe('9:16');
    expect(new Set(templates.map((t) => t.composition.canvas.aspect))).toEqual(
      new Set(['16:9', '9:16', '1:1']),
    );
  });

  it('exists in Spanish and English with the same design and a different script', () => {
    for (const id of BUILTIN_TEMPLATE_IDS) {
      const es = getBuiltinTemplate(id, 'es');
      const en = getBuiltinTemplate(id, 'en');
      if (!es || !en) throw new Error(id);
      expect(es.name.es).not.toBe(es.name.en);
      expect(es.description.es).not.toBe(es.description.en);
      expect(es.tags.length).toBeGreaterThanOrEqual(3);
      expect(en.tags.length).toBe(es.tags.length);
      expect(en.tags).not.toEqual(es.tags);
      expect(es.composition.canvas).toEqual(en.composition.canvas);
      expect(es.composition.music).toEqual(en.composition.music);
      expect(es.composition.variables.length).toBe(en.composition.variables.length);
      expect(es.composition.scenes.length).toBe(en.composition.scenes.length);
      es.composition.scenes.forEach((scene, i) => {
        const other = en.composition.scenes[i];
        if (!other) throw new Error(`${id} scene ${i}`);
        expect(other.id).toBe(scene.id);
        expect(other.background).toEqual(scene.background);
        expect(other.transition).toEqual(scene.transition);
        // Same layers in the same place; only the words change.
        const geometry = (layers: typeof scene.layers) =>
          layers.map((l) => ({ id: l.id, type: l.type, box: l.box, role: l.role, enter: l.enter }));
        expect(geometry(other.layers), `${id}/${scene.id}`).toEqual(geometry(scene.layers));
        if (scene.script.kind !== 'tts' || other.script.kind !== 'tts') {
          throw new Error(`${id}/${scene.id} has no narration`);
        }
        expect(scene.script.language).toBe('es');
        expect(other.script.language).toBe('en');
        expect(other.script.text, `${id}/${scene.id}`).not.toBe(scene.script.text);
      });
    }
    // Spanish is the default language.
    expect(getBuiltinTemplate('builtin_explainer')).toEqual(
      getBuiltinTemplate('builtin_explainer', 'es'),
    );
    expect(getBuiltinTemplate('builtin_nope')).toBeNull();
    expect(getBuiltinTemplate('builtin_nope', 'en')).toBeNull();
  });
});

describe.each(all)('$label', ({ template, locale }) => {
  const { composition } = template;

  it('is a complete multi-scene video with narration in every scene', () => {
    expect(CompositionSchema.parse(composition)).toEqual(composition);
    expect(composition.scenes.length).toBeGreaterThanOrEqual(3);
    expect(composition.subtitles.enabled).toBe(true);
    for (const scene of composition.scenes) {
      expect(scene.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(scene.name.length, scene.id).toBeGreaterThan(0);
      expect(scene.script.kind, scene.id).toBe('tts');
      if (scene.script.kind !== 'tts') continue;
      expect(scene.script.text.trim().length, scene.id).toBeGreaterThan(10);
      expect(scene.script.text.length).toBeLessThanOrEqual(COMPOSITION_LIMITS.maxScriptChars);
      expect(scene.script.language).toBe(locale);
      // One presenter per scene, and something to read on screen.
      expect(scene.layers.filter((l) => l.type === 'avatar').length, scene.id).toBe(1);
      expect(scene.layers.filter((l) => l.type === 'text').length, scene.id).toBeGreaterThan(0);
      for (const layer of scene.layers) {
        expect(layer.id, scene.id).toMatch(/^[a-z][a-z0-9-]*$/);
        if (layer.type === 'text') expect(layer.text.trim(), layer.id).not.toBe('');
        if (layer.type !== 'text') continue;
        // Readable text stays on the canvas and above the subtitle band.
        expect(layer.box.x, `${scene.id}/${layer.id}`).toBeGreaterThanOrEqual(0);
        expect(layer.box.x + layer.box.w, `${scene.id}/${layer.id}`).toBeLessThanOrEqual(1);
        expect(layer.box.y, `${scene.id}/${layer.id}`).toBeGreaterThanOrEqual(0);
        expect(layer.box.y + layer.box.h, `${scene.id}/${layer.id}`).toBeLessThanOrEqual(0.8);
      }
    }
    // The first scene never starts with a transition from nothing.
    expect(composition.scenes[0]?.transition.type).toBe('none');
  });

  it('only references avatars, voices and stock assets that exist', () => {
    expect(collectAssetIds(composition)).toEqual([]);
    const stockAvatars = new Map(listStockAvatars().map((a) => [a.id, a]));
    const avatarIds = collectAvatarIds(composition);
    expect(avatarIds.length).toBeGreaterThan(0);
    const voices = new Map(LOCAL_VOICES.map((v) => [`espeak:${v.providerVoiceId}`, v]));
    const voiceIds = collectVoiceIds(composition);
    expect(voiceIds.length).toBe(1);
    const voice = voices.get(voiceIds[0] ?? '');
    expect(voice, voiceIds[0]).toBeDefined();
    expect(voice?.language).toBe(locale);
    for (const avatarId of avatarIds) {
      const avatar = stockAvatars.get(avatarId);
      expect(avatar, avatarId).toBeDefined();
      // The voice matches the presenter (neutral presenters accept any voice).
      if (avatar && avatar.gender !== 'neutral') expect(voice?.gender).toBe(avatar.gender);
    }
    const uses = collectMediaRefs(composition);
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      if (use.ref.source !== 'stock') throw new Error(`${use.key} is not a stock asset`);
      const meta = getStockAssetMeta(use.ref.stockId);
      expect(meta, use.key).not.toBeNull();
      expect(meta?.kind, use.key).toBe(use.usage);
      expect(meta?.category, use.key).toBe(use.usage === 'audio' ? 'music' : 'background');
    }
    // A discreet music bed that ducks under the voice.
    const music = composition.music;
    expect(music).not.toBeNull();
    expect(music?.ducking).toBe(true);
    expect(music?.loop).toBe(true);
    expect(music?.volume).toBeGreaterThan(0.05);
    expect(music?.volume).toBeLessThanOrEqual(0.2);
    if (music?.src.source === 'stock') {
      expect(getStockAssetDetails(music.src.stockId)?.loop).toBe(true);
    }
  });

  it('declares exactly the variables it uses, each with a label and an example', () => {
    const declared = composition.variables.map((v) => v.name);
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual(listUsedVariables(composition).sort());
    for (const variable of composition.variables) {
      expect(variable.label.trim(), variable.name).not.toBe('');
      expect(variable.defaultValue.trim(), variable.name).not.toBe('');
    }
    expect(checkVariableValues(composition, {})).toEqual({ missing: [], unknown: [] });
    // With the examples applied nothing is left to fill in — in the script or on screen.
    const concrete = applyVariables(composition, {});
    for (const { text } of collectModerationTexts(concrete)) {
      expect(text).not.toMatch(/[{}]/);
      expect(text.trim()).not.toBe('');
    }
    // A value given by the user reaches the narration.
    const first = composition.variables[0];
    if (!first) throw new Error('no variables');
    const personalised = applyVariables(composition, { [first.name]: 'Zyxwv' });
    expect(JSON.stringify(personalised)).toContain('Zyxwv');
  });

  it('survives "use template" and a brand kit', () => {
    const copy = cloneCompositionWithNewIds(composition);
    expect(CompositionSchema.parse(copy)).toEqual(copy);
    expect(copy.scenes[0]?.id).not.toBe(composition.scenes[0]?.id);
    const brand = BrandStyleSchema.parse({
      id: newId('brandKit'),
      logoAssetId: null,
      colors: {
        primary: '#0055ff',
        secondary: '#002244',
        accent: '#ff3366',
        background: '#101010',
        text: '#fafafa',
      },
      fonts: { heading: 'Montserrat', body: 'Roboto Slab' },
    });
    const branded = applyBrandKit(composition, brand);
    expect(CompositionSchema.parse(branded)).toEqual(branded);
    // Every template gives the brand kit texts to restyle, and the result is still readable:
    // a text that takes the brand colour never sits directly on a LIGHT stock picture.
    const restyled = composition.scenes.flatMap((scene) =>
      scene.layers.flatMap((layer) => (layer.type === 'text' && layer.role ? [{ scene }] : [])),
    );
    expect(restyled.length).toBeGreaterThan(0);
    for (const { scene } of restyled) {
      const bg = scene.background;
      if (bg.type !== 'image' || bg.src.source !== 'stock') continue;
      const tone = getStockAssetDetails(bg.src.stockId)?.tone;
      expect(tone === 'light' && bg.dim < 0.4, `${scene.id} on ${bg.src.stockId}`).toBe(false);
    }
    expect(branded.brandKitId).toBe(brand.id);
    expect(branded.subtitles.fontFamily).toBe('Roboto Slab');
    expect(JSON.stringify(branded)).toContain('#fafafa');
  });

  it('has metadata (format, duration, references) and API DTOs in its language', () => {
    const meta = getBuiltinTemplateMeta(template.id, locale);
    if (!meta) throw new Error('meta');
    expect(listBuiltinTemplateMeta(locale).find((m) => m.id === template.id)).toEqual(meta);
    expect(meta).toMatchObject({
      name: template.name[locale],
      description: template.description[locale],
      category: template.category,
      aspect: composition.canvas.aspect,
      sceneCount: composition.scenes.length,
      languages: ['es', 'en'],
      tags: template.tags,
      variables: composition.variables,
      avatarIds: collectAvatarIds(composition),
      voiceIds: collectVoiceIds(composition),
      thumbnailUrl: `/api/templates/${template.id}/thumbnail`,
    });
    expect(meta.estimatedDurationMs).toBe(estimateCompositionDurationMs(composition));
    expect(meta.estimatedDurationMs).toBeGreaterThanOrEqual(10_000);
    expect(meta.estimatedDurationMs).toBeLessThanOrEqual(60_000);
    expect(meta.musicStockId).toMatch(/^music-/);
    expect(meta.stockIds).toContain(meta.musicStockId);
    expect(meta.stockIds.some((id) => id.startsWith('bg-'))).toBe(true);
    for (const id of meta.stockIds) expect(getStockAssetMeta(id), id).not.toBeNull();

    const dto = toTemplateDto(template, locale);
    expect(TemplateSchema.parse(dto)).toEqual(dto);
    expect(dto).toMatchObject({
      kind: 'builtin',
      workspaceId: null,
      name: template.name[locale],
      tags: template.tags,
      aspect: composition.canvas.aspect,
      sceneCount: composition.scenes.length,
      thumbnailUrl: meta.thumbnailUrl,
    });
    const detail = toTemplateDetailDto(template, locale);
    expect(TemplateDetailSchema.parse(detail)).toEqual(detail);
    expect(detail.composition).toEqual(composition);
    // Asking for the other language returns that language's script, whatever was passed in.
    const other = locale === 'es' ? 'en' : 'es';
    expect(toTemplateDetailDto(template, other).composition).toEqual(
      getBuiltinTemplate(template.id, other)?.composition,
    );
    expect(toTemplateDto(template, other).tags).toEqual(
      getBuiltinTemplate(template.id, other)?.tags,
    );
  });

  it('renders its first frame with the real renderer and stock backgrounds', async () => {
    const concrete = applyVariables(composition, {});
    const assets = new MapRenderAssets();
    for (const use of collectMediaRefs(concrete)) {
      if (use.usage !== 'image' || use.ref.source !== 'stock') continue;
      const data = await getStockAssetData(use.ref.stockId);
      assets.setImage(use.key, await loadNodeImage(data.bytes));
    }
    const runtime: RenderRuntime = { scenes: {} };
    const timeline = computeTimeline(concrete, runtime, { estimateMissing: true });
    expect(timeline.scenes.length).toBe(concrete.scenes.length);
    expect(Math.abs(timeline.totalMs - estimateCompositionDurationMs(concrete))).toBeLessThan(50);

    const width = concrete.canvas.width / 2;
    const height = concrete.canvas.height / 2;
    const render = (doc: Composition, tMs: number): Buffer =>
      renderFrameToPng(doc, tMs, runtime, assets, { timeline, width, height, subtitles: false });
    const first = render(concrete, 0);
    expect(first.subarray(1, 4).toString()).toBe('PNG');
    expect(first.readUInt32BE(16)).toBe(width);
    expect(first.readUInt32BE(20)).toBe(height);
    // Deterministic, and not an empty canvas: a second with the layers in place looks
    // different from a plain background-only version of the same scene.
    expect(render(concrete, 0).equals(first)).toBe(true);
    const settled = render(concrete, 1500);
    const bare: Composition = {
      ...concrete,
      scenes: concrete.scenes.map((scene) => ({ ...scene, layers: [] })),
    };
    expect(settled.equals(render(bare, 1500))).toBe(false);
    expect(settled.length).toBeGreaterThan(5_000);
  });
});

describe('registry API', () => {
  it('returns deep copies', () => {
    const a = getBuiltinTemplate('builtin_explainer');
    const b = getBuiltinTemplate('builtin_explainer');
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
    if (!a) return;
    const scenes = a.composition.scenes.length;
    a.composition.scenes.length = 0;
    a.tags.push('mutated');
    expect(getBuiltinTemplate('builtin_explainer')?.composition.scenes.length).toBe(scenes);
    expect(getBuiltinTemplate('builtin_explainer')?.tags).not.toContain('mutated');
    const listed = listBuiltinTemplates();
    listed.length = 0;
    expect(listBuiltinTemplates().length).toBe(BUILTIN_TEMPLATE_IDS.length);
    const meta = getBuiltinTemplateMeta('builtin_explainer');
    meta?.variables.splice(0);
    expect(getBuiltinTemplateMeta('builtin_explainer')?.variables.length).toBeGreaterThan(0);
    expect(getBuiltinTemplateMeta('builtin_nope')).toBeNull();
  });

  it('maps a template that is not in the registry as given', () => {
    const base = getBuiltinTemplate('builtin_explainer');
    if (!base) throw new Error('template');
    const custom = { ...base, id: 'builtin_unregistered', tags: ['x'] };
    const dto = toTemplateDetailDto(custom, 'en');
    expect(dto).toMatchObject({ id: 'builtin_unregistered', tags: ['x'], thumbnailUrl: null });
    expect(dto.composition).toEqual(base.composition);
  });
});
