/* Strings of the `script-writer` namespace (the AI script writer and, under `kit.*`, the kit
 * shared by the AI tools). Spanish is the source; English mirrors its shape (type-checked).
 * Keys never contain ':' (i18next reads it as a namespace separator). */

const es = {
  nav: { scriptWriter: 'Guionista IA' },
  common: { optional: '(opcional)', cancel: 'Cancelar' },
  page: {
    tab: 'Guionista IA',
    eyebrow: 'Guionista IA',
    title: 'De una idea a una escaleta',
    description:
      'Cuéntale de qué va el vídeo —o pásale una página web— y te devuelve un guion repartido en escenas, listo para retocar y llevar al Studio.',
  },
  brief: {
    eyebrow: 'El encargo',
    title: '¿De qué va el vídeo?',
    source: { label: 'Punto de partida', topic: 'Un tema', url: 'Una página web' },
    topic: {
      label: 'Tema',
      placeholder:
        'Ej.: Cómo funciona nuestra app de reservas para clínicas dentales y por qué ahorra llamadas.',
      hint: 'Cuanto más concreto, mejor: producto, público y lo que quieres que recuerden.',
    },
    url: {
      label: 'Dirección de la página',
      placeholder: 'https://ejemplo.com/articulo',
      hint: 'El servidor lee el texto de la página. Solo direcciones públicas http(s).',
    },
    tone: {
      label: 'Tono',
      options: {
        professional: { name: 'Profesional', text: 'Claro y sobrio, para empresa.' },
        friendly: { name: 'Cercano', text: 'De tú a tú, como a un conocido.' },
        enthusiastic: { name: 'Entusiasta', text: 'Con energía, para lanzamientos.' },
        educational: { name: 'Didáctico', text: 'Paso a paso, para formación.' },
        persuasive: { name: 'Persuasivo', text: 'Orientado a la acción, para vender.' },
        humorous: { name: 'Con humor', text: 'Ligero y con chispa.' },
      },
    },
    duration: {
      label: 'Duración objetivo',
      hint: 'Tu plan admite vídeos de hasta {{max}}.',
    },
    language: {
      label: 'Idioma del guion',
      hint: 'También decide qué voces podrás elegir después.',
    },
    more: 'Más opciones',
    scenes: {
      label: 'Número de escenas',
      hint: 'En automático se reparte según la duración.',
      auto: 'Automático',
      count_one: '{{count}} escena',
      count_other: '{{count}} escenas',
    },
    audience: {
      label: 'Público',
      placeholder: 'Ej.: responsables de clínicas pequeñas',
    },
    mode: {
      basic:
        'Lo escribirá la heurística local: una estructura de partida con tu tema repartido en escenas, sin redacción creativa. Es gratis. Con una clave de Anthropic en el servidor lo escribe Claude.',
      premium:
        'Lo escribirá {{name}}. Cada guion cuesta 1 crédito; si la generación falla, se devuelve.',
    },
    submit: 'Escribir el guion',
    again: 'Escribirlo de nuevo',
    writing: 'Escribiendo…',
  },
  loading: {
    topic: 'Escribiendo el guion…',
    url: 'Leyendo la página y escribiendo el guion…',
  },
  empty: {
    title: 'Aquí aparecerá la escaleta',
    text: 'Rellena el encargo y pulsa «Escribir el guion». Podrás corregir cada escena, reordenarlas y ver cuánto dura antes de crear el vídeo.',
  },
  scene: {
    label: 'Escena',
    silent: 'sin voz',
    approx: '≈ {{time}}',
    name: 'Nombre de la escena',
    namePlaceholder: 'Escena {{number}}',
    text: 'Narración',
    textPlaceholder: 'Lo que dirá el avatar en esta escena.',
    headline: 'Titular en pantalla',
    headlineHint: 'Texto corto que acompaña al avatar. Déjalo vacío para no mostrar ninguno.',
    moveUp: 'Subir la escena {{number}}',
    moveDown: 'Bajar la escena {{number}}',
    remove: 'Eliminar la escena {{number}}',
  },
  script: {
    region: 'Guion',
    eyebrow: 'Escaleta',
    edited: 'Con cambios tuyos',
    title: 'Título del vídeo',
    untitled: 'Ponle un título para poder crear el vídeo.',
    basedOn: 'Basado en «{{title}}»',
    stats: { scenes: 'Escenas', estimated: 'Duración estimada', target: 'Pediste' },
    basicTitle: 'Escrito en modo básico',
    basic:
      'Este guion lo ha escrito la heurística local, no un modelo de lenguaje: úsalo como estructura y reescribe las frases a tu gusto.',
    scenes: 'Escenas del guion',
    addScene: 'Añadir escena',
    problems: {
      noNarration: 'Ninguna escena tiene narración: escribe al menos una para crear el vídeo.',
      tooManyScenes: 'Tu plan admite hasta {{max}} escenas por vídeo. Elimina alguna.',
      tooLong: 'La duración estimada supera el máximo de tu plan ({{max}}). Acorta el guion.',
    },
    silentScenes_one: '{{count}} escena no tiene narración: quedará en silencio.',
    silentScenes_other: '{{count}} escenas no tienen narración: quedarán en silencio.',
    next: 'Cuando el texto te convenza, elige quién lo cuenta.',
    discard: 'Descartar',
    createVideo: 'Crear vídeo con este guion',
  },
  create: {
    title: 'Crear vídeo con este guion',
    description_one: '{{count}} escena · ≈ {{time}} · narración en {{language}}',
    description_other: '{{count}} escenas · ≈ {{time}} · narración en {{language}}',
    avatar: '¿Quién lo cuenta?',
    voice: 'Voz',
    voiceHint: 'Voces que hablan {{language}}.',
    aspect: 'Formato',
    aspects: { landscape: 'Horizontal 16:9', portrait: 'Vertical 9:16', square: 'Cuadrado 1:1' },
    subtitles: 'Subtítulos incrustados',
    subtitlesHint: 'Se generan del propio guion; podrás cambiar su estilo en el Studio.',
    photoreal:
      'Has elegido un avatar fotorrealista: el render usa el motor neuronal local, tarda más y cuesta el doble de créditos.',
    draftNote:
      'Se crea un borrador en tus vídeos. No gasta créditos: el render se lanza después, desde el Studio.',
    submit: 'Crear el vídeo',
    failed: 'No se ha podido crear el vídeo',
    done: 'Borrador creado',
    doneText: 'Lo abrimos para que revises las escenas antes de renderizar.',
    doneNoStudio: 'Lo encontrarás entre tus vídeos.',
    createdText: '«{{title}}» ya está entre tus vídeos como borrador.',
    open: 'Abrir el borrador',
  },
  replace: {
    title: '¿Sustituir el guion actual?',
    text: 'Has hecho cambios en el guion. Si lo escribes de nuevo, se pierden.',
    confirm: 'Escribir de nuevo',
  },
  discard: {
    title: '¿Descartar este guion?',
    text: 'Se borra la escaleta de esta pestaña. El encargo se conserva.',
    confirm: 'Descartar',
  },
  errors: {
    topicShort: 'Describe el tema con al menos 3 caracteres.',
    urlInvalid: 'Escribe una dirección web válida, por ejemplo https://ejemplo.com/pagina.',
    unsafeUrl:
      'Esa dirección no está permitida: solo se leen páginas públicas de internet, no redes internas.',
    unreadableUrl:
      'No se ha podido leer texto de esa página. Prueba con otra dirección o describe el tema.',
    blocked:
      'El tema o el resultado no cumplen las normas de uso, así que no se ha generado el guion. Reformula el encargo.',
    provider:
      'El proveedor de IA no ha devuelto un guion válido. No se ha cobrado nada; vuelve a intentarlo.',
    retry: 'Reintentar',
    buyCredits: 'Ver planes y créditos',
  },
  kit: {
    avatar: { instant: '2D', photoreal: 'Foto' },
    voice: {
      gender: { female: 'Femenina', male: 'Masculina', neutral: 'Neutra' },
      basic: 'modo básico',
      multilingual: 'multilingüe',
      groups: { auto: 'Sin elegir', cloned: 'Voces clonadas', stock: 'Voces de serie' },
      loading: 'Cargando voces…',
      placeholder: 'Elige una voz',
      empty: 'No hay voces disponibles para este idioma.',
      error: 'No se han podido cargar las voces.',
      retry: 'Reintentar',
    },
    mode: { basicTitle: 'Modo básico', premiumTitle: 'Modelo de IA externo' },
    credits: {
      free: 'Gratis: no gasta créditos',
      cost_one: 'Cuesta {{formatted}} crédito',
      cost_other: 'Cuesta {{formatted}} créditos',
      estimate_one: 'Coste estimado: {{formatted}} crédito',
      estimate_other: 'Coste estimado: {{formatted}} créditos',
      balance_one: 'Tienes {{formatted}} crédito en este workspace.',
      balance_other: 'Tienes {{formatted}} créditos en este workspace.',
      short_one: 'Te falta {{count}} crédito: el saldo es de {{balance}}.',
      short_other: 'Te faltan {{count}} créditos: el saldo es de {{balance}}.',
      buy: 'Ver planes y créditos',
    },
  },
};

const en: typeof es = {
  nav: { scriptWriter: 'AI script writer' },
  common: { optional: '(optional)', cancel: 'Cancel' },
  page: {
    tab: 'AI script writer',
    eyebrow: 'AI script writer',
    title: 'From an idea to a running order',
    description:
      'Say what the video is about — or hand it a web page — and get back a script split into scenes, ready to polish and take to the Studio.',
  },
  brief: {
    eyebrow: 'The brief',
    title: 'What is the video about?',
    source: { label: 'Starting point', topic: 'A topic', url: 'A web page' },
    topic: {
      label: 'Topic',
      placeholder:
        'E.g. How our booking app for dental clinics works and why it saves phone calls.',
      hint: 'The more specific the better: product, audience and what they should remember.',
    },
    url: {
      label: 'Page address',
      placeholder: 'https://example.com/article',
      hint: 'The server reads the text of the page. Public http(s) addresses only.',
    },
    tone: {
      label: 'Tone',
      options: {
        professional: { name: 'Professional', text: 'Clear and sober, for business.' },
        friendly: { name: 'Friendly', text: 'Warm, like talking to someone you know.' },
        enthusiastic: { name: 'Enthusiastic', text: 'High energy, for launches.' },
        educational: { name: 'Educational', text: 'Step by step, for training.' },
        persuasive: { name: 'Persuasive', text: 'Action oriented, for selling.' },
        humorous: { name: 'Humorous', text: 'Light and witty.' },
      },
    },
    duration: {
      label: 'Target duration',
      hint: 'Your plan allows videos up to {{max}}.',
    },
    language: {
      label: 'Script language',
      hint: 'It also decides which voices you can pick afterwards.',
    },
    more: 'More options',
    scenes: {
      label: 'Number of scenes',
      hint: 'Automatic splits it according to the duration.',
      auto: 'Automatic',
      count_one: '{{count}} scene',
      count_other: '{{count}} scenes',
    },
    audience: {
      label: 'Audience',
      placeholder: 'E.g. managers of small clinics',
    },
    mode: {
      basic:
        'The local heuristic will write it: a starting structure with your topic spread over scenes, no creative writing. It is free. With an Anthropic key on the server, Claude writes it.',
      premium:
        '{{name}} will write it. Each script costs 1 credit; if the generation fails it is refunded.',
    },
    submit: 'Write the script',
    again: 'Write it again',
    writing: 'Writing…',
  },
  loading: {
    topic: 'Writing the script…',
    url: 'Reading the page and writing the script…',
  },
  empty: {
    title: 'The running order will appear here',
    text: 'Fill in the brief and press “Write the script”. You can fix every scene, reorder them and see how long it runs before creating the video.',
  },
  scene: {
    label: 'Scene',
    silent: 'no voice',
    approx: '≈ {{time}}',
    name: 'Scene name',
    namePlaceholder: 'Scene {{number}}',
    text: 'Narration',
    textPlaceholder: 'What the avatar says in this scene.',
    headline: 'On-screen headline',
    headlineHint: 'Short text next to the avatar. Leave it empty to show none.',
    moveUp: 'Move scene {{number}} up',
    moveDown: 'Move scene {{number}} down',
    remove: 'Delete scene {{number}}',
  },
  script: {
    region: 'Script',
    eyebrow: 'Running order',
    edited: 'With your changes',
    title: 'Video title',
    untitled: 'Give it a title to create the video.',
    basedOn: 'Based on “{{title}}”',
    stats: { scenes: 'Scenes', estimated: 'Estimated length', target: 'You asked for' },
    basicTitle: 'Written in basic mode',
    basic:
      'This script was written by the local heuristic, not a language model: use it as a structure and rewrite the sentences to taste.',
    scenes: 'Scenes of the script',
    addScene: 'Add scene',
    problems: {
      noNarration: 'No scene has narration: write at least one to create the video.',
      tooManyScenes: 'Your plan allows up to {{max}} scenes per video. Delete some.',
      tooLong: 'The estimated length is above your plan maximum ({{max}}). Shorten the script.',
    },
    silentScenes_one: '{{count}} scene has no narration: it will be silent.',
    silentScenes_other: '{{count}} scenes have no narration: they will be silent.',
    next: 'When the text feels right, choose who tells it.',
    discard: 'Discard',
    createVideo: 'Create video with this script',
  },
  create: {
    title: 'Create video with this script',
    description_one: '{{count}} scene · ≈ {{time}} · narration in {{language}}',
    description_other: '{{count}} scenes · ≈ {{time}} · narration in {{language}}',
    avatar: 'Who tells it?',
    voice: 'Voice',
    voiceHint: 'Voices that speak {{language}}.',
    aspect: 'Format',
    aspects: { landscape: 'Landscape 16:9', portrait: 'Portrait 9:16', square: 'Square 1:1' },
    subtitles: 'Burned-in subtitles',
    subtitlesHint: 'Generated from the script itself; you can restyle them in the Studio.',
    photoreal:
      'You picked a photorealistic avatar: the render uses the local neural engine, takes longer and costs twice the credits.',
    draftNote:
      'A draft is created in your videos. It spends no credits: rendering starts later, from the Studio.',
    submit: 'Create the video',
    failed: 'The video could not be created',
    done: 'Draft created',
    doneText: 'We are opening it so you can review the scenes before rendering.',
    doneNoStudio: 'You will find it among your videos.',
    createdText: '“{{title}}” is now among your videos as a draft.',
    open: 'Open the draft',
  },
  replace: {
    title: 'Replace the current script?',
    text: 'You changed the script. Writing it again discards those changes.',
    confirm: 'Write again',
  },
  discard: {
    title: 'Discard this script?',
    text: 'The running order is removed from this tab. The brief is kept.',
    confirm: 'Discard',
  },
  errors: {
    topicShort: 'Describe the topic with at least 3 characters.',
    urlInvalid: 'Enter a valid web address, for example https://example.com/page.',
    unsafeUrl:
      'That address is not allowed: only public internet pages are read, not internal networks.',
    unreadableUrl:
      'No text could be read from that page. Try another address or describe the topic.',
    blocked:
      'The topic or the result breaks the usage rules, so no script was generated. Rephrase the brief.',
    provider: 'The AI provider did not return a valid script. Nothing was charged; try again.',
    retry: 'Retry',
    buyCredits: 'See plans and credits',
  },
  kit: {
    avatar: { instant: '2D', photoreal: 'Photo' },
    voice: {
      gender: { female: 'Female', male: 'Male', neutral: 'Neutral' },
      basic: 'basic mode',
      multilingual: 'multilingual',
      groups: { auto: 'No choice', cloned: 'Cloned voices', stock: 'Stock voices' },
      loading: 'Loading voices…',
      placeholder: 'Pick a voice',
      empty: 'No voices are available for this language.',
      error: 'The voices could not be loaded.',
      retry: 'Retry',
    },
    mode: { basicTitle: 'Basic mode', premiumTitle: 'External AI model' },
    credits: {
      free: 'Free: it spends no credits',
      cost_one: 'Costs {{formatted}} credit',
      cost_other: 'Costs {{formatted}} credits',
      estimate_one: 'Estimated cost: {{formatted}} credit',
      estimate_other: 'Estimated cost: {{formatted}} credits',
      balance_one: 'You have {{formatted}} credit in this workspace.',
      balance_other: 'You have {{formatted}} credits in this workspace.',
      short_one: 'You are {{count}} credit short: the balance is {{balance}}.',
      short_other: 'You are {{count}} credits short: the balance is {{balance}}.',
      buy: 'See plans and credits',
    },
  },
};

export const translations = { es, en };
