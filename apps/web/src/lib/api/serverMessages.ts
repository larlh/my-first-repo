/* -------------------------------------------------------------------------------------------
 * Server messages in the language of the interface.
 *
 * The API and the worker explain every refusal with an English sentence (`error.message`, also
 * stored on failed videos, avatars, voices and translations). The error CODE is translated by
 * the shell (`errors.<CODE>`), but for generic codes — UNPROCESSABLE above all — the sentence is
 * what tells the person what to do, and showing it verbatim put English prose in a Spanish
 * screen. This table gives the sentences a person can actually run into a Spanish wording.
 *
 * Anything not listed is not hidden: `localizeServerMessage` returns it marked as `technical`
 * and the UI shows it labelled as a technical detail. `serverMessages.test.ts` fails when a
 * sentence listed here no longer exists in the server sources, so the table cannot rot silently.
 * ----------------------------------------------------------------------------------------- */

/** Exact English sentence → Spanish. */
export const SERVER_MESSAGES_ES: Readonly<Record<string, string>> = {
  // Rendering
  'A file used by this video no longer exists or is not of the expected type. Replace it in the editor and render again.':
    'Un archivo que usa este vídeo ya no existe o no es del tipo esperado. Sustitúyelo en el editor y vuelve a renderizar.',
  'A file used by this video no longer exists. Replace it in the editor and render again.':
    'Un archivo que usa este vídeo ya no existe. Sustitúyelo en el editor y vuelve a renderizar.',
  'A file used by this video no longer exists': 'Un archivo que usa este vídeo ya no existe.',
  'A stock file used by this video does not exist or is not of the expected type':
    'Un archivo de la biblioteca incluida que usa este vídeo no existe o no es del tipo esperado.',
  'A voice used by this video is not available':
    'Una de las voces que usa este vídeo no está disponible.',
  'An audio file used by this video has no sound':
    'Un archivo de audio que usa este vídeo no tiene sonido.',
  'An avatar used by this video does not exist any more or is not ready':
    'Un avatar que usa este vídeo ya no existe o todavía no está listo.',
  'An avatar used by this video is not ready yet':
    'Un avatar que usa este vídeo todavía no está listo.',
  'An image used by this video could not be decoded':
    'No se ha podido leer una de las imágenes que usa este vídeo.',
  'This video uses an avatar that does not exist': 'Este vídeo usa un avatar que no existe.',
  'The narration audio of a scene is missing or is not an audio file':
    'Falta el audio de narración de una escena, o no es un archivo de audio.',
  'The narration audio of a scene is missing': 'Falta el audio de narración de una escena.',
  'The content of this video was blocked by moderation':
    'La moderación ha bloqueado el contenido de este vídeo.',
  'This content was blocked by moderation': 'La moderación ha bloqueado este contenido.',
  'This text was blocked by moderation': 'La moderación ha bloqueado este texto.',
  'The translated text was blocked by moderation': 'La moderación ha bloqueado el texto traducido.',
  'The worker stopped while rendering this video. Nothing was charged; try again.':
    'El proceso de render se detuvo a mitad de este vídeo. No se ha cobrado nada; vuelve a intentarlo.',
  'This video is being changed somewhere else. Reload it before saving':
    'Este vídeo se está modificando en otro sitio. Recárgalo antes de guardar.',
  'This video was changed somewhere else. Reload it before saving':
    'Este vídeo se ha modificado en otro sitio. Recárgalo antes de guardar.',

  // Translation
  'There is nothing to dub: the translated transcript has no speakable text':
    'No hay nada que doblar: la transcripción traducida no contiene texto que se pueda pronunciar.',
  'The transcript has no text inside the length of the video':
    'La transcripción no tiene texto dentro de la duración del vídeo.',
  'The transcript contains no usable text': 'La transcripción no contiene texto aprovechable.',
  'A plain-text transcript needs the length of the audio to be timed':
    'Una transcripción sin tiempos necesita la duración del audio para repartirse.',
  'No speech was recognised in this video': 'No se ha reconocido voz en este vídeo.',
  'This video has no audio to transcribe: provide its transcript':
    'Este vídeo no tiene audio que transcribir: aporta su transcripción.',
  'Automatic transcription is not available in local mode: provide the transcript (SRT, VTT or text)':
    'La transcripción automática no existe en modo local: aporta la transcripción (SRT, VTT o texto).',
  'Automatic transcription is not configured on this server: provide the transcript of the video (SRT, VTT or plain text)':
    'Este servidor no tiene transcripción automática: aporta la transcripción del vídeo (SRT, VTT o texto).',
  'Only a video that has been rendered can be translated. Render it first':
    'Solo se puede traducir un vídeo ya renderizado. Renderízalo primero.',
  'The rendered file of this video is missing. Render it again':
    'Falta el archivo renderizado de este vídeo. Renderízalo otra vez.',
  'The file to translate must be a video': 'El archivo que se traduce tiene que ser un vídeo.',
  'The file to translate has no video stream': 'El archivo que se traduce no contiene vídeo.',
  'The length of this video could not be read': 'No se ha podido leer la duración de este vídeo.',
  'The video could not be decoded': 'No se ha podido leer el vídeo.',
  'The video to translate no longer exists': 'El vídeo que se iba a traducir ya no existe.',
  'The translation provider returned a different number of segments':
    'El proveedor de traducción ha devuelto un número distinto de fragmentos.',

  // Batches
  'The source video has no {{variables}}: every row would produce the same video. Add a variable such as {{nombre}} to its script or texts':
    'El vídeo de partida no tiene {{variables}}: todas las filas darían el mismo vídeo. Añade una variable como {{nombre}} a su guion o a sus textos.',
  'This batch has already finished': 'Este lote ya ha terminado.',
  'Not enough credits to render every row of this batch':
    'No hay créditos suficientes para renderizar todas las filas de este lote.',

  // Avatars and voices
  'The photo of this avatar is missing': 'Falta la foto de este avatar.',
  'The source of a photo avatar must be an image':
    'El origen de un avatar de foto tiene que ser una imagen.',
  'This avatar has no description to generate from':
    'Este avatar no tiene una descripción a partir de la cual generarlo.',
  'This avatar already failed; create it again': 'Este avatar ya falló; créalo de nuevo.',
  'The avatar was deleted while it was being created':
    'El avatar se eliminó mientras se estaba creando.',
  'This file is already the source of another resource':
    'Este archivo ya es el origen de otro avatar o de otra voz.',
  'This file is the source of another resource. Delete that resource first':
    'Este archivo es el origen de un avatar o de una voz. Elimina antes ese avatar o esa voz.',
  'A valid, unused consent declaration from you is required for this operation':
    'Esta operación exige una declaración de consentimiento tuya, válida y sin usar.',
  'This consent statement is not the current one':
    'Esa declaración de consentimiento no es la vigente. Recarga la página y acéptala de nuevo.',
  'The voice sample is missing': 'Falta la muestra de voz.',
  'The voice sample must be an audio recording':
    'La muestra de voz tiene que ser una grabación de audio.',
  'The voice sample could not be read as audio': 'La muestra de voz no se puede leer como audio.',
  'The voice sample is too short to clone a voice':
    'La muestra de voz es demasiado corta para clonar una voz.',
  'The voice sample is too short: record at least a few seconds of speech':
    'La muestra de voz es demasiado corta: graba al menos unos segundos de habla.',
  'The voice sample must last between 10 seconds and 5 minutes':
    'La muestra de voz debe durar entre 10 segundos y 5 minutos.',
  'No voice could be detected in the sample: record clear speech without music or noise':
    'No se detecta ninguna voz en la muestra: graba habla clara, sin música ni ruido.',
  'There is no local voice for this language': 'No hay una voz local para este idioma.',
  'This voice already failed; create it again': 'Esta voz ya falló; créala de nuevo.',
  'This cloned voice is not ready yet': 'Esta voz clonada todavía no está lista.',
  'The voice provider could not synthesize this text. Try again':
    'El proveedor de voz no ha podido sintetizar este texto. Vuelve a intentarlo.',
  'The local speech engine (eSpeak NG) failed': 'El motor de voz local (eSpeak NG) ha fallado.',

  // Interactive avatar
  'This session reached its message limit. Start a new one to keep talking':
    'Esta conversación ha llegado a su límite de mensajes. Empieza otra para seguir hablando.',

  // Uploads
  'This file type is not supported': 'Ese tipo de archivo no está admitido.',
  'The file is larger than the allowed size': 'El archivo supera el tamaño permitido.',
  'The media file could not be read': 'No se ha podido leer el archivo.',

  // URLs (webhooks, "URL → script")
  'Only http and https URLs are allowed': 'Solo se admiten URLs http y https.',
  'The URL is not valid': 'La URL no es válida.',
  'The URL points to a private or local address':
    'La URL apunta a una dirección privada o local, y no está permitido.',
  'The host of the URL could not be resolved': 'No se ha podido resolver el dominio de la URL.',
  'URLs with embedded credentials are not allowed':
    'No se admiten URLs con usuario y contraseña incluidos.',
  'The page redirects too many times': 'La página redirige demasiadas veces.',

  // Account, plan, webhooks
  'The current password is not correct': 'La contraseña actual no es correcta.',
  'Too many failed attempts. Try again later': 'Demasiados intentos fallidos. Prueba más tarde.',
  'Not enough credits for this operation': 'No hay créditos suficientes para esta operación.',
  'The current plan does not include API access': 'El plan actual no incluye acceso a la API.',
  'The endpoint is disabled': 'El endpoint está pausado.',
  'The signing secret of this endpoint cannot be read; rotate it':
    'No se puede leer el secreto de firma de este endpoint; rótalo.',
  'The job queue is not available right now. Try again':
    'La cola de trabajos no está disponible ahora mismo. Vuelve a intentarlo.',
};

/** Sentences with values inside: pattern → Spanish built from the captures. */
const PATTERNS_ES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [
    /^The (\S+) plan cannot render (\S+)$/,
    (m) => `El plan ${m[1]} no permite renderizar a ${m[2]}.`,
  ],
  [
    /^The (\S+) plan limit was reached: row (\d+) would be too long$/,
    (m) =>
      `Se ha alcanzado el límite del plan ${m[1]}: la fila ${m[2]} daría un vídeo demasiado largo.`,
  ],
  [/^The (\S+) plan limit was reached$/, (m) => `Se ha alcanzado el límite del plan ${m[1]}.`],
  [
    /^The workspace uses more than the (\S+) plan allows\. Reduce the usage before changing plan$/,
    (m) =>
      `El workspace usa más de lo que permite el plan ${m[1]}. Reduce el uso antes de cambiar de plan.`,
  ],
  [
    /^A workspace can have at most (\d+) brand kits$/,
    (m) => `Un workspace puede tener como máximo ${m[1]} kits de marca.`,
  ],
  [
    /^A workspace can have at most (\d+) custom templates$/,
    (m) => `Un workspace puede tener como máximo ${m[1]} plantillas propias.`,
  ],
  [
    /^You can own at most (\d+) workspaces$/,
    (m) => `Puedes ser propietario de ${m[1]} workspaces como máximo.`,
  ],
  [/^Row (\d+) has no value for: (.+)$/, (m) => `La fila ${m[1]} no tiene valor para: ${m[2]}.`],
  [/^The data has no column for: (.+)$/, (m) => `Los datos no tienen columna para: ${m[1]}.`],
  [
    /^The voice sample is too short: at least (\d+) seconds of speech are needed$/,
    (m) => `La muestra de voz es demasiado corta: hacen falta al menos ${m[1]} segundos de habla.`,
  ],
  [
    /^The site answered with an error \(HTTP (\d+)\)$/,
    (m) => `El sitio web ha respondido con un error (HTTP ${m[1]}).`,
  ],
  [
    /^(.+) could not write the script\. Try again$/,
    (m) => `${m[1]} no ha podido escribir el guion. Vuelve a intentarlo.`,
  ],
  [
    /^(.+) returned an empty script\. Try again$/,
    (m) => `${m[1]} ha devuelto un guion vacío. Vuelve a intentarlo.`,
  ],
  [
    /^(.+) could not answer\. Try again$/,
    (m) => `${m[1]} no ha podido contestar. Vuelve a intentarlo.`,
  ],
  [/^(.+) returned an empty answer$/, (m) => `${m[1]} ha devuelto una respuesta vacía.`],
  [
    /^The local avatar engine is not reachable at (\S+) \(.*$/,
    (m) =>
      `El motor neuronal local no responde en ${m[1]}. Arráncalo con «pnpm avatar-engine»; los avatares 2D instantáneos funcionan sin él.`,
  ],
];

/**
 * Codes whose translated title already says everything the sentence says: in a non-English
 * interface the English sentence adds nothing and is dropped.
 */
const SELF_EXPLANATORY = new Set([
  'NOT_FOUND',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'INVALID_API_KEY',
  'EMAIL_TAKEN',
  'FORBIDDEN',
  'INTERNAL',
  'NETWORK_ERROR',
  'ABORTED',
  'INVALID_RESPONSE',
  'RATE_LIMITED',
]);

export interface LocalizedServerMessage {
  /** Text to show ('' when there is nothing worth showing). */
  text: string;
  /** True when `text` is the untranslated English sentence: label it as a technical detail. */
  technical: boolean;
}

/** The sentence of a server error in the language of the interface, when we have one. */
export function localizeServerMessage(
  message: string | null | undefined,
  locale: string,
  code?: string | null,
): LocalizedServerMessage {
  const raw = (message ?? '').trim();
  if (raw === '') return { text: '', technical: false };
  if (locale.toLowerCase().startsWith('en')) return { text: raw, technical: false };

  const exact = SERVER_MESSAGES_ES[raw] ?? SERVER_MESSAGES_ES[raw.replace(/[.!]+$/, '')];
  if (exact) return { text: exact, technical: false };
  for (const [pattern, build] of PATTERNS_ES) {
    const match = pattern.exec(raw);
    if (match) return { text: build(match), technical: false };
  }
  if (code && SELF_EXPLANATORY.has(code)) return { text: '', technical: false };
  return { text: raw, technical: true };
}
