# Arquitectura de Parlante

> Derivado del código real del repositorio (no de intenciones). Si este documento y el código
> discrepan, manda el código y hay que corregir este documento. El contrato del proyecto es
> [`docs/prompt/MASTER_PROMPT.md`](prompt/MASTER_PROMPT.md); el detalle de cada contrato está en
> [`docs/CONTRACTS.md`](CONTRACTS.md); quién toca qué, en [`docs/OWNERSHIP.md`](OWNERSHIP.md).

## 1. Vista general

Parlante convierte un documento **Composition** (JSON) en un MP4 con un avatar que habla. Hay
tres procesos Node, uno opcional en Python y dos servicios de infraestructura:

```
 navegador ──────────────────────────────────────────────────────────────────────────────┐
 │ apps/web (Vite + React)                                                                │
 │   Studio: renderFrame() en <canvas>  ◄── MISMO código de render que la exportación     │
 │   cliente tipado generado de la tabla de rutas `api` (@parlante/shared)                │
 └───────────────┬───────────────────────────────────────────────────────────────────────┘
                 │ HTTP  /api/* (cookie de sesión)   /v1/* (API key)   /api/files/* (URL firmada)
                 ▼
 ┌───────────────────────────────┐   encola (ids)   ┌──────────────────────────────────────┐
 │ apps/api  (Fastify)           │ ───────────────► │ Redis + BullMQ                       │
 │  defineRoute(api.x.y, handler)│                  │ colas: render, translation, batch,   │
 │  módulos autocargados         │ ◄─ estado en BD ─│ photo-avatar, voice-clone,           │
 │  auth, roles, CSRF, límites   │                  │ webhook-delivery, system             │
 └───────┬───────────────┬───────┘                  └───────────────┬──────────────────────┘
         │               │                                          │ consume
         ▼               ▼                                          ▼
 ┌──────────────┐ ┌──────────────────┐              ┌──────────────────────────────────────┐
 │ PostgreSQL   │ │ Storage          │ ◄──────────► │ apps/worker (BullMQ workers)         │
 │ (Drizzle)    │ │ disco local | S3 │              │  jobs autocargados · ffmpeg          │
 │ fuente de    │ │ claves generadas │              │  renderFrame() con @napi-rs/canvas   │
 │ verdad       │ │ por el servidor  │              └───────┬──────────────────────────────┘
 └──────────────┘ └──────────────────┘                      │ HTTP JSON + archivos por ruta
                                                            ▼ (solo avatares fotorrealistas)
                                            ┌──────────────────────────────────────────────┐
                                            │ services/avatar-engine (Python, opcional)    │
                                            │ modelos abiertos: generar retrato, preparar, │
                                            │ animar. CPU o GPU. Pesos fuera del repo.     │
                                            └──────────────────────────────────────────────┘
```

Regla de oro: **la base de datos es la fuente de verdad del estado**. Las colas solo llevan
ids; los clientes no hablan con Redis: sondean el recurso REST (`GET /api/videos/:id`…), que
refleja `status`, `progress`, etapa y tiempo estimado persistidos por el worker.

## 2. Paquetes y dependencias

```
packages/shared        zod + tipos. Sin dependencias internas. Isomórfico (navegador y Node);
                       lo exclusivo de Node vive en `@parlante/shared/node`.
packages/db            → shared            Drizzle: esquema, migraciones, libro de créditos, seed, utilidades de test
packages/renderer      → shared            renderFrame, timeline, reloj de medios, subtítulos, rigs de avatares
packages/providers     → shared            TTS, STT, LLM, traducción, clonado, lip-sync, retratos, moderación, storage
packages/templates     → shared            plantillas integradas (datos Composition)
packages/stock-assets  → shared, renderer  fondos/música generados por código; retratos stock fotorrealistas
packages/jobs          → shared, db, renderer, stock-assets
                                           cliente de colas y servicios que API y worker comparten
apps/api               → todo lo anterior  Fastify
apps/worker            → todo lo anterior  BullMQ + ffmpeg
apps/web               → shared, renderer, templates
services/avatar-engine (Python, fuera del workspace pnpm; contrato en shared/avatar-engine.ts)
```

Dos reglas de dependencia que evitan duplicar lógica:

- **El worker no puede importar de `apps/api`** (ni al revés). Lo que ambos necesitan vive en
  `packages/jobs`: `startRender`, `resolveVoice`, `synthesizeCached`, `createFileUrlBuilder`,
  `toPublicVideo`, `dispatchWebhookEvent`, `notifyVideoFinished`, `failRenderJob`.
- **Nadie salvo `packages/db` depende de `drizzle-orm`**: los helpers de consulta (`eq`, `and`,
  `sql`…) se importan de `@parlante/db`, que los reexporta. Dos copias de los tipos de Drizzle
  rompen el tipado de todas las consultas.

### Autocarga (por qué nadie edita archivos compartidos)

| Dónde       | Convención                                                                                    | Cargador                                                          |
| ----------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| API         | `apps/api/src/modules/<nombre>/index.ts` exporta `defineModule({ name, register })`           | `lib/modules.ts` (ignora carpetas que empiezan por `_`)           |
| Worker      | `apps/worker/src/jobs/<nombre>/index.ts` exporta `defineJob({ queue, handler })`              | `lib/loader.ts` (un job por cola; falla si dos reclaman la misma) |
| Web         | `apps/web/src/features/<nombre>/index.tsx` exporta `defineFeature({ id, routes, nav, i18n })` | glob de Vite (ver `apps/web/README.md`)                           |
| Proveedores | la implementación se elige dentro de `packages/providers/src/<capacidad>/index.ts`            | `registry.ts` solo las ensambla                                   |

Añadir un endpoint, un job o una pantalla es crear una carpeta; los agentes en paralelo no
chocan en un archivo de registro.

## 3. Flujo de datos del render

### 3.1 Antes de encolar: `startRender` (packages/jobs)

`POST /api/videos/:id/render`, `POST /v1/videos` y el fan-out de lote llaman a **la misma
función**. Secuencia (cada paso que falla no deja nada cobrado ni creado):

1. Carga vídeo y workspace filtrando por `workspaceId`; rechaza si ya hay un render activo.
2. `applyVariables(composition, variables)` → **snapshot** concreto (el vídeo conserva sus
   `{{variables}}`).
3. Valida referencias: avatares existen y están `ready`, voces resuelven (`resolveVoice`),
   audios de narración son del workspace → `UNPROCESSABLE`.
4. Límites del plan: escenas, resolución, duración estimada
   (`estimateCompositionDurationMs`), simultaneidad (`maxConcurrentRenders`; el lote está
   exento) → `PLAN_LIMIT_EXCEEDED`.
5. Moderación de todo texto (`collectModerationTexts` → `ModerationProvider`, contexto
   `script`) → `CONTENT_BLOCKED`.
6. Si hay avatares fotorrealistas, el motor debe poder **animar** → `SERVICE_UNAVAILABLE`.
7. En una transacción: `chargeCredits` (ref `renderJob`; ×2 a 1080p, ×2 fotorrealista),
   inserta `render_jobs` (snapshot, revisión, marca de agua del plan) y pone el vídeo en
   `queued`.
8. Encola con `jobId = renderJobId`. Si Redis falla, el job se marca fallido y se reembolsa.

### 3.2 Render 2D "instantáneo" (avatares `stock_…`)

```
job render (apps/worker/src/jobs/render — propietario: worker-render)
 loadRenderJob ── markRenderStarted                       lib/render-status.ts
 │
 ├─ etapa prepare   descarga assets del snapshot (collectMediaRefs), registra fuentes,
 │                  crea MapRenderAssets (imágenes, fuentes de vídeo, rigs)
 ├─ etapa audio     por escena:
 │                    script tts   → synthesizeCached(...)  (caché compartida con la API:
 │                                   la vista previa del Studio ya dejó el WAV y su timeline)
 │                    script audio → sceneRuntimeFromAudio({ transcript, PCM })
 │                  ⇒ RenderRuntime { sceneId → { audioDurationMs, visemes[], words[] } }
 │                  computeTimeline(composition, runtime)  ⇒ dónde cae cada escena y su narración
 ├─ etapa frames    for frame in 0..timeline.totalFrames:
 │                    mediaPlaybackAt(...)  → qué fotograma de cada vídeo hace falta (decodifica por ventana)
 │                    renderFrame(ctx, composition, t, runtime, assets, { width, height, watermark })
 │                    canvasToRgba(canvas) ──► stdin de ffmpeg (-f rawvideo)
 ├─ etapa encode    ffmpeg: H.264 + AAC, +faststart; mezcla narraciones + música
 │                  (constantes AUDIO_MIX: ducking, fundidos) + audio de vídeos
 ├─ etapa finalize  miniatura, SRT/VTT con compositionSubtitleCues + formatSrt/formatVtt,
 │                  subida a storage (storageKeys.videoOutput)
 └─ markRenderCompleted   liquida créditos al coste real, escribe salidas en `videos`,
                          notifyVideoFinished → webhooks + contabilidad de lote
    (o markRenderFailed   guarda {code,message}, reembolsa, notifica)
```

El avatar 2D lo dibuja un **rig** (`AvatarRig.draw`) a partir de un `AvatarState` puro
(`computeAvatarState`: visema actual y siguiente con mezcla, parpadeo, mirada, cabeza y
respiración deterministas con semilla `sceneId:layerId`). El Studio ejecuta exactamente el
mismo `renderFrame` en el navegador con el runtime que devuelve `POST /api/tts/synthesize`,
por eso la vista previa es igual a la exportación.

### 3.3 Render fotorrealista (avatares `real_…` y `avt_…`)

Se añade la etapa `avatars` entre `audio` y `frames`:

```
 por cada escena y cada capa de avatar fotorrealista:
   1. retrato preparado + mate          real_: packages/stock-assets (archivos versionados)
                                        avt_:  storage (avatars.image_key / mask_key)
   2. audio de TODA la escena           narración rellenada con silencio (padding inicial y final);
                                        escena sin narración ⇒ solo silencio (clip en reposo)
   3. caché                             avatarClipCacheKey({portraitSha, maskSha, audioSha, fps,…})
                                        → storageKeys.avatarClipCache(...)  ¿existe? se reutiliza
   4. providers.lipsync.animate({ portraitPath, maskPath, audioPath, visemes, fps, maxSize,
                                  outputDir, clientRef, onProgress, signal })
        proveedor `local-neural` (packages/providers):
          createEngineJobDir()  copia entradas al directorio compartido del motor
          POST /v1/animations → 202 EngineJob;  GET /v1/jobs/:id  (progress, etaSec)
          copia resultados a outputDir, borra el subdirectorio; DELETE del job si se aborta
   5. decodifica el clip (+ mate) a fotogramas RGBA y lo registra:
        assets.setAvatarClip(sceneId, layerId, { …frames, originMs: 0, landmarks })
        assets.setAvatar(avatarId, createPhotoAvatarRig(id, cutout, rig))   // red de seguridad
   progreso: reportRenderProgress(stage 'avatars', %, etaSec medido)  → visible en la UI
```

En `frames`, `renderFrame` dibuja el fotograma del clip con `photoAvatarPlacement` — la misma
función que usa el _stand-in_ Canvas de la vista previa — y `avatarClipTimeMs`. En `encode` el
MP4 recibe los metadatos `AI_GENERATED_METADATA` (contenido generado por IA).

Qué ve el usuario antes de exportar: el Studio y el avatar interactivo no esperan al motor;
muestran el **stand-in** (`createPhotoAvatarRig` sobre el recorte `cutoutUrl`), etiquetado como
vista previa. La exportación sustituye el stand-in por el clip neuronal en el mismo sitio.

### 3.4 Cancelación y fallos

- **Cancelar**: la API marca el job `canceled`, reembolsa y devuelve el vídeo a su estado
  anterior. El handler consulta `isRenderCanceled` entre etapas y termina devolviendo
  `{ canceled: true, videoId }`. `markRenderCompleted` / `markRenderFailed` solo actúan sobre
  jobs aún `running` (o `queued`), así que un job cancelado nunca se completa ni se vuelve a
  cobrar.
- **Worker muerto**: BullMQ detecta el job _stalled_, lo reintenta una vez y después lo falla
  sin ejecutar el handler. `JobDefinition.onFinalFailure` (invocado desde el evento `failed`)
  marca la fila como fallida y reembolsa. Probado con Redis real en `apps/worker`.
- **Redis caído al encolar**: `enqueueOrCompensate` marca la fila fallida y reembolsa.

## 4. Otros flujos (mismo patrón: API valida y cobra → cola → job → fila)

| Flujo                   | API                                                                                                                     | Job                                                                                                                                   | Proveedores           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Avatar desde foto (14)  | `POST /api/photo-avatars` — exige `ConsentRecord` (`consumeConsent`), comprueba operación `prepare`, cobra ref `avatar` | `photo-avatar`: `portrait.prepare` → `image.png`, `mask.png`, `cutout.png`, `thumb.jpg`; persiste progreso con `reportAvatarProgress` | portrait              |
| Avatar generado (14)    | `POST /api/photo-avatars/generate` — modera el prompt (`avatar_prompt`), comprueba `generate` y `prepare`               | mismo job: `portrait.generate` y después `prepare`                                                                                    | moderation, portrait  |
| Clonado de voz (14)     | `POST /api/voice-clones` — exige consentimiento                                                                         | `voice-clone`: `voiceClone.createVoice` → perfil local o voz externa                                                                  | voiceClone            |
| Traducción (12)         | `POST /api/translations` — transcripción del usuario o STT; límites de idiomas y duración                               | `translation`: transcribir → traducir → `synthesizeCached` por segmento → mezcla → subtítulos (`drawSubtitleCue` si van incrustados)  | stt, translation, tts |
| Lote (15)               | `POST /api/batches` — solo comprueba saldo                                                                              | `batch`: por fila crea un vídeo y llama a `startRender({ variables, skipConcurrencyLimit })`                                          | —                     |
| Avatar interactivo (16) | `POST …/sessions/:id/messages`: moderación → LLM → `synthesizeCached` → respuesta con `speech.runtime`                  | sin job (síncrono)                                                                                                                    | moderation, llm, tts  |
| Webhooks (9)            | CRUD de endpoints; `dispatchWebhookEvent` crea entregas                                                                 | `webhook-delivery`: POST firmado HMAC con guardia SSRF y reintentos                                                                   | —                     |

## 5. Decisiones y por qué

| Decisión                                                                                           | Por qué                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Composition es el único formato de documento** (zod, versionado con `migrateComposition`)        | Editor, API, plantillas, lote y worker hablan lo mismo; una plantilla es un vídeo sin renderizar.                                                                                             |
| **Renderer isomórfico y determinista** (`renderFrame(ctx, composition, t, runtime, assets)`)       | La vista previa del Studio ES el render; cualquier fotograma se puede dibujar aislado (paralelismo, miniaturas, tests de píxeles). Sin `Date.now()` ni `Math.random()` (ESLint lo prohíbe).   |
| **Geometría normalizada (0..1) y tamaños como fracción de la altura**                              | El mismo documento se renderiza a 720p y 1080p y cambia de formato sin recalcular.                                                                                                            |
| **El runtime (visemas, palabras) va aparte de la Composition**                                     | Depende del proveedor de voz y del audio; el documento sigue siendo pequeño y editable. Los tiempos son relativos al inicio de la narración.                                                  |
| **Tabla de rutas tipada en `shared`** (`RouteDef`)                                                 | Una sola definición alimenta validación, OpenAPI, auth/roles, cliente web tipado y tests.                                                                                                     |
| **Las colas llevan ids; la fila es la verdad; `jobId` = id de la fila**                            | Encolado idempotente, reintentos seguros, los clientes sondean REST.                                                                                                                          |
| **Créditos: reservar → liquidar/reembolsar con un libro mayor por referencia** (`netCharged`)      | Idempotente ante reintentos y caídas; nunca se actualiza `workspaces.credits` a mano.                                                                                                         |
| **Proveedores intercambiables con implementación local**                                           | Requisito central: funciona sin claves. `auto` usa el adaptador externo si hay clave. Cada resultado lleva `provider` (regla de honestidad).                                                  |
| **Avatares 2D "instantáneos" + motor neuronal local**                                              | 2D: tiempo real, preview = export, avatar interactivo. Neuronal: fotorrealismo sin servicios de pago, lento en CPU (se muestra ETA medido).                                                   |
| **Motor neuronal en Python, fuera del proceso Node, con archivos por ruta**                        | Los modelos viven en el ecosistema Python (ONNX Runtime / OpenVINO); intercambiar rutas evita mover cientos de MB por HTTP. El proveedor, no el job, copia archivos al directorio compartido. |
| **Stand-in y clip comparten `photoAvatarPlacement`; el clip cubre toda la escena (`originMs: 0`)** | La cara cae en el mismo sitio en la vista previa y en el MP4, y el avatar no se congela fuera de la narración.                                                                                |
| **Reloj de medios exportado (`mediaPlaybackAt`)**                                                  | El reproductor del Studio y el worker piden a los vídeos exactamente el instante que `renderFrame` va a dibujar, sin copiar aritmética.                                                       |
| **Caché de TTS y de clips por hash de contenido**                                                  | La vista previa y el render sintetizan una vez; re-renderizar tras tocar un texto no re-anima escenas intactas.                                                                               |
| **Archivos solo por claves generadas por el servidor y URLs firmadas**                             | Nunca se deriva una ruta de la entrada del usuario; el storage S3 y el local se sirven igual (`createFileUrlBuilder`).                                                                        |
| **Una base de datos por ejecución de tests**                                                       | Varios agentes ejecutan suites a la vez sin pisarse (`@parlante/db/testing`).                                                                                                                 |
| **`downloadUrl` separado de `videoUrl`**                                                           | Las URLs de archivo son de otro origen: `<a download>` no funciona; el nombre lo fija el servidor.                                                                                            |

## 6. Dónde se cumple cada regla de seguridad (§5 del prompt maestro)

| Regla                                    | Dónde                                                                                                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consentimiento obligatorio               | `apps/api/src/lib/consent.ts` (`consumeConsent`, dentro de la transacción) + check SQL `avatars_photo_requires_consent` + `voices.consent_id NOT NULL`. Revocar borra avatar/voz, sus archivos y el asset de origen. |
| Moderación antes de renderizar           | `startRender` → `collectModerationTexts`. Prompts de retrato: contexto `avatar_prompt`.                                                                                                                              |
| Validación zod en toda entrada           | `defineRoute` (params, query, body) y `QUEUES[*].payload` al encolar y al procesar.                                                                                                                                  |
| Autorización por workspace               | `auth.workspaceId` en cada consulta; recurso ajeno = `404`. Patrón en `modules/_template`.                                                                                                                           |
| Subidas                                  | `lib/uploads.ts`: tamaño límite en streaming, tipo real por _magic bytes_, nombre saneado, archivo temporal con nombre aleatorio.                                                                                    |
| Rutas de archivo                         | `storageKeys` + `isSafeStorageKey`; `LocalStorageProvider` comprueba que la ruta no sale de la raíz; `createEngineJobDir` rechaza rutas fuera del directorio del job.                                                |
| ffmpeg                                   | `runProcess` / `runFfmpeg` con arrays de argumentos, sin shell.                                                                                                                                                      |
| Límite de peticiones, cabeceras, cookies | `@fastify/rate-limit` (global + por ruta), `@fastify/helmet`, cookie httpOnly + SameSite, comprobación de `Origin` en métodos no seguros.                                                                            |
| SSRF                                     | `@parlante/shared/node` `assertPublicUrl` / `safeRequest` (webhooks y "URL → guion").                                                                                                                                |
| Secretos                                 | Contraseñas scrypt; sesiones y API keys guardadas como hash; secretos de webhook cifrados con `APP_SECRET`; `.env.example` documenta todo. Motor: `AVATAR_ENGINE_TOKEN` fuera de loopback.                           |

## 7. Estado de la base al cerrar la fase de contratos (qué es real y qué es esqueleto)

Implementado y con tests: contratos (`shared`), esquema y migraciones (`db`), cola y servicios
compartidos (`jobs`), almacenamiento local, esqueleto de API (auth, sesiones, API keys, roles,
subidas, archivos firmados, OpenAPI, módulo de referencia), esqueleto de worker (runner, ffmpeg,
estado de render, recuperación de jobs muertos), renderer base (línea de tiempo, reloj de
medios, `renderFrame` con dibujo simplificado, subtítulos, colocación fotorrealista).

Esqueleto con _stub_ honesto (lanzan `NOT_IMPLEMENTED` o informan "no disponible"): proveedores
de TTS, LLM, traducción, clonado, moderación, lip-sync y retratos; rigs de avatar (placeholder);
módulos de dominio de la API y jobs del worker distintos de `system`. Cada uno tiene dueño en
`docs/OWNERSHIP.md` y su contrato en `docs/CONTRACTS.md`.
