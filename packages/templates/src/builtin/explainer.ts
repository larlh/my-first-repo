import {
  AMBER,
  INK,
  NAVY,
  VIOLET,
  WHITE,
  avatar,
  avatarBadge,
  box,
  enter,
  narration,
  shape,
  stand,
  stockBackground,
  text,
  variable,
} from './helpers';
import type { TemplateDefinition } from './helpers';

const PRESENTER = 'stock_lucia';

/** Explainer: hook → problem → three-step solution → call to action. 16:9, four scenes. */
export const explainerTemplate: TemplateDefinition = {
  id: 'builtin_explainer',
  category: 'explainer',
  aspect: '16:9',
  name: { es: 'Vídeo explicativo', en: 'Explainer video' },
  description: {
    es: 'Presenta una idea en cuatro escenas: gancho, problema, solución en tres pasos y llamada a la acción.',
    en: 'Present an idea in four scenes: hook, problem, three-step solution and call to action.',
  },
  tags: {
    es: ['explicativo', 'paso a paso', 'horizontal'],
    en: ['explainer', 'step by step', 'landscape'],
  },
  build(t, locale) {
    const web = t('web', 'website');
    const steps = [
      {
        title: t('Escribe tu guion', 'Write your script'),
        body: t('O deja que la IA te proponga uno.', 'Or let the AI draft one for you.'),
      },
      {
        title: t('Elige presentador y voz', 'Pick a presenter and a voice'),
        body: t('Avatares y voces en varios idiomas.', 'Avatars and voices in several languages.'),
      },
      {
        title: t('Genera el vídeo', 'Generate the video'),
        body: t('Listo para descargar y compartir.', 'Ready to download and share.'),
      },
    ];
    return {
      music: { stockId: 'music-corporate-rise', volume: 0.13 },
      variables: [
        variable(
          t('titulo', 'title'),
          t('Título en pantalla', 'On-screen title'),
          t('Cómo funciona Parlante', 'How Parlante works'),
        ),
        variable(
          t('tema', 'topic'),
          t('Tema, dentro de la frase', 'Topic, inside the sentence'),
          t('cómo funciona Parlante', 'how Parlante works'),
        ),
        variable(web, t('Página web', 'Website'), 'parlante.example'),
      ],
      scenes: [
        {
          id: 'intro',
          name: t('Gancho', 'Hook'),
          background: stockBackground('bg-aurora'),
          script: narration(
            locale,
            'female',
            t(
              'Hola, soy Lucía. Hoy te explico, en menos de un minuto, {{tema}}.',
              "Hi, I'm Lucía. In less than a minute, I'll explain {{topic}}.",
            ),
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('16:9', 0.76, 0.1)),
            text(
              'kicker',
              t('EN UN MINUTO', 'IN ONE MINUTE'),
              box(0.068, 0.2, 0.3, 0.07),
              {
                fontSize: 0.024,
                fontWeight: 700,
                letterSpacing: 0.14,
                align: 'left',
                background: { color: '#ffffff26', padding: 0.014, radius: 0.03 },
              },
              { role: 'caption', enter: enter('fade', 100) },
            ),
            text(
              'title',
              t('{{titulo}}', '{{title}}'),
              box(0.06, 0.3, 0.48, 0.3),
              {
                fontFamily: 'Poppins',
                fontSize: 0.088,
                fontWeight: 800,
                align: 'left',
                lineHeight: 1.1,
              },
              { role: 'title', enter: enter('slide-up', 150, 500) },
            ),
            shape('accent', 'rect', box(0.06, 0.635, 0.12, 0.012), AMBER, {
              radius: 0.006,
              role: 'accent',
              enter: enter('fade', 450),
            }),
            text(
              'subtitle',
              t('Explicado paso a paso', 'Explained step by step'),
              box(0.06, 0.67, 0.46, 0.07),
              { fontSize: 0.034, fontWeight: 500, align: 'left', color: '#ffffffcc' },
              { role: 'subtitle', enter: enter('fade', 600) },
            ),
          ],
        },
        {
          id: 'problem',
          name: t('El problema', 'The problem'),
          transition: { type: 'fade', durationMs: 500 },
          background: { type: 'color', color: INK, brandRole: 'background' },
          script: narration(
            locale,
            'female',
            t(
              'Seguro que te suena: tienes una buena idea, pero explicarla te lleva demasiado tiempo.',
              'You know the feeling: you have a great idea, but explaining it takes far too long.',
            ),
          ),
          layers: [
            shape('glow', 'ellipse', box(0.72, -0.28, 0.45, 0.8), '#6d5efc26'),
            avatar('avatar', PRESENTER, stand('16:9', 0.24, 0.1)),
            text(
              'label',
              t('EL PROBLEMA', 'THE PROBLEM'),
              box(0.48, 0.2, 0.4, 0.05),
              {
                fontSize: 0.024,
                fontWeight: 700,
                letterSpacing: 0.16,
                align: 'left',
                color: AMBER,
              },
              { role: 'caption' },
            ),
            text(
              'heading',
              t('Explicar bien lleva tiempo', 'Explaining well takes time'),
              box(0.48, 0.26, 0.46, 0.24),
              {
                fontFamily: 'Poppins',
                fontSize: 0.064,
                fontWeight: 700,
                align: 'left',
                lineHeight: 1.12,
              },
              { role: 'subtitle', enter: enter('slide-up', 100) },
            ),
            text(
              'body',
              t(
                'Reuniones, correos y documentos que nadie termina de leer.',
                'Meetings, emails and documents nobody finishes reading.',
              ),
              box(0.48, 0.52, 0.44, 0.18),
              {
                fontSize: 0.036,
                fontWeight: 500,
                align: 'left',
                color: '#ffffffcc',
                lineHeight: 1.35,
              },
              { role: 'body', enter: enter('fade', 500) },
            ),
          ],
        },
        {
          id: 'solution',
          name: t('La solución', 'The solution'),
          transition: { type: 'slide-left', durationMs: 500 },
          background: {
            type: 'gradient',
            gradient: {
              kind: 'linear',
              angle: 135,
              stops: [
                { offset: 0, color: NAVY },
                { offset: 1, color: '#3b2f8f' },
              ],
            },
          },
          script: narration(
            locale,
            'female',
            t(
              'La solución tiene tres pasos. Primero, escribe tu guion. Después, elige presentador y voz. Y por último, pulsa en generar.',
              'The solution has three steps. First, write your script. Then, pick a presenter and a voice. And finally, press generate.',
            ),
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('16:9', 0.81, 0.12)),
            text(
              'heading',
              t('La solución, en tres pasos', 'The solution, in three steps'),
              box(0.06, 0.08, 0.56, 0.12),
              { fontFamily: 'Poppins', fontSize: 0.052, fontWeight: 700, align: 'left' },
              { role: 'subtitle' },
            ),
            ...steps.flatMap((step, i) => {
              const y = 0.25 + i * 0.17;
              const appear = enter('slide-left', 600 + i * 1800, 450);
              return [
                shape(`step-${i + 1}-card`, 'rect', box(0.06, y, 0.55, 0.145), '#ffffff14', {
                  radius: 0.025,
                  stroke: { color: '#ffffff2e', width: 0.002 },
                  enter: appear,
                }),
                shape(`step-${i + 1}-dot`, 'ellipse', box(0.075, y + 0.0275, 0.0506, 0.09), AMBER, {
                  role: 'accent',
                  enter: appear,
                }),
                text(
                  `step-${i + 1}-number`,
                  String(i + 1),
                  box(0.075, y + 0.0275, 0.0506, 0.09),
                  { fontFamily: 'Poppins', fontSize: 0.044, fontWeight: 800, color: INK },
                  { enter: appear },
                ),
                text(
                  `step-${i + 1}-title`,
                  step.title,
                  box(0.145, y + 0.014, 0.45, 0.062),
                  { fontFamily: 'Poppins', fontSize: 0.036, fontWeight: 700, align: 'left' },
                  { role: 'body', enter: appear },
                ),
                text(
                  `step-${i + 1}-body`,
                  step.body,
                  box(0.145, y + 0.074, 0.45, 0.055),
                  { fontSize: 0.026, fontWeight: 500, align: 'left', color: '#ffffffb8' },
                  { role: 'body', enter: appear },
                ),
              ];
            }),
          ],
        },
        {
          id: 'cta',
          name: t('Llamada a la acción', 'Call to action'),
          transition: { type: 'zoom', durationMs: 500 },
          background: { type: 'color', color: VIOLET, brandRole: 'primary' },
          script: narration(
            locale,
            'female',
            t(
              '¿Empezamos? Entra en {{web}} y crea tu primer vídeo hoy mismo.',
              'Shall we start? Go to {{website}} and create your first video today.',
            ),
          ),
          layers: [
            shape('ring', 'ellipse', box(0.045, 0.14, 0.3825, 0.68), null, {
              stroke: { color: '#ffffff40', width: 0.004 },
            }),
            avatarBadge('avatar', PRESENTER, '16:9', 0.08, 0.2, 0.56),
            text(
              'question',
              t('¿Empezamos?', 'Shall we start?'),
              box(0.46, 0.24, 0.48, 0.16),
              { fontFamily: 'Poppins', fontSize: 0.085, fontWeight: 800, align: 'left' },
              { role: 'title', enter: enter('slide-up') },
            ),
            text(
              'link',
              `{{${web}}}`,
              box(0.4725, 0.44, 0.46, 0.1),
              {
                fontFamily: 'Poppins',
                fontSize: 0.042,
                fontWeight: 700,
                align: 'left',
                color: INK,
                background: { color: WHITE, padding: 0.022, radius: 0.05 },
              },
              { enter: enter('pop', 500) },
            ),
            text(
              'note',
              t('Crea tu primer vídeo hoy', 'Create your first video today'),
              box(0.46, 0.6, 0.48, 0.07),
              { fontSize: 0.032, fontWeight: 500, align: 'left', color: '#ffffffd9' },
              { role: 'body', enter: enter('fade', 800) },
            ),
          ],
        },
      ],
    };
  },
};
