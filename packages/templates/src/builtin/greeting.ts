import {
  VIOLET,
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

const PRESENTER = 'stock_sofia';
const PLUM = '#2b2d42';

/** Personal greeting for any occasion: hello → message → sign-off. 1:1, three scenes. */
export const greetingTemplate: TemplateDefinition = {
  id: 'builtin_greeting',
  category: 'greeting',
  aspect: '1:1',
  name: { es: 'Saludo personalizado', en: 'Personal greeting' },
  description: {
    es: 'Felicita un cumpleaños, un aniversario o un logro con nombre, mensaje y firma personalizables.',
    en: 'Celebrate a birthday, an anniversary or an achievement with a custom name, message and sign-off.',
  },
  tags: {
    es: ['saludo', 'felicitación', 'cumpleaños', 'cuadrado'],
    en: ['greeting', 'congratulations', 'birthday', 'square'],
  },
  build(t, locale) {
    const name = t('nombre', 'name');
    const occasion = t('ocasion', 'occasion');
    const message = t('mensaje', 'message');
    const sender = t('remitente', 'sender');
    return {
      music: { stockId: 'music-happy-day', volume: 0.15 },
      subtitles: { fontFamily: 'Poppins', fontSize: 0.042, maxCharsPerLine: 26 },
      variables: [
        variable(name, t('Nombre de la persona', "Person's name"), t('Marta', 'Emma')),
        variable(occasion, t('Felicitación', 'Occasion'), t('Feliz cumpleaños', 'Happy birthday')),
        variable(
          message,
          t('Mensaje', 'Message'),
          t(
            'Que este año venga cargado de buenos momentos, salud y muchas risas.',
            'May this year bring you good times, good health and lots of laughter.',
          ),
        ),
        variable(sender, t('Quién firma', 'Who signs'), t('todo el equipo', 'the whole team')),
      ],
      scenes: [
        {
          id: 'hello',
          name: t('Saludo', 'Hello'),
          background: stockBackground('bg-confetti'),
          script: narration(
            locale,
            'female',
            t(
              '¡Hola, {{nombre}}! ¡{{ocasion}}! Hoy es tu día y queríamos celebrarlo contigo.',
              'Hi, {{name}}! {{occasion}}! Today is your day and we wanted to celebrate it with you.',
            ),
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('1:1', 0.5, 0.36)),
            shape('card', 'rect', box(0.07, 0.05, 0.86, 0.29), '#fffffff2', {
              radius: 0.04,
              enter: enter('pop', 200, 500),
            }),
            text(
              'title',
              t('¡{{ocasion}},\n{{nombre}}!', '{{occasion}},\n{{name}}!'),
              box(0.1, 0.06, 0.8, 0.27),
              {
                fontFamily: 'Playfair Display',
                fontSize: 0.078,
                fontWeight: 800,
                color: PLUM,
                lineHeight: 1.12,
              },
              { enter: enter('pop', 200, 500) },
            ),
          ],
        },
        {
          id: 'message',
          name: t('Mensaje', 'Message'),
          transition: { type: 'fade', durationMs: 500 },
          background: stockBackground('bg-bokeh'),
          script: narration(locale, 'female', `{{${message}}}`),
          layers: [
            avatar('avatar', PRESENTER, stand('1:1', 0.5, 0.46)),
            shape('card', 'rect', box(0.07, 0.06, 0.86, 0.37), '#ffffff1f', {
              radius: 0.04,
              stroke: { color: '#ffffff40', width: 0.002 },
              enter: enter('fade', 0, 400),
            }),
            text(
              'message',
              `{{${message}}}`,
              box(0.12, 0.08, 0.76, 0.33),
              { fontFamily: 'Playfair Display', fontSize: 0.05, fontWeight: 700, lineHeight: 1.28 },
              { role: 'body', enter: enter('fade', 200, 600) },
            ),
          ],
        },
        {
          id: 'signoff',
          name: t('Firma', 'Sign-off'),
          transition: { type: 'zoom', durationMs: 500 },
          background: stockBackground('bg-confetti'),
          script: narration(
            locale,
            'female',
            t(
              'Un abrazo muy fuerte de parte de {{remitente}}. ¡Disfruta mucho de tu día!',
              'A big hug from {{sender}}. Enjoy your day!',
            ),
          ),
          layers: [
            avatar('avatar', PRESENTER, stand('1:1', 0.5, 0.36)),
            shape('card', 'rect', box(0.07, 0.05, 0.86, 0.29), '#fffffff2', {
              radius: 0.04,
              enter: enter('fade', 0, 400),
            }),
            text('with-love', t('Con cariño,', 'With love,'), box(0.1, 0.075, 0.8, 0.08), {
              fontSize: 0.045,
              fontWeight: 500,
              color: PLUM,
            }),
            text(
              'sender',
              `{{${sender}}}`,
              box(0.1, 0.155, 0.8, 0.17),
              {
                fontFamily: 'Playfair Display',
                fontSize: 0.074,
                fontWeight: 800,
                color: VIOLET,
                lineHeight: 1.1,
              },
              { enter: enter('pop', 300, 500) },
            ),
          ],
        },
      ],
    };
  },
};
