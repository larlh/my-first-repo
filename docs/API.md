# API pública de Parlante (`/v1`)

Guía práctica para crear vídeos desde tu propio código. La referencia completa y siempre al día
la sirve la propia API: Swagger UI en `/v1/docs` y el documento OpenAPI en `/v1/openapi.json`
(por ejemplo <http://localhost:4000/v1/docs>).

> Todos los ejemplos de esta guía se ejecutaron contra una instalación local sin claves
> externas (proveedores locales) el 24-11-2026; las respuestas son reales, recortadas donde se
> indica con `…`. Sustituye `http://localhost:4000` por tu `PUBLIC_API_URL`.

- [Autenticación](#autenticación) · [Errores](#errores) · [Límites](#límites-de-peticiones)
- [Catálogos: avatares, voces y plantillas](#catálogos-avatares-voces-y-plantillas)
- [Crear un vídeo](#crear-un-vídeo) · [Consultar, listar y borrar](#consultar-listar-y-borrar)
- [Subir archivos](#subir-archivos) · [Webhooks](#webhooks)
- [Lo que la API pública no hace](#lo-que-la-api-pública-no-hace)

## Autenticación

Cada petición lleva una clave de API en la cabecera `Authorization: Bearer plk_…`. La clave
pertenece a un workspace y actúa con rol de editor: solo ve y modifica recursos de ese
workspace (un recurso de otro responde `404 NOT_FOUND`).

Crea la clave en la aplicación, **Ajustes → Claves de API** (rol admin o superior). La clave
completa se muestra una sola vez; Parlante solo guarda su hash. Revocarla la invalida en la
petición siguiente.

```bash
export PARLANTE_API=http://localhost:4000
export PARLANTE_KEY=plk_46thteya_…        # la tuya

curl -s $PARLANTE_API/v1/me -H "Authorization: Bearer $PARLANTE_KEY"
```

```json
{
  "workspace": {
    "id": "ws_djznhshxbro0ohz6",
    "name": "Espacio de Release",
    "plan": "free",
    "credits": 30
  },
  "apiKey": { "id": "key_8hplox8cqw3glmzb", "name": "docs", "prefix": "plk_46thteya" }
}
```

Sin clave, o con una clave revocada o mal formada:

```
HTTP/1.1 401 Unauthorized
{"error":{"code":"INVALID_API_KEY","message":"Missing or invalid API key (use \"Authorization: Bearer <key>\")"}}
```

## Errores

Todos los errores tienen la misma forma. Programa contra `code`, no contra el mensaje (los
mensajes están en inglés y pueden cambiar).

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request is not valid",
    "details": {
      "issues": [
        {
          "path": "body.input.text",
          "message": "Too small: expected string to have >=1 characters"
        }
      ]
    }
  }
}
```

| HTTP | `code`                                           | Cuándo                                                                                         |
| ---- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`, `BAD_REQUEST`                | El cuerpo o los parámetros no cumplen el esquema (`details.issues` dice dónde)                 |
| 401  | `INVALID_API_KEY`                                | Falta la clave, no existe o está revocada                                                      |
| 402  | `INSUFFICIENT_CREDITS`                           | El workspace no tiene saldo para el render (`details.required`, `details.available`)           |
| 403  | `PLAN_LIMIT_EXCEEDED`                            | Supera un límite del plan: escenas, duración, resolución, renders simultáneos, almacenamiento  |
| 404  | `NOT_FOUND`                                      | El recurso no existe **o es de otro workspace**                                                |
| 409  | `INVALID_STATE`                                  | El vídeo ya tiene un render en curso                                                           |
| 413  | `PAYLOAD_TOO_LARGE`                              | Archivo mayor que el máximo del plan                                                           |
| 415  | `UNSUPPORTED_MEDIA_TYPE`                         | El contenido real del archivo no es imagen, vídeo ni audio admitido (`details.allowed`)        |
| 422  | `CONTENT_BLOCKED`                                | La moderación ha bloqueado un texto del vídeo                                                  |
| 422  | `UNPROCESSABLE`                                  | Referencias que no resuelven: avatar, voz o archivo inexistentes, variables que no coinciden   |
| 429  | `RATE_LIMITED`                                   | Demasiadas peticiones; respeta `Retry-After`                                                   |
| 503  | `SERVICE_UNAVAILABLE`, `PROVIDER_NOT_CONFIGURED` | El vídeo usa un avatar fotorrealista y el motor neuronal no está disponible (`details.reason`) |

Una petición rechazada no cobra créditos ni deja un vídeo a medias en cola.

## Límites de peticiones

Cada clave tiene un límite por minuto según el plan del workspace: 60 (Free), 120 (Creator) o
300 (Team). Las respuestas lo indican:

```
ratelimit-limit: 60
ratelimit-remaining: 59
ratelimit-reset: 60
```

Hay además un límite global por dirección IP (`x-ratelimit-*`, 600 por minuto por defecto). Al
superar cualquiera, `429 RATE_LIMITED` con `Retry-After`.

## Catálogos: avatares, voces y plantillas

```bash
curl -s $PARLANTE_API/v1/avatars -H "Authorization: Bearer $PARLANTE_KEY"
```

Devuelve `{ "items": [...] }` con 21 avatares en una instalación nueva: 10 de estilo 2D
(`stock_lucia`, `stock_mateo`, `stock_amara`, `stock_kenji`, `stock_elena`, `stock_omar`,
`stock_sofia`, `stock_david`, `stock_noa`, `stock_priya`), 11 fotorrealistas de stock
(`real_lucia`, `real_samuel`, `real_anaya`, `real_hiro`, `real_carmen`, `real_amara`,
`real_erik`, `real_mei`, `real_diego`, `real_ines`, `real_tomas`) y los del workspace
(`avt_…`). Lo que importa de cada uno:

```json
{
  "id": "stock_lucia",
  "kind": "stock",
  "rendering": "instant",
  "name": "Lucía",
  "gender": "female",
  "status": "ready",
  "provider": {
    "id": "canvas2d",
    "name": "Parlante 2D (Canvas)",
    "quality": "basic",
    "local": true
  },
  "…": "…"
}
```

`rendering: "instant"` se renderiza en segundos; `rendering: "photoreal"` necesita el motor
neuronal, tarda minutos y cuesta el doble (ver el README). Solo se pueden usar avatares con
`status: "ready"`.

```bash
curl -s "$PARLANTE_API/v1/voices?language=es" -H "Authorization: Bearer $PARLANTE_KEY"
```

Seis voces en español sin claves externas (`espeak:es-f1`, `espeak:es-m1`, `espeak:es-f2`,
`espeak:es-m2`, `espeak:es-mx-f1`, `espeak:es-mx-m1`); con claves de ElevenLabs u OpenAI
aparecen además las suyas. Cada voz dice quién la produce:

```json
{
  "id": "espeak:es-f1",
  "kind": "stock",
  "name": "Carmen",
  "language": "es",
  "gender": "female",
  "provider": { "id": "espeak", "name": "eSpeak NG (local)", "quality": "basic", "local": true },
  "status": "ready",
  "…": "…"
}
```

```bash
curl -s $PARLANTE_API/v1/templates -H "Authorization: Bearer $PARLANTE_KEY" -H "Accept-Language: en"
```

Ocho plantillas integradas (`builtin_explainer`, `builtin_vertical-ad`, `builtin_training`,
`builtin_news`, `builtin_product`, `builtin_greeting`, `builtin_quick-tip`,
`builtin_team-welcome`) más las que el workspace haya guardado (`tpl_…`). Los textos del
catálogo salen en español salvo que envíes `Accept-Language: en`.

## Crear un vídeo

`POST /v1/videos` crea el vídeo y, por defecto, encola su render. Responde `202` con el vídeo
en estado `queued`. Hay tres formas de describirlo (`input.type`).

### 1. Desde un guion (`script`)

Una escena con un avatar que dice el texto: lo más sencillo.

```bash
curl -s -X POST $PARLANTE_API/v1/videos \
  -H "Authorization: Bearer $PARLANTE_KEY" -H "Content-Type: application/json" \
  -d '{
    "title": "Hola desde la API",
    "input": {
      "type": "script",
      "text": "Hola. Este vídeo se ha creado con la API pública de Parlante.",
      "avatarId": "stock_lucia",
      "voiceId": "espeak:es-f1",
      "language": "es"
    },
    "resolution": "720p"
  }'
```

```json
{
  "id": "vid_g6l0v67r9jtyqx4s",
  "title": "Hola desde la API",
  "status": "queued",
  "progress": 0,
  "aspect": "16:9",
  "resolution": null,
  "durationMs": null,
  "videoUrl": null,
  "downloadUrl": null,
  "thumbnailUrl": "http://localhost:4000/api/files/ws/…/draft-thumb.jpg?exp=…&sig=…",
  "srtUrl": null,
  "vttUrl": null,
  "providers": null,
  "aiGenerated": false,
  "error": null,
  "createdAt": "2026-11-24T13:00:20.165Z",
  "updatedAt": "2026-11-24T13:00:20.201Z",
  "renderedAt": null
}
```

Campos opcionales de `input`: `aspect` (`16:9` por defecto, `9:16`, `1:1`), `backgroundColor`
(`#101322`), `subtitles` (`true`). Campos opcionales del cuerpo: `title`, `resolution` (`720p`
por defecto; `1080p` según el plan, cuesta el doble) y `render` (`false` crea solo el borrador,
que se puede editar y renderizar desde la aplicación).

### 2. Desde una plantilla (`template`)

```bash
curl -s -X POST $PARLANTE_API/v1/videos \
  -H "Authorization: Bearer $PARLANTE_KEY" -H "Content-Type: application/json" \
  -d '{
    "title": "Saludo para Zoraida",
    "input": {
      "type": "template",
      "templateId": "builtin_greeting",
      "variables": { "nombre": "Zoraida", "remitente": "el equipo de Parlante" }
    }
  }'
```

Las variables que no envíes usan su valor por defecto. El vídeo de este ejemplo (formato 1:1,
16,6 s) terminó en 6 s y sus subtítulos empiezan con «¡Hola, Zoraida!».

`/v1/templates` no enumera las variables de cada plantilla. Se ven en la aplicación al abrir la
plantilla y, desde la API, en el propio error cuando envías un nombre que no existe:

```json
{
  "error": {
    "code": "UNPROCESSABLE",
    "message": "The variables sent do not match the {{placeholders}} of the video",
    "details": {
      "missing": [],
      "unknown": ["nombre_inexistente"],
      "expected": ["nombre", "ocasion", "mensaje", "remitente"]
    }
  }
}
```

### 3. Desde un documento completo (`composition`)

El formato de documento de Parlante (escenas, capas, fondos, subtítulos, música, variables).
El esquema completo está en `/v1/openapi.json` y explicado en
[`CONTRACTS.md` §1](CONTRACTS.md#1-composition). Ejemplo mínimo, vertical, con una variable:

```bash
curl -s -X POST $PARLANTE_API/v1/videos \
  -H "Authorization: Bearer $PARLANTE_KEY" -H "Content-Type: application/json" \
  -d '{
    "title": "Composition por API",
    "input": {
      "type": "composition",
      "composition": {
        "version": 1,
        "canvas": { "aspect": "9:16", "width": 1080, "height": 1920, "fps": 30 },
        "scenes": [
          {
            "id": "s1",
            "name": "Uno",
            "script": { "kind": "tts", "text": "Hola {{nombre}}, esto es una composición completa.",
                        "voiceId": "espeak:es-f1", "language": "es" },
            "background": { "type": "color", "color": "#0f766e" },
            "layers": [
              { "id": "l1", "type": "avatar", "avatarId": "stock_elena",
                "box": { "x": 0.1, "y": 0.25, "w": 0.8, "h": 0.75 } }
            ]
          }
        ],
        "variables": [ { "name": "nombre", "label": "Nombre", "defaultValue": "mundo" } ]
      },
      "variables": { "nombre": "Zoraida" }
    }
  }'
```

Resultado real: MP4 de 720×1280 y 3,8 s cuyo primer subtítulo es «Hola Zoraida, esto es una…».
Las posiciones (`box`) van normalizadas de 0 a 1 respecto al lienzo. Las imágenes, vídeos y
audios se referencian por id (`{ "source": "asset", "assetId": "ast_…" }` o
`{ "source": "stock", "stockId": "…" }`), nunca por URL.

### Qué pasa al crear

Se aplican las mismas reglas que en el Studio: se validan avatares, voces y archivos; se
comprueban los límites del plan; **se moderan todos los textos** (guion, capas de texto y
valores de las variables); se reservan los créditos (1 por cada 30 s empezados a 720p, ×2 a
1080p, ×2 con avatares fotorrealistas) y al terminar se ajustan a la duración real. Si el
render falla, se devuelven.

## Consultar, listar y borrar

Sondea el vídeo hasta que `status` sea `completed` o `failed` (o usa [webhooks](#webhooks)).
Estados: `draft` → `queued` → `rendering` → `completed` | `failed`. `progress` va de 0 a 100.

```bash
curl -s $PARLANTE_API/v1/videos/vid_g6l0v67r9jtyqx4s -H "Authorization: Bearer $PARLANTE_KEY"
```

```json
{
  "id": "vid_g6l0v67r9jtyqx4s",
  "title": "Hola desde la API",
  "status": "completed",
  "progress": 100,
  "aspect": "16:9",
  "resolution": "720p",
  "durationMs": 4522,
  "videoUrl": "http://localhost:4000/api/files/ws/…/video.mp4?exp=1795550400&sig=…",
  "downloadUrl": "http://localhost:4000/api/files/ws/…/video.mp4?exp=1795550400&sig=…&download=Hola%20desde%20la%20API.mp4",
  "thumbnailUrl": "http://localhost:4000/api/files/ws/…/thumb.jpg?exp=…&sig=…",
  "srtUrl": "http://localhost:4000/api/files/ws/…/subtitles.srt?exp=…&sig=…",
  "vttUrl": "http://localhost:4000/api/files/ws/…/subtitles.vtt?exp=…&sig=…",
  "providers": {
    "tts": { "id": "espeak", "name": "eSpeak NG (local)", "quality": "basic", "local": true }
  },
  "aiGenerated": false,
  "error": null,
  "createdAt": "2026-11-24T13:00:20.165Z",
  "updatedAt": "2026-11-24T13:00:23.048Z",
  "renderedAt": "2026-11-24T13:00:23.048Z"
}
```

Ese vídeo (4,5 s, avatar 2D) pasó de `queued` a `completed` en 4 s. El archivo es un MP4
H.264 + AAC (1280×720, 30 fps, estéreo a 48 kHz).

- **Las URLs de archivo están firmadas y caducan** (unas horas; 7 días las que viajan dentro
  de un webhook). Descarga el archivo o vuelve a pedir el vídeo; no guardes la URL.
- `downloadUrl` sirve el MP4 como adjunto con el título como nombre de archivo.
- `providers` dice qué proveedor generó la voz y, si lo hay, el avatar fotorrealista. La voz
  del ejemplo es la de reserva (`espeak:…`); con una voz neuronal local (`kokoro:…`,
  `piper:…`), `providers.tts.id` es `kokoro` o `piper`, con `quality: "premium"` y
  `local: true`. En un vídeo con avatar fotorrealista, `providers.lipsync.mode` dice además
  cómo se movieron los labios: `audio`, `visemes` o `mixed`.
- `aiGenerated` es `true` cuando el vídeo contiene un avatar fotorrealista animado por IA; el
  MP4 lleva entonces esa marca en sus metadatos.
- Si falla, `status` es `failed` y `error` trae `{ code, message, reason? }`.

```bash
curl -s "$PARLANTE_API/v1/videos?status=completed&limit=2" -H "Authorization: Bearer $PARLANTE_KEY"
# → { "items": [ { "id": "vid_io9e88hk5cp6qodq", … }, { "id": "vid_g6l0v67r9jtyqx4s", … } ], "nextCursor": null }
```

Paginación por cursor: `limit` (1–100, por defecto 20) y `cursor` (el `nextCursor` de la página
anterior; `null` = no hay más).

```bash
curl -s -X DELETE $PARLANTE_API/v1/videos/vid_t6lsv6not0gab7p9 -H "Authorization: Bearer $PARLANTE_KEY"
# → {"ok":true}        después, GET del mismo id → 404 {"error":{"code":"NOT_FOUND","message":"Video not found"}}
```

Borrar un vídeo borra también sus archivos.

## Subir archivos

`POST /v1/assets` (multipart, un campo `file` y un `name` opcional) sube una imagen, un vídeo o
un audio para usarlo en una composición.

```bash
curl -s -X POST $PARLANTE_API/v1/assets -H "Authorization: Bearer $PARLANTE_KEY" \
  -F "file=@logo.png" -F "name=Fondo azul"
```

```json
{
  "id": "ast_uvgusjqr1pdkg0yh",
  "kind": "image",
  "purpose": "library",
  "name": "Fondo azul",
  "mimeType": "image/png",
  "sizeBytes": 1505,
  "width": 640,
  "height": 360,
  "durationMs": null,
  "url": "http://localhost:4000/api/files/ws/…/original.png?exp=…&sig=…",
  "thumbnailUrl": "…",
  "…": "…"
}
```

El tipo se decide por el contenido real del archivo, no por su extensión ni por la cabecera
`Content-Type`. Un `.txt` responde:

```json
{
  "error": {
    "code": "UNSUPPORTED_MEDIA_TYPE",
    "message": "This file type is not supported",
    "details": {
      "detected": null,
      "allowed": [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "video/mp4",
        "video/webm",
        "video/quicktime",
        "audio/mpeg",
        "audio/wav",
        "…"
      ]
    }
  }
}
```

## Webhooks

En lugar de sondear, registra una URL en **Ajustes → Webhooks** (rol admin). Parlante le envía
un `POST` cuando un vídeo del workspace termina (`video.completed`) o falla (`video.failed`),
lo haya lanzado la API, el Studio o un lote. El secreto de firma (`whsec_…`) se muestra una
sola vez, al crear el endpoint o al rotarlo. El botón «Enviar prueba» manda un evento `ping`.

La URL debe ser pública: las direcciones privadas o de loopback se rechazan al registrarla
(`422 UNSAFE_URL`) y otra vez al entregar, y no se siguen redirecciones. (Para probar contra
`localhost` en desarrollo existe `ALLOW_PRIVATE_URLS=true`, que la API y el worker rechazan en
producción.)

### Qué recibe tu servidor

```
POST /parlante HTTP/1.1
Content-Type: application/json
Parlante-Event: video.completed
Parlante-Delivery: whd_xwhrijlkf51d03zj
Parlante-Signature: t=1795525305,v1=d6713a5ea090…
```

```json
{
  "id": "evt_520qd2jrbsys35n0",
  "type": "video.completed",
  "createdAt": "2026-11-24T13:01:45.394Z",
  "workspaceId": "ws_djznhshxbro0ohz6",
  "data": {
    "video": {
      "id": "vid_3dbagdk99w3g6dvp",
      "title": "Aviso por webhook",
      "status": "completed",
      "progress": 100,
      "aspect": "16:9",
      "videoUrl": "http://localhost:4000/api/files/ws/…/video.mp4?exp=1796133600&sig=…",
      "srtUrl": "…",
      "vttUrl": "…",
      "providers": { "tts": { "id": "espeak", "…": "…" } },
      "error": null,
      "…": "…"
    }
  }
}
```

`data.video` tiene la misma forma que `GET /v1/videos/:id`. En `ping`, `data` es `{}`. No
dependas del orden de las claves del JSON.

Responde con cualquier `2xx` en menos de 10 s para dar la entrega por recibida. Si no, Parlante
reintenta hasta 5 intentos en total, con espera creciente (10 s, 20 s, 40 s, 80 s). `410 Gone`
se considera definitivo y no se reintenta. Cada entrega, con su código de respuesta, queda en
el historial del endpoint, desde donde se puede reenviar. Una entrega puede repetirse: usa
`Parlante-Delivery` (o el `id` del evento) para no procesarla dos veces.

### Verificar la firma

`Parlante-Signature` tiene la forma `t=<segundos Unix>,v1=<hex>`, donde

```
v1 = HMAC-SHA256( clave = tu secreto whsec_…,  mensaje = "<t>" + "." + <cuerpo exacto recibido> )
```

1. Lee el cuerpo **como bytes, antes de interpretarlo como JSON** (volver a serializarlo cambia
   la firma).
2. Calcula el HMAC y compáralo con `v1` en tiempo constante.
3. Rechaza la petición si `t` se aleja más de 5 minutos de tu reloj (evita repeticiones).

Receptor completo en Node, sin dependencias. Es el código con el que se verificaron en esta
instalación un `ping` y un `video.completed` reales (firma aceptada; rechazada al alterar un
solo carácter del cuerpo):

```js
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.PARLANTE_WEBHOOK_SECRET; // whsec_…
const TOLERANCE_SEC = 300;

function verify(rawBody, header) {
  const parts = Object.fromEntries(
    String(header ?? '')
      .split(',')
      .map((part) => part.trim().split('=')),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > TOLERANCE_SEC) return false;
  const expected = createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8'); // the exact bytes received
    if (!verify(rawBody, req.headers['parlante-signature'])) {
      res.writeHead(400).end();
      return;
    }
    const event = JSON.parse(rawBody);
    if (event.type === 'video.completed') {
      console.log('listo:', event.data.video.id, event.data.video.videoUrl);
    }
    res.writeHead(204).end();
  });
}).listen(8787);
```

Si usas un framework, asegúrate de acceder al cuerpo sin procesar (en Express,
`express.raw({ type: 'application/json' })` en esa ruta).

## Lo que la API pública no hace

- No crea avatares desde foto, no genera retratos ni clona voces: esas operaciones exigen un
  registro de consentimiento hecho por una persona en la aplicación. Los avatares y voces ya
  creados sí se pueden **usar** desde `/v1` por su id.
- No gestiona claves, webhooks, miembros, plantillas, lotes, traducciones ni el kit de marca:
  eso se hace en la aplicación (su API interna `/api/*` va con cookie de sesión y no es un
  contrato público estable).
- No hay claves de idempotencia: si repites un `POST /v1/videos` por un fallo de red, puedes
  crear dos vídeos. Comprueba con `GET /v1/videos` antes de reintentar.
- No hay notificación de progreso por webhook: solo `video.completed` y `video.failed`.
