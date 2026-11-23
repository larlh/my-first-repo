import { describe, expect, it } from 'vitest';
import { GeneratedScriptSchema, LANGUAGE_CODES, ScriptToneSchema } from '@parlante/shared';
import type { GeneratedScript, ScriptGenerationRequest } from '@parlante/shared';
import { providerEnvSchema } from '../env';
import { createLlmProvider } from './index';
import { parseKnowledge } from './local-chat';
import { createLocalLlmProvider } from './local';
import { splitSentences } from './text';

const llm = createLocalLlmProvider();

const script = (request: Partial<ScriptGenerationRequest> & { topic: string }) =>
  llm.generateScript({ tone: 'professional', durationSec: 60, language: 'es', ...request });

const totalSec = (result: GeneratedScript) =>
  result.scenes.reduce((sum, scene) => sum + scene.estimatedSec, 0);
const fullText = (result: GeneratedScript) => result.scenes.map((scene) => scene.text).join(' ');

const SOLAR = `La energía solar fotovoltaica convierte la luz del sol en electricidad mediante paneles. En España, el autoconsumo creció un 30 % en 2023. Una instalación doméstica típica tiene entre 6 y 10 paneles. El coste medio ronda los 6.000 euros y se amortiza en unos siete años.
Aceptar cookies. Suscríbete a nuestra newsletter. Más información en https://ejemplo.es/solar
Los paneles duran más de 25 años con un mantenimiento mínimo. Además, existen deducciones fiscales para quienes instalan paneles. La batería permite usar la energía solar por la noche, aunque encarece la instalación. Antes de instalar, conviene revisar la orientación del tejado y las sombras. Un instalador certificado puede calcular el ahorro exacto según el consumo de la vivienda.`;

describe('local LLM: selection and honesty', () => {
  it('is the provider without keys and says it is basic', async () => {
    const provider = createLlmProvider(providerEnvSchema.parse({}));
    expect(provider.info).toEqual({
      id: 'local',
      name: 'Modo básico (local)',
      quality: 'basic',
      local: true,
    });
    const result = await provider.generateScript({
      topic: 'La seguridad en el trabajo',
      tone: 'professional',
      durationSec: 30,
      language: 'es',
    });
    expect(result.basicMode).toBe(true);
    expect(result.provider).toEqual(provider.info);
    expect(
      (
        await provider.chat({
          persona: { name: 'Ana', instructions: '', knowledge: '' },
          language: 'es',
          messages: [],
        })
      ).provider,
    ).toEqual(provider.info);
  });
});

describe('local script writer: from a topic', () => {
  it('builds opening, body and closing around the topic, in Spanish', async () => {
    const result = await script({ topic: 'Cómo ahorrar energía en casa', durationSec: 60 });
    expect(GeneratedScriptSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      title: 'Cómo ahorrar energía en casa',
      language: 'es',
      basicMode: true,
      sourceTitle: null,
    });
    expect(result.scenes.map((scene) => scene.title)).toEqual([
      'Introducción',
      'Qué es',
      'Por qué importa',
      'Cómo empezar',
      'Cierre',
    ]);
    // The topic reads naturally inside the sentence and keeps its form after a colon.
    expect(result.scenes[0]!.text).toMatch(/^Hoy hablamos de cómo ahorrar energía en casa\./);
    expect(result.scenes.at(-1)!.text).toContain(
      'idea principal de hoy: Cómo ahorrar energía en casa.',
    );
    expect(result.scenes[0]!.headline).toBe('Cómo ahorrar energía en casa');
    for (const scene of result.scenes) {
      expect(scene.text).not.toMatch(/[{}]/);
      expect(scene.headline.length).toBeLessThanOrEqual(48);
      expect(scene.estimatedSec).toBeGreaterThan(2);
    }
  });

  it('fits the requested duration (Spanish and English, 20 s to 2 min)', async () => {
    for (const language of ['es', 'en'] as const) {
      for (const durationSec of [20, 30, 45, 60, 90, 120]) {
        const result = await script({
          topic: language === 'es' ? 'La seguridad en el trabajo' : 'Workplace safety',
          language,
          durationSec,
        });
        const total = totalSec(result);
        expect(total, `${language} ${durationSec}s → ${total}s`).toBeGreaterThan(durationSec * 0.8);
        expect(total, `${language} ${durationSec}s → ${total}s`).toBeLessThan(durationSec * 1.15);
      }
    }
  });

  it('writes a single short scene for a ten-second video and never exceeds what it has', async () => {
    const short = await script({
      topic: 'remote work',
      language: 'en',
      tone: 'humorous',
      durationSec: 10,
    });
    expect(short.scenes).toHaveLength(1);
    expect(short.scenes[0]!.text).toMatch(/^Today we are talking about remote work\./);
    expect(totalSec(short)).toBeLessThan(13);

    // Ten minutes cannot be filled with scaffolding: the estimate says how long it really is.
    const long = await script({ topic: 'Workplace safety', language: 'en', durationSec: 600 });
    expect(long.scenes.length).toBe(9);
    expect(totalSec(long)).toBeLessThan(260);
    expect(new Set(long.scenes.map((scene) => scene.text)).size).toBe(long.scenes.length);
  });

  it('changes voice with the tone', async () => {
    const openings = new Map<string, string>();
    for (const tone of ScriptToneSchema.options) {
      for (const language of ['es', 'en'] as const) {
        const result = await script({ topic: 'Parlante Studio', tone, language, durationSec: 45 });
        openings.set(`${language}:${tone}`, result.scenes[0]!.text);
        expect(fullText(result)).toContain('Parlante Studio');
      }
    }
    expect(new Set(openings.values()).size).toBe(12);
    expect(openings.get('es:friendly')).toMatch(/^¡Hola!/);
    expect(openings.get('en:educational')).toMatch(/^In this lesson/);
    expect(openings.get('es:humorous')).toMatch(/no habrá examen/);
  });

  it('gives each key point typed by the user its own scene', async () => {
    const result = await script({
      topic: 'Parlante Studio: editor multiescena, avatares fotorrealistas y exportación en MP4',
      tone: 'friendly',
      durationSec: 45,
      audience: 'equipos de marketing',
    });
    expect(result.title).toBe('Parlante Studio');
    expect(result.scenes.map((scene) => scene.title)).toEqual([
      'Introducción',
      'Editor multiescena',
      'Avatares fotorrealistas',
      'Exportación en MP4',
      'Cierre',
    ]);
    expect(result.scenes[0]!.text).toContain('Este vídeo está pensado para equipos de marketing.');
    expect(result.scenes[1]!.text).toMatch(/^Punto 1: editor multiescena\./);
    expect(result.scenes[3]!.text).toMatch(/^Punto 3: exportación en MP4\./);

    // One point per line works too; with fewer scenes than points none is dropped.
    const lines = await script({
      topic:
        'Onboarding de clientes\n- Llamada de bienvenida\n- Configuración de la cuenta\n- Primera revisión a los 30 días',
      sceneCount: 3,
      durationSec: 40,
    });
    expect(lines.title).toBe('Onboarding de clientes');
    expect(lines.scenes).toHaveLength(3);
    for (const point of [
      'Llamada de bienvenida',
      'Configuración de la cuenta',
      'Primera revisión a los 30 días',
    ]) {
      expect(fullText(lines)).toContain(point);
    }
  });

  it('honours an explicit number of scenes', async () => {
    for (const sceneCount of [1, 2, 3, 5, 7]) {
      const result = await script({
        topic: 'El plan de formación anual',
        sceneCount,
        durationSec: 90,
      });
      expect(result.scenes, `sceneCount ${sceneCount}`).toHaveLength(sceneCount);
    }
    // Twelve were asked for but Spanish has nine distinct blocks: no padding with repeats.
    const many = await script({
      topic: 'El plan de formación anual',
      sceneCount: 12,
      durationSec: 300,
    });
    expect(many.scenes).toHaveLength(9);
  });

  it('is deterministic', async () => {
    const request = {
      topic: 'Nuestro nuevo producto',
      tone: 'persuasive',
      durationSec: 50,
    } as const;
    expect(await script(request)).toEqual(await script(request));
  });

  it('writes in every supported language with nothing left to fill in', async () => {
    for (const language of LANGUAGE_CODES) {
      const result = await script({
        topic: 'Parlante 2.0',
        language,
        durationSec: 40,
        audience: 'QA',
      });
      expect(GeneratedScriptSchema.parse(result)).toEqual(result);
      expect(result.scenes.length, language).toBeGreaterThanOrEqual(3);
      expect(fullText(result), language).toContain('Parlante 2.0');
      expect(fullText(result), language).not.toMatch(/[{}]|undefined/);
      expect(totalSec(result), language).toBeGreaterThan(25);
      expect(totalSec(result), language).toBeLessThan(48);
    }
    // Not the Spanish text under another label.
    const de = await script({ topic: 'Datenschutz im Büro', language: 'de', durationSec: 40 });
    expect(de.scenes[0]!.text).toMatch(
      /^Heute geht es um ein bestimmtes Thema: Datenschutz im Büro\./,
    );
    const ru = await script({ topic: 'Parlante', language: 'ru', durationSec: 40 });
    expect(ru.scenes[0]!.title).toBe('Введение');
  });
});

describe('local script writer: from source text (URL or notes)', () => {
  it('summarises extractively: real sentences of the source, in order, without boilerplate', async () => {
    const result = await script({
      topic: 'https://ejemplo.es/solar',
      sourceText: SOLAR,
      sourceTitle: 'Guía de energía solar en casa',
      tone: 'educational',
      durationSec: 45,
    });
    expect(result).toMatchObject({
      title: 'Guía de energía solar en casa',
      sourceTitle: 'Guía de energía solar en casa',
      basicMode: true,
    });
    expect(result.scenes[0]!.text).toBe(
      'Hoy repasamos las ideas principales de: Guía de energía solar en casa.',
    );
    expect(result.scenes.at(-1)!.title).toBe('Cierre');

    const sourceSentences = splitSentences(SOLAR);
    const body = result.scenes.slice(1, -1);
    expect(body.length).toBeGreaterThanOrEqual(2);
    const used = body.flatMap((scene) => splitSentences(scene.text));
    for (const sentence of used) expect(sourceSentences, sentence).toContain(sentence);
    const positions = used.map((sentence) => sourceSentences.indexOf(sentence));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(fullText(result)).not.toMatch(/cookies|newsletter|https?:/i);
    expect(totalSec(result)).toBeGreaterThan(36);
    expect(totalSec(result)).toBeLessThan(52);
    // Scene titles name what each part is about, without repeating a label.
    const titles = body.map((scene) => scene.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles[0]).toMatch(/^Parte 1: \p{Lu}/u);
  });

  it('keeps to the duration with one or two scenes', async () => {
    const two = await script({
      topic: 'x',
      sourceText: SOLAR,
      sourceTitle: 'Energía solar',
      durationSec: 20,
      sceneCount: 2,
    });
    expect(two.scenes).toHaveLength(2);
    expect(totalSec(two)).toBeLessThan(23);
    const one = await script({
      topic: 'x',
      sourceText: SOLAR,
      sourceTitle: 'Energía solar',
      durationSec: 12,
    });
    expect(one.scenes).toHaveLength(1);
    expect(one.scenes[0]!.text).toMatch(/^Hoy repasamos las ideas principales de: Energía solar\./);
  });

  it('treats a long typed topic as notes, and falls back to the template when nothing is usable', async () => {
    const notes = await script({ topic: SOLAR, durationSec: 30 });
    expect(notes.title).toBe(
      'La energía solar fotovoltaica convierte la luz del sol en electricidad…',
    );
    // The first sentence is the title, not a "subject" to announce: it is said once.
    expect(fullText(notes).split('La energía solar fotovoltaica convierte').length - 1).toBe(1);
    expect(notes.scenes[0]!.text).toBe(
      'En los próximos minutos repasamos lo esencial, de forma clara y ordenada.',
    );
    expect(fullText(notes)).toContain(
      'Una instalación doméstica típica tiene entre 6 y 10 paneles.',
    );

    const junk = await script({
      topic: 'Parlante',
      sourceText: 'Aceptar cookies. © 2026. https://x.y',
      sourceTitle: 'Parlante',
      durationSec: 30,
    });
    expect(junk.scenes[0]!.text).toMatch(/^Hoy hablamos de Parlante\./);
  });
});

describe('local chat: retrieval over the persona knowledge', () => {
  const persona = {
    name: 'Lucía',
    instructions:
      'Eres la asistente de ventas de Acme. Responde siempre con amabilidad. Nuestra oficina está en Valencia.',
    knowledge: `¿Cuál es el horario de atención?
Atendemos de lunes a viernes, de 9:00 a 18:00. Los sábados solo por correo electrónico.

¿Cuánto cuesta el plan Pro?
El plan Pro cuesta 29 euros al mes. Incluye 60 minutos de vídeo y avatares fotorrealistas. Hay un 20 % de descuento con pago anual.

P: ¿Cómo puedo cancelar mi suscripción?
R: Puedes cancelar en cualquier momento desde Ajustes > Facturación. No hay permanencia.

# Envíos
Enviamos a toda España en 48 horas. Los envíos a Canarias tardan cinco días. El envío es gratuito a partir de 50 euros.`,
  };

  async function converse(questions: string[], maxSentences = 2): Promise<string[]> {
    const messages: { role: 'user' | 'assistant'; text: string }[] = [];
    const replies: string[] = [];
    for (const text of questions) {
      messages.push({ role: 'user', text });
      const reply = await llm.chat({
        persona,
        language: 'es',
        messages: [...messages],
        maxSentences,
      });
      expect(reply.provider.quality).toBe('basic');
      messages.push({ role: 'assistant', text: reply.text });
      replies.push(reply.text);
    }
    return replies;
  }

  it('parses questions, Q/A pairs and headed sections', () => {
    const passages = parseKnowledge(persona.knowledge);
    expect(passages.map((p) => p.title)).toEqual([
      '¿Cuál es el horario de atención?',
      '¿Cuánto cuesta el plan Pro?',
      '¿Cómo puedo cancelar mi suscripción?',
      'Envíos',
    ]);
    expect(passages[2]!.answer).toBe(
      'Puedes cancelar en cualquier momento desde Ajustes > Facturación. No hay permanencia.',
    );
  });

  it('answers with the stored text, picks the relevant sentences and follows up', async () => {
    const replies = await converse([
      'Hola',
      '¿cuánto cuesta el plan pro?',
      '¿y con pago anual hay descuento?',
      '¿a qué hora abrís?',
      'quiero cancelar',
      '¿cuánto tarda un envío a Canarias?',
      '¿dónde está vuestra oficina?',
    ]);
    expect(replies).toEqual([
      'Hola, soy Lucía. ¿En qué puedo ayudarte?',
      'El plan Pro cuesta 29 euros al mes. Incluye 60 minutos de vídeo y avatares fotorrealistas.',
      'El plan Pro cuesta 29 euros al mes. Hay un 20 % de descuento con pago anual.',
      'Atendemos de lunes a viernes, de 9:00 a 18:00. Los sábados solo por correo electrónico.',
      'Puedes cancelar en cualquier momento desde Ajustes > Facturación. No hay permanencia.',
      'Los envíos a Canarias tardan cinco días. El envío es gratuito a partir de 50 euros.',
      // A fact stated in the instructions is usable; the orders to the avatar are not recited.
      'Nuestra oficina está en Valencia.',
    ]);
    expect((await converse(['¿cuánto cuesta el plan pro?'], 1))[0]).toBe(
      'El plan Pro cuesta 29 euros al mes.',
    );
  });

  it('admits what it does not know instead of inventing, and says what it can talk about', async () => {
    const [reply] = await converse(['¿quién ganó el mundial de 2010?']);
    expect(reply).toMatch(/^No tengo información sobre eso\. Funciono en modo básico/);
    expect(reply).toContain(
      'Puedo hablarte de: Cuál es el horario de atención; Cuánto cuesta el plan Pro;',
    );
    expect(reply).not.toMatch(/España|2010/);
  });

  it('handles small talk, identity and empty input', async () => {
    expect(await converse(['¿quién eres?', 'muchas gracias', 'adiós', '   '])).toEqual([
      'Soy Lucía, un avatar virtual. Respondo con la información que me han preparado.',
      '¡De nada! Si necesitas algo más, aquí estoy.',
      '¡Hasta pronto! Gracias por la conversación.',
      'No te he entendido. ¿Puedes repetirlo con otras palabras?',
    ]);
  });

  it('works in English and without any knowledge', async () => {
    const ask = (knowledge: string, text: string) =>
      llm.chat({
        persona: { name: 'Max', instructions: '', knowledge },
        language: 'en',
        messages: [{ role: 'user', text }],
      });
    expect((await ask('', 'What is the refund policy?')).text).toBe(
      'I run in basic mode and I have not been given any information to answer questions yet.',
    );
    expect(
      (
        await ask(
          'Refunds are available within 30 days of purchase. Contact support to start one.',
          'What is the refund policy?',
        )
      ).text,
    ).toBe('Refunds are available within 30 days of purchase. Contact support to start one.');
    expect((await ask('', 'hi!')).text).toBe('Hello, I am Max. How can I help you?');
    // No messages yet: the avatar opens the conversation.
    expect(
      (
        await llm.chat({
          persona: { name: 'Max', instructions: '', knowledge: '' },
          language: 'de',
          messages: [],
        })
      ).text,
    ).toBe('Hallo, ich bin Max. Wie kann ich Ihnen helfen?');
  });
});
