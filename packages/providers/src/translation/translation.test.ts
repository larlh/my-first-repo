import { describe, expect, it } from 'vitest';
import { LANGUAGE_CODES } from '@parlante/shared';
import type { LanguageCode } from '@parlante/shared';
import { providerEnvSchema } from '../env';
import { fakeAnthropic } from '../llm/testing/fake-anthropic';
import type { Reply } from '../llm/testing/fake-anthropic';
import { createAnthropicTranslationProvider } from './anthropic';
import { glossarySize } from './glossary';
import { createTranslationProvider } from './index';
import { createLocalTranslationProvider, tokenize } from './local';

const local = createLocalTranslationProvider();

async function translate(
  texts: string[],
  sourceLanguage: LanguageCode,
  targetLanguage: LanguageCode,
) {
  return local.translate({ texts, sourceLanguage, targetLanguage });
}

describe('local translation (basic, glossary)', () => {
  it('is the provider without keys and declares itself basic', async () => {
    const provider = createTranslationProvider(providerEnvSchema.parse({}));
    expect(provider.info).toEqual({
      id: 'local',
      name: 'Traducción básica por glosario (local)',
      quality: 'basic',
      local: true,
    });
    const result = await provider.translate({
      texts: ['Hola'],
      sourceLanguage: 'es',
      targetLanguage: 'en',
    });
    expect(result).toEqual({ texts: ['Hello'], provider: provider.info, coverage: 1 });
  });

  it('keeps one output per segment, in order, including empty ones', async () => {
    const texts = ['Hola y gracias.', '', '   ', 'Hasta pronto.'];
    const result = await translate(texts, 'es', 'en');
    expect(result.texts).toEqual(['Hello and thank you.', '', '   ', 'See you soon.']);
  });

  it('never touches {{variables}}, numbers, time codes, URLs and e-mail addresses', async () => {
    const texts = [
      'Hola {{nombre}}, bienvenidos a este vídeo.',
      'Hola {{ first_name }} y {{empresa.nombre}}: gracias.',
      'El precio es 1.299,50 € (un 20 % menos) hasta las 18:30.',
      'De 00:01:02,500 a 00:01:05,000 hablamos de seguridad.',
      'Más información en https://parlante.dev/precios?plan=pro o en hola@parlante.dev.',
      'El 3º paso es el más importante de 2026.',
    ];
    const result = await translate(texts, 'es', 'en');
    expect(result.texts[0]).toBe('Hello {{nombre}}, welcome to this video.');
    expect(result.texts[1]).toBe('Hello {{ first_name }} and {{empresa.nombre}}: thank you.');
    const protectedOf = (text: string) =>
      tokenize(text)
        .filter((token) => token.kind === 'protected')
        .map((token) => token.value);
    for (const [index, text] of texts.entries()) {
      expect(protectedOf(result.texts[index]!), text).toEqual(protectedOf(text));
    }
    expect(protectedOf(texts[2]!)).toEqual(['1.299,50', '20 %', '18:30']);
    expect(protectedOf(texts[3]!)).toEqual(['00:01:02,500', '00:01:05,000']);
    expect(protectedOf(texts[4]!)).toEqual([
      'https://parlante.dev/precios?plan=pro',
      'hola@parlante.dev',
    ]);
    expect(result.texts[5]).toContain('3º');
    expect(result.texts[5]).toContain('2026');
  });

  it('substitutes known words and phrases, longest phrase first, keeping case and punctuation', async () => {
    expect(
      (await translate(['Gracias por ver este vídeo. ¡Hasta pronto!'], 'es', 'en')).texts,
    ).toEqual(['Thank you for watching this video. See you soon!']);
    expect((await translate(['GRACIAS POR TU ATENCIÓN'], 'es', 'en')).texts).toEqual([
      'THANK YOU FOR YOUR ATTENTION',
    ]);
    expect(
      (await translate(['Hola, gracias por ver este vídeo. Hasta pronto.'], 'es', 'de')).texts,
    ).toEqual(['Hallo, danke fürs Zuschauen. Bis bald.']);
    // Accents decide between words ("sí" yes / "si" if) but are optional when unambiguous.
    expect((await translate(['Sí, si es importante.'], 'es', 'en')).texts).toEqual([
      'Yes, if is important.',
    ]);
    expect((await translate(['hola, gracias por tu atencion'], 'es', 'en')).texts).toEqual([
      'hello, thank you for your attention',
    ]);
  });

  it('adds and removes the Spanish opening marks', async () => {
    expect(
      (await translate(['Hello {{name}}, welcome! Why is it important? Thank you.'], 'en', 'es'))
        .texts,
    ).toEqual(['¡Hola {{name}}, bienvenidos! ¿Por qué es it importante? Gracias.']);
    expect((await translate(['¿Por qué? ¡Gracias!'], 'es', 'fr')).texts).toEqual([
      'Pourquoi? Merci!',
    ]);
  });

  it('is honest about what it could not translate: unknown words stay, coverage says how much', async () => {
    const result = await translate(
      ['Nuestro termostato inteligente regula la calefacción automáticamente.'],
      'es',
      'en',
    );
    expect(result.texts[0]).toBe(
      'Our termostato inteligente regula the calefacción automáticamente.',
    );
    expect(result.coverage).toBe(0.286); // 2 of 7 words
    expect(result.provider.quality).toBe('basic');

    const good = await translate(['Hola, bienvenidos a este vídeo.'], 'es', 'en');
    expect(good.coverage).toBe(1);
    // Languages outside the six main ones only have a small core.
    const russian = await translate(['Hola y gracias. Hoy hablamos del precio.'], 'es', 'ru');
    expect(russian.texts[0]).toBe('Привет и спасибо. Сегодня hablamos del цена.');
    expect(russian.coverage).toBeCloseTo(5 / 7, 2);
    // Nothing to translate → nothing to warn about.
    expect((await translate(['{{a}} 12:30', ''], 'es', 'en')).coverage).toBe(1);
    expect(await translate(['Hola'], 'es', 'es')).toMatchObject({ texts: ['Hola'], coverage: 1 });
  });

  it('has a glossary for every supported language (large for six, a core for the rest)', () => {
    for (const language of ['es', 'en', 'fr', 'de', 'it', 'pt'] as const) {
      expect(glossarySize(language), language).toBeGreaterThan(250);
    }
    for (const language of LANGUAGE_CODES) {
      expect(glossarySize(language), language).toBeGreaterThanOrEqual(25);
    }
  });
});

describe('Anthropic translation (stub fetch — no API key in this environment)', () => {
  const env = providerEnvSchema.parse({ ANTHROPIC_API_KEY: 'test-key-not-real' });
  const answer = (segments: { index: number; text: string }[]): Reply => ({
    kind: 'json',
    text: JSON.stringify({ segments }),
  });

  it('is selected with the key and sends indexed segments with a structured output', async () => {
    expect(createTranslationProvider(env).info.id).toBe('anthropic');
    const fake = fakeAnthropic([
      answer([
        { index: 3, text: ' See you soon! ' },
        { index: 0, text: 'Hello {{nombre}}, welcome.' },
      ]),
    ]);
    const provider = createAnthropicTranslationProvider(env, { client: fake.client });
    const result = await provider.translate({
      texts: ['Hola {{nombre}}, bienvenidos.', '', '  ', '¡Hasta pronto!'],
      sourceLanguage: 'es',
      targetLanguage: 'en',
      context: 'Vídeo de bienvenida',
    });
    // Same length and order; pauses untouched; answers matched by index, not by position.
    expect(result).toEqual({
      texts: ['Hello {{nombre}}, welcome.', '', '  ', 'See you soon!'],
      provider: { id: 'anthropic', name: 'Anthropic Claude', quality: 'premium', local: false },
    });
    expect(fake.requests).toHaveLength(1);
    const body = fake.requests[0]!.body as {
      model: string;
      fallbacks: unknown;
      system: string;
      messages: { content: string }[];
      output_config: { effort: string; format: { type: string } };
    };
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.fallbacks).toBe('default');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.system).toContain('{{name}}');
    const brief = body.messages[0]!.content;
    expect(brief).toContain('Translate from Spanish (es) into English (en).');
    expect(brief).toContain('Context of the video: Vídeo de bienvenida');
    expect(brief).toContain(
      JSON.stringify([
        { index: 0, text: 'Hola {{nombre}}, bienvenidos.' },
        { index: 3, text: '¡Hasta pronto!' },
      ]),
    );
  });

  it('retries once when a placeholder is altered or a segment is missing, then fails loudly', async () => {
    const texts = ['Hola {{nombre}}.', 'Tienes {{puntos}} puntos.'];
    const request = { texts, sourceLanguage: 'es', targetLanguage: 'en' } as const;

    const repaired = fakeAnthropic([
      answer([
        { index: 0, text: 'Hello {{name}}.' }, // translated the variable: rejected
        { index: 1, text: 'You have {{puntos}} points.' },
      ]),
      answer([
        { index: 0, text: 'Hello {{nombre}}.' },
        { index: 1, text: 'You have {{puntos}} points.' },
      ]),
    ]);
    const result = await createAnthropicTranslationProvider(env, {
      client: repaired.client,
    }).translate(request);
    expect(result.texts).toEqual(['Hello {{nombre}}.', 'You have {{puntos}} points.']);
    expect(repaired.requests).toHaveLength(2);
    expect((repaired.requests[1]!.body.messages as { content: string }[])[0]!.content).toContain(
      'A previous attempt was rejected because segment 0 changed its {{placeholders}}',
    );

    const broken = fakeAnthropic([answer([{ index: 0, text: 'Hello {{nombre}}.' }])]);
    await expect(
      createAnthropicTranslationProvider(env, { client: broken.client }).translate(request),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('segment 1 has no translation'),
    });
    expect(broken.requests).toHaveLength(2);
  });

  it('splits long transcripts into batches and skips the API when there is nothing to do', async () => {
    const texts = Array.from({ length: 170 }, (_unused, i) => `Frase número ${i}.`);
    const fake = fakeAnthropic([{ kind: 'json', text: '{}' }]);
    // Echo translator: answers each batch with its own segments, upper-cased.
    let call = 0;
    const provider = createAnthropicTranslationProvider(env, { client: fake.client });
    fake.replies.length = 0;
    const sizes = [80, 80, 10];
    let offset = 0;
    for (const size of sizes) {
      fake.replies.push(
        answer(
          Array.from({ length: size }, (_unused, i) => ({
            index: offset + i,
            text: `SENTENCE ${offset + i}.`,
          })),
        ),
      );
      offset += size;
      call += 1;
    }
    const result = await provider.translate({ texts, sourceLanguage: 'es', targetLanguage: 'en' });
    expect(call).toBe(3);
    expect(fake.requests).toHaveLength(3);
    expect(result.texts).toHaveLength(170);
    expect(result.texts[0]).toBe('SENTENCE 0.');
    expect(result.texts[169]).toBe('SENTENCE 169.');

    const idle = fakeAnthropic([{ kind: 'json', text: '{}' }]);
    const same = createAnthropicTranslationProvider(env, { client: idle.client });
    expect(
      (await same.translate({ texts: ['Hola'], sourceLanguage: 'es', targetLanguage: 'es' })).texts,
    ).toEqual(['Hola']);
    expect(
      (await same.translate({ texts: ['', ' '], sourceLanguage: 'es', targetLanguage: 'en' }))
        .texts,
    ).toEqual(['', ' ']);
    expect(idle.requests).toHaveLength(0);
  });

  it('maps refusals and API errors', async () => {
    const run = (reply: Reply) =>
      createAnthropicTranslationProvider(env, { client: fakeAnthropic([reply]).client })
        .translate({ texts: ['Hola'], sourceLanguage: 'es', targetLanguage: 'en' })
        .catch((err: unknown) => err);
    expect(await run({ kind: 'json', text: '', stopReason: 'refusal' })).toMatchObject({
      code: 'CONTENT_BLOCKED',
    });
    expect(await run({ kind: 'json', text: 'not json' })).toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('unexpected format'),
    });
    expect(
      await run({ kind: 'error', status: 401, type: 'authentication_error', message: 'bad key' }),
    ).toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  });
});
