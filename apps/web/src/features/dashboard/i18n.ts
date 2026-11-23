/* Strings of the `dashboard` namespace (home page). */

const es = {
  titles: { home: 'Inicio' },
  nav: { home: 'Inicio' },
  hero: {
    greeting: {
      morning: 'Buenos días, {{name}}',
      afternoon: 'Buenas tardes, {{name}}',
      evening: 'Buenas noches, {{name}}',
    },
    text: '¿Qué grabamos hoy en {{workspace}}? Escribe el guion y la cabina hace el resto.',
    create: 'Crear vídeo',
    idle: 'Cabina libre',
    onAir_one: 'En el aire · {{count}} render en curso',
    onAir_other: 'En el aire · {{count}} renders en curso',
  },
  create: {
    title: 'Empezar un vídeo',
    blank: {
      title: 'En blanco',
      text: 'Elige el formato y monta las escenas a tu manera en el Studio.',
    },
    template: {
      title: 'Desde una plantilla',
      text: 'Explicativo, anuncio vertical, formación, noticia… ya montados.',
    },
    script: {
      title: 'Con el guionista IA',
      text: 'Un tema o una URL, y sale un guion dividido en escenas.',
    },
  },
  recent: {
    title: 'Vídeos recientes',
    all: 'Ver todos',
  },
  guide: {
    eyebrow: 'Tu primer vídeo',
    title: 'De un guion a un MP4 en tres pasos',
    text: 'Todavía no hay nada grabado en este workspace. Así se hace el primero:',
    textViewer:
      'Todavía no hay vídeos en este workspace. Con rol de lector podrás verlos cuando alguien del equipo los cree.',
    steps: {
      script: {
        title: 'Escribe el guion',
        text: 'Escena a escena, o deja que el guionista IA te dé un borrador.',
      },
      cast: {
        title: 'Elige avatar y voz',
        text: 'Quién lo cuenta, en qué idioma y sobre qué fondo.',
      },
      render: {
        title: 'Renderiza y comparte',
        text: 'Obtienes un MP4 con labios sincronizados y subtítulos.',
      },
    },
    action: 'Crear mi primer vídeo',
    offline: 'Funciona en este equipo, sin claves de servicios externos (modo básico).',
  },
  plan: {
    title: 'Créditos y plan',
    name: 'Plan {{plan}}',
    ofMonthly: 'de {{total}} al mes',
    costHint: 'Un crédito paga 30 s de vídeo a 720p.',
    low: 'Quedan pocos créditos para renderizar.',
    empty: 'No quedan créditos: no se puede renderizar hasta recargar.',
    last30: 'Últimos 30 días',
    renders_one: 'vídeo renderizado',
    renders_other: 'vídeos renderizados',
    spent_one: 'crédito gastado',
    spent_other: 'créditos gastados',
    usage: 'Uso del plan',
    includes: 'Incluido en el plan',
    maxResolution: 'Hasta {{resolution}}',
    maxDuration: 'Vídeos de hasta {{time}}',
    watermark: 'Con marca de agua',
    noWatermark: 'Sin marca de agua',
    manage: 'Ver plan y créditos',
    simulated: 'Los pagos de esta instalación son simulados.',
    failed: 'No se ha podido cargar el uso del plan',
    fallback: 'Saldo según tu sesión: {{credits}} créditos · plan {{plan}}.',
  },
  usage: {
    of: '{{used}} de {{limit}}',
    storage: 'Almacenamiento',
    members: 'Miembros',
    photoAvatars: 'Avatares fotorrealistas propios',
    clonedVoices: 'Voces clonadas',
  },
};

export type DashboardTranslations = typeof es;

const en: DashboardTranslations = {
  titles: { home: 'Home' },
  nav: { home: 'Home' },
  hero: {
    greeting: {
      morning: 'Good morning, {{name}}',
      afternoon: 'Good afternoon, {{name}}',
      evening: 'Good evening, {{name}}',
    },
    text: 'What are we recording today in {{workspace}}? Write the script and the booth does the rest.',
    create: 'Create video',
    idle: 'Booth is free',
    onAir_one: 'On air · {{count}} render in progress',
    onAir_other: 'On air · {{count}} renders in progress',
  },
  create: {
    title: 'Start a video',
    blank: {
      title: 'Blank',
      text: 'Pick the format and build the scenes your way in the Studio.',
    },
    template: {
      title: 'From a template',
      text: 'Explainer, vertical ad, training, news… already built.',
    },
    script: {
      title: 'With the AI script writer',
      text: 'A topic or a URL in, a script split into scenes out.',
    },
  },
  recent: {
    title: 'Recent videos',
    all: 'See all',
  },
  guide: {
    eyebrow: 'Your first video',
    title: 'From a script to an MP4 in three steps',
    text: 'Nothing has been recorded in this workspace yet. This is how the first one is made:',
    textViewer:
      'There are no videos in this workspace yet. As a viewer you will see them once someone on the team creates one.',
    steps: {
      script: {
        title: 'Write the script',
        text: 'Scene by scene, or let the AI script writer draft it.',
      },
      cast: {
        title: 'Pick avatar and voice',
        text: 'Who tells it, in which language and on which background.',
      },
      render: { title: 'Render and share', text: 'You get an MP4 with synced lips and subtitles.' },
    },
    action: 'Create my first video',
    offline: 'It runs on this machine, with no external service keys (basic mode).',
  },
  plan: {
    title: 'Credits and plan',
    name: '{{plan}} plan',
    ofMonthly: 'of {{total}} a month',
    costHint: 'One credit pays for 30 s of video at 720p.',
    low: 'Few credits left to render.',
    empty: 'No credits left: rendering is blocked until you top up.',
    last30: 'Last 30 days',
    renders_one: 'video rendered',
    renders_other: 'videos rendered',
    spent_one: 'credit spent',
    spent_other: 'credits spent',
    usage: 'Plan usage',
    includes: 'Included in the plan',
    maxResolution: 'Up to {{resolution}}',
    maxDuration: 'Videos up to {{time}}',
    watermark: 'With watermark',
    noWatermark: 'No watermark',
    manage: 'See plan and credits',
    simulated: 'Payments are simulated in this installation.',
    failed: 'Plan usage could not be loaded',
    fallback: 'Balance from your session: {{credits}} credits · {{plan}} plan.',
  },
  usage: {
    of: '{{used}} of {{limit}}',
    storage: 'Storage',
    members: 'Members',
    photoAvatars: 'Own photorealistic avatars',
    clonedVoices: 'Cloned voices',
  },
};

export const translations = { es, en };
