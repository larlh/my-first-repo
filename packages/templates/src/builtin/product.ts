import {
  AMBER,
  INK,
  VIOLET,
  WHITE,
  avatar,
  avatarBadge,
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

const PRESENTER = 'stock_priya';
const TEAL = '#2ec4b6';

/** Product launch: reveal → three features → how it works → price and link. 16:9, four scenes. */
export const productTemplate: TemplateDefinition = {
  id: 'builtin_product',
  category: 'product',
  aspect: '16:9',
  name: { es: 'Presentación de producto', en: 'Product presentation' },
  description: {
    es: 'Lanza un producto: revelación en escenario, tres ventajas, cómo funciona y precio con enlace.',
    en: 'Launch a product: on-stage reveal, three benefits, how it works and price with a link.',
  },
  tags: {
    es: ['producto', 'lanzamiento', 'demo', 'horizontal'],
    en: ['product', 'launch', 'demo', 'landscape'],
  },
  build(t, locale) {
    const product = t('producto', 'product');
    const tagline = t('eslogan', 'tagline');
    const price = t('precio', 'price');
    const web = t('web', 'website');
    const features = [
      {
        icon: 'star',
        color: AMBER,
        title: t('Más rápido', 'Faster'),
        body: t('Abre tus archivos al instante.', 'Open your files instantly.'),
      },
      {
        icon: 'ellipse',
        color: TEAL,
        title: t('Más ligero', 'Lighter'),
        body: t('Funciona en cualquier dispositivo.', 'Works on any device.'),
      },
      {
        icon: 'triangle',
        color: '#ff6b9d',
        title: t('Listo en 2 min', 'Ready in 2 min'),
        body: t('Sin instalaciones ni esperas.', 'No installs, no waiting.'),
      },
    ] as const;
    const flow = [t('Conecta', 'Connect'), t('Elige plan', 'Pick a plan'), t('Listo', 'Done')];
    return {
      music: { stockId: 'music-cinematic-hope', volume: 0.14 },
      variables: [
        variable(product, t('Nombre del producto', 'Product name'), t('Nube Uno', 'Cloud One')),
        variable(
          tagline,
          t('Eslogan', 'Tagline'),
          t('tu oficina, en cualquier parte', 'your office, anywhere'),
        ),
        variable(price, t('Precio', 'Price'), t('9 euros al mes', '9 dollars a month')),
        variable(web, t('Página web', 'Website'), 'parlante.example'),
      ],
      scenes: [
        {
          id: 'reveal',
          name: t('Revelación', 'Reveal'),
          background: stockBackground('bg-stage'),
          script: narration(
            locale,
            'female',
            t('Te presento {{producto}}: {{eslogan}}.', 'Meet {{product}}: {{tagline}}.'),
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('16:9', 0.76, 0.1)),
            text(
              'label',
              t('NOVEDAD', 'NEW'),
              box(0.0675, 0.23, 0.3, 0.055),
              {
                fontFamily: 'Poppins',
                fontSize: 0.024,
                fontWeight: 700,
                letterSpacing: 0.16,
                align: 'left',
                color: INK,
                background: { color: AMBER, padding: 0.013, radius: 0.03 },
              },
              { enter: enter('fade', 0, 400) },
            ),
            text(
              'name',
              `{{${product}}}`,
              box(0.06, 0.31, 0.5, 0.22),
              {
                fontFamily: 'Poppins',
                fontSize: 0.105,
                fontWeight: 800,
                align: 'left',
                lineHeight: 1.05,
              },
              { role: 'title', enter: enter('slide-up', 200, 600) },
            ),
            text(
              'tagline',
              `{{${tagline}}}`,
              box(0.06, 0.54, 0.48, 0.14),
              {
                fontSize: 0.038,
                fontWeight: 500,
                align: 'left',
                color: '#ffffffd9',
                lineHeight: 1.3,
              },
              { role: 'subtitle', enter: enter('fade', 700, 500) },
            ),
          ],
        },
        {
          id: 'features',
          name: t('Ventajas', 'Benefits'),
          transition: { type: 'fade', durationMs: 500 },
          background: { type: 'color', color: INK, brandRole: 'background' },
          script: narration(
            locale,
            'female',
            t(
              'Tiene tres cosas que te van a gustar: es más rápido, es más ligero y está listo en dos minutos.',
              "There are three things you'll like: it's faster, it's lighter and it's ready in two minutes.",
            ),
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('16:9', 0.823, 0.14)),
            text(
              'heading',
              t('Por qué te va a gustar', "Why you'll like it"),
              box(0.06, 0.09, 0.58, 0.1),
              { fontFamily: 'Poppins', fontSize: 0.05, fontWeight: 700, align: 'left' },
              { role: 'subtitle' },
            ),
            ...features.flatMap((feature, i) => {
              const x = 0.06 + i * 0.195;
              const appear = enter('slide-up', 900 + i * 1300, 450);
              return [
                shape(`feature-${i + 1}-card`, 'rect', box(x, 0.25, 0.18, 0.41), '#ffffff12', {
                  radius: 0.03,
                  stroke: { color: '#ffffff26', width: 0.002 },
                  enter: appear,
                }),
                shape(
                  `feature-${i + 1}-icon`,
                  feature.icon,
                  box(x + 0.02, 0.29, 0.0563, 0.1),
                  feature.color,
                  { enter: appear },
                ),
                text(
                  `feature-${i + 1}-title`,
                  feature.title,
                  box(x + 0.02, 0.42, 0.145, 0.075),
                  { fontFamily: 'Poppins', fontSize: 0.032, fontWeight: 700, align: 'left' },
                  { role: 'body', enter: appear },
                ),
                text(
                  `feature-${i + 1}-body`,
                  feature.body,
                  box(x + 0.02, 0.5, 0.145, 0.18),
                  {
                    fontSize: 0.025,
                    fontWeight: 500,
                    align: 'left',
                    verticalAlign: 'top',
                    color: '#ffffffb8',
                    lineHeight: 1.35,
                  },
                  { role: 'body', enter: appear },
                ),
              ];
            }),
          ],
        },
        {
          id: 'how',
          name: t('Cómo funciona', 'How it works'),
          transition: { type: 'slide-left', durationMs: 500 },
          background: stockBackground('bg-midnight'),
          script: narration(
            locale,
            'female',
            t(
              'Lo conectas, eliges tu plan y listo. Sin instalaciones y sin esperas.',
              "You connect it, pick your plan and you're done. No installs, no waiting.",
            ),
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('16:9', 0.24, 0.1)),
            text(
              'heading',
              t('Así de fácil', "It's that easy"),
              box(0.48, 0.13, 0.46, 0.1),
              { fontFamily: 'Poppins', fontSize: 0.052, fontWeight: 700, align: 'left' },
              { role: 'subtitle' },
            ),
            ...flow.flatMap((step, i) => {
              const x = 0.48 + i * 0.16;
              const appear = enter('pop', 200 + i * 800, 350);
              const pill = chip(`flow-${i + 1}`, step, box(x, 0.29, 0.135, 0.085), {
                fill: VIOLET,
                style: { fontFamily: 'Poppins', fontSize: 0.028, fontWeight: 700 },
                role: 'caption',
                enter: appear,
              });
              if (i === flow.length - 1) return pill;
              return [
                ...pill,
                shape(
                  `flow-${i + 1}-arrow`,
                  'triangle',
                  box(x + 0.1392, 0.3175, 0.0169, 0.03),
                  '#ffffff80',
                  {
                    rotation: 90,
                    enter: appear,
                  },
                ),
              ];
            }),
            text(
              'zero',
              '0',
              box(0.48, 0.43, 0.11, 0.25),
              {
                fontFamily: 'Poppins',
                fontSize: 0.2,
                fontWeight: 800,
                align: 'left',
                color: AMBER,
              },
              { enter: enter('zoom-in', 2200, 450) },
            ),
            text(
              'zero-label',
              t(
                'instalaciones.\nTodo funciona en la nube.',
                'installs.\nEverything runs in the cloud.',
              ),
              box(0.6, 0.47, 0.35, 0.17),
              { fontSize: 0.034, fontWeight: 600, align: 'left', lineHeight: 1.35 },
              { role: 'body', enter: enter('fade', 2400) },
            ),
          ],
        },
        {
          id: 'cta',
          name: t('Precio', 'Price'),
          transition: { type: 'zoom', durationMs: 500 },
          background: { type: 'color', color: VIOLET, brandRole: 'primary' },
          script: narration(
            locale,
            'female',
            t(
              'Está disponible desde {{precio}}. Descúbrelo en {{web}}.',
              "It's available from {{price}}. Discover it at {{website}}.",
            ),
          ),
          layers: [
            shape('ring', 'ellipse', box(0.045, 0.14, 0.3825, 0.68), null, {
              stroke: { color: '#ffffff40', width: 0.004 },
            }),
            avatarBadge('avatar', PRESENTER, '16:9', 0.08, 0.2, 0.56),
            text(
              'from',
              t('Disponible desde', 'Available from'),
              box(0.46, 0.2, 0.48, 0.07),
              { fontSize: 0.034, fontWeight: 600, align: 'left', color: '#ffffffd9' },
              { role: 'subtitle' },
            ),
            text(
              'price',
              `{{${price}}}`,
              box(0.46, 0.27, 0.5, 0.2),
              {
                fontFamily: 'Poppins',
                fontSize: 0.085,
                fontWeight: 800,
                align: 'left',
                lineHeight: 1.08,
              },
              { role: 'title', enter: enter('slide-up', 100, 500) },
            ),
            text(
              'link',
              `{{${web}}}`,
              box(0.4725, 0.51, 0.44, 0.095),
              {
                fontFamily: 'Poppins',
                fontSize: 0.04,
                fontWeight: 700,
                align: 'left',
                color: INK,
                background: { color: WHITE, padding: 0.022, radius: 0.05 },
              },
              { enter: enter('pop', 700) },
            ),
          ],
        },
      ],
    };
  },
};
