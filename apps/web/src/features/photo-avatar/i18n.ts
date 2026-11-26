/* Translations of "create a photorealistic avatar". Spanish is the default language. */

const es = {
  nav: { photoAvatar: 'Avatar fotorrealista' },
  back: 'Avatares',
  eyebrow: 'Motor neuronal local',
  title: 'Crear avatar fotorrealista',
  description:
    'A partir de una foto tuya o de una descripción. Todo se procesa en este equipo con modelos abiertos, sin servicios de pago.',
  engineUnknown: 'No se pudo leer el estado del motor. Vuelve a comprobarlo.',
  optional: 'opcional',
  cancel: 'Cancelar',
  mode: {
    label: 'Cómo crear el avatar',
    photo: {
      title: 'Desde una foto',
      text: 'Sube el retrato de una persona real. El motor detecta la cara, la encuadra y separa el fondo.',
      note: 'Exige declaración de consentimiento',
    },
    generate: {
      title: 'Desde una descripción',
      text: 'Describe a una persona inventada y el motor genera su retrato. No representa a nadie real.',
      note: 'Persona sintética: sin consentimiento',
    },
  },
  allowance: 'Avatares propios: {{used}} de {{max}} (plan {{plan}})',
  problem: {
    nameRequired: 'Ponle un nombre al avatar.',
    nameTooLong: 'El nombre es demasiado largo.',
    photoRequired: 'Elige una foto para continuar.',
    promptRequired: 'Describe a la persona que quieres generar.',
    promptTooShort: 'La descripción es demasiado corta: da algún detalle más.',
    promptTooLong: 'La descripción es demasiado larga.',
    seedInvalid: 'La semilla es un número entero entre 0 y {{max}}.',
  },
  gender: { female: 'Femenino', male: 'Masculino', neutral: 'Neutro' },
  details: {
    title: 'Datos del avatar',
    name: 'Nombre',
    nameHint: 'Así aparecerá en la biblioteca.',
    gender: 'Género',
    genderHint: 'Solo sirve para filtrar y proponer una voz.',
  },
  photo: {
    pick: 'Elige la foto',
    drop: 'Arrastra un retrato o haz clic para elegirlo',
    formats: 'JPG, PNG o WebP.',
    previewAlt: 'Foto elegida para el avatar',
    change: 'Cambiar foto',
    tipsTitle: 'Para que salga bien',
    tips: {
      front: 'Cara de frente, mirando a cámara.',
      light: 'Luz uniforme, sin sombras fuertes.',
      alone: 'Una sola persona en la imagen.',
      clear: 'Sin gafas de sol, mascarilla ni manos sobre la cara.',
      size: 'Mejor de hombros hacia arriba y con buena resolución.',
    },
    private:
      'La foto no sale de tu navegador hasta que aceptes la declaración y pulses «Crear avatar». Después se guarda como origen del avatar y se borra con él.',
    consent: 'Consentimiento',
    engineOffTitle: 'El motor no puede preparar fotos ahora',
    engineOffText:
      'Puedes rellenar el formulario, pero no enviarlo hasta que el motor esté en marcha. Mira el panel «Motor neuronal local».',
    submit: 'Crear avatar',
    submitHint:
      'Al pulsar se sube la foto, se registra tu consentimiento y el motor empieza a prepararla.',
  },
  step: {
    idle: 'En espera',
    uploading: 'Subiendo la foto…',
    consent: 'Registrando el consentimiento…',
    creating: 'Poniendo el trabajo en cola…',
  },
  generate: {
    describe: 'Describe a la persona',
    prompt: 'Descripción',
    promptHint: 'Edad aproximada, pelo, ropa, expresión y fondo. Cuanto más concreta, mejor.',
    try: 'Prueba con:',
    exampleNames: {
      presenter: 'Presentadora',
      teacher: 'Profesor',
      creator: 'Creadora',
      senior: 'Divulgador sénior',
    },
    examples: {
      presenter:
        'Mujer de unos 35 años, melena castaña por los hombros, chaqueta azul marino, sonrisa suave, fondo gris neutro de estudio',
      teacher:
        'Hombre de unos 45 años, barba corta entrecana, gafas de pasta, jersey verde oscuro, expresión amable, fondo claro',
      creator:
        'Mujer joven de unos 25 años, pelo rizado oscuro recogido, sudadera mostaza, expresión alegre, fondo liso beige',
      senior:
        'Hombre de unos 65 años, pelo blanco corto, camisa clara y chaleco gris, mirada serena, fondo gris oscuro',
    },
    syntheticTitle: 'Solo personas inventadas',
    syntheticText:
      'No escribas nombres ni describas a personas reales o reconocibles: la moderación rechaza esas descripciones. Si quieres tu propia cara, usa «Desde una foto» con tu consentimiento.',
    seed: 'Semilla',
    seedHint: 'Con la misma descripción y semilla sale el mismo retrato.',
    seedPlaceholder: 'Aleatoria',
    time: {
      measured: 'Generar un retrato tarda unos {{time}} en este equipo (medido por el motor).',
      unmeasured:
        'El motor aún no ha medido cuánto tarda en este equipo; en CPU puede llevar varios minutos.',
    },
    engineOffTitle: 'El motor no puede generar retratos ahora',
    engineOffText:
      'Hace falta que el motor esté en marcha con los modelos de generación y de preparación. Mira el panel «Motor neuronal local».',
    submit: 'Generar avatar',
    submitHint: 'El motor genera el retrato y después lo prepara para animarlo.',
  },
  job: {
    back: 'Volver al formulario',
    kind: { photo: 'Avatar desde foto', generated: 'Avatar generado' },
    progressLabel: 'Preparación de {{name}}',
    stage: {
      photo: 'Preparando el retrato',
      generated: 'Generando y preparando el retrato',
    },
    elapsed: 'Tiempo transcurrido',
    typical: 'Un retrato en este equipo',
    explain: {
      photo:
        'El motor detecta la cara, endereza y encuadra el retrato y separa a la persona del fondo.',
      generated:
        'El motor genera el retrato a partir de tu descripción y después lo prepara igual que una foto.',
    },
    device: {
      cpu: 'Se ejecuta en CPU: es lento pero correcto.',
      gpu: 'Se ejecuta con GPU.',
    },
    leave: 'Puedes salir de esta página: el trabajo sigue y el avatar aparecerá en la biblioteca.',
    readyToast: '{{name}} ya está listo',
    failedToast: 'No se pudo crear {{name}}',
    readyTitle: 'Avatar listo',
    readyText:
      'Ya puedes usarlo en tus vídeos. En el Studio verás una vista previa aproximada; al exportar lo anima el motor neuronal.',
    resultAlt: 'Retrato preparado de {{name}}',
    standIn: 'Vista previa aproximada. En el vídeo lo anima el motor neuronal.',
    landmarks: 'Puntos de la cara',
    landmarksSource: {
      detected: 'Detectados por el motor',
      user: 'Marcados a mano',
      estimated: 'Estimados (sin detección)',
    },
    model: 'Modelo',
    seed: 'Semilla',
    use: 'Usar en un vídeo',
    open: 'Ver en la biblioteca',
    another: 'Crear otro',
    videoTitle: 'Vídeo con {{name}}',
    videoScript: 'Hola, soy {{name}}. Escribe aquí lo que quieres que cuente.',
    videoCreated: 'Borrador creado con este avatar',
    videoFailed: 'No se pudo crear el vídeo',
    failedTitle: 'No se pudo crear el avatar',
    failedUnknown: 'El motor no terminó el trabajo.',
    refunded: 'Los créditos se han devuelto.',
    retry: 'Intentar de nuevo',
    discard: 'Descartar',
    deleteFailed: 'No se pudo descartar',
  },
  queue: {
    title: 'En preparación',
    progress: 'Progreso de {{name}}',
    eta: 'quedan {{time}}',
  },
};

const en: typeof es = {
  nav: { photoAvatar: 'Photorealistic avatar' },
  back: 'Avatars',
  eyebrow: 'Local neural engine',
  title: 'Create a photorealistic avatar',
  description:
    'From a photo of yourself or from a description. Everything is processed on this machine with open models, with no paid service.',
  engineUnknown: 'The state of the engine could not be read. Check again.',
  optional: 'optional',
  cancel: 'Cancel',
  mode: {
    label: 'How to create the avatar',
    photo: {
      title: 'From a photo',
      text: 'Upload the portrait of a real person. The engine detects the face, frames it and separates the background.',
      note: 'Needs a consent declaration',
    },
    generate: {
      title: 'From a description',
      text: 'Describe an invented person and the engine generates their portrait. It depicts nobody real.',
      note: 'Synthetic person: no consent needed',
    },
  },
  allowance: 'Own avatars: {{used}} of {{max}} ({{plan}} plan)',
  problem: {
    nameRequired: 'Give the avatar a name.',
    nameTooLong: 'The name is too long.',
    photoRequired: 'Choose a photo to continue.',
    promptRequired: 'Describe the person you want to generate.',
    promptTooShort: 'The description is too short: add some detail.',
    promptTooLong: 'The description is too long.',
    seedInvalid: 'The seed is a whole number between 0 and {{max}}.',
  },
  gender: { female: 'Female', male: 'Male', neutral: 'Neutral' },
  details: {
    title: 'Avatar details',
    name: 'Name',
    nameHint: 'This is how it shows in the library.',
    gender: 'Gender',
    genderHint: 'Only used to filter and to suggest a voice.',
  },
  photo: {
    pick: 'Choose the photo',
    drop: 'Drop a portrait or click to choose one',
    formats: 'JPG, PNG or WebP.',
    previewAlt: 'Photo chosen for the avatar',
    change: 'Change photo',
    tipsTitle: 'For a good result',
    tips: {
      front: 'Face to the front, looking at the camera.',
      light: 'Even light, no hard shadows.',
      alone: 'Only one person in the picture.',
      clear: 'No sunglasses, mask or hands over the face.',
      size: 'Shoulders up and a good resolution work best.',
    },
    private:
      'The photo does not leave your browser until you accept the declaration and press "Create avatar". It is then stored as the source of the avatar and deleted with it.',
    consent: 'Consent',
    engineOffTitle: 'The engine cannot prepare photos right now',
    engineOffText:
      'You can fill in the form, but not send it until the engine is running. See the "Local neural engine" panel.',
    submit: 'Create avatar',
    submitHint:
      'Pressing it uploads the photo, records your consent and the engine starts preparing it.',
  },
  step: {
    idle: 'Waiting',
    uploading: 'Uploading the photo…',
    consent: 'Recording the consent…',
    creating: 'Queuing the job…',
  },
  generate: {
    describe: 'Describe the person',
    prompt: 'Description',
    promptHint:
      'Approximate age, hair, clothes, expression and background. The more specific, the better.',
    try: 'Try with:',
    exampleNames: {
      presenter: 'Presenter',
      teacher: 'Teacher',
      creator: 'Creator',
      senior: 'Senior explainer',
    },
    examples: {
      presenter:
        'Woman of about 35, shoulder-length brown hair, navy blazer, soft smile, neutral grey studio background',
      teacher:
        'Man of about 45, short greying beard, thick-rimmed glasses, dark green jumper, kind expression, light background',
      creator:
        'Young woman of about 25, dark curly hair tied up, mustard hoodie, cheerful expression, plain beige background',
      senior:
        'Man of about 65, short white hair, light shirt and grey waistcoat, calm look, dark grey background',
    },
    syntheticTitle: 'Invented people only',
    syntheticText:
      'Do not write names or describe real or recognisable people: moderation rejects those descriptions. If you want your own face, use "From a photo" with your consent.',
    seed: 'Seed',
    seedHint: 'The same description and seed give the same portrait.',
    seedPlaceholder: 'Random',
    time: {
      measured:
        'Generating a portrait takes about {{time}} on this machine (measured by the engine).',
      unmeasured:
        'The engine has not measured how long it takes on this machine yet; on CPU it can take several minutes.',
    },
    engineOffTitle: 'The engine cannot generate portraits right now',
    engineOffText:
      'The engine has to be running with the generation and preparation models. See the "Local neural engine" panel.',
    submit: 'Generate avatar',
    submitHint: 'The engine generates the portrait and then prepares it to be animated.',
  },
  job: {
    back: 'Back to the form',
    kind: { photo: 'Avatar from a photo', generated: 'Generated avatar' },
    progressLabel: 'Preparation of {{name}}',
    stage: {
      photo: 'Preparing the portrait',
      generated: 'Generating and preparing the portrait',
    },
    elapsed: 'Elapsed time',
    typical: 'One portrait on this machine',
    explain: {
      photo:
        'The engine detects the face, straightens and frames the portrait and separates the person from the background.',
      generated:
        'The engine generates the portrait from your description and then prepares it like a photo.',
    },
    device: {
      cpu: 'It runs on CPU: slow but correct.',
      gpu: 'It runs with a GPU.',
    },
    leave: 'You can leave this page: the job goes on and the avatar will show up in the library.',
    readyToast: '{{name}} is ready',
    failedToast: '{{name}} could not be created',
    readyTitle: 'Avatar ready',
    readyText:
      'You can use it in your videos now. The Studio shows an approximate preview; on export the neural engine animates it.',
    resultAlt: 'Prepared portrait of {{name}}',
    standIn: 'Approximate preview. In the video the neural engine animates it.',
    landmarks: 'Face landmarks',
    landmarksSource: {
      detected: 'Detected by the engine',
      user: 'Marked by hand',
      estimated: 'Estimated (no detection)',
    },
    model: 'Model',
    seed: 'Seed',
    use: 'Use in a video',
    open: 'See in the library',
    another: 'Create another',
    videoTitle: 'Video with {{name}}',
    videoScript: 'Hi, I am {{name}}. Write here what you want me to say.',
    videoCreated: 'Draft created with this avatar',
    videoFailed: 'The video could not be created',
    failedTitle: 'The avatar could not be created',
    failedUnknown: 'The engine did not finish the job.',
    refunded: 'The credits were refunded.',
    retry: 'Try again',
    discard: 'Discard',
    deleteFailed: 'It could not be discarded',
  },
  queue: {
    title: 'In preparation',
    progress: 'Progress of {{name}}',
    eta: '{{time}} left',
  },
};

export const translations = { es, en };
