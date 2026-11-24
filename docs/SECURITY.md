# Seguridad y uso responsable de Parlante

> Qué se defiende, con qué control y en qué archivo vive, qué límites se conocen y qué encontró
> la revisión de la fase 3. Las reglas obligatorias son las del §5 del
> [prompt maestro](prompt/MASTER_PROMPT.md). Si este documento y el código discrepan, manda el
> código: corrige el documento.

## 1. Modelo de amenazas

**Qué se protege**

| Activo                                                                         | Por qué importa                                                         |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Contenido de cada workspace (vídeos, assets, plantillas, lotes, traducciones)  | Es de un cliente; otro cliente no debe verlo, usarlo ni borrarlo.       |
| Datos de una persona: foto de origen, retrato, recortes, clips, muestra de voz | Biométricos. Solo existen con consentimiento y se borran al revocarlo.  |
| Credenciales: contraseñas, sesiones, claves de API, secretos de webhook        | Dan acceso a todo lo anterior.                                          |
| Créditos                                                                       | Son el dinero del producto.                                             |
| La máquina y su red interna                                                    | El servidor descarga URLs, procesa archivos ajenos y lanza ffmpeg.      |
| La reputación del producto                                                     | Un vídeo fotorrealista de alguien que no consintió, o contenido vetado. |

**De quién**

1. **Visitante sin cuenta**: fuerza bruta de contraseñas, enumeración de cuentas, enlaces
   adivinados (archivos, compartir, invitaciones), rutas sin autenticación.
2. **Usuario de otro workspace** (el caso principal): ids ajenos en la ruta, en el cuerpo o
   dentro de una Composition; claves de API de su workspace contra recursos de otro.
3. **Miembro con poco rol** (lector, editor) que intenta lo que corresponde a admin u owner.
4. **Sitio web malicioso** abierto por un usuario con sesión: CSRF, lectura entre orígenes,
   inicio de sesión forzado en la cuenta del atacante.
5. **Archivo o URL hostil** entregado al servidor: HTML o SVG disfrazado, listas de reproducción
   que hacen que ffmpeg abra otros archivos o URLs, imágenes gigantes, webhooks y "URL → guion"
   apuntando a la red interna.
6. **Uso indebido del producto**: avatar o voz de una persona sin su permiso, guiones vetados.

**Fuera del modelo**: quien ya tiene acceso al servidor, a la base de datos o a `APP_SECRET`; la
seguridad de los proveedores externos; ataques de denegación de servicio a gran escala (hay
límites por IP y por clave, no una defensa perimetral); pagos reales (no existen).

## 2. Controles existentes y dónde viven

### Identidad, sesiones y claves

| Control                                                                                                                                           | Dónde                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Contraseñas con scrypt (N=16384, sal por usuario), comparación en tiempo constante                                                                | `packages/shared/src/node/crypto.ts`                                                        |
| Sesión = token aleatorio de 256 bits en cookie `HttpOnly; SameSite=Lax; Path=/` (`Secure` en producción); en BD solo su SHA-256                   | `apps/api/src/lib/auth.ts`, `apps/api/src/config.ts` (`cookieSecure`)                       |
| Rotación: cada inicio de sesión, registro y cambio de contraseña emite un token nuevo y destruye el que traía el navegador (sin fijación)         | `apps/api/src/modules/auth/index.ts` (`startSession`)                                       |
| Cierre de sesión borra la fila; cambiar la contraseña revoca las demás sesiones                                                                   | `apps/api/src/modules/auth/index.ts`                                                        |
| Mismo error y mismo coste para e-mail desconocido y contraseña errónea                                                                            | `apps/api/src/lib/auth.ts` (`authenticate`)                                                 |
| Límite de intentos fallidos: 5 por e-mail + IP en 15 min (25 por e-mail, 40 por IP) → 429 con `Retry-After`; 5 en el cambio de contraseña         | `apps/api/src/modules/auth/attempt-throttle.ts`                                             |
| Límite de peticiones: 600/min por IP global, 10/min en login y registro, propios en rutas caras; `/v1` 60–300/min **por clave** según plan        | `apps/api/src/app.ts`, `RouteDef.rateLimit`, `apps/api/src/modules/public-v1/rate-limit.ts` |
| Claves de API `plk_<prefijo>_<secreto>`: en BD solo SHA-256 y prefijo; la clave se muestra una vez; revocar surte efecto en la petición siguiente | `apps/api/src/lib/auth.ts` (`createApiKey`, `resolveApiKey`), `modules/api-keys`            |
| Una cookie no sirve en `/v1` y una clave no sirve en `/api`                                                                                       | `apps/api/src/lib/define-route.ts`                                                          |
| Roles (`viewer < editor < admin < owner`) declarados en el contrato (`minRole`) y aplicados antes del handler                                     | `packages/shared/src/api/*.ts`, `apps/api/src/lib/define-route.ts`                          |
| CSRF: además de `SameSite=Lax`, toda petición no segura con cabecera `Origin` desconocida se rechaza (403), **también login y registro**          | `apps/api/src/lib/define-route.ts`                                                          |
| CORS solo para `WEB_ORIGIN` / `PUBLIC_WEB_URL`, con credenciales                                                                                  | `apps/api/src/app.ts`, `apps/api/src/config.ts` (`allowedOrigins`)                          |
| Secretos de webhook cifrados en reposo (AES-256-GCM con clave derivada de `APP_SECRET`); entregas firmadas HMAC-SHA256 con marca de tiempo        | `packages/shared/src/node/crypto.ts`, `apps/worker/src/jobs/webhook-delivery/`              |

### Aislamiento entre workspaces

| Control                                                                                                                                                    | Dónde                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Toda consulta y toda escritura filtran por `auth.workspaceId`; un recurso ajeno responde **404**, nunca 403                                                | cada `apps/api/src/modules/<dominio>/`; patrón en `modules/_template` |
| Los jobs cargan sus filas por id **y** `workspaceId` del payload                                                                                           | `apps/worker/src/jobs/*`, `apps/worker/src/lib/render-status.ts`      |
| Una Composition solo guarda ids; cada referencia (avatares, voces, narración, música, imágenes y vídeos) se valida contra el workspace **antes de cobrar** | `packages/jobs/src/render-start.ts` (`validateReferences`)            |
| …y otra vez al renderizar, por si la fila cambió entre medias                                                                                              | `apps/worker/src/jobs/render/media.ts`                                |
| Las voces clonadas solo resuelven en su workspace                                                                                                          | `packages/jobs/src/voices.ts` (`resolveVoice`)                        |
| Los jobs de ping llevan el workspace en su id                                                                                                              | `apps/api/src/modules/system/index.ts`                                |
| **Recorrido sistemático**: cada ruta con parámetro, cada referencia en el cuerpo y cada lista, atacadas desde otro workspace                               | `apps/api/src/security/isolation-matrix.ts`, `isolation.test.ts`      |

### Archivos

| Control                                                                                                                                              | Dónde                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Las claves de storage las construye el servidor con ids propios y extensiones de lista blanca; ningún nombre de archivo del cliente llega a una ruta | `packages/shared/src/node/storage-keys.ts` (`storageKeys`, `isSafeStorageKey`) |
| URLs firmadas: HMAC-SHA256 sobre `clave + caducidad` con clave derivada de `APP_SECRET`; 6 h (7 días en webhooks); comparación en tiempo constante   | `packages/shared/src/node/crypto.ts`, `packages/jobs/src/file-urls.ts`         |
| La ruta de archivos rechaza claves mal formadas antes de tocar el disco, y el storage local comprueba que la ruta no sale de su raíz                 | `apps/api/src/plugins/core-routes.ts`, `packages/providers/src/storage/`       |
| Todo archivo se sirve con su tipo guardado, `X-Content-Type-Options: nosniff` y `Content-Security-Policy: default-src 'none'; sandbox`               | `apps/api/src/plugins/core-routes.ts`                                          |
| El nombre de descarga se sanea y conserva siempre la extensión del objeto guardado                                                                   | `apps/api/src/plugins/core-routes.ts` (`downloadFilename`)                     |
| Subidas: tamaño cortado en streaming (límite del plan y `MAX_UPLOAD_MB`), temporal con nombre aleatorio y modo 0600, borrado siempre                 | `apps/api/src/lib/uploads.ts`                                                  |
| Tipo real por _magic bytes_ contra lista blanca (PNG, JPEG, WebP, GIF, MP4, WebM, MOV y audio); **SVG y HTML no se aceptan**                         | `apps/api/src/lib/uploads.ts`, `ALLOWED_UPLOAD_MIME` en `packages/shared`      |
| Después se decodifica de verdad (dimensiones, duración, miniatura); imágenes de más de 50 Mpx o 16 384 px se rechazan por cabecera                   | `apps/api/src/modules/assets/media.ts`                                         |
| Cuota de almacenamiento por plan                                                                                                                     | `apps/api/src/modules/assets/service.ts`                                       |
| ffmpeg y ffprobe siempre con **array de argumentos**, sin shell, con rutas generadas por el servidor, tiempo límite y salida acotada                 | `packages/shared/src/node/process.ts`, `apps/worker/src/lib/ffmpeg.ts`         |
| Ningún valor de usuario llega a un filtro o a una opción de ffmpeg salvo números validados por zod; los metadatos del MP4 son constantes             | `apps/worker/src/jobs/render/{encode,mix}.ts`, `jobs/translation/mix.ts`       |
| Listas de reproducción (HLS, concat) dentro de un archivo subido: no pasan la detección de tipo; el objeto se guarda como `original.<ext detectada>` | `apps/api/src/lib/uploads.ts`; probado en `security/hardening.test.ts`         |

### Peticiones salientes (SSRF)

| Control                                                                                                                                                        | Dónde                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Solo `http`/`https`, sin credenciales en la URL; bloqueadas IPs privadas, loopback, link-local (metadatos de nube), CGNAT, multicast y reservadas, IPv4 e IPv6 | `packages/shared/src/node/ssrf.ts` (`isBlockedAddress`)                  |
| IPv6 que **incrusta** una IPv4 (mapeada, compatible `::a.b.c.d`, 6to4, Teredo, NAT64) también bloqueada                                                        | ídem                                                                     |
| La comprobación se repite **al conectar** con un `lookup` propio (DNS que cambia entre comprobación y uso) y en **cada salto** de redirección                  | `safeRequest`, `guardedLookup`                                           |
| Webhooks: URL validada al guardar y otra vez en cada entrega; POST nunca sigue redirecciones; tiempo límite y respuesta acotada                                | `apps/api/src/modules/webhooks`, `apps/worker/src/jobs/webhook-delivery` |
| "URL → guion": 8 s, 1,5 MB, 3 redirecciones, descompresión acotada                                                                                             | `apps/api/src/modules/script-writer/fetch-page.ts`                       |
| `ALLOW_PRIVATE_URLS` (solo desarrollo) está apagada por defecto y API y worker **no arrancan** con ella si `NODE_ENV=production`                               | `packages/shared/src/node/env.ts` (`refuseDevOnlySwitches`)              |

No hay ninguna otra descarga dirigida por el usuario: los proveedores externos usan URLs base de
la configuración y la Composition no admite URLs, solo ids.

### Uso responsable

| Control                                                                                                                                                                         | Dónde                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Avatar desde foto y voz clonada exigen un `ConsentRecord` del mismo usuario, del tipo correcto, sin usar y sin revocar, consumido **en la transacción** que crea el recurso     | `apps/api/src/lib/consent.ts` (`consumeConsent`)                                      |
| Respaldo en la base de datos: `CHECK avatars_photo_requires_consent` y `voices.consent_id NOT NULL`                                                                             | `packages/db/src/schema.ts`                                                           |
| El consentimiento guarda fecha, usuario, IP, texto y versión de la declaración                                                                                                  | `apps/api/src/modules/consent/index.ts`                                               |
| Solo existe por sesión: `/v1` no tiene rutas de avatar ni de voz, y los lotes solo usan avatares y voces ya creados                                                             | `packages/shared/src/api/public-v1.ts`                                                |
| Revocar (o borrar) elimina fila, prefijo de storage (retrato, mate, recorte, clips; muestra y **habla sintetizada con la voz**), asset de origen, voz externa y caché del motor | `apps/api/src/lib/person-data.ts`, `packages/jobs/src/tts-cache.ts`                   |
| Moderación antes de sintetizar o renderizar: vídeo, `/v1` y cada fila de lote (tras aplicar variables)                                                                          | `packages/jobs/src/render-start.ts` (`collectModerationTexts`)                        |
| …vista previa de voz, avatar interactivo (persona, mensaje y respuesta), guionista, nombres y lote al crearlo                                                                   | `apps/api/src/lib/moderation.ts` y sus llamadas en `modules/*`                        |
| …traducción: la transcripción (del usuario o del STT) **y el texto ya traducido**, por idioma                                                                                   | `apps/api/src/modules/translations`, `apps/worker/src/jobs/translation/`              |
| Descripciones de retratos: se rechazan personas reales identificables y menores                                                                                                 | `packages/providers/src/moderation/people.ts`                                         |
| El MP4 con presentador fotorrealista lleva `com.parlante.ai_generated=true`, y la página pública lo indica                                                                      | `AI_GENERATED_METADATA` en `packages/shared`, `apps/worker/src/jobs/render/encode.ts` |

### Dictado por micrófono

Qué sale del equipo con cada motor: con el **local**, nada (el audio viaja del navegador a la
API de la propia instalación y se transcribe allí); con el del **navegador**, el audio lo trata
el navegador y, en Chrome, se envía a Google — Parlante no lo recibe, no lo controla y por eso
la interfaz lo avisa y exige aceptarlo antes del primer uso.

| Control                                                                                                                                                                                                                                                                                                                                                                                                                            | Dónde                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| El audio del dictado local se procesa **en memoria**: no se escribe en disco (no usa el temporal de las subidas), ni en storage, ni en la base de datos; se descarta con la petición                                                                                                                                                                                                                                               | `apps/api/src/modules/dictation/index.ts` (`receiveAudio`)                                                   |
| Ni el audio ni el texto reconocido se escriben en el log (solo la línea de la petición); los errores del modelo solo citan al propio modelo                                                                                                                                                                                                                                                                                        | idem; `packages/providers/src/stt/local-whisper.ts`                                                          |
| Solo con sesión (cualquier miembro); no existe en `/v1`; comprobación de `Origin` como el resto de rutas con cookie                                                                                                                                                                                                                                                                                                                | `packages/shared/src/api/dictation.ts`, `apps/api/src/lib/define-route.ts`                                   |
| Cuerpo acotado a 964 140 bytes mientras se recibe; se valida la cabecera WAV, el formato (PCM 16 bits, mono, 16 kHz) y la duración **real** (≤ 30 s), sin fiarse de la cabecera                                                                                                                                                                                                                                                    | `apps/api/src/modules/dictation/wav.ts`                                                                      |
| Límite por usuario (60 fragmentos/min) y tope global de fragmentos en espera (4), con `429` y `Retry-After`; el modelo corre en un hilo aparte y no bloquea el resto de la API                                                                                                                                                                                                                                                     | `apps/api/src/modules/dictation/index.ts`, `whisper-engine.ts`                                               |
| La **telemetría de ONNX Runtime se desactiva** (`ORT_DISABLE_TELEMETRY=1`, fijada por el motor antes de cargar la biblioteca). Sin ello, `onnxruntime-node` 1.30 intenta conectar con `mobile.events.data.microsoft.com` y guarda un identificador de dispositivo y una cola de eventos en `~/.cache/Microsoft` (medido). Un test con el modelo real lo vigila: ninguna conexión saliente y nada escrito en el directorio personal | `packages/providers/src/stt/whisper-engine.ts` (`disableOnnxRuntimeTelemetry`), `local-whisper.real.test.ts` |
| El modelo no se descarga nunca en ejecución: el runtime tiene los modelos remotos desactivados y recibe una ruta local absoluta                                                                                                                                                                                                                                                                                                    | `packages/providers/src/stt/whisper-worker.mjs`                                                              |
| Instalación (`pnpm dictation:setup`): solo `huggingface.co`, revisión fijada, tamaño y SHA-256 por archivo antes de aceptarlo; solo formatos de datos (ONNX, JSON)                                                                                                                                                                                                                                                                 | `packages/providers/src/stt/whisper-{models,setup}.ts`                                                       |
| El dictado es siempre local aunque haya claves de proveedores externos: `OPENAI_API_KEY` cambia el STT de la traducción de vídeo, nunca el destino del audio dictado                                                                                                                                                                                                                                                               | `packages/providers/src/stt/index.ts` (`createDictationProvider`)                                            |

### Entrada, errores, registros y configuración

| Control                                                                                                                                       | Dónde                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Validación zod de parámetros, consulta y cuerpo en cada ruta, y del payload de cada cola                                                      | `apps/api/src/lib/define-route.ts`, `packages/shared/src/queues.ts`       |
| Consultas siempre parametrizadas (Drizzle); comodines de `LIKE` escapados; cursores opacos validados                                          | `packages/db`; `likePattern` en `modules/{videos,assets}/index.ts`        |
| Cuerpo JSON ≤ 2 MB; páginas ≤ 100; CSV de lote ≤ 500 filas, 60 columnas y 500 caracteres por celda; variables por nombre con `hasOwnProperty` | `apps/api/src/app.ts`, `modules/batch/csv.ts`, `composition/variables.ts` |
| Una sola forma de error, sin trazas; lo inesperado es `500 Internal server error` y el detalle va al log                                      | `apps/api/src/plugins/errors.ts`                                          |
| Los errores inesperados que se guardan en una fila (y viajan a la interfaz, a `/v1` y a los webhooks) pierden rutas, URLs y direcciones       | `packages/shared/src/errors.ts` (`scrubInternals`)                        |
| Registros sin `Authorization`, `Cookie` ni `Set-Cookie`; las firmas de archivos y los tokens de invitación y de compartir se enmascaran       | `apps/api/src/app.ts` (`redact`, `redactUrl`)                             |
| Cabeceras: CSP `default-src 'none'`, `frame-ancestors 'none'`, HSTS, `nosniff`, `Referrer-Policy: no-referrer`                                | `apps/api/src/app.ts` (helmet)                                            |
| `APP_SECRET` ≥ 32 caracteres; en producción se rechaza el valor de desarrollo y cualquiera con menos de 12 caracteres distintos               | `packages/shared/src/node/env.ts` (`weakSecretReason`)                    |
| Fuera de producción la API avisa al arrancar si usa el secreto de desarrollo                                                                  | `apps/api/src/server.ts`                                                  |
| Sin secretos en el repositorio; `.env` ignorado; `.env.example` documenta cada variable con los secretos vacíos                               | `.gitignore`, `.env.example`                                              |

## 3. Límites conocidos

- **Límites de intentos en memoria por proceso.** El contador de contraseñas fallidas
  (`attempt-throttle.ts`) y los de `@fastify/rate-limit` viven en cada proceso de la API: se
  pierden al reiniciar y no se comparten entre instancias. Con N instancias el límite real es N
  veces mayor. Para escalar horizontalmente hay que moverlos a Redis.
- **Bloqueo de una cuenta por terceros.** 25 fallos sobre un e-mail desde cualquier IP bloquean
  ese e-mail 15 minutos también para su dueño. Es el precio de frenar el ataque distribuido.
- **`TRUST_PROXY`.** Detrás de un proxy inverso hay que activarlo, o todos los clientes
  comparten la IP del proxy (y su límite). Expuesto directamente con `TRUST_PROXY=true`,
  `X-Forwarded-For` es falsificable y los límites por IP se pueden esquivar.
- **`NODE_ENV` sin definir** equivale a desarrollo: cookie sin `Secure` y secreto público
  aceptado (con aviso). Un despliegue real debe fijar `NODE_ENV=production` y `APP_SECRET`.
- **Las URLs firmadas son credenciales al portador.** Quien tenga el enlace ve el archivo hasta
  que caduque (6 h; 7 días en webhooks). Revocar un consentimiento o borrar un recurso borra el
  archivo, y el enlace deja de servir en el acto; desactivar un enlace de compartir no invalida
  las URLs de archivo ya entregadas hasta que caducan.
- **Los vídeos ya renderizados sobreviven a la revocación** del consentimiento del avatar o de
  la voz que usan (decisión de producto: son obra del workspace). No se pueden volver a
  renderizar. Quien quiera retirarlos debe borrarlos.
- **Carrera al revocar.** Una síntesis o un render en curso en el instante de la revocación
  puede volver a escribir un archivo bajo el prefijo ya borrado (o el `.npz` del motor).
- **La moderación local es una lista de bloqueo** en español e inglés con normalización
  (acentos, _leet_, letras separadas o repetidas, caracteres invisibles). No entiende contexto,
  otros idiomas, homoglifos de otros alfabetos ni palabras partidas entre escenas. Una narración
  subida como audio no se modera (solo su transcripción); una foto subida no se analiza: el
  consentimiento es una declaración, no una verificación de identidad.
- **Dictado.** El texto dictado no pasa por moderación al transcribirse: es texto que el usuario
  escribe en un campo y se modera donde ya se moderaba ese campo (guion, nombre, mensaje…). Los
  límites del dictado viven en la memoria del proceso (misma salvedad que el resto de límites).
  Con el modelo cargado, la API ocupa 1,4–1,8 GB más; un atacante autenticado no puede
  multiplicarlo (una sola instancia del modelo, cola acotada), pero sí mantenerlo cargado. El
  motor del navegador queda fuera del control del servidor: lo que el navegador haga con el
  audio depende de su fabricante.
- **Telemetría de bibliotecas de terceros.** La del ONNX Runtime que usa el dictado está
  apagada y vigilada por un test (tabla de arriba). El interruptor se fija en el entorno real
  del proceso desde el hilo principal; quien cree el motor de voz desde dentro de otro
  `worker_thread` debe definir `ORT_DISABLE_TELEMETRY=1` en el entorno del proceso. Las voces
  neuronales usan el mismo interruptor antes de crear su hilo (`tts/neural-engine.ts`); son los
  dos únicos sitios de API y worker que cargan ONNX Runtime. **Medido en uso normal, con las
  voces neuronales por defecto**: la API y el worker reales, arrancados bajo
  `strace -f -e trace=connect` con un `HOME` vacío y la configuración por defecto (sin claves),
  mientras se pedían cuatro preescuchas con Kokoro, dos dictados con Whisper, tres renders de
  un vídeo de 30 s y una traducción de vídeo con transcripción local y doblaje neuronal: la API
  hizo 7 llamadas `connect()` y el worker 16, **todas** a PostgreSQL (`127.0.0.1:5432`), Redis
  (`127.0.0.1:6379`), al motor de avatares (`127.0.0.1:8090`) o a sockets Unix de la propia
  máquina (`nscd`, la tubería de `tsx`); ninguna a otra dirección, y no se escribió ningún
  archivo en `HOME`. Es una medida de esos recorridos, no una garantía de todos: los
  adaptadores externos (con clave), los webhooks y «URL → guion» conectan fuera por diseño, y
  solo cuando el usuario los configura o los usa. **El motor de avatares (Python)
  llamaba a casa por dos vías, y ya no**: medido con `HOME` vacío y un proxy sumidero, su
  `onnxruntime` 1.32 escribía un identificador de dispositivo y abría
  `mobile.events.data.microsoft.com:443`, y `import openvino` escribía un identificador de
  cliente en `~/intel` y abría `www.google-analytics.com:443` (4 conexiones en los primeros 23 s
  de arranque). `parlante_engine/core/privacy.py` lo apaga antes de importar ninguna de las dos
  bibliotecas (`ORT_DISABLE_TELEMETRY=1` y el paquete `openvino_telemetry` hecho inimportable);
  con ello, el servidor real bajo `strace` no hizo ninguna conexión ni escribió nada en `HOME`
  al arrancar, preparar, animar (con ambos conductores) y generar un retrato. Lo vigila
  `services/avatar-engine/tests/test_privacy.py` con control negativo, y `GET /health → privacy`
  lo declara. En una máquina donde ya se ejecutó una versión anterior quedan esos
  identificadores: se pueden borrar (`~/.cache/Microsoft/DeveloperTools/.onnxruntime/`,
  `~/intel/openvino_ga_cid`, `~/intel/stats`). Detalle y tabla de medidas en el README del motor.
- **Cadena de suministro del reconocimiento de voz.** `@huggingface/transformers` y
  `onnxruntime-node` se instalan de npm con versión fijada por el lockfile; el script de
  post-instalación de `onnxruntime-node` (descarga de binarios CUDA) **no se ejecuta** (pnpm
  ignora los scripts de dependencias no autorizadas en `pnpm-workspace.yaml`; no lo añadas ahí).
  Los JSON del modelo no tienen hash publicado por el Hub: los suyos se calcularon de la
  revisión fijada en la primera descarga y quedaron escritos en el catálogo.
- **OpenAPI público.** `/docs` y `/openapi.json` se sirven también en producción
  (`OPENAPI_ENABLED=false` los apaga). Describen la API, no contienen secretos.
- **Mensajes del motor.** Los 503 del motor neuronal citan `AVATAR_ENGINE_URL` (pensado para
  quien administra su propia instalación). En un despliegue multi-cliente conviene un proxy que
  no lo exponga.
- **ffmpeg del sistema.** La defensa frente a listas de reproducción incrustadas se apoya en la
  detección de tipo de la subida, en que el objeto nunca se guarda con extensión `.m3u8` y en
  que el ffmpeg actual no detecta HLS sin esa extensión ni abre red desde un archivo local
  (comprobado con 6.1.1). Versiones antiguas de ffmpeg detectaban HLS solo por el contenido:
  no ejecute el worker con una de ellas.
- **Sin exportación de datos a hojas de cálculo.** El CSV de lotes solo entra; no hay
  descarga CSV/XLSX, así que no hay inyección de fórmulas que tratar. Si se añade una, hay que
  anteponer `'` a las celdas que empiecen por `=`, `+`, `-`, `@`, tabulador o retorno.
- **Dependencias.** `pnpm audit --prod`: sin vulnerabilidades conocidas (24-11-2026). En
  dependencias de desarrollo quedan dos avisos moderados (`esbuild` ≤ 0.24.2 bajo `drizzle-kit`,
  `minimatch` bajo `typescript-eslint`): no llegan a producción; se resuelven actualizando esas
  herramientas.

## 4. Revisión de la fase 3: hallazgos

Método: API y worker reales arrancados contra una base de datos propia y atacados por HTTP con
dos cuentas, además de la lectura del código. Cada hallazgo corregido tiene test de regresión.

| #   | Gravedad | Hallazgo                                                                                                                                                              | Corrección                                                                               | Test                                                                    |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Media    | Revocar el consentimiento de una voz clonada dejaba en `cache/tts/` el audio sintetizado con ella; su URL firmada seguía sirviéndolo                                  | El habla de una voz clonada se guarda bajo el prefijo de la voz, que la revocación borra | `packages/jobs/src/render-start.test.ts`                                |
| 2   | Media    | En traducción solo se moderaba la transcripción de origen: el texto traducido se doblaba sin revisar                                                                  | Moderación por idioma antes de doblar; ese idioma falla con `CONTENT_BLOCKED`            | `apps/worker/src/jobs/translation/translation.test.ts`                  |
| 3   | Media    | Un carácter invisible dentro de una palabra (espacio de ancho cero, guion blando) esquivaba la lista de bloqueo, y la voz la pronunciaba entera                       | Se eliminan los caracteres de formato antes de comparar                                  | `packages/providers/src/moderation/moderation.test.ts`                  |
| 4   | Baja     | `startRender` no comprobaba imágenes, vídeos ni música de la Composition: con un archivo ajeno o borrado cobraba, encolaba y fallaba en el worker (que sí lo impedía) | Toda referencia se valida antes de cobrar: `422`, nada cobrado ni encolado               | `render-start.test.ts`, `security/isolation.test.ts`                    |
| 5   | Baja     | `GET /api/system/worker-ping/:jobId` devolvía el ping de cualquier workspace a quien conociera su id                                                                  | El id del job lleva el workspace; otro recibe 404                                        | `security/isolation.test.ts`                                            |
| 6   | Baja     | Login y registro no comprobaban `Origin` (inicio de sesión forzado desde otro sitio; solo lo frenaba el tipo de contenido)                                            | La comprobación de `Origin` cubre toda ruta que no sea de clave de API                   | `security/hardening.test.ts`                                            |
| 7   | Baja     | El guardián SSRF aceptaba IPv6 con una IPv4 privada incrustada (`::127.0.0.1`, 6to4, Teredo, NAT64 local)                                                             | Rangos añadidos a la lista de bloqueo                                                    | `packages/shared/src/node/node.test.ts`, `security/hardening.test.ts`   |
| 8   | Baja     | `download=` no va firmado: un enlace válido podía entregar una imagen como `factura.html` desde el dominio de la API                                                  | El nombre conserva siempre la extensión del objeto guardado                              | `security/hardening.test.ts`                                            |
| 9   | Baja     | Un error inesperado de un job guardaba rutas del servidor e IPs internas en la fila, visibles en la interfaz, en `/v1` y en el webhook `video.failed`                 | `scrubInternals` en `toStoredError` y en el runner                                       | `packages/shared/src/schemas.test.ts`, `apps/worker/src/worker.test.ts` |
| 10  | Baja     | El log de peticiones escribía la firma de cada URL de archivo y los tokens de invitación y de compartir                                                               | `redactUrl` en el serializador de peticiones                                             | `security/hardening.test.ts`                                            |
| 11  | Baja     | En producción solo se rechazaba el `APP_SECRET` de desarrollo; `aaaa…` se aceptaba                                                                                    | `weakSecretReason`; aviso al arrancar fuera de producción                                | `packages/shared/src/node/node.test.ts`                                 |
| 12  | Baja     | Una descarga abortada por el cliente (cada salto de un reproductor) provocaba un segundo envío y un `ERROR` en el log por petición                                    | `defineRoute` y el manejador de errores no envían si la respuesta ya empezó              | `security/hardening.test.ts`                                            |

Comprobado sin encontrar defecto: aislamiento por ruta, cuerpo y listas (50 rutas con parámetro,
20 referencias en el cuerpo, 26 listas); rotación y cierre de sesión; fijación de sesión; CORS;
límite de intentos (también con el e-mail en otra caja); hash y revocación de claves; roles en
las 60 rutas del contrato con rol mínimo (y que las 62 mutaciones con sesión lo declaran, salvo
las 8 de autoservicio); firma, caducidad y recorrido de directorios en URLs de archivo;
corte de tamaño en streaming (120 MB rechazados en 0,5 s, sin temporal); HTML, SVG y listas HLS
disfrazadas; cabeceras al servir archivos; consentimiento por todos los caminos; moderación en
vídeo, `/v1`, lote, interactivo, vista previa y retratos; arranque con `NODE_ENV=production`.

## 5. Cómo repetir las comprobaciones

```bash
pnpm --filter @parlante/api exec vitest run src/security      # aislamiento + regresiones
# La misma matriz por HTTP contra una API en marcha (misma DATABASE_URL y storage que ella;
# registra dos cuentas e2e-…@example.test y siembra filas: nunca sobre datos reales):
LIVE_API_URL=http://127.0.0.1:4000 pnpm --filter @parlante/api exec tsx src/security/scripts/live-isolation.ts
pnpm audit --prod
```

Al añadir una ruta con un parámetro nuevo, `isolation-matrix.ts` falla hasta que se indica qué
recurso de la víctima lo rellena: es deliberado. Al añadir un campo de cuerpo que nombra otro
recurso, añade su caso a `bodyCases`.
