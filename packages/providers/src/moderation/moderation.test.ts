import { describe, expect, it } from 'vitest';
import type { ModerationContext, ModerationResult } from '@parlante/shared';
import { providerEnvSchema } from '../env';
import {
  createLocalModerationProvider,
  createModerationProvider,
  parseExtraBlocklist,
} from './index';
import { normalizedVariants } from './normalize';

const moderation = createLocalModerationProvider({ MODERATION_EXTRA_BLOCKLIST: '' });

async function check(
  context: ModerationContext,
  text: string,
  language?: string,
): Promise<ModerationResult> {
  return moderation.check({ text, context, language });
}

async function categories(context: ModerationContext, text: string): Promise<string[]> {
  return (await check(context, text)).flags.map((flag) => flag.category).sort();
}

describe('text normalisation', () => {
  it('removes accents and case but keeps ñ apart from n', () => {
    expect(normalizedVariants('  ¡Cómo  FABRICAR… una Bomba!  ')).toContain(
      'como fabricar una bomba',
    );
    expect(normalizedVariants('El año del coño')).toContain('el año del coño');
    expect(normalizedVariants('ano')).not.toContain('año');
  });

  it('undoes leetspeak only inside words, stretched letters and spelled-out words', () => {
    expect(normalizedVariants('p0rn0 sh1t @ss')).toContain('porno shit ass');
    // Numbers and quantities are not words.
    expect(normalizedVariants('En 2024 crecimos un 15 % en 1080p')).toContain(
      'en 2024 crecimos un 15 en 1080p',
    );
    expect(normalizedVariants('fuuuuuck')).toContain('fuck');
    expect(normalizedVariants('asss')).toContain('ass');
    expect(normalizedVariants('f.u.c.k and f u c k')).toContain('fuck and fuck');
  });

  it('ignores invisible characters hidden inside a word (zero-width space, soft hyphen, BOM)', async () => {
    // Neither spoken nor drawn: the word reaches the voice and the subtitles intact.
    const hidden = 'bo\u200Bm\u00ADba ca\u200Dse\uFEFFra';
    expect(normalizedVariants(hidden)).toContain('bomba casera');
    const custom = createModerationProvider(
      providerEnvSchema.parse({ MODERATION_EXTRA_BLOCKLIST: 'acme corp' }),
    );
    expect(
      (await custom.check({ text: 'Mejor que Ac\u200Bme\u2060 Corp', context: 'script' })).allowed,
    ).toBe(false);
    expect((await custom.check({ text: 'Mejor que nadie\u200B', context: 'script' })).allowed).toBe(
      true,
    );
  });
});

describe('local moderation: general rules (every context)', () => {
  it('allows ordinary scripts in several languages and stamps the provider', async () => {
    for (const text of [
      'Hola, bienvenidos a nuestro curso de cocina. Hoy preparamos una tortilla de patatas.',
      'Welcome to the quarterly update. Sales grew 20 % and we assess the class of 2024.',
      'Bonjour et bienvenue dans cette formation sur la sécurité au travail.',
      'El año pasado abrimos tres oficinas. Scunthorpe, Essex y Cockburn están en la lista.',
      'Hace 10 años empezamos en un garaje. Hoy somos 200 personas.',
      'Matamos el tiempo jugando; el análisis del sexo de los pollitos es un oficio real.',
      '',
    ]) {
      const result = await check('script', text);
      expect(result, text).toMatchObject({ allowed: true, flags: [] });
      expect(result.provider).toEqual({
        id: 'local',
        name: 'Lista de bloqueo (local)',
        quality: 'basic',
        local: true,
      });
    }
  });

  it('blocks hate, explicit sex, threats and dangerous instructions', async () => {
    expect(await categories('script', 'Muerte a los inmigrantes, son una raza inferior')).toEqual([
      'hate',
    ]);
    expect(await categories('script', 'Watch free porn videos here')).toEqual(['sexual']);
    expect(await categories('chat', 'I will kill you')).toEqual(['violence']);
    expect(await categories('chat', 'te voy a matar, suicídate')).toEqual(['violence']);
    expect(await categories('translation', 'Cómo fabricar una bomba casera paso a paso')).toEqual([
      'dangerous',
    ]);
    expect(await categories('script', 'pornografía infantil')).toEqual(['sexual', 'sexual_minors']);
  });

  it('sees through accents, leetspeak, stretched and spelled-out words', async () => {
    for (const text of [
      'mira este p0rn0 gratis',
      'PÓRNÓ gratis',
      'k i l l   y o u r s e l f',
      'kill yourseeeelf',
      'k.y.s',
      'h3il h1tler',
    ]) {
      expect((await check('script', text)).allowed, text).toBe(false);
    }
  });

  it('never echoes the offending text and answers in the language of the request', async () => {
    const es = await check('script', 'te voy a matar', 'es');
    const en = await check('script', 'te voy a matar', 'en-US');
    const fallback = await check('script', 'te voy a matar');
    expect(es.flags[0]?.reason).toMatch(/amenazas/);
    expect(en.flags[0]?.reason).toMatch(/threats/);
    expect(fallback.flags[0]?.reason).toBe(es.flags[0]?.reason);
    for (const result of [es, en]) {
      expect(result.flags[0]?.reason).not.toMatch(/matar/);
      expect(result.flags[0]?.reason.length).toBeLessThan(220);
    }
  });

  it('scans long transcripts completely', async () => {
    const filler = 'Esta es una frase normal de una transcripción muy larga. '.repeat(900);
    expect(filler.length).toBeGreaterThan(40_000);
    expect((await check('translation', filler)).allowed).toBe(true);
    expect((await check('translation', `${filler} te voy a matar ${filler}`)).allowed).toBe(false);
    expect((await check('translation', `${filler} I will kill you`)).allowed).toBe(false);
  });
});

describe('local moderation: rules per context', () => {
  it('tolerates strong language in scripts, chat and transcripts but not in names', async () => {
    const text = 'Esto es una puta maravilla, joder';
    for (const context of ['script', 'chat', 'translation'] as const) {
      expect((await check(context, text)).allowed, context).toBe(true);
    }
    // A common Spanish nickname must not read as a slur.
    expect((await check('script', 'Hola, soy Kike y hoy os presento el curso.')).allowed).toBe(
      true,
    );
    expect(await categories('name', 'Mi avatar de mierda')).toEqual(['profanity']);
    expect(await categories('name', 'F*ck this voice')).toEqual([]);
    expect(await categories('name', 'Fuck this voice')).toEqual(['profanity']);
    expect((await check('name', 'Avatar de Ana (ventas 2024)')).allowed).toBe(true);
  });

  it('applies the operator blocklist (MODERATION_EXTRA_BLOCKLIST) in every context', async () => {
    expect(parseExtraBlocklist(' acme corp, compet* ,, x ,\n rival ')).toEqual([
      'acme corp',
      'compet*',
      'rival',
    ]);
    const custom = createModerationProvider(
      providerEnvSchema.parse({ MODERATION_EXTRA_BLOCKLIST: 'Acme Corp, compet*' }),
    );
    for (const context of ['script', 'chat', 'name', 'translation', 'avatar_prompt'] as const) {
      const result = await custom.check({ text: 'Mejor que ÁCME   corp', context });
      expect(
        result.flags.map((flag) => flag.category),
        context,
      ).toEqual(['custom']);
    }
    expect((await custom.check({ text: 'los competidores', context: 'script' })).allowed).toBe(
      false,
    );
    expect((await custom.check({ text: 'la compra', context: 'script' })).allowed).toBe(true);
    expect((await check('script', 'Mejor que Acme Corp')).allowed).toBe(true);
  });
});

describe('local moderation: avatar_prompt', () => {
  it('allows generic descriptions of synthetic adults', async () => {
    for (const text of [
      'mujer de 35 años, pelo castaño rizado, chaqueta azul marino y gafas',
      'a man in his 50s with a grey beard, Middle Eastern, navy suit',
      'doctora con 15 años de experiencia, bata blanca',
      'ingeniero con más de 12 años de experiencia',
      'hombre de 45 años que lleva 10 años en la empresa',
      'un hombre maduro y elegante con traje',
      'hombre negro de 40 años con barba corta, camisa blanca',
      'looks like a Latin American doctor in her forties',
      'una mujer llamada Ana, presentadora de noticias',
      'Young Woman With Short Hair And Glasses In A Studio',
      'kindergarten teacher, 40 years old, friendly smile',
      'child psychologist in her forties with a baby blue shirt',
      'mujer asiática de unos 30 años con el pelo recogido, estilo ejecutivo',
      'a designer in her thirties, glasses, in the style of Art Deco posters',
      'mujer de 50 años que bebe café, with a minor scar on the cheek',
    ]) {
      expect(await categories('avatar_prompt', text), text).toEqual([]);
    }
  });

  it('blocks real, identifiable people: names, likeness, offices, people the user knows', async () => {
    for (const text of [
      'elon musk',
      'a woman who looks like Taylor Swift',
      'Looks like Shakira',
      'un hombre parecido a Pedro Sánchez con traje',
      'una cantante al estilo de Rosalía',
      'a painter in the style of Vincent Van Gogh',
      'retrato de María García López, abogada',
      'photo of John Smith, our CFO',
      'una mujer igual que Zendaya pero rubia',
      'a man resembling Dwayne',
      'the president of France giving a speech',
      'el presidente del Gobierno en una rueda de prensa',
      'mi jefa, rubia con gafas',
      'my ex girlfriend',
      'a famous actor from the nineties',
      'deepfake of a politician',
      'OBAMA',
      'm e s s i',
    ]) {
      expect(await categories('avatar_prompt', text), text).toContain('real_person');
    }
    // The same names are fine in a script: only avatar descriptions are restricted.
    expect((await check('script', 'Hoy hablamos del discurso de Barack Obama')).allowed).toBe(true);
  });

  it('blocks minors: words and stated ages under 18', async () => {
    for (const text of [
      'a 15 year old student',
      'niña de 8 años con coletas',
      'un adolescente con sudadera',
      'teenage girl with braces',
      'a boy with a red cap',
      'mujer de 30 años con su hija de 5 años',
      'aged 16, blonde',
      'a 6 month old',
      'schoolgirl in uniform',
    ]) {
      expect(await categories('avatar_prompt', text), text).toContain('minor');
    }
    expect(await categories('avatar_prompt', 'a 19 year old student')).toEqual([]);
    expect(await categories('avatar_prompt', 'mujer de 18 años')).toEqual([]);
  });

  it('blocks sexualised descriptions and still applies the general rules', async () => {
    expect(await categories('avatar_prompt', 'sexy woman in lingerie')).toEqual([
      'sexualized_avatar',
    ]);
    expect(await categories('avatar_prompt', 'mujer desnuda')).toEqual(['sexualized_avatar']);
    expect(await categories('avatar_prompt', 'hombre con corbata de nudo ancho')).toEqual([]);
    expect(await categories('avatar_prompt', 'a nazi officer shouting heil hitler')).toContain(
      'hate',
    );
  });
});
