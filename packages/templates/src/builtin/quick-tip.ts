import {
  AMBER,
  INK,
  VIOLET,
  WHITE,
  avatar,
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

const PRESENTER = 'stock_mateo';

/** Daily tip for vertical feeds: the tip → why it works → follow. 9:16, three scenes. */
export const quickTipTemplate: TemplateDefinition = {
  id: 'builtin_quick-tip',
  category: 'explainer',
  aspect: '9:16',
  name: { es: 'Consejo del día', en: 'Tip of the day' },
  description: {
    es: 'Un consejo breve en vertical: el consejo, por qué funciona y una invitación a seguirte.',
    en: 'A short vertical tip: the tip, why it works and an invitation to follow you.',
  },
  tags: {
    es: ['consejo', 'redes sociales', 'vertical', 'serie'],
    en: ['tip', 'social media', 'vertical', 'series'],
  },
  build(t, locale) {
    const number = t('numero', 'number');
    const tip = t('consejo', 'tip');
    const reason = t('motivo', 'reason');
    const account = t('cuenta', 'account');
    return {
      music: { stockId: 'music-ambient-dawn', volume: 0.16 },
      subtitles: {
        preset: 'boxed',
        fontFamily: 'Poppins',
        fontSize: 0.028,
        maxCharsPerLine: 26,
        margin: 0.06,
      },
      variables: [
        variable(number, t('Número del consejo', 'Tip number'), '7'),
        variable(
          tip,
          t('El consejo', 'The tip'),
          t('Haz una pausa de cinco minutos cada hora', 'Take a five-minute break every hour'),
        ),
        variable(
          reason,
          t('Por qué funciona', 'Why it works'),
          t(
            'Tu atención se recupera y vuelves con más energía.',
            'Your focus recovers and you come back with more energy.',
          ),
        ),
        variable(account, t('Tu cuenta', 'Your handle'), '@parlante'),
      ],
      scenes: [
        {
          id: 'tip',
          name: t('El consejo', 'The tip'),
          background: stockBackground('bg-ocean'),
          script: narration(
            locale,
            'male',
            t('Consejo número {{numero}}: {{consejo}}.', 'Tip number {{number}}: {{tip}}.'),
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('9:16', 0.5, 0.42)),
            text(
              'label',
              t('CONSEJO Nº {{numero}}', 'TIP #{{number}}'),
              box(0.2, 0.07, 0.6, 0.045),
              {
                fontFamily: 'Poppins',
                fontSize: 0.02,
                fontWeight: 800,
                letterSpacing: 0.16,
                color: INK,
                background: { color: AMBER, padding: 0.012, radius: 0.03 },
              },
              { enter: enter('fade', 0, 400) },
            ),
            text(
              'tip',
              `{{${tip}}}`,
              box(0.08, 0.135, 0.84, 0.25),
              {
                fontFamily: 'Poppins',
                fontSize: 0.046,
                fontWeight: 800,
                lineHeight: 1.15,
                shadow: { color: '#00000066', blur: 0.01, offsetX: 0, offsetY: 0.004 },
              },
              { role: 'title', enter: enter('slide-up', 200, 500) },
            ),
          ],
        },
        {
          id: 'why',
          name: t('Por qué funciona', 'Why it works'),
          transition: { type: 'slide-up', durationMs: 450 },
          background: stockBackground('bg-midnight'),
          script: narration(
            locale,
            'male',
            t(
              '¿Por qué funciona? {{motivo}} Pruébalo hoy y nota la diferencia.',
              'Why does it work? {{reason}} Try it today and feel the difference.',
            ),
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('9:16', 0.5, 0.44)),
            text(
              'heading',
              t('¿Por qué funciona?', 'Why does it work?'),
              box(0.08, 0.08, 0.84, 0.07),
              { fontFamily: 'Poppins', fontSize: 0.03, fontWeight: 700, color: AMBER },
              { role: 'caption' },
            ),
            shape('card', 'rect', box(0.08, 0.165, 0.84, 0.23), '#ffffff14', {
              radius: 0.025,
              stroke: { color: '#ffffff2e', width: 0.0015 },
            }),
            text(
              'reason',
              `{{${reason}}}`,
              box(0.13, 0.175, 0.74, 0.21),
              { fontSize: 0.032, fontWeight: 600, lineHeight: 1.3 },
              { role: 'body', enter: enter('fade', 200, 500) },
            ),
          ],
        },
        {
          id: 'follow',
          name: t('Sígueme', 'Follow'),
          transition: { type: 'fade', durationMs: 450 },
          background: { type: 'color', color: VIOLET, brandRole: 'primary' },
          script: narration(
            locale,
            'male',
            t(
              'Si te ha servido, sígueme para ver un consejo nuevo cada día.',
              'If this helped, follow me for a new tip every day.',
            ),
          ),
          layers: [
            shape('halo', 'ellipse', box(-0.1, 0.38, 1.2, 0.675), '#ffffff1f'),
            avatar('avatar', PRESENTER, stand('9:16', 0.5, 0.42)),
            text(
              'headline',
              t('Un consejo nuevo cada día', 'A new tip every day'),
              box(0.08, 0.08, 0.84, 0.16),
              { fontFamily: 'Poppins', fontSize: 0.046, fontWeight: 800, lineHeight: 1.15 },
              { role: 'title' },
            ),
            text(
              'handle',
              `{{${account}}}`,
              box(0.14, 0.27, 0.72, 0.07),
              {
                fontFamily: 'Poppins',
                fontSize: 0.032,
                fontWeight: 700,
                color: INK,
                background: { color: WHITE, padding: 0.018, radius: 0.05 },
              },
              { enter: enter('pop', 500, 350) },
            ),
          ],
        },
      ],
    };
  },
};
