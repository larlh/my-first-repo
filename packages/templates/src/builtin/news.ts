import {
  INK,
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

const ANCHOR = 'stock_omar';
const RED = '#e23b4e';
const SKY = '#7fd0ff';
const NIGHT = '#061534';

const label = (color: string) =>
  ({
    fontFamily: 'Montserrat',
    fontSize: 0.024,
    fontWeight: 800,
    letterSpacing: 0.14,
    align: 'left',
    background: { color, padding: 0.013, radius: 0.006 },
  }) as const;

/** News bulletin: opener → headline → figure of the day → sign-off. 16:9, four scenes. */
export const newsTemplate: TemplateDefinition = {
  id: 'builtin_news',
  category: 'news',
  aspect: '16:9',
  name: { es: 'Boletín de noticias', en: 'News bulletin' },
  description: {
    es: 'Un informativo breve con presentador en plató: cabecera, titular, el dato del día y despedida.',
    en: 'A short newscast with an anchor in the studio: opener, headline, figure of the day and sign-off.',
  },
  tags: {
    es: ['noticias', 'informativo', 'comunicado', 'horizontal'],
    en: ['news', 'bulletin', 'announcement', 'landscape'],
  },
  build(t, locale) {
    const show = t('programa', 'show');
    const date = t('fecha', 'date');
    const headline = t('titular', 'headline');
    const web = t('web', 'website');
    const bars = [0.05, 0.075, 0.105, 0.15];
    return {
      music: { stockId: 'music-news-desk', volume: 0.1 },
      subtitles: { preset: 'classic', fontFamily: 'Montserrat', fontWeight: 600 },
      variables: [
        variable(
          show,
          t('Nombre del programa', 'Show name'),
          t('Parlante Noticias', 'Parlante News'),
        ),
        variable(
          date,
          t('Fecha en pantalla', 'On-screen date'),
          t('Lunes, 3 de marzo', 'Monday, March 3'),
        ),
        variable(
          headline,
          t('Titular', 'Headline'),
          t(
            'El ayuntamiento amplía el transporte nocturno',
            'City council extends night transport',
          ),
        ),
        variable(web, t('Página web', 'Website'), 'parlante.example'),
      ],
      scenes: [
        {
          id: 'opener',
          name: t('Cabecera', 'Opener'),
          background: stockBackground('bg-newsroom'),
          script: narration(
            locale,
            'male',
            t(
              'Buenas tardes. Esto es {{programa}} y estos son los titulares de hoy.',
              "Good afternoon. This is {{show}}, and here are today's headlines.",
            ),
          ),
          layers: [
            avatar('avatar', ANCHOR, stand('16:9', 0.76, 0.1)),
            text(
              'label',
              t('INFORMATIVO', 'NEWS BULLETIN'),
              box(0.0675, 0.22, 0.3, 0.06),
              label(RED),
              {
                role: 'caption',
                enter: enter('slide-right', 0, 400),
              },
            ),
            text(
              'title',
              `{{${show}}}`,
              box(0.06, 0.31, 0.5, 0.28),
              {
                fontFamily: 'Montserrat',
                fontSize: 0.082,
                fontWeight: 800,
                align: 'left',
                lineHeight: 1.08,
                shadow: { color: '#00000080', blur: 0.012, offsetX: 0, offsetY: 0.004 },
              },
              { role: 'title', enter: enter('slide-up', 150, 500) },
            ),
            shape('rule', 'rect', box(0.06, 0.615, 0.44, 0.006), SKY, {
              role: 'accent',
              enter: enter('fade', 500),
            }),
            text(
              'date',
              `{{${date}}}`,
              box(0.06, 0.635, 0.5, 0.06),
              { fontSize: 0.03, fontWeight: 500, align: 'left', color: '#ffffffd9' },
              { role: 'subtitle', enter: enter('fade', 600) },
            ),
          ],
        },
        {
          id: 'headline',
          name: t('Titular', 'Headline'),
          transition: { type: 'wipe', durationMs: 450 },
          background: stockBackground('bg-newsroom', { dim: 0.15 }),
          script: narration(
            locale,
            'male',
            t(
              '{{titular}}. Según las primeras informaciones, la medida entrará en vigor el próximo mes.',
              '{{headline}}. According to early reports, the measure comes into force next month.',
            ),
          ),
          layers: [
            avatar('avatar', ANCHOR, stand('16:9', 0.24, 0.1)),
            shape('panel', 'rect', box(0.47, 0.15, 0.47, 0.57), '#04102bd9', {
              radius: 0.025,
              stroke: { color: '#7fd0ff66', width: 0.002 },
              enter: enter('fade', 0, 400),
            }),
            text('label', t('ÚLTIMA HORA', 'BREAKING'), box(0.5075, 0.2, 0.3, 0.055), label(RED), {
              role: 'caption',
              enter: enter('slide-right', 200, 400),
            }),
            text(
              'headline',
              `{{${headline}}}`,
              box(0.5, 0.285, 0.41, 0.25),
              {
                fontFamily: 'Montserrat',
                fontSize: 0.046,
                fontWeight: 700,
                align: 'left',
                verticalAlign: 'top',
                lineHeight: 1.18,
              },
              { role: 'title', enter: enter('slide-up', 350, 500) },
            ),
            shape('panel-rule', 'rect', box(0.5, 0.565, 0.41, 0.003), '#7fd0ff66', {
              enter: enter('fade', 1000),
            }),
            text(
              'summary',
              t(
                'La medida entrará en vigor el próximo mes.',
                'The measure comes into force next month.',
              ),
              box(0.5, 0.585, 0.41, 0.11),
              {
                fontSize: 0.028,
                fontWeight: 500,
                align: 'left',
                color: '#ffffffcc',
                lineHeight: 1.3,
              },
              { role: 'body', enter: enter('fade', 1200) },
            ),
          ],
        },
        {
          id: 'figure',
          name: t('El dato', 'The figure'),
          transition: { type: 'slide-left', durationMs: 450 },
          background: { type: 'color', color: NIGHT, brandRole: 'background' },
          script: narration(
            locale,
            'male',
            t(
              'El dato del día: se espera un treinta y cinco por ciento más de viajeros por la noche.',
              'The figure of the day: night-time ridership is expected to grow by thirty-five percent.',
            ),
          ),
          layers: [
            shape('beam-1', 'rect', box(0.52, -0.3, 0.1, 1.6), '#2a86ff1f', { rotation: 18 }),
            shape('beam-2', 'rect', box(0.74, -0.3, 0.04, 1.6), '#7fd0ff1a', { rotation: 18 }),
            shape('floor', 'rect', box(0, 0.76, 1, 0.006), RED),
            avatar('avatar', ANCHOR, stand('16:9', 0.78, 0.1)),
            text(
              'label',
              t('EL DATO', 'BY THE NUMBERS'),
              box(0.0675, 0.16, 0.3, 0.055),
              label('#2a86ff'),
              {
                role: 'caption',
              },
            ),
            text(
              'number',
              t('+35 %', '+35%'),
              box(0.06, 0.23, 0.5, 0.25),
              {
                fontFamily: 'Montserrat',
                fontSize: 0.18,
                fontWeight: 800,
                align: 'left',
                color: SKY,
              },
              { enter: enter('zoom-in', 300, 500) },
            ),
            text(
              'caption',
              t('viajeros nocturnos previstos', 'expected night-time passengers'),
              box(0.06, 0.485, 0.5, 0.07),
              { fontSize: 0.034, fontWeight: 600, align: 'left' },
              { role: 'body', enter: enter('fade', 700) },
            ),
            ...bars.map((height, i) =>
              shape(
                `bar-${i + 1}`,
                'rect',
                box(0.06 + i * 0.05, 0.75 - height, 0.036, height),
                i === bars.length - 1 ? RED : SKY,
                { radius: 0.006, enter: enter('slide-up', 900 + i * 200, 350) },
              ),
            ),
          ],
        },
        {
          id: 'signoff',
          name: t('Despedida', 'Sign-off'),
          transition: { type: 'fade', durationMs: 500 },
          background: stockBackground('bg-newsroom'),
          script: narration(
            locale,
            'male',
            t(
              'Esto ha sido todo por hoy. Tienes más información en {{web}}. Hasta mañana.',
              "That's all for today. You can find more at {{website}}. See you tomorrow.",
            ),
          ),
          layers: [
            avatar('avatar', ANCHOR, stand('16:9', 0.76, 0.1)),
            text(
              'title',
              t('Más información', 'More information'),
              box(0.06, 0.28, 0.48, 0.12),
              { fontFamily: 'Montserrat', fontSize: 0.058, fontWeight: 800, align: 'left' },
              { role: 'title' },
            ),
            text(
              'link',
              `{{${web}}}`,
              box(0.0713, 0.43, 0.44, 0.09),
              {
                fontFamily: 'Montserrat',
                fontSize: 0.038,
                fontWeight: 700,
                align: 'left',
                color: INK,
                background: { color: WHITE, padding: 0.02, radius: 0.01 },
              },
              { enter: enter('slide-right', 400) },
            ),
            text(
              'note',
              t('Volvemos mañana a la misma hora', 'Back tomorrow at the same time'),
              box(0.06, 0.57, 0.48, 0.06),
              { fontSize: 0.03, fontWeight: 500, align: 'left', color: '#ffffffd9' },
              { role: 'subtitle' },
            ),
          ],
        },
      ],
    };
  },
};
