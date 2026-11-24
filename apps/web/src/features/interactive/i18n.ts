/* Strings of the `interactive` namespace. Spanish is the source; English mirrors its shape
 * (type-checked). Keys never contain ':' (i18next reads it as a namespace separator). */

const es = {
  nav: { interactive: 'Avatar interactivo' },
  page: {
    tab: 'Avatar interactivo',
    eyebrow: 'Avatar interactivo',
    title: 'Una conversación cara a cara',
    description:
      'Escribe y el avatar te contesta en voz alta, moviendo los labios con cada sílaba. Sirve para ensayar un asistente, una recepción virtual o un tutor antes de publicarlo.',
  },
  setup: {
    eyebrow: 'Preparar la conversación',
    title: '¿Con quién vas a hablar?',
    viewer: 'Con tu rol puedes releer las conversaciones, pero no empezar una nueva.',
    avatar: 'Avatar',
    avatarHint: 'Los avatares 2D se animan al instante en tu navegador.',
    language: 'Idioma de la conversación',
    voice: 'Voz',
    name: 'Nombre con el que se presenta',
    nameHint: 'Así se llamará en la conversación.',
    optional: '(opcional)',
    instructions: 'Instrucciones',
    instructionsHint: 'Para qué sirve y cómo debe contestar.',
    instructionsPlaceholder:
      'Ej.: Eres la recepcionista de una clínica dental. Contesta en dos frases y ofrece pedir cita.',
    knowledge: 'Conocimiento',
    knowledgeHint: 'Texto en el que puede apoyarse: preguntas frecuentes, horarios, precios…',
    knowledgePlaceholder:
      'Ej.: ¿Cuál es el horario? De lunes a viernes de 9 a 20 h.\n¿Dónde estáis? En la calle Mayor, 12.',
    mode: {
      basic:
        'Contestará la heurística local: busca la respuesta en el conocimiento que le des y, si no la encuentra, lo dice con frases hechas. No razona ni improvisa. Es gratis. Con una clave de Anthropic en el servidor contesta Claude.',
      premium_one:
        'Contestará {{name}}. Empezar una conversación cuesta {{count}} crédito; los mensajes no se cobran aparte.',
      premium_other:
        'Contestará {{name}}. Empezar una conversación cuesta {{count}} créditos; los mensajes no se cobran aparte.',
    },
    costDetail: 'Se cobra una vez, al empezar la conversación.',
    start: 'Empezar a hablar',
    preview: 'En la cabina',
    previewLabel: 'Vista previa animada de {{name}}',
    instant: 'Avatar 2D: se dibuja en tu navegador con el mismo código que el vídeo final.',
    photoreal:
      'Avatar fotorrealista: en directo se muestra una vista previa de la foto con un movimiento leve; la animación neuronal completa solo existe en el vídeo renderizado.',
    errors: {
      name: 'Escribe el nombre con el que se presentará.',
      blocked: 'Este texto no cumple las normas de uso. Cámbialo para continuar.',
      failed: 'No se ha podido empezar la conversación',
    },
  },
  recent: {
    title: 'Conversaciones anteriores',
    emptyTitle: 'Todavía no has hablado con nadie',
    emptyText: 'Cuando empieces una conversación, aquí quedará su historial.',
    messages_one: '{{count}} mensaje',
    messages_other: '{{count}} mensajes',
    active: 'Abierta',
    ended: 'Terminada',
  },
  session: {
    tab: 'Conversación',
    eyebrow: 'Conversación en directo',
    missingTitle: 'Conversación no disponible',
    back: 'Volver al avatar interactivo',
    live: 'En directo',
    ended: 'Terminada',
    voice: 'voz de {{name}}',
    started: 'empezó {{when}}',
    again: 'Hablar otra vez',
    answeredBy: 'Responde',
    spokenBy: 'y pone la voz',
    basicTitle: 'Modo básico',
    basicText:
      'Las respuestas salen de la heurística local, no de un modelo de lenguaje: se limita al conocimiento que le diste y a frases hechas.',
    endedTitle: 'Esta conversación ha terminado',
    endedAt: 'Se cerró el {{when}}. Puedes releerla y volver a escuchar las respuestas.',
    endedText: 'Puedes releerla y volver a escuchar las respuestas.',
    viewer: 'Con tu rol puedes leer la conversación, pero no escribir en ella.',
  },
  end: {
    action: 'Terminar',
    title: '¿Terminar la conversación?',
    text: 'El historial se conserva, pero no se podrán enviar más mensajes.',
    confirm: 'Terminar',
    failed: 'No se ha podido terminar la conversación',
  },
  stage: {
    label: '{{name}}, avatar animado',
    phase: { idle: 'A la escucha', thinking: 'Pensando', speaking: 'En el aire' },
    stop: 'Callar al avatar',
    mute: 'Silenciar el audio',
    unmute: 'Activar el audio',
    blockedTitle: 'El navegador ha retenido el audio',
    blockedText: 'Hace falta un clic para que suene la respuesta.',
    blockedAction: 'Escuchar la respuesta',
    avatarMissing:
      'El avatar de esta conversación ya no está disponible; las respuestas siguen sonando.',
    photoreal:
      'Avatar fotorrealista en vista previa: en directo solo se mueve levemente. La animación neuronal completa existe en los vídeos renderizados.',
  },
  transcript: {
    region: 'Conversación',
    label: 'Mensajes de la conversación',
    you: 'Tú',
    thinking: 'Pensando la respuesta…',
    empty: 'Saluda a {{name}} para empezar.',
    emptyEnded: 'Esta conversación se cerró sin mensajes.',
  },
  message: {
    listen: 'Escuchar esta respuesta',
    stop: 'Detener el audio',
    loadingAudio: 'Preparando el audio…',
    audioFailed: 'No se ha podido generar el audio',
    noAudio: 'sin audio: la síntesis de voz ha fallado',
    by: 'Respuesta de {{name}}',
    byBasic: 'Respuesta en modo básico',
    blocked: 'Mensaje bloqueado por las normas de uso. No se ha enviado.',
    ended: 'La conversación está cerrada o llegó a su límite de mensajes.',
    retry: 'Reintentar',
    remove: 'Quitar',
  },
  composer: {
    label: 'Mensaje para {{name}}',
    placeholder: 'Escribe a {{name}}…',
    hint: 'Intro envía · Mayús + Intro hace un salto de línea',
    send: 'Enviar',
  },
};

const en: typeof es = {
  nav: { interactive: 'Interactive avatar' },
  page: {
    tab: 'Interactive avatar',
    eyebrow: 'Interactive avatar',
    title: 'A face-to-face conversation',
    description:
      'Type and the avatar answers out loud, moving its lips with every syllable. Use it to rehearse an assistant, a virtual front desk or a tutor before publishing it.',
  },
  setup: {
    eyebrow: 'Set up the conversation',
    title: 'Who are you going to talk to?',
    viewer: 'Your role can read conversations but cannot start a new one.',
    avatar: 'Avatar',
    avatarHint: '2D avatars are animated instantly in your browser.',
    language: 'Conversation language',
    voice: 'Voice',
    name: 'Name it introduces itself with',
    nameHint: 'What it is called in the conversation.',
    optional: '(optional)',
    instructions: 'Instructions',
    instructionsHint: 'What it is for and how it should answer.',
    instructionsPlaceholder:
      'E.g. You are the receptionist of a dental clinic. Answer in two sentences and offer to book an appointment.',
    knowledge: 'Knowledge',
    knowledgeHint: 'Text it can rely on: frequent questions, opening hours, prices…',
    knowledgePlaceholder:
      'E.g. What are the opening hours? Monday to Friday, 9 am to 8 pm.\nWhere are you? 12 Main Street.',
    mode: {
      basic:
        'The local heuristic will answer: it looks the answer up in the knowledge you give it and, when it is not there, says so with stock phrases. It does not reason or improvise. It is free. With an Anthropic key on the server, Claude answers.',
      premium_one:
        '{{name}} will answer. Starting a conversation costs {{count}} credit; messages are not charged separately.',
      premium_other:
        '{{name}} will answer. Starting a conversation costs {{count}} credits; messages are not charged separately.',
    },
    costDetail: 'Charged once, when the conversation starts.',
    start: 'Start talking',
    preview: 'In the booth',
    previewLabel: 'Animated preview of {{name}}',
    instant: '2D avatar: drawn in your browser with the same code as the final video.',
    photoreal:
      'Photorealistic avatar: live you see a preview of the photo with slight motion; full neural animation only exists in rendered videos.',
    errors: {
      name: 'Enter the name it will introduce itself with.',
      blocked: 'This text breaks the usage rules. Change it to continue.',
      failed: 'The conversation could not be started',
    },
  },
  recent: {
    title: 'Earlier conversations',
    emptyTitle: 'You have not talked to anyone yet',
    emptyText: 'When you start a conversation, its history stays here.',
    messages_one: '{{count}} message',
    messages_other: '{{count}} messages',
    active: 'Open',
    ended: 'Ended',
  },
  session: {
    tab: 'Conversation',
    eyebrow: 'Live conversation',
    missingTitle: 'Conversation not available',
    back: 'Back to the interactive avatar',
    live: 'Live',
    ended: 'Ended',
    voice: 'voice of {{name}}',
    started: 'started {{when}}',
    again: 'Talk again',
    answeredBy: 'Answered by',
    spokenBy: 'and voiced by',
    basicTitle: 'Basic mode',
    basicText:
      'Answers come from the local heuristic, not a language model: it is limited to the knowledge you gave it and to stock phrases.',
    endedTitle: 'This conversation has ended',
    endedAt: 'It was closed on {{when}}. You can reread it and listen to the answers again.',
    endedText: 'You can reread it and listen to the answers again.',
    viewer: 'Your role can read the conversation but cannot write in it.',
  },
  end: {
    action: 'End',
    title: 'End the conversation?',
    text: 'The history is kept, but no more messages can be sent.',
    confirm: 'End',
    failed: 'The conversation could not be ended',
  },
  stage: {
    label: '{{name}}, animated avatar',
    phase: { idle: 'Listening', thinking: 'Thinking', speaking: 'On air' },
    stop: 'Silence the avatar',
    mute: 'Mute the audio',
    unmute: 'Unmute the audio',
    blockedTitle: 'The browser held the audio back',
    blockedText: 'It needs a click to play the answer.',
    blockedAction: 'Listen to the answer',
    avatarMissing:
      'The avatar of this conversation is no longer available; answers are still spoken.',
    photoreal:
      'Photorealistic avatar in preview: live it only moves slightly. Full neural animation exists in rendered videos.',
  },
  transcript: {
    region: 'Conversation',
    label: 'Messages of the conversation',
    you: 'You',
    thinking: 'Thinking about the answer…',
    empty: 'Say hello to {{name}} to begin.',
    emptyEnded: 'This conversation was closed without messages.',
  },
  message: {
    listen: 'Listen to this answer',
    stop: 'Stop the audio',
    loadingAudio: 'Preparing the audio…',
    audioFailed: 'The audio could not be generated',
    noAudio: 'no audio: speech synthesis failed',
    by: 'Answer by {{name}}',
    byBasic: 'Basic-mode answer',
    blocked: 'Message blocked by the usage rules. It was not sent.',
    ended: 'The conversation is closed or reached its message limit.',
    retry: 'Retry',
    remove: 'Remove',
  },
  composer: {
    label: 'Message for {{name}}',
    placeholder: 'Write to {{name}}…',
    hint: 'Enter sends · Shift + Enter breaks the line',
    send: 'Send',
  },
};

export const translations = { es, en };
