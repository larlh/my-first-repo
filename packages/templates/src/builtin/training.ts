import {
  AMBER,
  NAVY,
  VIOLET,
  WHITE,
  avatar,
  box,
  chip,
  enter,
  narration,
  shape,
  stand,
  stockBackground,
  text,
  variable,
} from './helpers';
import type { TemplateDefinition } from './helpers';
import type { NewSceneInput } from '@parlante/shared';

const PRESENTER = 'stock_david';
const PAPER = '#f6efe2';
const paper: NonNullable<NewSceneInput['background']> = {
  type: 'color',
  color: PAPER,
  brandRole: 'background',
};

/** Training lesson: title → objectives → key idea → steps → self-check. 16:9, five scenes. */
export const trainingTemplate: TemplateDefinition = {
  id: 'builtin_training',
  category: 'training',
  aspect: '16:9',
  name: { es: 'Lección de formación', en: 'Training lesson' },
  description: {
    es: 'Una lección completa: portada del curso, objetivos, idea clave, pasos y pregunta de repaso.',
    en: 'A complete lesson: course cover, objectives, key idea, steps and a review question.',
  },
  tags: {
    es: ['formación', 'curso', 'onboarding', 'horizontal'],
    en: ['training', 'course', 'onboarding', 'landscape'],
  },
  build(t, locale) {
    const objectives = [
      t('Identificar los riesgos más comunes', 'Spot the most common risks'),
      t('Aplicar el protocolo paso a paso', 'Apply the protocol step by step'),
      t('Resolver las dudas frecuentes', 'Answer the frequent questions'),
    ];
    const steps = [
      [t('Párate', 'Stop'), t('Respira y evalúa', 'Breathe and assess')],
      [t('Observa', 'Look'), t('Busca señales de riesgo', 'Look for warning signs')],
      [t('Comprueba', 'Check'), t('Confirma antes de seguir', 'Confirm before going on')],
    ] as const;
    const options = [
      t('A · Actuar rápido', 'A · Act fast'),
      t('B · Pararse', 'B · Stop'),
      t('C · Avisar', 'C · Call out'),
    ];
    return {
      music: { stockId: 'music-lofi-study', volume: 0.12 },
      variables: [
        variable(
          t('curso', 'course'),
          t('Nombre del curso', 'Course name'),
          t('Seguridad en el trabajo', 'Workplace safety'),
        ),
        variable(t('modulo', 'module'), t('Número de módulo', 'Module number'), '1'),
        variable(
          t('leccion', 'lesson'),
          t('Tema de la lección', 'Lesson topic'),
          t('los tres pasos básicos', 'the three basic steps'),
        ),
      ],
      scenes: [
        {
          id: 'cover',
          name: t('Portada', 'Cover'),
          background: paper,
          script: narration(
            locale,
            'male',
            t(
              'Te doy la bienvenida al curso {{curso}}. Soy David y en esta lección veremos {{leccion}}.',
              "Welcome to the course {{course}}. I'm David, and in this lesson we'll cover {{lesson}}.",
            ),
          ),
          layers: [
            shape('stripe', 'rect', box(0, 0, 0.014, 1), VIOLET, { role: 'accent' }),
            shape('halo', 'ellipse', box(0.6, 0.14, 0.369, 0.656), '#6d5efc24'),
            avatar('avatar', PRESENTER, stand('16:9', 0.785, 0.12)),
            text(
              'kicker',
              t('CURSO · MÓDULO {{modulo}}', 'COURSE · MODULE {{module}}'),
              box(0.07, 0.2, 0.5, 0.06),
              {
                fontSize: 0.026,
                fontWeight: 700,
                letterSpacing: 0.14,
                align: 'left',
                color: VIOLET,
              },
              { role: 'caption' },
            ),
            text(
              'title',
              t('{{curso}}', '{{course}}'),
              box(0.07, 0.275, 0.5, 0.2),
              {
                fontFamily: 'Roboto Slab',
                fontSize: 0.078,
                fontWeight: 700,
                align: 'left',
                color: NAVY,
                lineHeight: 1.12,
              },
              { role: 'title', enter: enter('slide-up', 100, 500) },
            ),
            text(
              'lesson',
              t('Lección: {{leccion}}', 'Lesson: {{lesson}}'),
              box(0.07, 0.495, 0.5, 0.09),
              { fontSize: 0.034, fontWeight: 500, align: 'left', color: '#1b1f3bcc' },
              { role: 'subtitle', enter: enter('fade', 500) },
            ),
          ],
        },
        {
          id: 'objectives',
          name: t('Objetivos', 'Objectives'),
          transition: { type: 'fade', durationMs: 500 },
          background: paper,
          script: narration(
            locale,
            'male',
            t(
              'Al terminar sabrás identificar los riesgos más comunes, aplicar el protocolo paso a paso y resolver las dudas frecuentes.',
              "By the end you'll be able to spot the most common risks, apply the protocol step by step and answer the frequent questions.",
            ),
          ),
          layers: [
            shape('stripe', 'rect', box(0, 0, 0.014, 1), VIOLET, { role: 'accent' }),
            avatar('avatar', PRESENTER, stand('16:9', 0.22, 0.14)),
            text(
              'heading',
              t('Qué vas a aprender', 'What you will learn'),
              box(0.44, 0.14, 0.5, 0.1),
              {
                fontFamily: 'Roboto Slab',
                fontSize: 0.054,
                fontWeight: 700,
                align: 'left',
                color: NAVY,
              },
              { role: 'subtitle' },
            ),
            ...objectives.flatMap((objective, i) => {
              const y = 0.3 + i * 0.12;
              const appear = enter('slide-left', 400 + i * 1900, 450);
              return [
                shape(
                  `objective-${i + 1}-mark`,
                  'rect',
                  box(0.44, y + 0.014, 0.0253, 0.045),
                  VIOLET,
                  {
                    radius: 0.012,
                    role: 'accent',
                    enter: appear,
                  },
                ),
                text(
                  `objective-${i + 1}`,
                  objective,
                  box(0.485, y, 0.47, 0.073),
                  { fontSize: 0.035, fontWeight: 500, align: 'left', color: NAVY },
                  { role: 'body', enter: appear },
                ),
              ];
            }),
          ],
        },
        {
          id: 'key-idea',
          name: t('Idea clave', 'Key idea'),
          transition: { type: 'slide-left', durationMs: 500 },
          background: stockBackground('bg-dots'),
          script: narration(
            locale,
            'male',
            t(
              'La idea clave es muy sencilla: antes de actuar, párate, observa y comprueba.',
              'The key idea is very simple: before you act, stop, look and check.',
            ),
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('16:9', 0.79, 0.12)),
            text('quote-mark', '“', box(0.07, 0.06, 0.16, 0.26), {
              fontFamily: 'Playfair Display',
              fontSize: 0.3,
              fontWeight: 800,
              align: 'left',
              verticalAlign: 'top',
              color: AMBER,
            }),
            text(
              'quote',
              t(
                'Antes de actuar: párate, observa y comprueba.',
                'Before you act: stop, look and check.',
              ),
              box(0.1, 0.27, 0.5, 0.36),
              {
                fontFamily: 'Playfair Display',
                fontSize: 0.064,
                fontWeight: 700,
                align: 'left',
                lineHeight: 1.2,
              },
              { role: 'title', enter: enter('fade', 300, 600) },
            ),
            text(
              'label',
              t('IDEA CLAVE', 'KEY IDEA'),
              box(0.1, 0.66, 0.3, 0.05),
              {
                fontSize: 0.024,
                fontWeight: 700,
                letterSpacing: 0.16,
                align: 'left',
                color: AMBER,
              },
              { role: 'caption' },
            ),
          ],
        },
        {
          id: 'steps',
          name: t('Los pasos', 'The steps'),
          transition: { type: 'fade', durationMs: 500 },
          background: paper,
          script: narration(
            locale,
            'male',
            t(
              'Recuerda los tres pasos: párate, observa y comprueba. Repítelos hasta que te salgan solos.',
              'Remember the three steps: stop, look and check. Repeat them until they come naturally.',
            ),
          ),
          layers: [
            shape('stripe', 'rect', box(0, 0, 0.014, 1), VIOLET, { role: 'accent' }),
            avatar('avatar', PRESENTER, stand('16:9', 0.81, 0.14)),
            text(
              'heading',
              t('Los tres pasos', 'The three steps'),
              box(0.07, 0.1, 0.54, 0.1),
              {
                fontFamily: 'Roboto Slab',
                fontSize: 0.054,
                fontWeight: 700,
                align: 'left',
                color: NAVY,
              },
              { role: 'subtitle' },
            ),
            shape('rail', 'rect', box(0.135, 0.377, 0.38, 0.006), '#1b1f3b33'),
            ...steps.flatMap(([label, hint], i) => {
              const x = 0.09 + i * 0.19;
              const appear = enter('pop', 300 + i * 1100, 400);
              return [
                shape(`step-${i + 1}-dot`, 'ellipse', box(x, 0.3, 0.09, 0.16), VIOLET, {
                  role: 'accent',
                  enter: appear,
                }),
                text(
                  `step-${i + 1}-number`,
                  String(i + 1),
                  box(x, 0.3, 0.09, 0.16),
                  { fontFamily: 'Poppins', fontSize: 0.07, fontWeight: 800, color: WHITE },
                  { enter: appear },
                ),
                text(
                  `step-${i + 1}-label`,
                  label,
                  box(x - 0.045, 0.485, 0.18, 0.07),
                  { fontSize: 0.036, fontWeight: 700, color: NAVY },
                  { role: 'body', enter: appear },
                ),
                text(
                  `step-${i + 1}-hint`,
                  hint,
                  box(x - 0.045, 0.555, 0.18, 0.1),
                  { fontSize: 0.024, fontWeight: 500, color: '#1b1f3bb8', verticalAlign: 'top' },
                  { role: 'body', enter: appear },
                ),
              ];
            }),
          ],
        },
        {
          id: 'check',
          name: t('Ponte a prueba', 'Test yourself'),
          transition: { type: 'slide-up', durationMs: 500 },
          background: { type: 'color', color: VIOLET, brandRole: 'primary' },
          script: narration(
            locale,
            'male',
            t(
              'Ahora te toca a ti. Responde a la pregunta de la pantalla y pasa a la siguiente lección cuando quieras.',
              "Now it's your turn. Answer the question on screen and move on to the next lesson whenever you're ready.",
            ),
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('16:9', 0.805, 0.12)),
            text(
              'label',
              t('PONTE A PRUEBA', 'TEST YOURSELF'),
              box(0.07, 0.15, 0.5, 0.05),
              { fontSize: 0.026, fontWeight: 700, letterSpacing: 0.16, align: 'left' },
              { role: 'caption' },
            ),
            text(
              'question',
              t(
                '¿Cuál es el primer paso ante una situación de riesgo?',
                'What is the first step when you face a risk?',
              ),
              box(0.07, 0.22, 0.54, 0.3),
              {
                fontFamily: 'Roboto Slab',
                fontSize: 0.054,
                fontWeight: 700,
                align: 'left',
                lineHeight: 1.2,
              },
              { role: 'title', enter: enter('slide-up', 100) },
            ),
            ...options.flatMap((option, i) =>
              chip(`option-${i + 1}`, option, box(0.07 + i * 0.185, 0.57, 0.17, 0.085), {
                fill: '#ffffff2e',
                style: { fontSize: 0.027, fontWeight: 600 },
                enter: enter('fade', 600 + i * 300),
              }),
            ),
          ],
        },
      ],
    };
  },
};
