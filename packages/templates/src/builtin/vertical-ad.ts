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

const PRESENTER = 'stock_amara';

/** Vertical ad for social feeds: hook → benefits → offer → call to action. 9:16, four scenes. */
export const verticalAdTemplate: TemplateDefinition = {
  id: 'builtin_vertical-ad',
  category: 'ad',
  aspect: '9:16',
  name: { es: 'Anuncio vertical', en: 'Vertical ad' },
  description: {
    es: 'Anuncio corto para redes: gancho, tres ventajas, oferta con descuento y llamada a la acción.',
    en: 'Short ad for social feeds: hook, three benefits, discount offer and call to action.',
  },
  tags: {
    es: ['anuncio', 'redes sociales', 'vertical', 'oferta'],
    en: ['ad', 'social media', 'vertical', 'offer'],
  },
  build(t, locale) {
    const product = t('producto', 'product');
    const discount = t('descuento', 'discount');
    const web = t('web', 'website');
    const benefits = [
      t('Rápido de verdad', 'Really fast'),
      t('Fácil desde el minuto uno', 'Easy from minute one'),
      t('Sin letra pequeña', 'No small print'),
    ];
    const pill = {
      fontFamily: 'Poppins',
      fontWeight: 700,
      color: INK,
      background: { color: WHITE, padding: 0.016, radius: 0.04 },
    } as const;
    return {
      music: { stockId: 'music-tech-pulse', volume: 0.15 },
      subtitles: {
        preset: 'karaoke',
        fontFamily: 'Poppins',
        fontWeight: 700,
        fontSize: 0.03,
        maxCharsPerLine: 24,
        margin: 0.06,
        uppercase: true,
      },
      variables: [
        variable(product, t('Nombre del producto', 'Product name'), t('Zumos Sol', 'Sunny Juice')),
        variable(discount, t('Descuento', 'Discount'), t('20 %', '20%')),
        variable(web, t('Página web', 'Website'), 'parlante.example'),
      ],
      scenes: [
        {
          id: 'hook',
          name: t('Gancho', 'Hook'),
          background: stockBackground('bg-diagonal'),
          script: narration(
            locale,
            'female',
            t(
              '¡Espera! ¿Todavía no conoces {{producto}}?',
              "Wait! You still haven't tried {{product}}?",
            ),
            1.05,
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('9:16', 0.5, 0.4)),
            text(
              'headline',
              t('¿Aún no conoces {{producto}}?', "Still haven't tried {{product}}?"),
              box(0.08, 0.07, 0.84, 0.23),
              {
                fontFamily: 'Poppins',
                fontSize: 0.052,
                fontWeight: 800,
                lineHeight: 1.1,
                shadow: { color: '#7a103566', blur: 0.008, offsetX: 0, offsetY: 0.004 },
              },
              { role: 'title', enter: enter('pop', 0, 450) },
            ),
            text(
              'sticker',
              t('NUEVO', 'NEW'),
              box(0.36, 0.32, 0.28, 0.045),
              {
                fontFamily: 'Poppins',
                fontSize: 0.022,
                fontWeight: 800,
                letterSpacing: 0.16,
                color: INK,
                background: { color: AMBER, padding: 0.012, radius: 0.03 },
              },
              { rotation: -4, enter: enter('pop', 500, 350) },
            ),
          ],
        },
        {
          id: 'benefits',
          name: t('Ventajas', 'Benefits'),
          transition: { type: 'slide-up', durationMs: 400 },
          background: {
            type: 'gradient',
            gradient: {
              kind: 'linear',
              angle: 160,
              stops: [
                { offset: 0, color: INK },
                { offset: 1, color: '#3b2f8f' },
              ],
            },
          },
          script: narration(
            locale,
            'female',
            t(
              'Es rápido, es fácil y no tiene letra pequeña.',
              "It's fast, it's easy and there's no small print.",
            ),
            1.05,
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('9:16', 0.5, 0.42)),
            text(
              'heading',
              t('Te va a encantar', "You'll love it"),
              box(0.08, 0.06, 0.84, 0.09),
              { fontFamily: 'Poppins', fontSize: 0.046, fontWeight: 800 },
              { role: 'subtitle' },
            ),
            ...benefits.map((benefit, i) =>
              text(
                `benefit-${i + 1}`,
                benefit,
                box(0.12, 0.175 + i * 0.078, 0.76, 0.06),
                { ...pill, fontSize: 0.028 },
                { enter: enter('pop', 300 + i * 900, 350) },
              ),
            ),
          ],
        },
        {
          id: 'offer',
          name: t('Oferta', 'Offer'),
          transition: { type: 'zoom', durationMs: 400 },
          background: stockBackground('bg-rays'),
          script: narration(
            locale,
            'female',
            t(
              'Y solo esta semana, con un {{descuento}} de descuento.',
              'And this week only, you get {{discount}} off.',
            ),
            1.05,
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('9:16', 0.5, 0.46)),
            shape('burst', 'star', box(0.1, 0.005, 0.8, 0.45), '#ffffff38', {
              rotation: 10,
              enter: enter('zoom-in', 0, 500),
            }),
            shape('badge', 'ellipse', box(0.24, 0.085, 0.52, 0.2925), AMBER, {
              role: 'accent',
              enter: enter('pop', 100, 450),
            }),
            text(
              'discount',
              `-{{${discount}}}`,
              box(0.24, 0.085, 0.52, 0.2925),
              { fontFamily: 'Poppins', fontSize: 0.075, fontWeight: 800, color: INK },
              { enter: enter('pop', 100, 450) },
            ),
            text(
              'deadline',
              t('SOLO ESTA SEMANA', 'THIS WEEK ONLY'),
              box(0.1, 0.405, 0.8, 0.05),
              { fontFamily: 'Poppins', fontSize: 0.028, fontWeight: 800, letterSpacing: 0.1 },
              { role: 'caption', enter: enter('fade', 600) },
            ),
          ],
        },
        {
          id: 'cta',
          name: t('Llamada a la acción', 'Call to action'),
          transition: { type: 'slide-left', durationMs: 400 },
          background: { type: 'color', color: VIOLET, brandRole: 'primary' },
          script: narration(
            locale,
            'female',
            t('Entra en {{web}} y pruébalo hoy.', 'Go to {{website}} and try it today.'),
            1.05,
          ),
          layers: [
            shape('halo', 'ellipse', box(-0.1, 0.36, 1.2, 0.675), '#ffffff1f'),
            avatar('avatar', PRESENTER, stand('9:16', 0.5, 0.4)),
            text(
              'headline',
              t('Pruébalo hoy', 'Try it today'),
              box(0.08, 0.09, 0.84, 0.12),
              { fontFamily: 'Poppins', fontSize: 0.06, fontWeight: 800 },
              { role: 'title', enter: enter('slide-down') },
            ),
            text(
              'link',
              `{{${web}}}`,
              box(0.12, 0.235, 0.76, 0.07),
              {
                ...pill,
                fontSize: 0.032,
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
