/* Translations of the avatar library and of the shared library kit (`kit.*`, used by the
 * voices, photo-avatar and voice-clone features too). Spanish is the default language. */

const es = {
  nav: { avatars: 'Avatares' },
  eyebrow: 'Biblioteca',
  title: 'Avatares',
  description:
    'Elige quién presenta tu vídeo. Los instantáneos se dibujan en tiempo real; los fotorrealistas los anima el motor neuronal local al exportar.',
  create: 'Crear avatar fotorrealista',
  missing: 'Ese avatar ya no existe o no pertenece a este workspace.',
  views: {
    label: 'Tipo de avatar',
    all: 'Todos',
    instant: 'Instantáneos 2D',
    photoreal: 'Fotorrealistas',
    mine: 'Propios',
  },
  filters: {
    label: 'Filtros de avatares',
    search: 'Buscar avatares',
    searchPlaceholder: 'Nombre, estilo o etiqueta…',
    gender: 'Género',
    age: 'Edad',
    style: 'Estilo',
    anyGender: 'Cualquier género',
    anyAge: 'Cualquier edad',
    anyStyle: 'Cualquier estilo',
    clear: 'Quitar filtros',
  },
  gender: { female: 'Femenino', male: 'Masculino', neutral: 'Neutro' },
  age: { young: 'Joven', adult: 'Edad adulta', senior: 'Sénior' },
  style: { professional: 'Profesional', casual: 'Informal', creative: 'Creativo' },
  framing: { bust: 'Busto', half: 'Medio cuerpo', closeup: 'Primer plano' },
  empty: {
    title: 'Ningún avatar coincide',
    text: 'Prueba con otra búsqueda o quita algún filtro.',
    mineTitle: 'Aún no has creado avatares',
    mineText:
      'Crea un avatar fotorrealista desde una foto tuya (con tu consentimiento) o genera una persona sintética a partir de una descripción. Todo ocurre en este equipo, sin servicios de pago.',
  },
  shelf: {
    count_one: '{{count}} avatar',
    count_other: '{{count}} avatares',
    mine: {
      title: 'Tus avatares',
      text: 'Fotorrealistas creados por este workspace desde una foto o desde una descripción.',
    },
    instant: {
      title: 'Instantáneos 2D',
      text: 'Personajes ilustrados que se dibujan en tiempo real: lo que ves aquí es exactamente lo que sale en el vídeo. Pasa el cursor para verlos hablar.',
    },
    stockPhotoreal: {
      title: 'Fotorrealistas de stock',
      text: 'Personas sintéticas: nadie real. Se generaron con el motor local y se animan con él al exportar, más despacio que los 2D.',
    },
  },
  origin: {
    instant: 'Instantáneo 2D',
    stockPhotoreal: 'Fotorrealista',
    photo: 'Desde foto',
    generated: 'Generado',
  },
  originHint: {
    instant: 'Avatar ilustrado 2D de la biblioteca.',
    stockPhotoreal: 'Persona sintética fotorrealista de la biblioteca.',
    photo: 'Avatar fotorrealista creado desde una foto.',
    generated: 'Persona sintética generada desde una descripción.',
  },
  originText: {
    instant:
      'Avatar instantáneo: un personaje 2D paramétrico dibujado en Canvas. Labios, parpadeo y gestos se calculan en tiempo real, así que la vista previa del Studio y el vídeo exportado son idénticos.',
    stockPhotoreal:
      'Persona sintética: este rostro no pertenece a nadie. El retrato se generó con el motor neuronal local; al exportar, el mismo motor anima labios, parpadeo y cabeza.',
    photo:
      'Creado desde la foto de una persona real, con su consentimiento registrado. Al exportar lo anima el motor neuronal local.',
    generated:
      'Persona sintética generada por este workspace desde una descripción. No representa a nadie real. Al exportar la anima el motor neuronal local.',
  },
  card: {
    open: 'Abrir la ficha de {{name}}',
    live: 'Vista previa animada de {{name}}',
    portrait: 'Retrato de {{name}}',
    preparing: 'Preparación de {{name}}',
    progress: '{{percent}} %',
    eta: 'quedan {{time}}',
    failed: 'No se pudo crear',
  },
  sheet: {
    live: 'Vista previa animada de {{name}}',
    standIn: 'Vista previa aproximada. En el vídeo lo anima el motor neuronal.',
    framing: 'Encuadre',
    intro: 'Hola, soy {{name}}. Puedo presentar tu próximo vídeo.',
    listen: 'Escuchar presentación',
    stop: 'Parar',
    listenHint: {
      instant:
        'Sintetiza una frase con una voz local y mueve los labios con el mismo código que la exportación.',
      photoreal:
        'La voz es real; el movimiento de esta vista previa es solo una aproximación sobre el retrato. Labios, parpadeo y cabeza los genera el motor al exportar.',
    },
    processing: 'El motor local está preparando el avatar',
    failedTitle: 'No se pudo crear este avatar',
    failedText: 'El motor no terminó el trabajo. Los créditos se han devuelto.',
    renderCost: {
      measured:
        'Animar {{video}} de vídeo con este avatar tarda unos {{time}} en este equipo (velocidad medida por el motor).',
      unmeasured:
        'El motor todavía no ha medido su velocidad en este equipo; en CPU, animar puede tardar minutos por cada 10 s de vídeo.',
      off: 'Ahora mismo el motor no puede animar: los vídeos con este avatar no se pueden exportar hasta que lo arranques.',
      credits: 'Los renders fotorrealistas cuestan {{factor}}× créditos.',
    },
    nonCommercialTitle: 'Modelo de uso no comercial',
    nonCommercialText:
      'El motor tiene cargado al menos un modelo cuya licencia no permite uso comercial. Revisa las licencias antes de publicar vídeos con fines comerciales.',
    tags: 'Etiquetas',
    id: 'Identificador',
    prompt: 'Descripción con la que se generó',
    model: 'Modelo',
    seed: 'Semilla',
    landmarks: 'Puntos de la cara',
    landmarksSource: {
      detected: 'Detectados por el motor',
      user: 'Marcados a mano',
      estimated: 'Estimados (sin detección): la vista previa no mueve la boca',
    },
    created: 'Creado',
    use: 'Usar en un vídeo',
    videoTitle: 'Vídeo con {{name}}',
    videoScript: 'Hola, soy {{name}}. Escribe aquí lo que quieres que cuente.',
    videoCreated: 'Borrador creado con este avatar',
    videoFailed: 'No se pudo crear el vídeo',
    copyId: 'Copiar id',
    idCopied: 'Identificador copiado',
    idCopyFailed: 'No se pudo copiar',
    rename: 'Cambiar nombre',
    nameLabel: 'Nombre del avatar',
    save: 'Guardar',
    cancel: 'Cancelar',
    renamed: 'Nombre actualizado',
    renameFailed: 'No se pudo cambiar el nombre',
    delete: 'Eliminar avatar',
    deleteTitle: '¿Eliminar a {{name}}?',
    deleteText: {
      photo:
        'Se borran el avatar, sus imágenes, los clips en caché y la foto original. Los vídeos ya exportados se conservan; los borradores que lo usen no podrán renderizarse hasta cambiar de avatar.',
      generated:
        'Se borran el avatar, sus imágenes y los clips en caché. Los vídeos ya exportados se conservan; los borradores que lo usen no podrán renderizarse hasta cambiar de avatar.',
    },
    deleted: 'Avatar eliminado',
    deleteFailed: 'No se pudo eliminar el avatar',
  },
  kit: {
    player: {
      play: 'Reproducir la vista previa',
      pause: 'Pausar',
      replay: 'Volver a reproducir',
      position: 'Posición de la vista previa',
    },
    cost: {
      credits_one: 'Cuesta {{count}} crédito',
      credits_other: 'Cuesta {{count}} créditos',
      balance: '· tienes {{credits}}',
      refund: 'Se cobran al poner el trabajo en cola y se devuelven si falla.',
      billing: 'Ver créditos y planes',
    },
    failure: {
      detail: 'Respuesta del servidor: {{detail}}',
      buyCredits: 'Conseguir créditos',
      seePlans: 'Ver planes',
      consent: {
        title: 'Falta un consentimiento válido',
        text: 'El registro de consentimiento no existe, ya se usó o es de otra persona. Revisa la declaración y vuelve a enviarla.',
      },
      credits: {
        title: 'No hay créditos suficientes',
        text: 'No se ha cobrado ni creado nada.',
      },
      limit: {
        title: 'Has llegado al límite de tu plan',
        text: 'Elimina alguno de los que ya tienes o cambia de plan. No se ha cobrado nada.',
      },
      blocked: {
        title: 'El contenido no supera la moderación',
        text: 'El nombre o la descripción contienen algo no permitido, o describen a una persona real identificable. Cámbialo y vuelve a intentarlo.',
      },
      engine: {
        title: 'El motor local no puede hacerlo ahora',
        text: 'No se ha cobrado nada. Arranca el motor (panel «Motor neuronal local») y vuelve a intentarlo.',
      },
      notConfigured: {
        title: 'El proveedor no está configurado',
        text: 'Este servidor no tiene configurado el servicio necesario. No se ha cobrado nada.',
      },
      sourceInUse: {
        title: 'Ese archivo ya se está usando',
        text: 'El archivo ya es el origen de otro avatar o voz. Sube uno nuevo.',
      },
      tooLarge: {
        title: 'El archivo es demasiado grande',
        text: 'Supera el tamaño máximo de subida de tu plan.',
      },
      wrongFileType: {
        title: 'Ese tipo de archivo no sirve',
        text: 'El servidor comprueba el contenido real del archivo, no su extensión.',
      },
      invalid: {
        title: 'Hay datos que no son válidos',
        text: 'Revisa el formulario y vuelve a enviarlo.',
      },
      network: {
        title: 'No se pudo contactar con el servidor',
        text: 'Comprueba la conexión y vuelve a intentarlo. No se ha cobrado nada.',
      },
      generic: {
        title: 'No se pudo completar',
        text: 'Algo falló en el servidor. Vuelve a intentarlo.',
      },
    },
    consent: {
      title: 'Declaración de consentimiento',
      why: {
        photo_avatar:
          'Obligatoria para crear un avatar con la cara de una persona real. Sin ella, la operación se rechaza.',
        voice_clone:
          'Obligatoria para crear una voz a partir de la voz de una persona real. Sin ella, la operación se rechaza.',
      },
      name: 'Nombre completo de quien consiente',
      nameHint: 'La persona que aparece o habla, tal como firmaría.',
      relationship: '¿Quién consiente?',
      self: { photo_avatar: 'Soy yo', voice_clone: 'Es mi voz' },
      authorized: 'Tengo su autorización',
      accept: 'He leído la declaración y la acepto',
      acceptHint: 'Marca la casilla para continuar.',
      problem: {
        nameRequired: 'Escribe el nombre de quien consiente.',
        nameTooShort: 'El nombre es demasiado corto.',
        nameTooLong: 'El nombre es demasiado largo.',
        notAccepted: 'Tienes que aceptar la declaración para continuar.',
      },
      stored: {
        photo_avatar:
          'Guardamos la declaración con la fecha, tu usuario y tu IP. Si se revoca, se borran el avatar, sus archivos y la foto original.',
        voice_clone:
          'Guardamos la declaración con la fecha, tu usuario y tu IP. Si se revoca, se borran la voz, la muestra y el archivo original.',
      },
      manage: 'Ver consentimientos',
    },
    quality: {
      failedTitle: 'El retrato no pasó el control de calidad',
      failedText_one:
        'El motor lo intentó {{count}} vez y se quedó con este retrato. Puedes usarlo, pero la animación puede salir peor.',
      failedText_other:
        'El motor lo intentó {{count}} veces y se quedó con el mejor retrato. Puedes usarlo, pero la animación puede salir peor.',
      failedTextOnce:
        'El motor se quedó con este retrato aunque tiene defectos. Puedes usarlo, pero la animación puede salir peor.',
      remarksTitle: 'Retrato listo, con observaciones',
      issues: {
        no_face: 'No se detecta ninguna cara.',
        multiple_faces: 'Hay más de una cara.',
        face_not_clear: 'La cara no se ve con claridad.',
        face_too_small: 'La cara ocupa muy poco del retrato.',
        face_too_large: 'La cara está demasiado cerca.',
        head_tilted: 'La cabeza está inclinada.',
        not_frontal: 'La cara no está de frente.',
        head_pitched: 'La cabeza mira hacia arriba o hacia abajo.',
        off_center: 'La cara no está centrada.',
        mouth_open: 'La boca está abierta: la animación parte mejor de una boca cerrada.',
        eyes_closed: 'Los ojos están cerrados.',
        not_looking_at_camera: 'No mira a cámara.',
        matte_fallback:
          'El fondo se separó con el modelo de reserva: el borde del recorte puede ser menos fino.',
        no_matte: 'No se pudo separar el fondo: el avatar se muestra con el fondo de su foto.',
      },
    },
    reasons: {
      engine_unreachable: 'El motor neuronal se detuvo o no está arrancado.',
      engine_timeout: 'El motor neuronal no contestó a tiempo.',
      engine_error: 'El motor neuronal respondió con un error interno.',
      engine_invalid: 'El motor neuronal respondió algo que este servidor no entiende.',
      weights_missing: 'Al motor neuronal le faltan pesos de modelos por descargar.',
      not_configured: 'Este servidor no tiene configurado ningún motor de avatares.',
      unsupported_image: 'La imagen no es un PNG, JPEG o WebP válido.',
      image_unreadable: 'El archivo de imagen está dañado y no se pudo leer.',
      image_too_small: 'La imagen es demasiado pequeña.',
      image_too_large: 'La imagen es demasiado grande.',
      no_face: 'No se detecta ninguna cara en la foto. Usa un retrato de frente y bien iluminado.',
      no_face_at_landmarks: 'No se encuentra una cara donde marcaste los puntos.',
      multiple_faces: 'En la foto hay más de una persona. Usa una con una sola cara.',
      face_unclear: 'La cara no se ve con claridad. Usa una foto más nítida y de frente.',
      face_too_small: 'La cara ocupa muy poco de la foto. Usa un retrato más cercano.',
      face_cut_off: 'La cara queda cortada por el borde de la foto.',
      not_frontal: 'La cara no está de frente. Usa una foto mirando a cámara.',
      head_tilted: 'La cabeza está demasiado inclinada. Usa una foto con la cabeza recta.',
    },
    engine: {
      title: 'Motor neuronal local',
      dialogTitle: 'Motor de avatares fotorrealistas',
      dialogText:
        'Un servicio de código abierto que se ejecuta en este equipo, sin servicios de pago. Genera retratos, prepara fotos y anima los avatares al exportar.',
      checking: 'Comprobando…',
      health: {
        ready: 'En marcha',
        partial: 'En marcha, con funciones sin instalar',
        off: 'Apagado',
        unknown: 'Estado desconocido',
      },
      strip: {
        ready: 'en marcha',
        partial: 'en marcha, incompleto',
        off: 'apagado — los fotorrealistas no se pueden crear ni exportar',
        unknown: 'estado desconocido',
      },
      stripSpeed: 'animar ≈ {{time}} por segundo de vídeo',
      device: { cpu: 'CPU', gpu: 'GPU' },
      refresh: 'Volver a comprobar',
      details: 'Detalles',
      fix: 'Cómo arrancarlo',
      offText:
        'El motor no responde. Los avatares instantáneos 2D funcionan igual; los fotorrealistas no se pueden crear ni exportar hasta arrancarlo.',
      partialText:
        'El motor está en marcha pero le faltan pesos para alguna función. Vuelve a ejecutar el comando para descargarlos.',
      unknownText:
        'El servidor no ha informado del estado del motor. Si los fotorrealistas fallan, arráncalo con este comando.',
      reason: 'Motivo:',
      reasons: {
        engine_unreachable:
          'no hay nada escuchando en la dirección del motor: no está arrancado o se ha detenido.',
        engine_timeout: 'el motor no contesta a tiempo: puede estar arrancando o saturado.',
        engine_error: 'el motor ha respondido con un error interno.',
        engine_invalid:
          'el motor ha respondido algo que este servidor no entiende (¿otra versión?).',
        weights_missing: 'al motor le faltan pesos de modelos por descargar.',
        not_configured: 'este servidor no tiene configurado ningún motor de avatares.',
        unknown: 'el motor no ha dicho por qué.',
      },
      howTo: 'Arráncalo en una terminal, en la raíz del repositorio:',
      howToHint:
        'La primera vez instala el entorno de Python, descarga los pesos (con suma de verificación) y mide la velocidad de este equipo. Después pulsa «Volver a comprobar».',
      copy: 'Copiar',
      copied: 'Comando copiado',
      copyFailed: 'No se pudo copiar el comando',
      canDo: 'Qué puede hacer ahora',
      operation: {
        generate: 'Generar retratos',
        prepare: 'Preparar fotos',
        animate: 'Animar al exportar',
      },
      available: 'Disponible',
      unavailable: 'No disponible',
      neededHere: 'necesario aquí',
      portraitSpeed: 'Generar un retrato',
      animationSpeed: 'Animar',
      perVideoSecond: '≈ {{time}} por segundo de vídeo',
      example: 'Un vídeo de {{video}} ≈ {{time}} de cálculo',
      notMeasured: 'Aún sin medir',
      measured: {
        cpu: 'Cifras medidas por el motor en este equipo, en CPU. Es lento pero correcto; con GPU baja mucho.',
        gpu: 'Cifras medidas por el motor en este equipo, con GPU.',
      },
      nonCommercialTitle: 'Modelo de uso no comercial cargado',
      nonCommercialText:
        'La licencia de {{models}} no permite uso comercial. Lo que generes o animes con el motor hereda esa restricción.',
      nonCommercialShort: 'Uso no comercial',
      models_one: 'Modelos y licencias ({{count}})',
      models_other: 'Modelos y licencias ({{count}})',
      role: {
        'portrait-generation': 'Generación de retratos',
        'face-detection': 'Detección de cara',
        matting: 'Recorte del fondo',
        animation: 'Animación',
        other: 'Auxiliar',
      },
      commercialOk: 'Uso comercial',
      commercialNo: 'No comercial',
      downloaded: 'Descargado',
      notDownloaded: 'Sin descargar',
      modelsDoc: 'Origen, tamaño y licencia de cada modelo: {{doc}}.',
    },
  },
};

const en: typeof es = {
  nav: { avatars: 'Avatars' },
  eyebrow: 'Library',
  title: 'Avatars',
  description:
    'Choose who presents your video. Instant avatars are drawn in real time; photorealistic ones are animated by the local neural engine on export.',
  create: 'Create photorealistic avatar',
  missing: 'That avatar no longer exists or does not belong to this workspace.',
  views: {
    label: 'Avatar type',
    all: 'All',
    instant: 'Instant 2D',
    photoreal: 'Photorealistic',
    mine: 'Yours',
  },
  filters: {
    label: 'Avatar filters',
    search: 'Search avatars',
    searchPlaceholder: 'Name, style or tag…',
    gender: 'Gender',
    age: 'Age',
    style: 'Style',
    anyGender: 'Any gender',
    anyAge: 'Any age',
    anyStyle: 'Any style',
    clear: 'Clear filters',
  },
  gender: { female: 'Female', male: 'Male', neutral: 'Neutral' },
  age: { young: 'Young', adult: 'Adult', senior: 'Senior' },
  style: { professional: 'Professional', casual: 'Casual', creative: 'Creative' },
  framing: { bust: 'Bust', half: 'Half body', closeup: 'Close-up' },
  empty: {
    title: 'No avatar matches',
    text: 'Try another search or remove a filter.',
    mineTitle: 'You have not created any avatar yet',
    mineText:
      'Create a photorealistic avatar from a photo of yourself (with your consent) or generate a synthetic person from a description. Everything runs on this machine, with no paid service.',
  },
  shelf: {
    count_one: '{{count}} avatar',
    count_other: '{{count}} avatars',
    mine: {
      title: 'Your avatars',
      text: 'Photorealistic avatars this workspace created from a photo or from a description.',
    },
    instant: {
      title: 'Instant 2D',
      text: 'Illustrated characters drawn in real time: what you see here is exactly what ends up in the video. Hover to watch them talk.',
    },
    stockPhotoreal: {
      title: 'Stock photorealistic',
      text: 'Synthetic people: nobody real. They were generated with the local engine and it animates them on export, slower than the 2D ones.',
    },
  },
  origin: {
    instant: 'Instant 2D',
    stockPhotoreal: 'Photorealistic',
    photo: 'From photo',
    generated: 'Generated',
  },
  originHint: {
    instant: 'Illustrated 2D avatar from the library.',
    stockPhotoreal: 'Photorealistic synthetic person from the library.',
    photo: 'Photorealistic avatar created from a photo.',
    generated: 'Synthetic person generated from a description.',
  },
  originText: {
    instant:
      'Instant avatar: a parametric 2D character drawn on a canvas. Lips, blinking and gestures are computed in real time, so the Studio preview and the exported video are identical.',
    stockPhotoreal:
      'Synthetic person: this face belongs to nobody. The portrait was generated with the local neural engine; on export the same engine animates lips, blinking and head.',
    photo:
      'Created from the photo of a real person, with their consent on record. On export it is animated by the local neural engine.',
    generated:
      'Synthetic person generated by this workspace from a description. It depicts nobody real. On export it is animated by the local neural engine.',
  },
  card: {
    open: 'Open the card of {{name}}',
    live: 'Animated preview of {{name}}',
    portrait: 'Portrait of {{name}}',
    preparing: 'Preparation of {{name}}',
    progress: '{{percent}}%',
    eta: '{{time}} left',
    failed: 'Could not be created',
  },
  sheet: {
    live: 'Animated preview of {{name}}',
    standIn: 'Approximate preview. In the video the neural engine animates it.',
    framing: 'Framing',
    intro: 'Hi, I am {{name}}. I can present your next video.',
    listen: 'Hear an introduction',
    stop: 'Stop',
    listenHint: {
      instant:
        'Synthesizes a sentence with a local voice and moves the lips with the same code as the export.',
      photoreal:
        'The voice is real; the motion in this preview is only an approximation over the portrait. Lips, blinking and head are generated by the engine on export.',
    },
    processing: 'The local engine is preparing the avatar',
    failedTitle: 'This avatar could not be created',
    failedText: 'The engine did not finish the job. The credits were refunded.',
    renderCost: {
      measured:
        'Animating {{video}} of video with this avatar takes about {{time}} on this machine (speed measured by the engine).',
      unmeasured:
        'The engine has not measured its speed on this machine yet; on CPU, animating can take minutes per 10 s of video.',
      off: 'The engine cannot animate right now: videos with this avatar cannot be exported until you start it.',
      credits: 'Photorealistic renders cost {{factor}}× credits.',
    },
    nonCommercialTitle: 'Non-commercial model',
    nonCommercialText:
      'The engine has at least one model loaded whose licence forbids commercial use. Check the licences before publishing videos commercially.',
    tags: 'Tags',
    id: 'Identifier',
    prompt: 'Description it was generated from',
    model: 'Model',
    seed: 'Seed',
    landmarks: 'Face landmarks',
    landmarksSource: {
      detected: 'Detected by the engine',
      user: 'Marked by hand',
      estimated: 'Estimated (no detection): the preview does not move the mouth',
    },
    created: 'Created',
    use: 'Use in a video',
    videoTitle: 'Video with {{name}}',
    videoScript: 'Hi, I am {{name}}. Write here what you want me to say.',
    videoCreated: 'Draft created with this avatar',
    videoFailed: 'The video could not be created',
    copyId: 'Copy id',
    idCopied: 'Identifier copied',
    idCopyFailed: 'Could not copy',
    rename: 'Rename',
    nameLabel: 'Avatar name',
    save: 'Save',
    cancel: 'Cancel',
    renamed: 'Name updated',
    renameFailed: 'The name could not be changed',
    delete: 'Delete avatar',
    deleteTitle: 'Delete {{name}}?',
    deleteText: {
      photo:
        'The avatar, its images, the cached clips and the original photo are deleted. Exported videos are kept; drafts that use it cannot be rendered until you pick another avatar.',
      generated:
        'The avatar, its images and the cached clips are deleted. Exported videos are kept; drafts that use it cannot be rendered until you pick another avatar.',
    },
    deleted: 'Avatar deleted',
    deleteFailed: 'The avatar could not be deleted',
  },
  kit: {
    player: {
      play: 'Play the preview',
      pause: 'Pause',
      replay: 'Play again',
      position: 'Preview position',
    },
    cost: {
      credits_one: 'Costs {{count}} credit',
      credits_other: 'Costs {{count}} credits',
      balance: '· you have {{credits}}',
      refund: 'Charged when the job is queued and refunded if it fails.',
      billing: 'See credits and plans',
    },
    failure: {
      detail: 'Server answer: {{detail}}',
      buyCredits: 'Get credits',
      seePlans: 'See plans',
      consent: {
        title: 'A valid consent is missing',
        text: 'The consent record does not exist, was already used or belongs to someone else. Check the declaration and send it again.',
      },
      credits: {
        title: 'Not enough credits',
        text: 'Nothing was charged or created.',
      },
      limit: {
        title: 'You reached the limit of your plan',
        text: 'Delete one you already have or change plan. Nothing was charged.',
      },
      blocked: {
        title: 'The content does not pass moderation',
        text: 'The name or the description contains something not allowed, or describes a real, identifiable person. Change it and try again.',
      },
      engine: {
        title: 'The local engine cannot do it right now',
        text: 'Nothing was charged. Start the engine ("Local neural engine" panel) and try again.',
      },
      notConfigured: {
        title: 'The provider is not configured',
        text: 'This server has not configured the service this needs. Nothing was charged.',
      },
      sourceInUse: {
        title: 'That file is already in use',
        text: 'The file is already the source of another avatar or voice. Upload a new one.',
      },
      tooLarge: {
        title: 'The file is too large',
        text: 'It exceeds the maximum upload size of your plan.',
      },
      wrongFileType: {
        title: 'That kind of file will not work',
        text: 'The server checks the real content of the file, not its extension.',
      },
      invalid: {
        title: 'Some data is not valid',
        text: 'Check the form and send it again.',
      },
      network: {
        title: 'The server could not be reached',
        text: 'Check the connection and try again. Nothing was charged.',
      },
      generic: {
        title: 'It could not be completed',
        text: 'Something failed on the server. Try again.',
      },
    },
    consent: {
      title: 'Consent declaration',
      why: {
        photo_avatar:
          'Required to create an avatar with the face of a real person. Without it the operation is rejected.',
        voice_clone:
          'Required to create a voice from the voice of a real person. Without it the operation is rejected.',
      },
      name: 'Full name of the person consenting',
      nameHint: 'The person shown or speaking, as they would sign.',
      relationship: 'Who is consenting?',
      self: { photo_avatar: 'It is me', voice_clone: 'It is my voice' },
      authorized: 'I hold their authorisation',
      accept: 'I have read the declaration and I accept it',
      acceptHint: 'Tick the box to continue.',
      problem: {
        nameRequired: 'Write the name of the person consenting.',
        nameTooShort: 'The name is too short.',
        nameTooLong: 'The name is too long.',
        notAccepted: 'You must accept the declaration to continue.',
      },
      stored: {
        photo_avatar:
          'We store the declaration with the date, your user and your IP. If it is revoked, the avatar, its files and the original photo are deleted.',
        voice_clone:
          'We store the declaration with the date, your user and your IP. If it is revoked, the voice, the sample and the original file are deleted.',
      },
      manage: 'See consent records',
    },
    quality: {
      failedTitle: 'The portrait did not pass quality control',
      failedText_one:
        'The engine tried {{count}} time and kept this portrait. You can use it, but the animation may look worse.',
      failedText_other:
        'The engine tried {{count}} times and kept the best portrait. You can use it, but the animation may look worse.',
      failedTextOnce:
        'The engine kept this portrait although it has flaws. You can use it, but the animation may look worse.',
      remarksTitle: 'Portrait ready, with remarks',
      issues: {
        no_face: 'No face is detected.',
        multiple_faces: 'There is more than one face.',
        face_not_clear: 'The face is not clearly visible.',
        face_too_small: 'The face takes up very little of the portrait.',
        face_too_large: 'The face is too close.',
        head_tilted: 'The head is tilted.',
        not_frontal: 'The face is not front-facing.',
        head_pitched: 'The head looks up or down.',
        off_center: 'The face is not centred.',
        mouth_open: 'The mouth is open: the animation starts better from a closed mouth.',
        eyes_closed: 'The eyes are closed.',
        not_looking_at_camera: 'The person is not looking at the camera.',
        matte_fallback:
          'The background was separated with the fallback model: the edge of the cut-out may be rougher.',
        no_matte:
          'The background could not be separated: the avatar keeps the background of its photo.',
      },
    },
    reasons: {
      engine_unreachable: 'The neural engine stopped or is not started.',
      engine_timeout: 'The neural engine did not answer in time.',
      engine_error: 'The neural engine answered with an internal error.',
      engine_invalid: 'The neural engine answered something this server does not understand.',
      weights_missing: 'The neural engine is missing model weights that must be downloaded.',
      not_configured: 'This server has no avatar engine configured.',
      unsupported_image: 'The image is not a valid PNG, JPEG or WebP.',
      image_unreadable: 'The image file is damaged and could not be read.',
      image_too_small: 'The image is too small.',
      image_too_large: 'The image is too large.',
      no_face: 'No face is detected in the photo. Use a well-lit, front-facing portrait.',
      no_face_at_landmarks: 'No face was found where you marked the points.',
      multiple_faces: 'There is more than one person in the photo. Use one with a single face.',
      face_unclear: 'The face is not clearly visible. Use a sharper, front-facing photo.',
      face_too_small: 'The face takes up very little of the photo. Use a closer portrait.',
      face_cut_off: 'The face is cut off by the edge of the photo.',
      not_frontal: 'The face is not front-facing. Use a photo looking at the camera.',
      head_tilted: 'The head is tilted too much. Use a photo with the head upright.',
    },
    engine: {
      title: 'Local neural engine',
      dialogTitle: 'Photorealistic avatar engine',
      dialogText:
        'An open-source service that runs on this machine, with no paid service. It generates portraits, prepares photos and animates avatars on export.',
      checking: 'Checking…',
      health: {
        ready: 'Running',
        partial: 'Running, with features not installed',
        off: 'Off',
        unknown: 'Unknown state',
      },
      strip: {
        ready: 'running',
        partial: 'running, incomplete',
        off: 'off — photorealistic avatars cannot be created or exported',
        unknown: 'unknown state',
      },
      stripSpeed: 'animating ≈ {{time}} per second of video',
      device: { cpu: 'CPU', gpu: 'GPU' },
      refresh: 'Check again',
      details: 'Details',
      fix: 'How to start it',
      offText:
        'The engine does not answer. Instant 2D avatars work as usual; photorealistic ones cannot be created or exported until you start it.',
      partialText:
        'The engine is running but lacks the weights for some feature. Run the command again to download them.',
      unknownText:
        'The server did not report the state of the engine. If photorealistic avatars fail, start it with this command.',
      reason: 'Reason:',
      reasons: {
        engine_unreachable:
          'nothing is listening at the address of the engine: it is not started or it stopped.',
        engine_timeout: 'the engine does not answer in time: it may be starting or overloaded.',
        engine_error: 'the engine answered with an internal error.',
        engine_invalid:
          'the engine answered something this server does not understand (another version?).',
        weights_missing: 'the engine is missing model weights that must be downloaded.',
        not_configured: 'this server has no avatar engine configured.',
        unknown: 'the engine did not say why.',
      },
      howTo: 'Start it in a terminal, at the root of the repository:',
      howToHint:
        'The first run installs the Python environment, downloads the weights (checksum verified) and measures the speed of this machine. Then press "Check again".',
      copy: 'Copy',
      copied: 'Command copied',
      copyFailed: 'The command could not be copied',
      canDo: 'What it can do now',
      operation: {
        generate: 'Generate portraits',
        prepare: 'Prepare photos',
        animate: 'Animate on export',
      },
      available: 'Available',
      unavailable: 'Not available',
      neededHere: 'needed here',
      portraitSpeed: 'Generating a portrait',
      animationSpeed: 'Animating',
      perVideoSecond: '≈ {{time}} per second of video',
      example: 'A {{video}} video ≈ {{time}} of computation',
      notMeasured: 'Not measured yet',
      measured: {
        cpu: 'Figures measured by the engine on this machine, on CPU. Slow but correct; a GPU cuts them a lot.',
        gpu: 'Figures measured by the engine on this machine, with a GPU.',
      },
      nonCommercialTitle: 'Non-commercial model loaded',
      nonCommercialText:
        'The licence of {{models}} forbids commercial use. Whatever you generate or animate with the engine inherits that restriction.',
      nonCommercialShort: 'Non-commercial',
      models_one: 'Models and licences ({{count}})',
      models_other: 'Models and licences ({{count}})',
      role: {
        'portrait-generation': 'Portrait generation',
        'face-detection': 'Face detection',
        matting: 'Background matting',
        animation: 'Animation',
        other: 'Auxiliary',
      },
      commercialOk: 'Commercial use',
      commercialNo: 'Non-commercial',
      downloaded: 'Downloaded',
      notDownloaded: 'Not downloaded',
      modelsDoc: 'Source, size and licence of every model: {{doc}}.',
    },
  },
};

export const translations = { es, en };
