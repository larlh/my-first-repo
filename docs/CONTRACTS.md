# Contratos de Parlante

> Resumen navegable de los contratos que comparten todos los paquetes. **La fuente de verdad es
> el código de `packages/shared`** (esquemas zod con comentarios); este documento dice dónde
> está cada cosa, qué reglas la gobiernan y cómo ampliarla sin romper a nadie.
> Arquitectura y flujos: [`ARCHITECTURE.md`](ARCHITECTURE.md). Propiedad: [`OWNERSHIP.md`](OWNERSHIP.md).

Índice: [0 Reglas](#0-reglas-generales) · [1 Composition](#1-composition) ·
[2 Runtime y visemas](#2-runtime-visemas-y-estimadores) · [3 Renderer](#3-renderer) ·
[4 Entidades](#4-entidades-dto) · [5 API](#5-api-tabla-de-rutas) · [6 Colas](#6-colas) ·
[7 Créditos y planes](#7-créditos-y-planes) · [8 Proveedores](#8-proveedores) ·
[9 Motor neuronal](#9-motor-neuronal-local) · [10 Storage](#10-claves-de-storage-y-cachés) ·
[11 Servicios compartidos](#11-servicios-compartidos-packagesjobs) ·
[12 Patrón de módulo de API](#12-patrón-de-módulo-de-api) ·
[13 Patrón de job](#13-patrón-de-job-del-worker) · [14 Extender](#14-cómo-extender-un-contrato)

## 0. Reglas generales

- Importa siempre de la raíz: `@parlante/shared` (isomórfico) o `@parlante/shared/node`
  (crypto, env, SSRF, claves de storage, ffmpeg). Nunca de rutas internas.
- **Ids**: `<prefijo>_<16 caracteres>` (`newId('video')` → `vid_…`); valida con `idOf('video')`.
  Avatares: `stock_<slug>` (2D instantáneo), `real_<slug>` (stock fotorrealista), `avt_…`
  (del workspace). Voces: `<proveedor>:<id>` (stock) o `vcl_…` (clonada).
- **Errores**: una sola forma `{ error: { code, message, details? } }`; se lanza
  `new AppError(code, message, details)` en cualquier capa. Códigos y estado HTTP en
  `errors.ts` (`ERROR_CODES`): 400 `VALIDATION_ERROR` `BAD_REQUEST` · 401 `UNAUTHENTICATED`
  `INVALID_CREDENTIALS` `INVALID_API_KEY` · 402 `INSUFFICIENT_CREDITS` · 403 `FORBIDDEN`
  `PLAN_LIMIT_EXCEEDED` `CONSENT_REQUIRED` · 404 `NOT_FOUND` · 409 `CONFLICT` `EMAIL_TAKEN`
  `INVALID_STATE` `REVISION_CONFLICT` · 413 `PAYLOAD_TOO_LARGE` · 415 `UNSUPPORTED_MEDIA_TYPE` ·
  422 `CONTENT_BLOCKED` `TRANSCRIPT_REQUIRED` `UNSAFE_URL` `UNPROCESSABLE` · 429 `RATE_LIMITED` ·
  500 `INTERNAL` · 501 `NOT_IMPLEMENTED` · 502 `PROVIDER_ERROR` · 503 `PROVIDER_NOT_CONFIGURED`
  `SERVICE_UNAVAILABLE`. En filas fallidas se guarda `StoredError { code, message }`
  (`toStoredError(err)`).
- **Fechas** ISO-8601 en los DTO; **tiempos** en milisegundos enteros; **30 fps** fijos.
- **Archivos**: en BD solo claves de storage; en los DTO solo URLs ya firmadas
  (`app.fileUrl(key)` / `ctx.fileUrl(key)`). El cliente nunca construye una URL de archivo ni
  la persiste (caducan).
- **Honestidad de proveedores**: todo resultado de IA lleva `provider: ProviderRef`
  (`quality: 'basic' | 'premium'`, `local`). La UI nunca presenta el modo básico como premium.

## 1. Composition

`packages/shared/src/composition/` — el **único formato de documento de vídeo**.

```
Composition { version: 1, canvas, scenes[1..50], subtitles, music|null, brandKitId|null, variables[] }
 ├─ canvas     { aspect: '16:9'|'9:16'|'1:1', width, height, fps: 30 }      CANVAS_PRESETS, resolutionSize()
 ├─ Scene      { id, name, duration: auto | fixed{seconds}, script, background, transition,
 │               layers[0..30], paddingStartMs=300, paddingEndMs=500 }
 │   ├─ script      tts   { text, voiceId, speed 0.5..2, pitch -12..12, language }
 │   │              audio { assetId, transcript, language? }      narración subida
 │   │              none
 │   ├─ background  color{color, brandRole?} | gradient | image{src, fit, blur, dim}
 │   │              | video{src, fit, loop, volume, trimStartMs, dim}
 │   ├─ transition  { type: none|fade|slide-*|wipe|zoom, durationMs }   ENTRADA a la escena
 │   └─ Layer (unión por `type`)   base: id, name, box{x,y,w,h}, rotation, opacity, z, visible,
 │        │                              locked, enter?, exit?, timing?{startMs,endMs}, role?
 │        ├─ avatar { avatarId, framing: bust|half|closeup, shape: none|circle|rounded, backdrop, flip }
 │        ├─ text   { text, style: TextStyle }
 │        ├─ image  { src, fit, radius }
 │        ├─ video  { src, fit, radius, trimStartMs, loop, volume }
 │        └─ shape  { shape: rect|ellipse|triangle|line|star, fill, stroke, radius }
 ├─ subtitles  SubtitleStyle { enabled, preset: classic|boxed|karaoke|minimal, fuente, colores,
 │                             position, margin, maxCharsPerLine, maxLines, uppercase }
 ├─ music      MusicTrack { src, volume, ducking, fadeInMs, fadeOutMs, loop }
 └─ variables  VariableDef { name, label, defaultValue }      `{{nombre}}` en textos
```

Convenciones (cabecera de `schema.ts`):

- Cajas normalizadas al lienzo (0..1, pueden desbordar). Tamaños que no son cajas (fuente,
  trazo, radio, márgenes) son **fracciones de la altura del lienzo**.
- `MediaRef` nunca es una URL libre: `{ source: 'asset', assetId }` (subida del workspace) o
  `{ source: 'stock', stockId }` (packages/stock-assets). Clave canónica: `mediaRefKey(ref)` →
  `asset:<id>` / `stock:<id>`.
- Orden de pintado: `z` ascendente y, a igualdad, orden del array.
- La transición no cambia la duración total: ocurre en los primeros `durationMs` de la escena
  entrante con la anterior congelada en su último fotograma.

Funciones que acompañan al esquema (úsalas, no las reescribas):

| Función                                                                                                 | Para qué                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createComposition`, `createScene`, `createLayer`, `canvasForAspect`, `withAspect`                      | Construir documentos con todos los valores por defecto.                                                                                            |
| `compositionFromScript(scenes, { avatarId, voiceId, language, aspect, … })`                             | **La** maquetación guion → vídeo. La usan el guionista IA (web) y `POST /v1/videos` con `input.type: 'script'`.                                    |
| `cloneCompositionWithNewIds`                                                                            | Duplicar vídeo / usar plantilla / filas de lote.                                                                                                   |
| `parseComposition`, `migrateComposition`                                                                | Leer documentos guardados (migra versiones antiguas).                                                                                              |
| `extractPlaceholders`, `listUsedVariables`, `syncVariableDefs`, `checkVariableValues`, `applyVariables` | Variables `{{…}}` (lote, API v1).                                                                                                                  |
| `collectMediaRefs`, `collectAssetIds`, `collectAvatarIds`, `collectVoiceIds`, `usesPhotorealAvatars`    | Qué referencia un documento.                                                                                                                       |
| `collectModerationTexts`                                                                                | **Qué se modera antes de renderizar**: guiones, transcripciones y capas de texto (tras `applyVariables`).                                          |
| `estimateSpeechMs`, `sceneDurationMs`, `estimateCompositionDurationMs`                                  | Duración estimada (créditos, límites, línea de tiempo sin audio).                                                                                  |
| `applyBrandKit(composition, brand)`                                                                     | Kit de marca: usa `layer.role` y `background.brandRole`.                                                                                           |
| `AUDIO_MIX`, `duckingGainAt`                                                                            | Constantes de mezcla (ducking 0,35; ataque 150 ms; liberación 400 ms; fundido de corte 120 ms) compartidas por el reproductor del Studio y ffmpeg. |

## 2. Runtime, visemas y estimadores

`runtime.ts`, `visemes.ts`, `speech-estimate.ts`.

```
RenderRuntime { scenes: { [sceneId]: SceneRuntime } }        escena ausente = silenciosa
SceneRuntime  { audioDurationMs, visemes: VisemeCue[], words: WordCue[] }
VisemeCue     { tMs, viseme }            la boca toma esa forma en tMs y la mantiene
WordCue       { tMs, durMs, text }       palabra con su puntuación
```

**Todos los tiempos son relativos al inicio del audio de narración de la escena** (no a la
escena ni al vídeo). La narración empieza `paddingStartMs` después de la escena;
`computeTimeline` hace la conversión.

- 15 visemas: `rest MBP FV TH DT KG CHJ SZ NL R A E I O U`. `VISEME_MOUTH_SHAPES` da los
  parámetros canónicos de boca (`open`, `width`, `round`, `teeth`, `tongue`) de los que derivan
  todos los rigs; `blendMouthShapes` interpola.
- `phonemeToViseme(fonema)` (IPA + mnemónicos de eSpeak; tabla `PHONEME_TO_VISEME`, ampliable
  de forma aditiva).
- Cuando no hay tiempos de fonema — **un único estimador compartido**:
  - `estimateSpeechTimeline(text, durationMs, language?)` → `{ visemes, words }`. Lo usan los
    adaptadores TTS externos (ElevenLabs, OpenAI).
  - `sceneRuntimeFromAudio({ audioDurationMs, transcript?, samples?, sampleRate? })` → el
    runtime de una escena con narración subida (`script.kind: 'audio'`): palabras desde la
    transcripción, visemas desde la envolvente del audio (`visemesFromAudio`) o, sin PCM,
    estimados del texto. **El Studio (navegador) y el job de render llaman a la misma función**
    con el PCM decodificado; no hay ruta HTTP para esto.
- Subtítulos (`subtitles.ts`): `TimedText { startMs, endMs, text }`, `formatSrt`, `formatVtt`,
  `parseSubtitles`, `parseTranscript(format, content, totalMs)`.

## 3. Renderer

`packages/renderer` — entrada única:

```ts
renderFrame(ctx, composition, tMs, runtime, assets, { width?, height?, timeline?, subtitles?, watermark?, quality? })
```

Puro y determinista. Lo ejecutan el Studio (navegador, `@parlante/renderer/browser`) y el worker
(Node, `@parlante/renderer/node` con @napi-rs/canvas).

| Pieza                                                                                                                                                                                                                                                                                                        | Contrato                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `computeTimeline(composition, runtime, { estimateMissing? })` → `Timeline { fps, totalMs, totalFrames, scenes: SceneTiming[] }`                                                                                                                                                                              | Escenas una tras otra; `speechStartMs`, `speechDurationMs`, `transitionMs` (acotada a la mitad de la escena más corta). `locateScene`, `frameToMs`, `msToFrame`.                                                                                                                                                                                                                                                                                           |
| `RenderAssets` (`MapRenderAssets`)                                                                                                                                                                                                                                                                           | Búsquedas **síncronas**: `image(key)`, `video(key)`, `avatar(avatarId)`, `avatarClip(sceneId, layerId)`. Lo que falta se dibuja como marcador neutro, nunca lanza.                                                                                                                                                                                                                                                                                         |
| `VideoFrameSource { durationMs, width, height, frameAt(timeMs) }`                                                                                                                                                                                                                                            | Navegador: `videoElementSource(<video>)`. Node: fotogramas decodificados por el worker.                                                                                                                                                                                                                                                                                                                                                                    |
| **Reloj de medios** (`media.ts`): `mediaPlaybackAt(composition, timeline, tMs)` → `{ kind: background\|layer\|avatarClip, sceneId, layerId, key, rawMs, loop, volume, frozen, localMs, speechMs }[]`; `mediaTimeMs(rawMs, loop, durationMs)`; `avatarClipTimeMs(clip, localMs, speechMs)`; `sceneInstantsAt` | `renderFrame` los usa internamente. El reproductor del Studio hace _seek_ y ajusta volumen con ellos; el worker decodifica solo lo que cada fotograma pide. Hay un test que comprueba que predicen exactamente lo que `renderFrame` solicita.                                                                                                                                                                                                              |
| `AvatarRig { id, kind, draw(ctx, box, state, { framing, flip, quality }) }`                                                                                                                                                                                                                                  | El rig se ancla abajo-centro de la caja y no pinta fuera. `computeAvatarState({ runtime, speechMs, sceneMs, seed })` → `AvatarState` (visema actual/siguiente + mezcla, `mouth`, `blink`, `gaze`, `head`, `breath`, `speaking`).                                                                                                                                                                                                                           |
| Catálogo stock 2D                                                                                                                                                                                                                                                                                            | `listStockAvatars()`, `getStockAvatarMeta(id)`, `getStockAvatarRig(id)`; `MapRenderAssets.avatar` los resuelve solo.                                                                                                                                                                                                                                                                                                                                       |
| **Avatares fotorrealistas**                                                                                                                                                                                                                                                                                  | Vista previa: `createPhotoAvatarRig(id, cutout, rig)` con el **recorte** (`Avatar.cutoutUrl`, retrato con el mate aplicado). Exportación: `AvatarClipSource` = `VideoFrameSource` + `originMs?` + `landmarks?`. **`photoAvatarPlacement(imageW, imageH, box, framing, landmarks)`** es la única definición de dónde va la imagen (half: entera; bust: ojos→mentón = 20 % de la caja; closeup: 32 %, línea de ojos al 40 %); la usan el stand-in y el clip. |
| Regla para el job de render                                                                                                                                                                                                                                                                                  | Por cada capa fotorrealista de cada escena registra el stand-in (`setAvatar`) **y** un clip (`setAvatarClip`) con `originMs: 0` que cubra toda la escena (narración rellenada con silencio; sin narración, solo silencio) y los `landmarks` del avatar. Un MP4 nunca muestra el marcador gris.                                                                                                                                                             |
| Mate                                                                                                                                                                                                                                                                                                         | `applyAlphaMatte(platform, image, mask)` / `matteCanvas` (isomórfico); en Node `cutoutPng(portrait, mask)` y `thumbnailJpeg(source, maxSide)`. Blanco = persona.                                                                                                                                                                                                                                                                                           |
| Subtítulos                                                                                                                                                                                                                                                                                                   | `buildSubtitleCues(words, style)`, `cueAt`, `compositionSubtitleCues(composition, runtime, timeline)` (mismo origen para incrustados y SRT/VTT) y **`drawSubtitleCue(ctx, cue, style, width, height, tMs)`**, que también usa el job de traducción (`options.subtitleStyle`).                                                                                                                                                                              |
| Fuentes                                                                                                                                                                                                                                                                                                      | `FONT_FAMILIES` (@fontsource) registradas igual en navegador (`ensureBrowserFonts`) y Node (`registerNodeFonts`); `canvasFont(...)`.                                                                                                                                                                                                                                                                                                                       |

## 4. Entidades (DTO)

`entities.ts`. Las filas de BD viven en `packages/db/src/schema.ts`; cada módulo mapea fila →
DTO en una función. Los campos nuevos de respuesta llevan `.default(...)`: el productor puede
omitirlos y el consumidor siempre los recibe.

| Entidad              | Esquema                                                                                                          | Notas que suelen olvidarse                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sesión               | `SessionInfoSchema` (user, session, workspaces con rol, `currentWorkspaceId`)                                    | Todo lo que necesita el _shell_ web.                                                                                                                                                                                                                                                                              |
| Workspace / miembros | `WorkspaceSchema`, `MemberSchema`, `InviteSchema` (+ `InviteCreatedSchema` con token una sola vez)               | Roles `owner > admin > editor > viewer` (`roleAtLeast`).                                                                                                                                                                                                                                                          |
| Capacidades          | `CapabilitiesSchema`                                                                                             | `active` por capacidad; `sttRequiresTranscript`; `avatarEngine { available, reason, device, secondsPerVideoSecond, operations{generate,prepare,animate}, models[], nonCommercial, secondsPerPortrait }`. La UI muestra aviso visible si `nonCommercial`.                                                          |
| Avatar               | `AvatarSchema`                                                                                                   | `kind` stock/photo/generated; `rendering` instant/photoreal; `status`, **`progress`, `etaSec`** (persistidos por el job); `imageUrl`, `maskUrl`, **`cutoutUrl`**, `thumbnailUrl`, `rig` (landmarks sobre el retrato preparado), `prompt`, `seed`, `model`. `real_…` → URLs de `GET /api/stock-avatars/:id/:file`. |
| Voz                  | `VoiceSchema`                                                                                                    | `multilingual` (+ `languages?`): el filtro por idioma las incluye siempre. `profile` para clonado local.                                                                                                                                                                                                          |
| Voz sintetizada      | `SynthesizedSpeechSchema`                                                                                        | `audioUrl` (WAV) + `runtime` + `provider`.                                                                                                                                                                                                                                                                        |
| Vídeo                | `VideoSummarySchema` (listados) / `VideoSchema` (detalle)                                                        | `status`, `progress`, `renderStage`, `renderEtaSec`, `usesPhotorealAvatars` también en el listado. Detalle: `composition`, `revision`/`renderedRevision`, `videoUrl`, **`downloadUrl`** (adjunto con nombre), `srtUrl`, `vttUrl`, `providers`.                                                                    |
| Render job           | `RenderJobSchema`                                                                                                | Etapas `prepare → audio → avatars → frames → encode → finalize`.                                                                                                                                                                                                                                                  |
| Asset                | `AssetSchema`                                                                                                    | `kind` image/video/audio; **`purpose`** library/avatar_source/voice_sample/translation_source (el listado solo muestra `library` por defecto).                                                                                                                                                                    |
| Stock                | `StockAssetSchema`, `StockAvatarMetaSchema`, `StockPhotorealAvatarMetaSchema`                                    | Catálogos en español con `en?` opcional (`localizeCatalogEntry`).                                                                                                                                                                                                                                                 |
| Plantilla            | `TemplateSchema` / `TemplateDetailSchema` / `BuiltinTemplateSchema`                                              | Ids `builtin_<slug>` / `tpl_…`. `thumbnailUrl`: ruta de póster (integradas) o URL firmada (propias).                                                                                                                                                                                                              |
| Kit de marca         | `BrandKitSchema`                                                                                                 | Como máximo uno `isDefault` por workspace.                                                                                                                                                                                                                                                                        |
| API key / webhooks   | `ApiKeySchema` (+`Created`), `WebhookEndpointSchema` (+`Created`), `WebhookDeliverySchema`, `WebhookEventSchema` | Clave y secreto visibles solo al crear. Firma: `Parlante-Signature: t=<s>,v1=<hmac>`.                                                                                                                                                                                                                             |
| Vídeo público        | `PublicVideoSchema`                                                                                              | API v1 **y** webhooks (un único mapeador: `toPublicVideo`). Incluye `downloadUrl`, `aiGenerated`.                                                                                                                                                                                                                 |
| Traducción           | `TranslationJobSchema`, `TranslationOutputSchema`, `TranslationOptionsSchema`                                    | Estado `partial`; `downloadUrl` por idioma; `subtitleStyle?`.                                                                                                                                                                                                                                                     |
| Lote                 | `BatchJobSchema`, `BatchJobDetailSchema`, `BatchItemSchema`                                                      | `creditsCharged` = suma de sus renders.                                                                                                                                                                                                                                                                           |
| Consentimiento       | `ConsentRecordSchema` (+ `CONSENT_STATEMENTS` versionados)                                                       | Se consume una sola vez.                                                                                                                                                                                                                                                                                          |
| Créditos             | `CreditLedgerEntrySchema`                                                                                        | `delta`, `balanceAfter`, `reason`, `refType`/`refId`.                                                                                                                                                                                                                                                             |
| Compartir            | `ShareLinkSchema`, `PublicShareSchema`                                                                           | Página pública: `downloadUrl` (null si se desactiva), `aiGenerated`.                                                                                                                                                                                                                                              |
| Guionista            | `GeneratedScriptSchema`                                                                                          | `basicMode: true` con la heurística local.                                                                                                                                                                                                                                                                        |
| Interactivo          | `InteractiveSessionSchema`, `InteractiveMessageSchema`, `InteractiveReplySchema`                                 | La respuesta trae `speech` con su runtime.                                                                                                                                                                                                                                                                        |

## 5. API: tabla de rutas

`packages/shared/src/api/` exporta `api` (agrupada por módulo) y `allRoutes()`. Cada entrada es
un `RouteDef`:

```ts
route({ method, path, auth: 'session' | 'apiKey' | 'public', minRole?, feature, tag, summary,
        params?, query?, body?, multipart?, response, status?, binary?, errors?, rateLimit? })
```

- `/api/*` es la API propia (cookie de sesión; el workspace es el actual de la sesión);
  `/v1/*` es la API pública (`Authorization: Bearer plk_…`, rol `editor`).
- `defineRoute(app, api.x.y, handler)` registra validación, serialización, OpenAPI,
  autenticación, rol mínimo, comprobación de origen (CSRF) y límite de peticiones a partir del
  `RouteDef`. El cliente web y los tests (`t.call(api.x.y, …)`) se tipan con el mismo objeto.
- Listas paginadas: `?limit&cursor` → `{ items, nextCursor }` (`cursorWhere`, `cursorOrder`,
  `buildPage`). Listas pequeñas: `{ items }`. Acciones sin resultado: `{ ok: true }` (`OK`).
- Tipos derivados: `RouteBody<R>` (lo que recibe el handler, con _defaults_), `RouteBodyInput<R>`
  (lo que envía el cliente), `RouteResponse<R>`.
- OpenAPI en `/openapi.json` y Swagger UI en `/docs`, generados de esta tabla.

114 rutas. **F** = funcionalidad del prompt maestro (0 = infraestructura). La columna
de errores lista solo los de dominio; todas pueden devolver además 400/401/403/404/429/500.
Tabla generada de `allRoutes()`; si añades una ruta, añade su fila.

#### `api.system`

| Ruta               | Método | Path                             | Auth           | F   | Resumen                                                                   | Errores de dominio |
| ------------------ | ------ | -------------------------------- | -------------- | --- | ------------------------------------------------------------------------- | ------------------ |
| `health`           | GET    | `/health`                        | pública        | 0   | Liveness and dependency check                                             | —                  |
| `capabilities`     | GET    | `/api/capabilities`              | sesión         | 0   | Active provider per AI capability (drives "modo básico" labels in the UI) | —                  |
| `pingWorker`       | POST   | `/api/system/worker-ping`        | sesión ≥ admin | 0   | Queue a ping job for the worker _(202)_                                   | —                  |
| `workerPingStatus` | GET    | `/api/system/worker-ping/:jobId` | sesión ≥ admin | 0   | State and result of a ping job                                            | —                  |
| `file`             | GET    | `/api/files/*`                   | pública        | 0   | Download a stored file via signed URL _(binario)_                         | —                  |

#### `api.auth`

| Ruta              | Método | Path                         | Auth    | F   | Resumen                                                                               | Errores de dominio  |
| ----------------- | ------ | ---------------------------- | ------- | --- | ------------------------------------------------------------------------------------- | ------------------- |
| `register`        | POST   | `/api/auth/register`         | pública | 1   | Create an account with a personal workspace and start a session (sets cookie) _(201)_ | EMAIL_TAKEN         |
| `login`           | POST   | `/api/auth/login`            | pública | 1   | Start a session (sets cookie)                                                         | INVALID_CREDENTIALS |
| `logout`          | POST   | `/api/auth/logout`           | sesión  | 1   | End the current session (clears cookie)                                               | —                   |
| `me`              | GET    | `/api/auth/me`               | sesión  | 1   | Current user, workspaces and active workspace                                         | —                   |
| `updateProfile`   | PATCH  | `/api/auth/me`               | sesión  | 1   | Update name / UI language                                                             | —                   |
| `changePassword`  | POST   | `/api/auth/change-password`  | sesión  | 1   | Change password (other sessions are revoked)                                          | INVALID_CREDENTIALS |
| `switchWorkspace` | POST   | `/api/auth/switch-workspace` | sesión  | 1   | Change the active workspace of the session                                            | —                   |

#### `api.workspaces`

| Ruta      | Método | Path                      | Auth           | F   | Resumen                                                                        | Errores de dominio |
| --------- | ------ | ------------------------- | -------------- | --- | ------------------------------------------------------------------------------ | ------------------ |
| `list`    | GET    | `/api/workspaces`         | sesión         | 1   | Workspaces the user belongs to                                                 | —                  |
| `create`  | POST   | `/api/workspaces`         | sesión         | 1   | Create a workspace (caller becomes owner) _(201)_                              | —                  |
| `current` | GET    | `/api/workspaces/current` | sesión         | 1   | Active workspace with the caller role                                          | —                  |
| `update`  | PATCH  | `/api/workspaces/current` | sesión ≥ admin | 1   | Rename the active workspace                                                    | —                  |
| `remove`  | DELETE | `/api/workspaces/current` | sesión ≥ owner | 1   | Delete the active workspace and all its content (not allowed for the last one) | INVALID_STATE      |

#### `api.members`

| Ruta           | Método | Path                         | Auth           | F   | Resumen                                                                                             | Errores de dominio                 |
| -------------- | ------ | ---------------------------- | -------------- | --- | --------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `list`         | GET    | `/api/members`               | sesión         | 1   | Members of the active workspace                                                                     | —                                  |
| `updateRole`   | PATCH  | `/api/members/:memberId`     | sesión ≥ admin | 1   | Change a member role. Only owners can grant/revoke owner or admin; the last owner cannot be demoted | INVALID_STATE                      |
| `remove`       | DELETE | `/api/members/:memberId`     | sesión         | 1   | Remove a member (admin+) or leave the workspace (self). The last owner cannot leave                 | INVALID_STATE                      |
| `listInvites`  | GET    | `/api/invites`               | sesión ≥ admin | 1   | Pending invitations                                                                                 | —                                  |
| `createInvite` | POST   | `/api/invites`               | sesión ≥ admin | 1   | Invite a person by e-mail. Returns the accept link (no e-mail is sent) _(201)_                      | PLAN_LIMIT_EXCEEDED, CONFLICT      |
| `revokeInvite` | DELETE | `/api/invites/:inviteId`     | sesión ≥ admin | 1   | Revoke a pending invitation                                                                         | —                                  |
| `lookupInvite` | GET    | `/api/invites/lookup/:token` | pública        | 1   | Public details of an invitation (shown on the accept page)                                          | —                                  |
| `acceptInvite` | POST   | `/api/invites/accept`        | sesión         | 1   | Join the inviting workspace and make it the active one                                              | INVALID_STATE, PLAN_LIMIT_EXCEEDED |

#### `api.apiKeys`

| Ruta     | Método | Path                      | Auth           | F   | Resumen                                                                    | Errores de dominio  |
| -------- | ------ | ------------------------- | -------------- | --- | -------------------------------------------------------------------------- | ------------------- |
| `list`   | GET    | `/api/api-keys`           | sesión ≥ admin | 9   | API keys of the workspace (secrets are never returned)                     | —                   |
| `create` | POST   | `/api/api-keys`           | sesión ≥ admin | 9   | Create an API key. The plain key is returned only in this response _(201)_ | PLAN_LIMIT_EXCEEDED |
| `revoke` | DELETE | `/api/api-keys/:apiKeyId` | sesión ≥ admin | 9   | Revoke an API key                                                          | —                   |

#### `api.webhooks`

| Ruta             | Método | Path                                         | Auth           | F   | Resumen                                                                            | Errores de dominio              |
| ---------------- | ------ | -------------------------------------------- | -------------- | --- | ---------------------------------------------------------------------------------- | ------------------------------- |
| `list`           | GET    | `/api/webhooks`                              | sesión ≥ admin | 9   | Webhook endpoints of the workspace                                                 | —                               |
| `create`         | POST   | `/api/webhooks`                              | sesión ≥ admin | 9   | Register an endpoint. The signing secret is returned only in this response _(201)_ | UNSAFE_URL, PLAN_LIMIT_EXCEEDED |
| `update`         | PATCH  | `/api/webhooks/:webhookId`                   | sesión ≥ admin | 9   | Update URL, events, description or enabled flag                                    | UNSAFE_URL                      |
| `remove`         | DELETE | `/api/webhooks/:webhookId`                   | sesión ≥ admin | 9   | Delete an endpoint and its delivery history                                        | —                               |
| `rotateSecret`   | POST   | `/api/webhooks/:webhookId/rotate-secret`     | sesión ≥ admin | 9   | Generate a new signing secret (returned once)                                      | —                               |
| `test`           | POST   | `/api/webhooks/:webhookId/test`              | sesión ≥ admin | 9   | Queue a signed `ping` event to the endpoint _(202)_                                | —                               |
| `listDeliveries` | GET    | `/api/webhooks/:webhookId/deliveries`        | sesión ≥ admin | 9   | Delivery attempts, newest first                                                    | —                               |
| `retryDelivery`  | POST   | `/api/webhooks/deliveries/:deliveryId/retry` | sesión ≥ admin | 9   | Re-queue a failed delivery _(202)_                                                 | INVALID_STATE                   |

#### `api.billing`

| Ruta         | Método | Path                       | Auth           | F   | Resumen                                                                       | Errores de dominio |
| ------------ | ------ | -------------------------- | -------------- | --- | ----------------------------------------------------------------------------- | ------------------ |
| `overview`   | GET    | `/api/billing`             | sesión         | 10  | Plan, limits, credit balance and usage of the workspace                       | —                  |
| `ledger`     | GET    | `/api/billing/ledger`      | sesión         | 10  | Credit ledger, newest first                                                   | —                  |
| `changePlan` | POST   | `/api/billing/change-plan` | sesión ≥ owner | 10  | Switch plan (simulated checkout). Upgrades grant the new plan monthly credits | INVALID_STATE      |
| `topUp`      | POST   | `/api/billing/top-up`      | sesión ≥ owner | 10  | Buy a credit pack (simulated checkout)                                        | —                  |

#### `api.consents`

| Ruta     | Método | Path                              | Auth            | F   | Resumen                                                                                                                                                             | Errores de dominio |
| -------- | ------ | --------------------------------- | --------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `create` | POST   | `/api/consents`                   | sesión ≥ editor | 14  | Record an explicit consent declaration (stores user, date and IP). Required before creating a photo avatar or cloning a voice; each record can be used once _(201)_ | —                  |
| `list`   | GET    | `/api/consents`                   | sesión ≥ admin  | 14  | Consent records of the workspace, newest first                                                                                                                      | —                  |
| `revoke` | POST   | `/api/consents/:consentId/revoke` | sesión ≥ admin  | 14  | Revoke a consent: the avatar/voice created with it, its files and the source photo/sample are deleted                                                               | —                  |

#### `api.videos`

| Ruta             | Método | Path                                    | Auth            | F   | Resumen                                                                                                                                                                          | Errores de dominio                                                                                                                     |
| ---------------- | ------ | --------------------------------------- | --------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `list`           | GET    | `/api/videos`                           | sesión          | 6   | Videos of the workspace, newest first                                                                                                                                            | —                                                                                                                                      |
| `create`         | POST   | `/api/videos`                           | sesión ≥ editor | 4   | Create a draft video _(201)_                                                                                                                                                     | —                                                                                                                                      |
| `get`            | GET    | `/api/videos/:videoId`                  | sesión          | 6   | Video with composition, status, progress and output URLs (poll while rendering)                                                                                                  | —                                                                                                                                      |
| `update`         | PATCH  | `/api/videos/:videoId`                  | sesión ≥ editor | 4   | Autosave title and/or composition                                                                                                                                                | REVISION_CONFLICT                                                                                                                      |
| `remove`         | DELETE | `/api/videos/:videoId`                  | sesión ≥ editor | 6   | Delete a video, its files and share link                                                                                                                                         | —                                                                                                                                      |
| `duplicate`      | POST   | `/api/videos/:videoId/duplicate`        | sesión ≥ editor | 6   | Copy a video as a new draft _(201)_                                                                                                                                              | —                                                                                                                                      |
| `render`         | POST   | `/api/videos/:videoId/render`           | sesión ≥ editor | 5   | Moderate the script, reserve credits, snapshot the composition and queue a render job (implemented by `startRender` in @parlante/jobs — never re-implement the sequence) _(202)_ | INSUFFICIENT_CREDITS, PLAN_LIMIT_EXCEEDED, CONTENT_BLOCKED, INVALID_STATE, UNPROCESSABLE, PROVIDER_NOT_CONFIGURED, SERVICE_UNAVAILABLE |
| `cancelRender`   | POST   | `/api/videos/:videoId/cancel-render`    | sesión ≥ editor | 5   | Cancel the queued/running render and refund its credits                                                                                                                          | INVALID_STATE                                                                                                                          |
| `renderJobs`     | GET    | `/api/videos/:videoId/render-jobs`      | sesión          | 5   | Render history of a video, newest first                                                                                                                                          | —                                                                                                                                      |
| `saveAsTemplate` | POST   | `/api/videos/:videoId/save-as-template` | sesión ≥ editor | 7   | Save the composition as a custom workspace template _(201)_                                                                                                                      | —                                                                                                                                      |
| `applyBrandKit`  | POST   | `/api/videos/:videoId/apply-brand-kit`  | sesión ≥ editor | 13  | Apply a brand kit to the composition (see `applyBrandKit` in shared)                                                                                                             | —                                                                                                                                      |

#### `api.share`

| Ruta     | Método | Path                         | Auth            | F   | Resumen                                                          | Errores de dominio |
| -------- | ------ | ---------------------------- | --------------- | --- | ---------------------------------------------------------------- | ------------------ |
| `get`    | GET    | `/api/videos/:videoId/share` | sesión          | 6   | Share link of a video, if any                                    | —                  |
| `upsert` | PUT    | `/api/videos/:videoId/share` | sesión ≥ editor | 6   | Create or update the public share link (video must be completed) | INVALID_STATE      |
| `remove` | DELETE | `/api/videos/:videoId/share` | sesión ≥ editor | 6   | Delete the share link (the public page stops working)            | —                  |
| `public` | GET    | `/api/public/shares/:token`  | pública         | 6   | Public data of a shared video (increments the view counter)      | —                  |

#### `api.assets`

| Ruta        | Método | Path                              | Auth            | F   | Resumen                                                                                                                             | Errores de dominio                                             |
| ----------- | ------ | --------------------------------- | --------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `list`      | GET    | `/api/assets`                     | sesión          | 8   | Uploaded assets, newest first. Only `purpose: library` unless another purpose is requested                                          | —                                                              |
| `upload`    | POST   | `/api/assets`                     | sesión ≥ editor | 8   | Upload an image, video or audio file. The real file type is detected from its bytes; size is limited by the plan _(multipart, 201)_ | PAYLOAD_TOO_LARGE, UNSUPPORTED_MEDIA_TYPE, PLAN_LIMIT_EXCEEDED |
| `get`       | GET    | `/api/assets/:assetId`            | sesión          | 8   | One asset                                                                                                                           | —                                                              |
| `update`    | PATCH  | `/api/assets/:assetId`            | sesión ≥ editor | 8   | Rename an asset                                                                                                                     | —                                                              |
| `remove`    | DELETE | `/api/assets/:assetId`            | sesión ≥ editor | 8   | Delete an asset and its file (409 CONFLICT while a translation, avatar or voice clone uses it as its source)                        | CONFLICT                                                       |
| `listStock` | GET    | `/api/stock-assets`               | sesión          | 8   | Built-in backgrounds and music (generated by code, free to use)                                                                     | —                                                              |
| `stockFile` | GET    | `/api/stock-assets/:stockId/file` | pública         | 8   | Bytes of a built-in stock asset (cacheable) _(binario)_                                                                             | —                                                              |

#### `api.avatars`

| Ruta        | Método | Path                                 | Auth    | F   | Resumen                                                                                           | Errores de dominio |
| ----------- | ------ | ------------------------------------ | ------- | --- | ------------------------------------------------------------------------------------------------- | ------------------ |
| `list`      | GET    | `/api/avatars`                       | sesión  | 2   | Instant (2D) and photorealistic stock avatars plus the photo / generated avatars of the workspace | —                  |
| `get`       | GET    | `/api/avatars/:avatarId`             | sesión  | 2   | One avatar                                                                                        | —                  |
| `stockFile` | GET    | `/api/stock-avatars/:avatarId/:file` | pública | 2   | Portrait, matte, cut-out or thumbnail of a photorealistic stock avatar (cacheable) _(binario)_    | —                  |

#### `api.voices`

| Ruta         | Método | Path                   | Auth   | F   | Resumen                                                                       | Errores de dominio              |
| ------------ | ------ | ---------------------- | ------ | --- | ----------------------------------------------------------------------------- | ------------------------------- |
| `list`       | GET    | `/api/voices`          | sesión | 3   | Stock voices of every active TTS provider plus cloned voices of the workspace | —                               |
| `get`        | GET    | `/api/voices/:voiceId` | sesión | 3   | One voice                                                                     | —                               |
| `synthesize` | POST   | `/api/tts/synthesize`  | sesión | 3   | Text → WAV + viseme/word timeline (voice preview and Studio live preview)     | CONTENT_BLOCKED, PROVIDER_ERROR |

#### `api.templates`

| Ruta        | Método | Path                                   | Auth            | F   | Resumen                                                    | Errores de dominio |
| ----------- | ------ | -------------------------------------- | --------------- | --- | ---------------------------------------------------------- | ------------------ |
| `list`      | GET    | `/api/templates`                       | sesión          | 7   | Built-in templates plus custom templates of the workspace  | —                  |
| `get`       | GET    | `/api/templates/:templateId`           | sesión          | 7   | Template with its composition                              | —                  |
| `thumbnail` | GET    | `/api/templates/:templateId/thumbnail` | pública         | 7   | JPEG poster of a built-in template (cacheable) _(binario)_ | —                  |
| `use`       | POST   | `/api/templates/:templateId/use`       | sesión ≥ editor | 7   | Create a draft video from the template _(201)_             | —                  |
| `update`    | PATCH  | `/api/templates/:templateId`           | sesión ≥ editor | 7   | Edit a custom template (built-in templates are read-only)  | FORBIDDEN          |
| `remove`    | DELETE | `/api/templates/:templateId`           | sesión ≥ editor | 7   | Delete a custom template                                   | FORBIDDEN          |

#### `api.brandKits`

| Ruta     | Método | Path                          | Auth            | F   | Resumen                     | Errores de dominio |
| -------- | ------ | ----------------------------- | --------------- | --- | --------------------------- | ------------------ |
| `list`   | GET    | `/api/brand-kits`             | sesión          | 13  | Brand kits of the workspace | —                  |
| `create` | POST   | `/api/brand-kits`             | sesión ≥ editor | 13  | Create a brand kit _(201)_  | —                  |
| `get`    | GET    | `/api/brand-kits/:brandKitId` | sesión          | 13  | One brand kit               | —                  |
| `update` | PATCH  | `/api/brand-kits/:brandKitId` | sesión ≥ editor | 13  | Update a brand kit          | —                  |
| `remove` | DELETE | `/api/brand-kits/:brandKitId` | sesión ≥ editor | 13  | Delete a brand kit          | —                  |

#### `api.scriptWriter`

| Ruta       | Método | Path                          | Auth            | F   | Resumen                                                              | Errores de dominio                                                |
| ---------- | ------ | ----------------------------- | --------------- | --- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `generate` | POST   | `/api/script-writer/generate` | sesión ≥ editor | 11  | Topic or URL + tone + duration + language → script split into scenes | UNSAFE_URL, CONTENT_BLOCKED, INSUFFICIENT_CREDITS, PROVIDER_ERROR |

#### `api.translations`

| Ruta     | Método | Path                               | Auth            | F   | Resumen                                                                                                | Errores de dominio                                                                             |
| -------- | ------ | ---------------------------------- | --------------- | --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `list`   | GET    | `/api/translations`                | sesión          | 12  | Translation jobs, newest first                                                                         | —                                                                                              |
| `create` | POST   | `/api/translations`                | sesión ≥ editor | 12  | Queue a translation: transcript → translation → TTS dub → mix → subtitles, per target language _(202)_ | TRANSCRIPT_REQUIRED, INSUFFICIENT_CREDITS, PLAN_LIMIT_EXCEEDED, CONTENT_BLOCKED, UNPROCESSABLE |
| `get`    | GET    | `/api/translations/:translationId` | sesión          | 12  | Translation job with per-language outputs (poll while processing)                                      | —                                                                                              |
| `remove` | DELETE | `/api/translations/:translationId` | sesión ≥ editor | 12  | Delete a translation job and its outputs (cancels it when still running)                               | —                                                                                              |

#### `api.batches`

| Ruta      | Método | Path                           | Auth            | F   | Resumen                                                                                         | Errores de dominio                                                        |
| --------- | ------ | ------------------------------ | --------------- | --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `preview` | POST   | `/api/batches/preview`         | sesión ≥ editor | 15  | Parse a CSV and check it against the variables of the source video                              | UNPROCESSABLE                                                             |
| `create`  | POST   | `/api/batches`                 | sesión ≥ editor | 15  | Queue one personalised video per row (credits are charged per rendered video, not here) _(202)_ | INSUFFICIENT_CREDITS, PLAN_LIMIT_EXCEEDED, CONTENT_BLOCKED, UNPROCESSABLE |
| `list`    | GET    | `/api/batches`                 | sesión          | 15  | Batch jobs, newest first                                                                        | —                                                                         |
| `get`     | GET    | `/api/batches/:batchId`        | sesión          | 15  | Batch job with its items and their videos (poll while processing)                               | —                                                                         |
| `cancel`  | POST   | `/api/batches/:batchId/cancel` | sesión ≥ editor | 15  | Cancel pending items of a batch (finished videos are kept)                                      | INVALID_STATE                                                             |
| `remove`  | DELETE | `/api/batches/:batchId`        | sesión ≥ editor | 15  | Delete a batch job record (its videos are kept)                                                 | —                                                                         |

#### `api.interactive`

| Ruta            | Método | Path                                            | Auth            | F   | Resumen                                                                     | Errores de dominio                             |
| --------------- | ------ | ----------------------------------------------- | --------------- | --- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| `createSession` | POST   | `/api/interactive/sessions`                     | sesión ≥ editor | 16  | Start a real-time conversation with an avatar _(201)_                       | INSUFFICIENT_CREDITS, CONTENT_BLOCKED          |
| `listSessions`  | GET    | `/api/interactive/sessions`                     | sesión          | 16  | Interactive sessions, newest first                                          | —                                              |
| `getSession`    | GET    | `/api/interactive/sessions/:sessionId`          | sesión          | 16  | Session with its message history                                            | —                                              |
| `sendMessage`   | POST   | `/api/interactive/sessions/:sessionId/messages` | sesión ≥ editor | 16  | Send a user message and receive the spoken reply with its lip-sync timeline | CONTENT_BLOCKED, INVALID_STATE, PROVIDER_ERROR |
| `endSession`    | POST   | `/api/interactive/sessions/:sessionId/end`      | sesión ≥ editor | 16  | End the session                                                             | —                                              |

#### `api.photoAvatars`

| Ruta       | Método | Path                           | Auth            | F   | Resumen                                                                                                                    | Errores de dominio                                                                                                         |
| ---------- | ------ | ------------------------------ | --------------- | --- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `create`   | POST   | `/api/photo-avatars`           | sesión ≥ editor | 14  | Create a photorealistic avatar from a photo of a real person (consent required). Preparation is asynchronous _(202)_       | CONSENT_REQUIRED, INSUFFICIENT_CREDITS, PLAN_LIMIT_EXCEEDED, CONTENT_BLOCKED, PROVIDER_NOT_CONFIGURED, SERVICE_UNAVAILABLE |
| `generate` | POST   | `/api/photo-avatars/generate`  | sesión ≥ editor | 14  | Generate a photorealistic avatar of a synthetic person from a text description with the local engine. Asynchronous _(202)_ | INSUFFICIENT_CREDITS, PLAN_LIMIT_EXCEEDED, CONTENT_BLOCKED, PROVIDER_NOT_CONFIGURED, SERVICE_UNAVAILABLE                   |
| `update`   | PATCH  | `/api/photo-avatars/:avatarId` | sesión ≥ editor | 14  | Rename a workspace avatar or adjust its landmarks (on the prepared portrait)                                               | —                                                                                                                          |
| `remove`   | DELETE | `/api/photo-avatars/:avatarId` | sesión ≥ editor | 14  | Delete a workspace avatar, its images, cached clips and (photo avatars) the source photo                                   | —                                                                                                                          |

#### `api.voiceClones`

| Ruta     | Método | Path                         | Auth            | F   | Resumen                                                                                      | Errores de dominio                                                           |
| -------- | ------ | ---------------------------- | --------------- | --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `create` | POST   | `/api/voice-clones`          | sesión ≥ editor | 14  | Clone a voice from a sample (consent required). Processing is asynchronous _(202)_           | CONSENT_REQUIRED, INSUFFICIENT_CREDITS, PLAN_LIMIT_EXCEEDED, CONTENT_BLOCKED |
| `update` | PATCH  | `/api/voice-clones/:voiceId` | sesión ≥ editor | 14  | Rename a cloned voice                                                                        | —                                                                            |
| `remove` | DELETE | `/api/voice-clones/:voiceId` | sesión ≥ editor | 14  | Delete a cloned voice, its sample and source asset (also removed from the external provider) | —                                                                            |

#### `api.v1`

| Ruta            | Método | Path                  | Auth    | F   | Resumen                                                                        | Errores de dominio                                                                                                                     |
| --------------- | ------ | --------------------- | ------- | --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `me`            | GET    | `/v1/me`              | API key | 9   | Workspace and key the request is authenticated as                              | —                                                                                                                                      |
| `listAvatars`   | GET    | `/v1/avatars`         | API key | 9   | Avatars available to the workspace                                             | —                                                                                                                                      |
| `listVoices`    | GET    | `/v1/voices`          | API key | 9   | Voices available to the workspace                                              | —                                                                                                                                      |
| `listTemplates` | GET    | `/v1/templates`       | API key | 9   | Templates available to the workspace                                           | —                                                                                                                                      |
| `createVideo`   | POST   | `/v1/videos`          | API key | 9   | Create a video and (by default) queue its render _(202)_                       | INSUFFICIENT_CREDITS, PLAN_LIMIT_EXCEEDED, CONTENT_BLOCKED, UNPROCESSABLE, INVALID_STATE, PROVIDER_NOT_CONFIGURED, SERVICE_UNAVAILABLE |
| `listVideos`    | GET    | `/v1/videos`          | API key | 9   | Videos of the workspace, newest first                                          | —                                                                                                                                      |
| `getVideo`      | GET    | `/v1/videos/:videoId` | API key | 9   | Status, progress and output URLs of a video                                    | —                                                                                                                                      |
| `deleteVideo`   | DELETE | `/v1/videos/:videoId` | API key | 9   | Delete a video and its files                                                   | —                                                                                                                                      |
| `uploadAsset`   | POST   | `/v1/assets`          | API key | 9   | Upload an image, video or audio file to use in compositions _(multipart, 201)_ | PAYLOAD_TOO_LARGE, UNSUPPORTED_MEDIA_TYPE, PLAN_LIMIT_EXCEEDED                                                                         |

## 6. Colas

`queues.ts`: `QUEUES[key] = { name, payload, progress, result, attempts, backoffMs, concurrency }`.

| Clave             | Cola BullMQ        | Payload (solo ids)                      | Intentos | Backoff ms | Concurrencia |
| ----------------- | ------------------ | --------------------------------------- | -------- | ---------- | ------------ |
| `render`          | `render`           | `{ renderJobId, videoId, workspaceId }` | 1        | 0          | 1            |
| `translation`     | `translation`      | `{ translationJobId, workspaceId }`     | 1        | 0          | 1            |
| `batch`           | `batch`            | `{ batchJobId, workspaceId }`           | 2        | 5000       | 2            |
| `photoAvatar`     | `photo-avatar`     | `{ avatarId, workspaceId }`             | 2        | 3000       | 2            |
| `voiceClone`      | `voice-clone`      | `{ voiceId, workspaceId }`              | 2        | 3000       | 2            |
| `webhookDelivery` | `webhook-delivery` | `{ deliveryId, workspaceId }`           | 5        | 10000      | 5            |
| `system`          | `system`           | `{ kind: 'ping', echo }`                | 1        | 0          | 2            |

Reglas:

- `jobId` de BullMQ = id de la fila sobre la que trabaja (encolado idempotente).
- El handler carga la fila por los ids del payload **filtrando por `workspaceId`**, es
  idempotente, informa progreso (`job.progress`) y además lo **persiste en la fila**.
- Errores `AppError` con estado < 500 son definitivos (sin reintento); el resto se reintenta
  según la cola. En el fallo definitivo: guardar `{code,message}` en la fila y reembolsar.
- `JobDefinition.onFinalFailure` cubre los jobs que mueren sin ejecutar su `catch` (worker
  caído → _stalled_). Debe ser idempotente.
- La API encola **después** de confirmar su transacción; si falla, compensa
  (`enqueueOrCompensate`).
- Resultado de `render`: salidas completas **o** `{ canceled: true, videoId }` (cancelación
  silenciosa, no es un fallo).
- **Lote**: `POST /api/batches` no cobra (solo comprueba saldo). El job crea un vídeo por fila
  y llama a `startRender({ variables, skipConcurrencyLimit: true })`; cada render se cobra con
  la referencia `renderJob`. `BatchJob.creditsCharged` = suma de sus renders
  (`recomputeBatchStatus`).

## 7. Créditos y planes

`plans.ts` y `packages/db/src/credits.ts`.

| Límite                    | free   | creator | team   |
| ------------------------- | ------ | ------- | ------ |
| Créditos mensuales        | 30     | 300     | 1500   |
| `maxVideoDurationSec`     | 180    | 900     | 1800   |
| `maxScenesPerVideo`       | 10     | 30      | 50     |
| `maxResolution`           | 720p   | 1080p   | 1080p  |
| `maxMembers`              | 2      | 5       | 25     |
| `maxStorageBytes`         | 1 GB   | 20 GB   | 100 GB |
| `maxUploadBytes`          | 100 MB | 500 MB  | 1 GB   |
| `maxPhotoAvatars`         | 1      | 10      | 50     |
| `maxClonedVoices`         | 1      | 5       | 25     |
| `maxBatchRows`            | 5      | 50      | 500    |
| `maxTranslationTargets`   | 1      | 5       | 13     |
| `maxTranslationSourceSec` | 300    | 1800    | 3600   |
| `maxConcurrentRenders`    | 1      | 2       | 4      |
| `maxApiKeys`              | 2      | 10      | 25     |
| `maxWebhookEndpoints`     | 2      | 5       | 10     |
| `watermark`               | sí     | no      | no     |

`maxConcurrentRenders` solo se aplica a renders pedidos uno a uno (Studio y `/v1`); el fan-out
de lote está exento. En la API: `assertWithinLimit(workspace, 'maxScenesPerVideo', n)`.

Costes (`CREDIT_COSTS`): render 1 crédito por cada 30 s iniciados a 720p, ×2 a 1080p, ×2 con
avatares fotorrealistas (`creditsForRender(ms, resolution, { photoreal })`); traducción 2 por
minuto e idioma (`creditsForTranslation`); avatar desde foto 5; avatar generado 8; clonado de
voz 10; guion con LLM externo 1; sesión interactiva con LLM externo 2 (gratis en modo básico).

Libro mayor — nunca se toca `workspaces.credits` directamente:

```
API     chargeCredits(db, { workspaceId, amount, reason, refType, refId })   reserva (402 si no alcanza)
worker  settleCredits(db, { …ref, actualCost, reason? })                     ajusta al coste real (idempotente)
worker  refundCredits(db, { …ref })                                          devuelve lo que quede (idempotente)
        netCharged(db, workspaceId, ref)                                     cargado neto de una referencia
```

Referencias: `renderJob` (motivo `render`), `translationJob`, `avatar` (`photo_avatar` /
`generated_avatar`), `voice` (`voice_clone`). `settleCredits` etiqueta con `render_adjustment`
salvo que se pase `reason` (p. ej. `adjustment` en una traducción parcial).

## 8. Proveedores

`providers.ts` (interfaces) · `packages/providers` (implementaciones) ·
`createProviders(env)` → `Providers`.

| Capacidad     | Interfaz                                                                                              | Local (por defecto)                                                   | Externos               | Selección                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `tts`         | `TTSProvider { listVoices, synthesize }` → WAV PCM16 mono + visemas + palabras                        | `espeak`                                                              | `elevenlabs`, `openai` | Todos los que tengan clave están activos a la vez; `TTS_PROVIDER` elige el predeterminado. `providers.tts.get(id)`. |
| `stt`         | `STTProvider { requiresUserTranscript, transcribe }`                                                  | `manual` (el usuario aporta la transcripción → `TRANSCRIPT_REQUIRED`) | `openai`               | `STT_PROVIDER`                                                                                                      |
| `llm`         | `LLMProvider { generateScript, chat }`                                                                | `local` (heurística, `basicMode: true`)                               | `anthropic`            | `LLM_PROVIDER`                                                                                                      |
| `translation` | `TranslationProvider { translate }`                                                                   | `local`                                                               | `anthropic`            | `TRANSLATION_PROVIDER`                                                                                              |
| `voiceClone`  | `VoiceCloneProvider { createVoice, deleteVoice }`                                                     | `local` (perfil de voz)                                               | `elevenlabs`           | `VOICE_CLONE_PROVIDER`                                                                                              |
| `lipsync`     | `LipSyncProvider { status, animate }`                                                                 | `local-neural` (motor)                                                | `external`             | `LIPSYNC_PROVIDER`                                                                                                  |
| `portrait`    | `PortraitProvider { status, generate, prepare }`                                                      | `local-neural` (motor)                                                | —                      | `PORTRAIT_PROVIDER`                                                                                                 |
| `moderation`  | `ModerationProvider { check }`                                                                        | `local` (lista de bloqueo)                                            | —                      | `MODERATION_PROVIDER`                                                                                               |
| `storage`     | `StorageProvider` (put, get, getStream, stat, delete, deletePrefix, downloadTo, localPath, signedUrl) | `local` (disco)                                                       | `s3`                   | `STORAGE_PROVIDER`                                                                                                  |

Reglas para quien implementa:

- `info` veraz (`quality: 'basic'` para heurísticas locales) y `provider` en cada resultado.
- `AppError('PROVIDER_ERROR')` para fallos del servicio; `PROVIDER_NOT_CONFIGURED` si falta la
  clave. `auto` = externo si hay clave, si no local (`resolveChoice`).
- TTS sin tiempos de fonema: `estimateSpeechTimeline` (§2). Voces que hablan todos los idiomas:
  `ProviderVoice.languages` → una sola voz `multilingual`, nunca duplicada por idioma.
- STT: recibe WAV 16 kHz (`audio` y, si existe, `audioPath`); **el adaptador trocea** cuando su
  servicio limita el tamaño y recompone los tiempos.
- Moderación: `context` = `script | chat | name | translation | avatar_prompt`. El último
  bloquea además descripciones de personas reales identificables.
- `EngineStatus` (lip-sync y retratos): `available`, `reason`, `device`,
  `secondsPerVideoSecond` + opcionales `operations`, `models`, `nonCommercial`,
  `secondsPerPortrait`. `describeCapabilities` los combina (`mergeEngineStatus`).
- **Rutas de archivo en `LipSyncRequest` / `Portrait*Request`**: cualquier ruta legible por el
  proceso Node. El proveedor `local-neural` es quien copia entradas al directorio del motor,
  recoge los resultados en `request.outputDir` y limpia (`createEngineJobDir`). Al abortar
  `signal`, cancela el job del motor.

## 9. Motor neuronal local

`avatar-engine.ts` es el contrato HTTP de `services/avatar-engine` (Python). Sus únicos clientes
son los proveedores `local-neural`. Modelos y licencias: [`MODELS.md`](MODELS.md).

| Endpoint                      | Cuerpo → respuesta                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                 | `EngineHealth { status, version, device, capabilities{generate,prepare,animate}, models[{id, role, downloaded, license, commercialUse}], secondsPerVideoSecond, secondsPerPortrait? }` |
| `POST /v1/portraits/generate` | `{ prompt, seed, width, height, outputDir, clientRef? }` → 202 `EngineJob`                                                                                                             |
| `POST /v1/portraits/prepare`  | `{ imagePath, landmarks?, outputDir, clientRef? }` → 202 `EngineJob`                                                                                                                   |
| `POST /v1/animations`         | `{ portraitPath, maskPath, audioPath, visemes?, fps, maxSize, outputDir, clientRef? }` → 202 `EngineJob`                                                                               |
| `GET /v1/jobs/:jobId`         | `EngineJob { jobId, status, progress 0..1, etaSec, result, error }`                                                                                                                    |
| `DELETE /v1/jobs/:jobId`      | cancela                                                                                                                                                                                |

- **Transporte**: JSON en `AVATAR_ENGINE_URL` (loopback por defecto). Fuera de loopback (docker
  compose) el motor exige `AVATAR_ENGINE_TOKEN` (`Authorization: Bearer`, salvo `/health`);
  `engineRequestHeaders(env)` lo añade.
- **Archivos por ruta** dentro de `AVATAR_ENGINE_WORK_DIR`, montado en la **misma ruta
  absoluta** en ambos procesos. El motor rechaza rutas fuera de él.
- **Geometría (normativo)**: los fotogramas de `animate` tienen el mismo encuadre y relación de
  aspecto que `portraitPath`; el mate tiene el mismo tamaño que el retrato.
- **Reintentos**: `clientRef` permite reengancharse a un job vivo; el proveedor llama a
  `DELETE` cuando se aborta.
- Resultados (`EngineJobResult`, unión por `kind`): `generate { imagePath, model }`,
  `prepare { portraitPath, maskPath, width, height, landmarks, landmarksSource }`,
  `animate { videoPath, alpha: none|mask-video|mask-image, maskPath, width, height, fps, frameCount, model }`.
- Errores: `{ error: { code, message } }` con los códigos compartidos (`UNPROCESSABLE` = sin
  cara utilizable; `SERVICE_UNAVAILABLE` = faltan pesos).
- **Landmarks**: en `prepare` (petición) van sobre la imagen de entrada; en el resultado y en
  `Avatar.rig`, sobre el retrato preparado. Ver `PhotoLandmarksSchema`.

## 10. Claves de storage y cachés

`@parlante/shared/node` → `storageKeys` (nunca se construye una clave a mano):

```
ws/<ws>/assets/<assetId>/original.<ext> | thumb.jpg
ws/<ws>/videos/<videoId>/<renderJobId>/video.mp4 | thumb.jpg | subtitles.srt | subtitles.vtt
ws/<ws>/videos/<videoId>/draft-thumb.jpg                     póster de borrador
ws/<ws>/templates/<templateId>/thumb.jpg                     póster de plantilla propia
ws/<ws>/avatars/<avatarId>/image.png | mask.png | cutout.png | thumb.jpg | source.png
ws/<ws>/avatars/<avatarId>/clips/<sha>/clip.mp4 | mask.mp4 | mask.png | clip.json
ws/<ws>/voices/<voiceId>/sample.wav
ws/<ws>/translations/<jobId>/<idioma>/video.mp4 | subtitles.srt | subtitles.vtt
cache/tts/<sha>.wav | <sha>.json                             TtsCacheMetaSchema
cache/avatar-clips/<sha>/…                                   solo avatares stock real_
```

- Borrar un avatar / voz / vídeo / plantilla borra su prefijo (`storage.deletePrefix`). Los
  clips de un avatar del workspace cuelgan de su prefijo: al borrarlo (o revocar el
  consentimiento) desaparecen también.
- **Caché de TTS**: solo a través de `synthesizeCached` (§11). Clave `ttsCacheKey(...)`; el
  `.json` es `TtsCacheMetaSchema { v: 1, runtime, provider, sampleRate }`.
- **Caché de clips**: `avatarClipCacheKey({ portraitSha, maskSha, audioSha, fps, maxSize, providerId, model })`
  - `AvatarClipCacheMetaSchema` en `clip.json`. El job de render la consulta antes de animar.
- URLs: `createFileUrlBuilder` → URL firmada del proveedor (S3) o
  `/api/files/<key>?exp&sig[&download]` servida por la API. `downloadName` produce
  `Content-Disposition: attachment`.

## 11. Servicios compartidos (packages/jobs)

| Función                                                                                                                                                 | Uso obligatorio                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `startRender(deps, { workspaceId, videoId, resolution, createdBy, variables?, skipConcurrencyLimit? })` → `{ video, renderJob }`                        | `POST /api/videos/:id/render`, `POST /v1/videos`, job de lote. Secuencia completa en ARCHITECTURE §3.1.       |
| `failRenderJob(db, ref, error)` → `boolean`                                                                                                             | Fallo terminal + reembolso, solo si el job sigue `queued`/`running`.                                          |
| `resolveVoice(db, providers, workspaceId, voiceId)` → `{ tts, providerVoiceId, profile, kind, language }`                                               | Toda síntesis: valida proveedor activo, workspace y estado de la voz clonada.                                 |
| `synthesizeCached({ db, providers }, workspaceId, { text, voiceId, language, speed?, pitch? })` → `{ audioKey, runtime, provider, sampleRate, cached }` | `POST /api/tts/synthesize`, render, doblaje de traducción, avatar interactivo. La moderación es del llamador. |
| `createQueueClient` / `InMemoryQueueClient` (tests)                                                                                                     | `enqueue(key, payload, { jobId })`, `getJob`, `remove`, `ping`.                                               |
| `enqueueOrCompensate(queues, key, payload, opts, compensate)`                                                                                           | Encolar tras el _commit_; si falla, compensa y lanza `SERVICE_UNAVAILABLE`.                                   |
| `createFileUrlBuilder`, `videoDownloadName(row)`                                                                                                        | Todas las `*Url` de los DTO.                                                                                  |
| `toPublicVideo(row, fileUrl, opts?)`                                                                                                                    | `PublicVideo` para API v1 y webhooks.                                                                         |
| `dispatchWebhookEvent`, `notifyVideoFinished`, `recomputeBatchStatus`                                                                                   | Efectos de un vídeo terminado.                                                                                |

En el worker (`apps/worker/src/lib`): `render-status.ts` (`loadRenderJob`, `markRenderStarted`,
`reportRenderProgress`, `isRenderCanceled`, `markRenderCompleted`, `markRenderFailed`,
`actualRenderCredits`), `avatar-status.ts` (`reportAvatarProgress`, `markAvatarFailed`),
`progress.ts` (`throttled`, `scale`), `tmp.ts` (`withTempDir`), `ffmpeg.ts`, `errors.ts`
(`finalFailure`). En la API (`apps/api/src/lib`): `define-route.ts`, `auth.ts`, `consent.ts`
(`consumeConsent`), `limits.ts` (`assertWithinLimit`), `uploads.ts` (`receiveUpload`),
`binary.ts` (`sendPublicBinary`), `poster.ts` (`renderPoster`), `dto.ts`.

## 12. Patrón de módulo de API

Referencia viva y completa (CRUD con roles, paginación, referencias a otros recursos):
`apps/api/src/modules/_template/` con su test. Un módulo es **una carpeta** con un `index.ts`
que exporta `defineModule`; se carga solo. Ejemplo copiable (el módulo `share`, compila contra
el contrato real):

```ts
// apps/api/src/modules/share/index.ts
import { AppError, OK, api, newId } from '@parlante/shared';
import { randomToken } from '@parlante/shared/node';
import type { ShareLink } from '@parlante/shared';
import { and, eq, shareLinks, videos } from '@parlante/db';
import type { Db, ShareLinkRow } from '@parlante/db';
import { defineRoute } from '../../lib/define-route';
import { iso, isoOrNull } from '../../lib/dto';
import { defineModule } from '../../lib/modules';

/** Row → DTO in ONE place. Dates as ISO strings; URLs built by the server. */
function toShareDto(row: ShareLinkRow, publicWebUrl: string): ShareLink {
  return {
    id: row.id,
    videoId: row.videoId,
    token: row.token,
    url: `${publicWebUrl.replace(/\/+$/, '')}/s/${row.token}`,
    enabled: row.enabled,
    allowDownload: row.allowDownload,
    viewCount: row.viewCount,
    expiresAt: isoOrNull(row.expiresAt),
    createdAt: iso(row.createdAt),
  };
}

/** Load a video of THIS workspace or 404 (a foreign id looks exactly like a missing one). */
async function findVideo(db: Db, workspaceId: string, videoId: string) {
  const [video] = await db
    .select()
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.workspaceId, workspaceId)));
  if (!video) throw AppError.notFound('Video');
  return video;
}

export default defineModule({
  name: 'share', // = directory name
  register(app) {
    // Validation, auth (session), minimum role, OpenAPI and response serialisation all come
    // from the RouteDef. The handler only does the domain work.
    defineRoute(app, api.share.get, async ({ auth, params, app: { db, config } }) => {
      await findVideo(db, auth.workspaceId, params.videoId);
      const [row] = await db
        .select()
        .from(shareLinks)
        .where(
          and(eq(shareLinks.videoId, params.videoId), eq(shareLinks.workspaceId, auth.workspaceId)),
        );
      return { share: row ? toShareDto(row, config.PUBLIC_WEB_URL) : null };
    });

    defineRoute(app, api.share.upsert, async ({ auth, params, body, app: { db, config } }) => {
      const video = await findVideo(db, auth.workspaceId, params.videoId);
      if (video.status !== 'completed') {
        throw AppError.invalidState('Only completed videos can be shared');
      }
      const values = {
        enabled: body.enabled,
        allowDownload: body.allowDownload,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        updatedAt: new Date(),
      };
      const [row] = await db
        .insert(shareLinks)
        .values({
          id: newId('shareLink'),
          workspaceId: auth.workspaceId,
          videoId: video.id,
          token: randomToken(24),
          createdBy: auth.userId,
          ...values,
        })
        .onConflictDoUpdate({ target: shareLinks.videoId, set: values })
        .returning();
      if (!row) throw new Error('Upsert returned no row');
      return toShareDto(row, config.PUBLIC_WEB_URL);
    });

    defineRoute(app, api.share.remove, async ({ auth, params, app: { db } }) => {
      // The workspace filter is repeated on every write: never update/delete by id alone.
      await db
        .delete(shareLinks)
        .where(
          and(eq(shareLinks.videoId, params.videoId), eq(shareLinks.workspaceId, auth.workspaceId)),
        );
      return OK;
    });
  },
});
```

Lo que el ejemplo hace y todo módulo debe hacer:

1. **Ámbito de workspace** en cada consulta y en cada escritura (`auth.workspaceId`). Un recurso
   de otro workspace responde `404`, nunca `403`.
2. Los **roles** vienen del contrato (`minRole`); el handler no los vuelve a comprobar.
3. Las referencias a otros recursos (un asset, un vídeo) se verifican contra el workspace.
4. Fila → DTO en una sola función; fechas ISO; archivos como URL firmada con `app.fileUrl(key)`.
5. Errores con `AppError`; cambios de varias sentencias en `db.transaction`.
6. Dependencias desde `app`: `db`, `queues`, `providers`, `fileUrl`, `config`.
7. Subidas: `receiveUpload(request, { maxBytes, kinds })` y valida los campos de texto con
   `api.<grupo>.<ruta>.multipart.fields.parse(upload.fields)`.
8. Binarios públicos (stock): `sendPublicBinary(reply, { bytes, mimeType })`.

Test de integración (app real con `app.inject`, BD de test real, cola en memoria):

```ts
// apps/api/src/modules/share/share.test.ts
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { api, createComposition, newId } from '@parlante/shared';
import { videos } from '@parlante/db';
import { createTestApp } from '../../testing/index';
import type { TestApp } from '../../testing/index';
import shareModule from './index';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ modules: [shareModule] }); // real app, test DB, in-memory queue
});
afterAll(() => t.close());
beforeEach(() => t.reset());

// Every module test covers: happy path, validation (400), authentication (401),
// role (403) and workspace isolation (404).
it('shares a completed video and hides it from other workspaces', async () => {
  const alice = await t.signUp(); // user + workspace (owner) + session cookie
  const bob = await t.signUp();
  const viewer = await t.addMember(alice.workspace, 'viewer');
  const videoId = newId('video');
  await t.db.insert(videos).values({
    id: videoId,
    workspaceId: alice.workspace.id,
    title: 'Demo',
    composition: createComposition(),
    aspect: '16:9',
    status: 'completed',
  });
  const params = { videoId };

  const created = await t.call(api.share.upsert, { as: alice, params, body: {} });
  expect(created.status).toBe(200);
  expect(created.body.url).toBe(`${t.config.PUBLIC_WEB_URL}/s/${created.body.token}`);
  expect((await t.call(api.share.get, { as: viewer, params })).body.share?.id).toBe(
    created.body.id,
  );

  expect((await t.call(api.share.get, { params })).status).toBe(401);
  expect((await t.call(api.share.upsert, { as: viewer, params, body: {} })).status).toBe(403);
  expect((await t.call(api.share.get, { as: bob, params })).status).toBe(404);
  expect((await t.call(api.share.get, { as: alice, params: { videoId: 'nope' } })).status).toBe(
    400,
  );
});
```

## 13. Patrón de job del worker

Un job es **una carpeta** `apps/worker/src/jobs/<nombre>/index.ts` que exporta `defineJob`; se
carga solo (un job por cola). Ejemplo mínimo real: `jobs/system`. Ejemplo copiable con todos
los puntos obligatorios (el job de clonado de voz; compila contra el contrato real):

```ts
// apps/worker/src/jobs/voice-clone/index.ts
import fs from 'node:fs/promises';
import { AppError, toStoredError } from '@parlante/shared';
import type { StoredError } from '@parlante/shared';
import { and, assets, eq, refundCredits, voices } from '@parlante/db';
import type { WorkerContext } from '../../context';
import { finalFailure } from '../../lib/errors';
import { runFfmpeg } from '../../lib/ffmpeg';
import { defineJob } from '../../lib/job';
import { withTempDir } from '../../lib/tmp';

interface VoiceRef {
  voiceId: string;
  workspaceId: string;
}

/** Terminal failure, idempotent: only a voice still `processing` is failed and refunded. */
async function markVoiceFailed(ctx: WorkerContext, ref: VoiceRef, error: StoredError) {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(voices)
      .set({ status: 'failed', error, updatedAt: new Date() })
      .where(
        and(
          eq(voices.id, ref.voiceId),
          eq(voices.workspaceId, ref.workspaceId),
          eq(voices.status, 'processing'),
        ),
      )
      .returning({ id: voices.id });
    if (!row) return;
    await refundCredits(tx, {
      workspaceId: ref.workspaceId,
      refType: 'voice',
      refId: ref.voiceId,
      description: 'Voice cloning failed — credits refunded',
    });
  });
}

export default defineJob({
  queue: 'voiceClone', // payload / progress / result schemas come from QUEUES.voiceClone
  async handler(ctx, job) {
    const ref = job.payload; // { voiceId, workspaceId } — already validated
    // 1. Load the row by the ids of the payload, ALWAYS scoped to the workspace.
    const [voice] = await ctx.db
      .select()
      .from(voices)
      .where(and(eq(voices.id, ref.voiceId), eq(voices.workspaceId, ref.workspaceId)));
    if (!voice) throw new AppError('NOT_FOUND', 'Voice not found');
    // 2. Idempotency: the job may run again after a crash.
    if (voice.status === 'ready') {
      return { voiceId: voice.id, provider: voice.provider?.id ?? 'unknown' };
    }
    try {
      const [sample] = voice.sampleAssetId
        ? await ctx.db
            .select()
            .from(assets)
            .where(and(eq(assets.id, voice.sampleAssetId), eq(assets.workspaceId, ref.workspaceId)))
        : [];
      if (!sample) throw new AppError('UNPROCESSABLE', 'The voice sample is missing');
      await job.progress({ percent: 10 });

      // 3. Files: private temp dir (always removed), ffmpeg with an ARGUMENT ARRAY.
      const result = await withTempDir(ctx, 'voice-clone', async (tmp) => {
        await ctx.providers.storage.downloadTo(sample.storageKey, tmp.file('sample.bin'));
        await runFfmpeg(
          [
            '-y',
            '-i',
            tmp.file('sample.bin'),
            '-ac',
            '1',
            '-ar',
            '22050',
            '-c:a',
            'pcm_s16le',
            tmp.file('sample.wav'),
          ],
          { signal: job.signal, timeoutMs: 120_000 },
        );
        await job.progress({ percent: 40 });
        // 4. AI work goes through a provider interface, never a concrete service.
        return ctx.providers.voiceClone.createVoice({
          name: voice.name,
          sample: await fs.readFile(tmp.file('sample.wav')),
          sampleRate: 22050,
          language: voice.language,
          gender: voice.gender,
          consentId: voice.consentId,
        });
      });

      // 5. Persist the result on the row (clients poll the REST resource, not the queue).
      await ctx.db
        .update(voices)
        .set({
          status: 'ready',
          ttsProviderId: result.ttsProviderId,
          providerVoiceId: result.providerVoiceId,
          profile: result.profile,
          provider: result.provider, // honesty rule: who produced it
          error: null,
          updatedAt: new Date(),
        })
        .where(and(eq(voices.id, ref.voiceId), eq(voices.workspaceId, ref.workspaceId)));
      await job.progress({ percent: 100 });
      return { voiceId: voice.id, provider: result.provider.id };
    } catch (err) {
      // 6. Final failure (domain error or last attempt): store the error, refund, rethrow.
      //    Otherwise just rethrow and BullMQ retries with the queue's backoff.
      if (finalFailure(err, job)) await markVoiceFailed(ctx, ref, toStoredError(err));
      throw err;
    }
  },
  // 7. Safety net for a worker that died mid-job (the handler never reached its catch).
  onFinalFailure: (ctx, payload, error) => markVoiceFailed(ctx, payload, error),
});
```

`job.progress(...)` hacia BullMQ está limitado a ~4 llamadas por segundo (las intermedias, y a
veces la última, se descartan): lo que ve el usuario es lo que persistes en la fila.

Test (sin Redis: contexto real sobre la BD de test, cola en memoria, storage temporal):

```ts
import { createTestWorker } from '../../testing/index';
import job from './index';

const t = await createTestWorker(); // en beforeAll; t.reset() en beforeEach; t.close() en afterAll
const { result, progress } = await t.run(job, { voiceId, workspaceId });
await t.run(job, payload, { attemptsMade: 1 }); // simular el último intento
```

Para el render usa los ayudantes de `lib/render-status.ts` (no escribas `videos.status` a mano)
y devuelve `{ canceled: true, videoId }` si `isRenderCanceled` o `markRenderStarted` da `false`.

## 14. Cómo extender un contrato

Todo cambio en `packages/shared` debe ser **aditivo y compatible** (regla 2 del prompt
maestro). Si no puede serlo, no se hace: se reporta.

| Quiero…                                 | Cómo, de forma aditiva                                                                                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Un campo nuevo en un DTO de respuesta   | `campo: Tipo.default(valor)` o `.nullable().default(null)`: los productores existentes siguen compilando y los consumidores siempre lo reciben. Rellénalo en el mapeador.                                                     |
| Un campo nuevo en un cuerpo de petición | `.optional()` o `.default(...)`. Nunca hagas obligatorio un campo existente ni cambies su significado.                                                                                                                        |
| Un endpoint                             | Un `RouteDef` nuevo en el grupo de su módulo (`api/*.ts`), su handler con `defineRoute` y su fila en §5. No reutilices un _path_ con otra semántica.                                                                          |
| Un código de error                      | Añádelo a `ERROR_CODES` (nunca renombrar ni reutilizar) y decláralo en `errors` de la ruta.                                                                                                                                   |
| Un valor de enumeración                 | Añádelo al final. Revisa los `switch` exhaustivos (TypeScript los señala).                                                                                                                                                    |
| Una columna                             | `packages/db/src/schema.ts` (nullable o con `default`) → `pnpm db:generate --name <motivo>` → `pnpm db:migrate`. Nunca edites una migración ya publicada.                                                                     |
| Un tipo de capa / fondo / transición    | Nuevo miembro de la unión discriminada con _defaults_; el renderer debe ignorar con elegancia lo que no conoce. Si cambia el significado de documentos guardados: sube `COMPOSITION_VERSION` y añade un paso en `migrate.ts`. |
| Una cola                                | Entrada en `QUEUE_NAMES` + `QUEUES` (payload solo con ids), carpeta en `apps/worker/src/jobs`, variable `WORKER_CONCURRENCY_<CLAVE>`.                                                                                         |
| Un proveedor                            | Implementación nueva en `packages/providers/src/<capacidad>/` elegida en su `index.ts`; variables en `env.ts` y `.env.example`. La interfaz no cambia.                                                                        |
| Un método en una interfaz de proveedor  | Opcional (`metodo?()`) o con campos de petición opcionales, para no romper las implementaciones existentes.                                                                                                                   |
| Un fonema / visema                      | Entradas nuevas en `PHONEME_TO_VISEME`. El conjunto de 15 visemas está congelado (los rigs dependen de él).                                                                                                                   |
| Una clave de storage                    | Constructor nuevo en `storageKeys` (segmentos validados por `seg()`), y su línea en §10.                                                                                                                                      |
| Algo en el contrato del motor           | Campos opcionales en `avatar-engine.ts`; el motor debe seguir funcionando si los ignora.                                                                                                                                      |

Antes de dar por bueno un cambio de contrato: `pnpm -r typecheck`, `pnpm lint`, `pnpm -r test`,
y un test que ejercite el campo o la función nuevos.
