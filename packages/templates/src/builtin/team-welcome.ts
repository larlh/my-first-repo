import {
  NAVY,
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

const HOST = 'stock_elena';

/** Welcome for a new hire: greeting → first day → who to ask. 16:9, three scenes. */
export const teamWelcomeTemplate: TemplateDefinition = {
  id: 'builtin_team-welcome',
  category: 'training',
  aspect: '16:9',
  name: { es: 'Bienvenida al equipo', en: 'Welcome to the team' },
  description: {
    es: 'Recibe a una persona nueva: saludo con su nombre, agenda del primer día y a quién acudir.',
    en: 'Welcome a new hire: a greeting by name, the first-day agenda and who to turn to.',
  },
  tags: {
    es: ['bienvenida', 'onboarding', 'recursos humanos', 'horizontal'],
    en: ['welcome', 'onboarding', 'human resources', 'landscape'],
  },
  build(t, locale) {
    const name = t('nombre', 'name');
    const team = t('equipo', 'team');
    const contact = t('contacto', 'contact');
    const agenda = [
      [t('9:00', '9:00'), t('Café con el equipo', 'Coffee with the team')],
      [t('11:00', '11:00'), t('Tus herramientas y accesos', 'Your tools and accounts')],
      [t('15:00', '3:00'), t('Tu primer proyecto', 'Your first project')],
    ] as const;
    return {
      music: { stockId: 'music-warm-acoustic', volume: 0.13 },
      variables: [
        variable(name, t('Nombre de la persona', "New hire's name"), t('Marta', 'Emma')),
        variable(team, t('Nombre del equipo', 'Team name'), t('Producto', 'Product')),
        variable(
          contact,
          t('Correo de contacto', 'Contact email'),
          t('personas@parlante.example', 'people@parlante.example'),
        ),
      ],
      scenes: [
        {
          id: 'welcome',
          name: t('Bienvenida', 'Welcome'),
          background: stockBackground('bg-office'),
          script: narration(
            locale,
            'female',
            t(
              '¡Hola, {{nombre}}! Soy Elena y te doy la bienvenida al equipo de {{equipo}}.',
              "Hi, {{name}}! I'm Elena, and I'd like to welcome you to the {{team}} team.",
            ),
          ),
          layers: [
            avatar('avatar', HOST, stand('16:9', 0.76, 0.1)),
            shape('card', 'rect', box(0.05, 0.2, 0.5, 0.46), '#ffffffeb', {
              radius: 0.03,
              enter: enter('slide-right', 0, 500),
            }),
            shape('card-accent', 'rect', box(0.05, 0.2, 0.012, 0.46), VIOLET, {
              enter: enter('slide-right', 0, 500),
            }),
            text(
              'title',
              t('Te damos la bienvenida, {{nombre}}', 'Welcome aboard, {{name}}'),
              box(0.09, 0.24, 0.43, 0.26),
              {
                fontFamily: 'Poppins',
                fontSize: 0.058,
                fontWeight: 800,
                align: 'left',
                color: NAVY,
                lineHeight: 1.15,
              },
              { enter: enter('fade', 300, 500) },
            ),
            text(
              'team',
              t('Equipo de {{equipo}}', '{{team}} team'),
              box(0.09, 0.52, 0.43, 0.08),
              { fontSize: 0.034, fontWeight: 600, align: 'left', color: VIOLET },
              { enter: enter('fade', 600, 500) },
            ),
          ],
        },
        {
          id: 'first-day',
          name: t('Tu primer día', 'Your first day'),
          transition: { type: 'slide-left', durationMs: 500 },
          background: { type: 'color', color: '#f6efe2', brandRole: 'background' },
          script: narration(
            locale,
            'female',
            t(
              'Tu primer día será tranquilo: un café con el equipo, la puesta a punto de tus herramientas y, por la tarde, tu primer proyecto.',
              'Your first day will be easy-going: coffee with the team, getting your tools set up and, in the afternoon, your first project.',
            ),
          ),
          layers: [
            avatar('avatar', HOST, stand('16:9', 0.22, 0.14)),
            text(
              'heading',
              t('Tu primer día', 'Your first day'),
              box(0.44, 0.13, 0.5, 0.1),
              {
                fontFamily: 'Poppins',
                fontSize: 0.054,
                fontWeight: 800,
                align: 'left',
                color: NAVY,
              },
              { role: 'subtitle' },
            ),
            ...agenda.flatMap(([time, activity], i) => {
              const y = 0.29 + i * 0.135;
              const appear = enter('slide-left', 900 + i * 1700, 450);
              return [
                text(
                  `agenda-${i + 1}-time`,
                  time,
                  box(0.44, y, 0.11, 0.085),
                  {
                    fontFamily: 'Poppins',
                    fontSize: 0.03,
                    fontWeight: 700,
                    color: WHITE,
                    background: { color: VIOLET, padding: 0.016, radius: 0.04 },
                  },
                  { role: 'caption', enter: appear },
                ),
                text(
                  `agenda-${i + 1}-activity`,
                  activity,
                  box(0.57, y, 0.39, 0.085),
                  { fontSize: 0.034, fontWeight: 600, align: 'left', color: NAVY },
                  { role: 'body', enter: appear },
                ),
              ];
            }),
          ],
        },
        {
          id: 'contact',
          name: t('A quién acudir', 'Who to ask'),
          transition: { type: 'fade', durationMs: 500 },
          background: stockBackground('bg-office', { dim: 0.6, blur: 0.01 }),
          script: narration(
            locale,
            'female',
            t(
              'Si tienes cualquier duda, escribe a {{contacto}}. ¡Nos vemos dentro!',
              'If you have any questions, write to {{contact}}. See you inside!',
            ),
          ),
          layers: [
            avatar('avatar', HOST, stand('16:9', 0.76, 0.1)),
            text(
              'question',
              t('¿Tienes dudas?', 'Any questions?'),
              box(0.06, 0.26, 0.48, 0.14),
              { fontFamily: 'Poppins', fontSize: 0.07, fontWeight: 800, align: 'left' },
              { role: 'title', enter: enter('slide-up') },
            ),
            text(
              'write-to',
              t('Escríbenos a', 'Write to us at'),
              box(0.06, 0.42, 0.48, 0.06),
              { fontSize: 0.032, fontWeight: 500, align: 'left', color: '#ffffffd9' },
              { role: 'subtitle' },
            ),
            text(
              'contact',
              `{{${contact}}}`,
              box(0.0713, 0.5, 0.48, 0.09),
              {
                fontFamily: 'Poppins',
                fontSize: 0.032,
                fontWeight: 700,
                align: 'left',
                color: NAVY,
                background: { color: WHITE, padding: 0.02, radius: 0.05 },
              },
              { enter: enter('pop', 500) },
            ),
          ],
        },
      ],
    };
  },
};
