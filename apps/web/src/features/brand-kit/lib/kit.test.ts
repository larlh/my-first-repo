import { BrandColorsSchema, CompositionSchema, CreateBrandKitBodySchema } from '@parlante/shared';
import { describe, expect, it } from 'vitest';
import { makeBrandKit } from '@/features/avatars/kit/testing/fixtures';
import {
  contrastRatio,
  contrastWarnings,
  draftFromKit,
  draftProblem,
  emptyDraft,
  isDirty,
  kitBody,
  luminance,
} from './kit';
import { brandedSample, logoMediaKey, sampleComposition } from './sample';
import type { SampleTexts } from './sample';

const texts: SampleTexts = {
  eyebrow: 'Novedad',
  title: 'Tu marca en cada escena',
  subtitle: 'Así se verán tus vídeos',
  body: 'Colores, fuentes y logo.',
  script: ['Así se ve tu marca.', 'Colores, fuentes y logo.'],
  language: 'es',
};

describe('brand kit draft', () => {
  it('starts from the contract defaults and is valid for the API', () => {
    const draft = emptyDraft('Mi marca', true);
    expect(draft.colors).toEqual(BrandColorsSchema.parse({}));
    expect(draft.isDefault).toBe(true);
    expect(CreateBrandKitBodySchema.safeParse(kitBody(draft)).success).toBe(true);
    // The logo URL is only for drawing: it is never sent.
    expect(kitBody({ ...draft, logoUrl: 'http://x/y.png' })).not.toHaveProperty('logoUrl');
  });

  it('detects real changes only', () => {
    const saved = draftFromKit(makeBrandKit(1));
    expect(isDirty(saved, saved)).toBe(false);
    expect(isDirty({ ...saved, name: `${saved.name} ` }, saved)).toBe(false);
    expect(
      isDirty(
        { ...saved, colors: { ...saved.colors, primary: saved.colors.primary.toUpperCase() } },
        saved,
      ),
    ).toBe(false);
    expect(isDirty({ ...saved, colors: { ...saved.colors, accent: '#00ff00' } }, saved)).toBe(true);
    expect(isDirty({ ...saved, fonts: { ...saved.fonts, heading: 'Montserrat' } }, saved)).toBe(
      true,
    );
    expect(isDirty({ ...saved, isDefault: !saved.isDefault }, saved)).toBe(true);
    expect(isDirty({ ...saved, logoUrl: 'other-signature' }, saved)).toBe(false);
  });

  it('validates the name', () => {
    expect(draftProblem(emptyDraft('  ', false))).toBe('nameRequired');
    expect(draftProblem(emptyDraft('x'.repeat(61), false))).toBe('nameTooLong');
    expect(draftProblem(emptyDraft('Marca', false))).toBeNull();
  });
});

describe('contrast of the kit', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#fff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#ffffff80', '#000000')).toBeCloseTo(21, 0);
    expect(contrastRatio('nope', '#000000')).toBeNull();
    expect(luminance('#12')).toBeNull();
  });

  it('warns about text that will be hard to read in a video', () => {
    expect(contrastWarnings(BrandColorsSchema.parse({}))).toEqual([]);
    const warnings = contrastWarnings(
      BrandColorsSchema.parse({ text: '#ffffff', background: '#f5f5f5', primary: '#ffe066' }),
    );
    expect(warnings.map((warning) => warning.pair)).toEqual(['textOnBackground', 'textOnPrimary']);
    expect(warnings[0]?.ratio).toBeLessThan(3);
  });
});

describe('sample scene', () => {
  it('is a valid composition in the three formats', () => {
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      const composition = sampleComposition(aspect, texts);
      expect(CompositionSchema.safeParse(composition).success).toBe(true);
      expect(composition.canvas.aspect).toBe(aspect);
      expect(composition.scenes).toHaveLength(2);
    }
  });

  it('applies the kit with the shared applyBrandKit rules', () => {
    const draft = {
      logoAssetId: 'ast_0001abcdefgh1234',
      colors: BrandColorsSchema.parse({
        primary: '#112233',
        secondary: '#223344',
        accent: '#ff0066',
        background: '#001122',
        text: '#fafafa',
      }),
      fonts: { heading: 'Playfair Display' as const, body: 'Montserrat' as const },
    };
    const branded = brandedSample('16:9', texts, draft);
    expect(CompositionSchema.safeParse(branded).success).toBe(true);
    const [cover, message] = branded.scenes;
    expect(cover?.background).toMatchObject({ type: 'color', color: '#001122' });
    expect(message?.background).toMatchObject({ type: 'color', color: '#223344' });
    const layer = (id: string) => cover?.layers.find((item) => item.id === id);
    expect(layer('title')).toMatchObject({
      style: { fontFamily: 'Playfair Display', color: '#fafafa' },
    });
    expect(layer('eyebrow')).toMatchObject({
      style: { fontFamily: 'Montserrat', background: { color: '#112233' } },
    });
    expect(layer('rule')).toMatchObject({ fill: '#ff0066' });
    expect(layer('logo')).toMatchObject({
      src: { source: 'asset', assetId: 'ast_0001abcdefgh1234' },
    });
    expect(branded.subtitles).toMatchObject({
      fontFamily: 'Montserrat',
      highlightColor: '#ff0066',
    });
    expect(logoMediaKey(draft)).toBe('asset:ast_0001abcdefgh1234');
  });

  it('drops the logo layers when the kit has no logo', () => {
    const branded = brandedSample('1:1', texts, {
      logoAssetId: null,
      colors: BrandColorsSchema.parse({}),
      fonts: { heading: 'Poppins', body: 'Inter' },
    });
    expect(branded.scenes.flatMap((scene) => scene.layers).some((l) => l.role === 'logo')).toBe(
      false,
    );
    expect(logoMediaKey({ logoAssetId: null })).toBeNull();
  });
});
