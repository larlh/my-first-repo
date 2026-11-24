# Parlante

Plataforma web de vídeo con avatares IA: escribes un guion, eliges un avatar y una voz, compones
las escenas en un editor y obtienes un MP4 con el avatar hablando, con los labios sincronizados
y subtítulos. Incluye traducción de vídeo, plantillas, kit de marca, vídeo personalizado en
lote, avatar interactivo en el navegador, API pública con webhooks y avatares fotorrealistas
generados y animados en tu propia máquina.

**Funciona sin ninguna clave de API ni servicio de pago.** Cada capacidad de IA tiene una
implementación local; con claves, los mismos flujos usan proveedores externos de más calidad.
La interfaz y la API dicen siempre qué proveedor produjo cada resultado.

Es un producto original (nombre, diseño, avatares y API propios). Interfaz en español e inglés.

- [Requisitos](#requisitos)
- [Puesta en marcha en 5 minutos](#puesta-en-marcha-en-5-minutos)
- [Proveedores: local sin clave y externo con clave](#proveedores-local-sin-clave-y-externo-con-clave)
- [Avatares fotorrealistas: el motor neuronal local](#avatares-fotorrealistas-el-motor-neuronal-local)
- [Comandos](#comandos)
- [Con Docker](#con-docker)
- [Estructura del monorepo](#estructura-del-monorepo)
- [Límites conocidos](#límites-conocidos)
- [Documentación](#documentación) · [Licencias de terceros](#licencias-de-terceros)

## Requisitos

| Qué               | Versión                           | Para qué                                                                        |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| Node.js           | 22 o superior                     | API, worker y web                                                               |
| pnpm              | 10 (el repo fija `pnpm@10.28.0`)  | Monorepo                                                                        |
| PostgreSQL        | 16                                | Fuente de verdad del estado                                                     |
| Redis             | 7                                 | Colas (BullMQ)                                                                  |
| ffmpeg y ffprobe  | 5 o superior, en el `PATH`        | Codificar el MP4, leer los archivos subidos                                     |
| Python (opcional) | 3.11 – 3.13, Linux x86-64         | Solo para el motor de avatares fotorrealistas                                   |
| Navegador         | Reciente, con Canvas2D y WebAudio | Todas las pruebas se han hecho con Chromium; Firefox y Safari no se han probado |

La voz local (eSpeak NG) va empaquetada como WebAssembly dentro de las dependencias de npm: no
hay que instalar nada en el sistema. Desarrollado y probado en Linux (Ubuntu 24.04, PostgreSQL
16.15, Redis 7.0, ffmpeg 6.1, Node 22.23).

## Puesta en marcha en 5 minutos

```bash
pnpm install          # dependencias del monorepo
pnpm services         # arranca PostgreSQL y Redis locales y crea el rol y las bases de datos
pnpm db:migrate       # aplica las migraciones
pnpm db:seed          # opcional: usuario de demostración
pnpm dev              # API en :4000, worker y web en :5173
```

Abre <http://localhost:5173>, regístrate (o entra con `demo@parlante.local` /
`parlante-demo` si ejecutaste la semilla), pulsa **Crear vídeo**, elige «Desde cero» y, ya en
el Studio, **Renderizar**. A los pocos segundos tienes un MP4 con avatar, voz y subtítulos.

No hace falta ningún archivo `.env`: todas las variables tienen un valor por defecto que
funciona en local. Para cambiar algo, copia `.env.example` a `.env` en la raíz (lo leen la API,
el worker, la web en desarrollo y el motor).

- `pnpm services` no usa Docker: arranca los servicios instalados en la máquina (`service`,
  `pg_ctlcluster`, Homebrew…) y es idempotente. Si prefieres Docker para la infraestructura:
  `docker compose up -d postgres redis` (Compose exige que `APP_SECRET` esté definido en `.env`
  también para esto; ver [Con Docker](#con-docker)).
- Si el puerto 4000 o el 5173 están ocupados: `API_PORT=4001`, `WEB_PORT=5174` y
  `VITE_API_PROXY_TARGET=http://localhost:4001` en `.env`; ajusta también `PUBLIC_API_URL`,
  `PUBLIC_WEB_URL` y `WEB_ORIGIN`, que deben coincidir con las direcciones que abre el navegador.
- Abre la web por el mismo nombre de host que figura en `WEB_ORIGIN` (por defecto
  `localhost`, no `127.0.0.1`): la API rechaza con 403 las peticiones de otro origen.
- La documentación interactiva de la API está en <http://localhost:4000/docs>.

Cuánto tarda (medido en una máquina de 4 núcleos sin GPU): la pila arranca en unos 5 s; un vídeo
de 30 s con avatar 2D se renderiza en 13–14 s a 720p (2,2 veces más rápido que el tiempo real)
y en 24–26 s a 1080p, con un pico de unos 0,75–1 GB de memoria entre el worker y ffmpeg.

## Proveedores: local sin clave y externo con clave

Con el valor `auto` (por defecto) cada capacidad usa el adaptador externo si su clave está
definida y, si no, la implementación local.

| Capacidad              | Local, sin clave (por defecto)                                                                                                                                             | Externo                                                                                                                                                          | Qué lo activa                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Voz (TTS)              | eSpeak NG: 44 voces en 13 idiomas, sintéticas y claramente robóticas; tiempos de fonema exactos para los labios                                                            | ElevenLabs, OpenAI TTS                                                                                                                                           | `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` (sus voces se suman al catálogo); `TTS_PROVIDER` |
| Avatar parlante 2D     | Avatares paramétricos dibujados en Canvas2D (10 de stock), en tiempo real; es lo que ves en la vista previa y lo que se exporta                                            | —                                                                                                                                                                | —                                                                                       |
| Avatar fotorrealista   | Motor neuronal local (`pnpm avatar-engine`): genera retratos, prepara fotos y anima. Lento en CPU                                                                          | Servicio propio de lip-sync por HTTP                                                                                                                             | `LIPSYNC_PROVIDER=external` + `LIPSYNC_ENDPOINT_URL`                                    |
| Guionista y chat (LLM) | «Heurística local»: plantillas deterministas, etiquetadas como modo básico. No redacta: ordena y reparte tu texto                                                          | Anthropic Claude                                                                                                                                                 | `ANTHROPIC_API_KEY` (`LLM_PROVIDER`, `ANTHROPIC_MODEL`)                                 |
| Traducción             | Glosario local limitado, marcado como modo básico                                                                                                                          | Anthropic Claude                                                                                                                                                 | `ANTHROPIC_API_KEY` (`TRANSLATION_PROVIDER`)                                            |
| Transcripción (STT)    | La aporta el usuario (SRT, VTT o texto); con el modelo de voz instalado (`pnpm dictation:setup`), Whisper base en la propia máquina                                        | OpenAI Whisper                                                                                                                                                   | `OPENAI_API_KEY` (`STT_PROVIDER`, `OPENAI_STT_MODEL`)                                   |
| Dictado                | Whisper base en la propia máquina (CPU), tras `pnpm dictation:setup`. El audio no sale del equipo ni se guarda. Sin el modelo, el dictado local aparece como no disponible | Ninguno en el servidor. La web puede ofrecer además el reconocimiento del navegador (en Chrome envía el audio a Google), solo si el usuario lo elige y lo acepta | `pnpm dictation:setup` (`DICTATION_MODEL`, `DICTATION_MODEL_DIR`)                       |
| Clonado de voz         | «Perfil de voz»: estima tono y velocidad de la muestra y ajusta una voz local. No imita el timbre                                                                          | ElevenLabs                                                                                                                                                       | `ELEVENLABS_API_KEY` (`VOICE_CLONE_PROVIDER`)                                           |
| Moderación             | Lista de bloqueo local, ampliable con `MODERATION_EXTRA_BLOCKLIST`                                                                                                         | —                                                                                                                                                                | —                                                                                       |
| Almacenamiento         | Disco local (`STORAGE_LOCAL_DIR`, por defecto `./data/storage`)                                                                                                            | S3 o compatible (MinIO…)                                                                                                                                         | `STORAGE_PROVIDER=s3` + `S3_*`                                                          |
| Pagos                  | Adaptador simulado: cambiar de plan no cobra nada                                                                                                                          | fuera de alcance                                                                                                                                                 | —                                                                                       |

### Dictado por micrófono

Cualquier campo de texto libre de la aplicación lleva un botón de micrófono: el guion y los
textos del Studio, títulos y nombres, descripciones, el tema del guionista, la descripción del
retrato, las variables de plantillas y lotes, la transcripción de una traducción, el mensaje al
avatar interactivo, las búsquedas… Nunca aparece en contraseñas, correos, direcciones web,
números, fechas, campos de solo lectura ni claves o secretos.

**Cómo se usa.** Pulsa el micrófono del campo (o llega a él con el tabulador y pulsa Intro),
acepta el permiso del navegador la primera vez y habla. El texto entra donde está el cursor —o
sustituye lo que tengas seleccionado—, con sus espacios y su mayúscula inicial, por el mismo
camino que si lo teclearas: deshacer, el autoguardado del Studio y el límite de caracteres del
campo siguen funcionando. Un panel junto al campo dice en todo momento qué está pasando
(esperando el permiso, escuchando con el nivel de entrada, transcribiendo, o el error con su
explicación) y **qué motor está transcribiendo**. Para parar: el mismo botón, «Detener» o la
tecla Esc; también se detiene solo al cambiar de pestaña o de página, y al empezar a dictar en
otro campo (solo dicta uno a la vez). Se dicta en el idioma de la interfaz salvo que elijas otro
en las preferencias; algunos campos traen el suyo: el guion del Studio, el de la voz de esa
escena; la transcripción de una traducción, el del vídeo.

**Dos motores**, que se eligen en _Ajustes → Idioma, tema y dictado_ (la elección se guarda en
el navegador, por usuario, junto con el idioma del dictado y la opción de ocultar los botones):

| Motor                          | Qué hace                                                                                                                                                 | Qué sale del equipo                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Local** (por defecto)        | El navegador capta el micrófono, corta el habla por frases y la API las transcribe con Whisper en la propia máquina. El texto llega al acabar cada frase | Nada. No usa ningún servicio externo y el audio no se guarda                                                          |
| **Navegador** (opcional)       | La Web Speech API del navegador, con texto provisional en vivo                                                                                           | Tu voz: el navegador la envía a su servicio de reconocimiento (**en Chrome, a Google**). Parlante no recibe ese audio |
| **Automático** (valor inicial) | Usa el local si el modelo está instalado. Si no lo está, lo explica (y qué ejecutar) y **ofrece** el del navegador; nunca lo activa por su cuenta        | Lo mismo que el local                                                                                                 |

El motor del navegador solo arranca si lo eliges tú y tras aceptar, una vez, un aviso que dice
adónde va el audio; la aceptación se puede retirar en la misma página de ajustes. Si no hay
ningún motor (modelo sin instalar y navegador sin Web Speech), el botón dice «Dictado no
disponible» y al pulsarlo explica por qué.

El motor **local** funciona así: el navegador corta el
habla por frases y envía cada una (WAV de 16 kHz, como mucho 30 s) a
`POST /api/dictation/transcribe`; la API la transcribe en la propia máquina con el modelo
abierto Whisper y responde con el texto y el proveedor que lo produjo. El audio se procesa en
memoria: no se escribe en disco, ni en el almacenamiento, ni en los registros, y no consume
créditos. La telemetría que el runtime de inferencia (ONNX Runtime) trae activada de fábrica se
desactiva, y un test con el modelo real comprueba que el proceso no intenta ninguna conexión
saliente.

El modelo no viene con el repositorio ni se descarga solo. Se instala una vez:

```bash
pnpm dictation:setup            # Whisper base: 139 MB (132,5 MiB) en ./data/models, verificados por SHA-256
pnpm dictation:setup --list     # catálogo y qué hay instalado
pnpm dictation:setup --model whisper-small   # alternativa más precisa y más lenta: 252 MB
```

Es un script de Node (funciona igual en Windows, macOS y Linux), se puede repetir sin miedo (no
vuelve a descargar lo que ya está verificado) y solo baja archivos de datos de `huggingface.co`,
de una revisión fijada. El dictado lo detecta en el acto; para que la traducción de vídeo use
también el modelo (`STT_PROVIDER=auto`), reinicia API y worker. Sin el modelo nada falla:
`GET /api/capabilities` anuncia el dictado local como no disponible (`model_not_installed`) y
el resto de la aplicación sigue igual.

Medido en 4 núcleos sin GPU con `whisper-base`: una frase de 5 s tarda 1,3–1,45 s en volver
transcrita (2,0–2,2 s si no se indica el idioma y hay que detectarlo), una de 15 s tarda
2,1–2,6 s y la primera tras arrancar añade 1–2 s de carga. Con el modelo cargado, el proceso de la API
pasa de 0,24 GB a 1,6 GB (pico de 2,0 GB), hasta que el modelo se descarga solo tras 15 min sin
uso. `whisper-small` acierta bastante más, pero tarda unos 4,6 s por frase —más que la propia
frase— y necesita 3,9 GB: tabla comparativa en [`docs/MODELS.md`](docs/MODELS.md). Es un modelo
pequeño y se etiqueta como modo básico; la precisión con voces humanas no se ha medido aquí (las
pruebas usan habla sintetizada con eSpeak, que Whisper entiende bien en inglés y regular en
español).

Los proveedores externos no se han ejercitado contra los servicios reales en este entorno
(no hay claves): están cubiertos por tests con respuestas simuladas. Ver
[Límites conocidos](#límites-conocidos).

Todas las variables, con su valor por defecto y su efecto, están en
[`.env.example`](.env.example). Las que más cambian el comportamiento:

| Variable                                    | Efecto                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `APP_SECRET`                                | Firma las URLs de archivos y cifra los secretos de webhook. Obligatoria y fuerte (≥ 32) con `NODE_ENV=production` |
| `PUBLIC_API_URL`, `PUBLIC_WEB_URL`          | Direcciones públicas: enlaces de archivos, de compartir y de invitación                                           |
| `WEB_ORIGIN`                                | Orígenes a los que la API acepta peticiones con cookie (CORS y comprobación de `Origin`)                          |
| `ANTHROPIC_API_KEY`                         | Guionista, chat del avatar interactivo y traducción pasan de modo básico a Claude (y empiezan a costar créditos)  |
| `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`      | Voces de más calidad, clonado real (ElevenLabs) y transcripción automática (OpenAI)                               |
| `DICTATION_MODEL`, `DICTATION_MODEL_DIR`    | Qué modelo de voz local se usa (`whisper-base` o `whisper-small`) y dónde lo instala `pnpm dictation:setup`       |
| `STORAGE_PROVIDER=s3`                       | Los archivos van a un bucket; las URLs las firma el propio S3                                                     |
| `AVATAR_ENGINE_URL`, `AVATAR_PORTRAIT_SIZE` | Dónde está el motor fotorrealista y a qué tamaño genera los retratos (512 es unas dos veces más rápido que 768)   |
| `ALLOW_PRIVATE_URLS`                        | Solo desarrollo: levanta la protección SSRF. API y worker se niegan a arrancar con ella en producción             |
| `MODERATION_EXTRA_BLOCKLIST`                | Términos adicionales que bloquean guiones, textos, variables de lote y descripciones de retrato                   |

## Avatares fotorrealistas: el motor neuronal local

Los avatares 2D funcionan siempre. Los fotorrealistas (11 personas sintéticas de stock, los que
generes desde una descripción y los que crees desde una foto) necesitan el motor neuronal: un
servicio Python con modelos abiertos que corre en tu máquina, sin servicios de pago.

```bash
pnpm avatar-engine    # en otra terminal; escucha en http://127.0.0.1:8090
```

La primera vez crea un entorno virtual en `services/avatar-engine/.venv` (unos 660 MB),
descarga los pesos con verificación sha256 a `data/models` (5,0 GB; el generador de retratos son
4,3 GB de ellos) y deriva en el primer uso un archivo más de 1,7 GB. No hace falta reiniciar la
API ni el worker: la web muestra el motor como disponible en cuanto responde. Con
`AVATAR_ENGINE_DOWNLOAD_ARGS=--minimal` solo se bajan 0,56 GB (animar y preparar fotos, sin
generar retratos). Sin el motor, la aplicación lo dice en la biblioteca de avatares y en el
diálogo de render, y no deja encolar (ni cobra) nada que lo necesite.

**Es lento en CPU, y la aplicación lo dice antes de empezar.** Cifras medidas en una máquina de
4 núcleos (Xeon a 2,3 GHz con AVX512-BF16, 15 GB de RAM, sin GPU), a 30 fps:

| Operación                                              | Tiempo medido                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| Animar: generador solo, máquina casi libre             | 0,95 s por fotograma → unos 5 min por cada 10 s de vídeo             |
| Animar: render completo junto al resto de Parlante     | 1,5–2,1 s por fotograma → 8–10 min por cada 10 s de vídeo            |
| Vídeo de 2,7 s (81 fotogramas) con un avatar de foto   | 175 s                                                                |
| Vídeo de 3,3 s (100 fotogramas) con un avatar de stock | 228 s                                                                |
| Generar un retrato a 512 px                            | 84–98 s con un intento; hasta 217 s si repite por control de calidad |
| Crear un avatar desde una foto                         | 13–21 s con el motor en caliente; 43 s la primera vez                |
| Memoria del motor                                      | unos 2–3 GB animando; hasta 5,7–6,6 GB generando un retrato          |

En CPU sin AVX512-BF16 el generador es unas 2,8 veces más lento. El soporte de GPU (CUDA) está
implementado pero **no se ha podido verificar**: la máquina de construcción no tiene GPU. El
tiempo crece en proporción a la duración del vídeo; el diálogo de render y la página del vídeo
muestran el tiempo restante calculado con la velocidad medida en tu máquina. Un render
fotorrealista cuesta el doble de créditos.

El vídeo exportado con un avatar fotorrealista lleva en los metadatos del MP4 la marca de
contenido generado por IA. Crear un avatar desde la foto de una persona exige su consentimiento
registrado. Lee [`docs/RESPONSIBLE_USE.md`](docs/RESPONSIBLE_USE.md) antes de usarlo con
terceros: el modelo que genera los retratos impone restricciones de uso. Detalles del motor en
[`services/avatar-engine/README.md`](services/avatar-engine/README.md); modelos y licencias en
[`docs/MODELS.md`](docs/MODELS.md).

## Comandos

```bash
pnpm dev                      # api + worker + web        (dev:api | dev:worker | dev:web)
pnpm services                 # PostgreSQL + Redis locales (idempotente)
pnpm avatar-engine            # motor neuronal local en :8090 (opcional)
pnpm dictation:setup          # instala el modelo de voz del dictado local (139 MB, una vez; opcional)
pnpm db:migrate               # aplica migraciones a DATABASE_URL
pnpm db:seed                  # usuario demo@parlante.local / parlante-demo (plan Creator)
pnpm db:generate --name <motivo>   # nueva migración tras tocar packages/db/src/schema.ts

pnpm -r typecheck             # TypeScript estricto en los 10 paquetes
pnpm lint                     # ESLint de todo el repo, 0 avisos
pnpm format:check             # Prettier            (pnpm format para aplicarlo)
pnpm -r test                  # todos los tests     (pnpm --filter @parlante/<paquete> test)
pnpm -r build                 # comprobación de tipos de cada paquete + bundle de la web
pnpm e2e e2e/core.mjs         # recorrido de extremo a extremo con navegador (ver e2e/README.md)
pnpm db:test:clean            # borra bases de datos de test que hayan quedado huérfanas
```

Los tests de `db`, `jobs`, `api` y `worker` usan PostgreSQL y Redis reales y crean una base de
datos propia por ejecución, así que necesitan `pnpm services`. Los del motor:
`cd services/avatar-engine && .venv/bin/python -m pytest` (segundos; los marcados `slow` cargan
los modelos y renderizan vídeo real). Los tests marcados `[slow]` de `providers`, `api` y
`worker` cargan el modelo de voz real y se saltan solos si no está instalado
(`pnpm dictation:setup`).

Las pruebas de extremo a extremo arrancan su propia pila (base de datos nueva, API, worker y
web) y la borran al terminar:

```bash
pnpm e2e e2e/core.mjs                       # registro → Studio → render → MP4, compartir, créditos, API, webhooks
E2E_ALLOW_PRIVATE_URLS=false pnpm e2e e2e/ai.mjs    # bibliotecas, guionista, clonado, traducción, lotes, interactivo
pnpm e2e e2e/dictation.mjs                  # dictado con micrófono simulado y el modelo local (se salta si falta)
```

Con el motor arrancado, `e2e/ai.mjs` cubre además lo fotorrealista; su cabecera explica las
variables (`E2E_ENGINE=1`, `E2E_AVATAR_ENGINE_URL`…).

## Con Docker

```bash
echo "APP_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" > .env
docker compose up --build                      # web y API en http://localhost:8080
echo "AVATAR_ENGINE_TOKEN=$(openssl rand -hex 24)" >> .env
docker compose --profile neural up --build     # añade el motor fotorrealista
```

La pila de Compose arranca con `NODE_ENV=production`: exige `APP_SECRET`, aplica las migraciones
antes de la API y sirve la web con nginx, que hace de proxy de `/api`, `/v1` y `/docs`. Los
archivos, la base de datos y los pesos viven en volúmenes. Para Docker **no copies
`.env.example` entero**: sus `PUBLIC_API_URL`, `PUBLIC_WEB_URL` y `WEB_ORIGIN` son los de
`pnpm dev` (puertos 4000 y 5173) y Compose los tomaría en lugar de `http://localhost:8080`.

> **Sin ejecutar.** En el entorno donde se construyó Parlante no hay daemon de Docker. Lo
> comprobado es estático: `docker compose config` valida con y sin el perfil `neural`, y las
> rutas, variables y comandos de los Dockerfile se han revisado contra el repositorio. Las
> imágenes no se han construido ni arrancado nunca.

## Estructura del monorepo

```
packages/shared        Contratos: esquemas zod de Composition, entidades, tabla de rutas de la API,
                       colas, interfaces de proveedores, visemas, errores, planes
packages/db            Drizzle + PostgreSQL: esquema, migraciones, libro de créditos, semilla
packages/renderer      Render isomórfico Canvas2D: el mismo renderFrame() en el navegador y en Node
packages/providers     TTS, LLM, STT, traducción, clonado, lip-sync, retratos, moderación, storage
packages/templates     Las 8 plantillas integradas (datos Composition)
packages/stock-assets  Fondos y música generados por código; retratos de stock fotorrealistas
packages/jobs          Lo que comparten API y worker: startRender, caché de voz, webhooks, colas
apps/api               Fastify: /api (sesión), /v1 (API pública), OpenAPI; un módulo por dominio
apps/worker            BullMQ + ffmpeg: render, traducción, lote, avatar de foto, clonado, webhooks
apps/web               Vite + React + Tailwind: Studio y el resto de pantallas; una carpeta por feature
services/avatar-engine Motor neuronal local (Python: ONNX Runtime + OpenVINO), fuera del workspace pnpm
e2e/, scripts/         Pruebas de extremo a extremo y scripts de servicios
docker/                Dockerfile de API/worker y de la web, configuración de nginx
docs/                  Arquitectura, contratos, API, seguridad, modelos, uso responsable
```

El documento de vídeo es siempre una **Composition** (JSON validado con zod). El Studio la edita
y la previsualiza con el mismo código de render que usa el worker para exportar, por eso la
vista previa coincide con el MP4. La API valida, cobra y encola; el worker renderiza y escribe
el resultado en la base de datos, que es lo que la web consulta.

## Límites conocidos

Dichos tal cual, para que nadie los descubra por sorpresa.

- **Calidad del modo local.** La voz de eSpeak NG es inteligible pero robótica. El guionista y
  la traducción locales son heurísticos (la traducción local es un glosario: sirve para probar
  el flujo, no para publicar). El «clonado» local es un perfil de tono y velocidad, no una
  imitación del timbre. Todo ello se etiqueta como modo básico en la interfaz y en la API.
- **Proveedores externos sin probar contra el servicio real.** Los adaptadores de Anthropic,
  ElevenLabs, OpenAI, S3 y el lip-sync externo tienen tests con respuestas simuladas; ninguno
  se ha ejecutado aquí con una clave real.
- **Lo fotorrealista es lento en CPU** (tabla de arriba) y la GPU no está verificada. La vista
  previa del Studio y el avatar interactivo no usan el motor: muestran una aproximación 2D del
  retrato; el movimiento neuronal solo aparece en el vídeo exportado.
- **Encuadre «busto» de los avatares fotorrealistas**: el retrato es cuadrado y, si la caja del
  avatar es más ancha que la figura, los hombros se cortan en vertical en los lados. Se evita
  con «primer plano», con forma circular o redondeada, o ajustando la caja.
- **El kit de marca no comprueba el contraste**: aplica sus colores y tipografías a las capas
  con papel de marca y sustituye las capas marcadas como «logo» (ninguna plantilla integrada
  trae una; se marca en el Studio). Un color de texto oscuro sobre una plantilla con fondo de
  imagen oscuro queda ilegible: revisa el resultado en la vista previa.
- **Dictado local**: modelo pequeño en CPU. Tarda entre 1 y 2,5 s por frase y transcribe un
  fragmento cada vez (con varias personas dictando a la vez, la API responde 429 con
  `Retry-After` a partir de 4 fragmentos en espera; la web espera y reintenta). No hay texto en
  vivo mientras se habla: el texto llega al terminar cada frase (una pausa de unos 0,7 s la
  cierra). Las pruebas usan habla sintetizada, no voces humanas. El runtime (`onnxruntime-node`)
  trae binarios para Windows, macOS y Linux, pero **solo se ha ejecutado en Linux x86-64**, y la
  web solo se ha probado de extremo a extremo en Chromium (`e2e/dictation.mjs`, con un micrófono
  simulado): Firefox, Safari y un micrófono físico están sin probar.
- **Dictado del navegador**: no se puede ejercitar sin el servicio de voz del fabricante del
  navegador, así que solo está cubierto por tests con un doble de `SpeechRecognition`. Existe en
  Chrome, Edge y Safari; Firefox no lo trae (allí la opción aparece desactivada). No mide el
  nivel de entrada. El navegador necesita HTTPS o `localhost` para dar acceso al micrófono, con
  cualquiera de los dos motores.
- **Docker sin ejecutar** (ver arriba). **Solo se ha probado en Linux**; `pnpm services` tiene
  ramas para Homebrew que no se han ejercitado, y el motor requiere Linux x86-64.
- **Una sola instancia de la API.** Los límites de peticiones y de intentos de acceso viven en
  la memoria del proceso; con varias réplicas harían falta en Redis.
- **Pagos simulados.** Cambiar de plan es inmediato y no cobra. No hay SSO, apps móviles ni
  edición colaborativa en tiempo real.
- **Subidas**: no hay grabación de vídeo desde el navegador; la muestra de voz para clonar sí
  puede grabarse con el micrófono, pero ese camino solo está cubierto por tests con dobles.
- **Idioma del contenido**: los nombres y descripciones de plantillas y voces que devuelve el
  servidor a la web están en español aunque la interfaz esté en inglés (la API pública `/v1`
  sí respeta `Accept-Language`).
- **Moderación básica**: una lista de bloqueo con normalización; no detecta homoglifos, otros
  idiomas ni palabras con guiones intercalados. Es un punto de extensión
  (`ModerationProvider`), no un filtro de contenido completo.
- **`/docs` y `/openapi.json` se sirven también en producción**; `OPENAPI_ENABLED=false` los apaga.
- Más detalle sobre los límites de seguridad en [`docs/SECURITY.md`](docs/SECURITY.md) §3.

## Documentación

| Documento                                                                    | Contenido                                                                    |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                               | Procesos, flujo del render, decisiones y por qué                             |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md)                                     | Composition, entidades, las 115 rutas, colas, créditos, proveedores, storage |
| [`docs/API.md`](docs/API.md)                                                 | Guía de la API pública `/v1` con ejemplos y verificación de webhooks         |
| [`docs/RESPONSIBLE_USE.md`](docs/RESPONSIBLE_USE.md)                         | Consentimiento, moderación, marcado de IA, borrado y condiciones de uso      |
| [`docs/SECURITY.md`](docs/SECURITY.md)                                       | Modelo de amenazas, controles y límites conocidos                            |
| [`docs/MODELS.md`](docs/MODELS.md)                                           | Modelos del motor y del dictado: origen, tamaño, licencia, mediciones        |
| [`services/avatar-engine/README.md`](services/avatar-engine/README.md)       | El motor neuronal: API, rendimiento medido, configuración                    |
| [`e2e/README.md`](e2e/README.md), [`apps/web/README.md`](apps/web/README.md) | Pruebas de extremo a extremo; convenciones de la web                         |

## Licencias de terceros

- **Modelos del motor neuronal**: MIT y Apache-2.0, salvo el generador de retratos (Realistic
  Vision 6, **CreativeML OpenRAIL-M**: uso comercial permitido con restricciones de uso que
  quien ofrezca Parlante a terceros debe trasladar a sus usuarios). Tabla completa en
  [`docs/MODELS.md`](docs/MODELS.md); condiciones en
  [`docs/RESPONSIBLE_USE.md`](docs/RESPONSIBLE_USE.md).
- **Voz local**: `@echogarden/espeak-ng-emscripten` (eSpeak NG compilado a WebAssembly) se
  distribuye bajo **GPL-3.0**. Parlante lo usa como dependencia de npm sin modificarla. Si
  redistribuyes Parlante con esa dependencia incluida (por ejemplo, en una imagen de Docker),
  debes cumplir la GPL-3.0 para ese componente; valora con asesoría legal su efecto sobre el
  conjunto, o configura otro proveedor de voz (`TTS_PROVIDER`) y retira la dependencia.
- **Reconocimiento de voz local**: los modelos Whisper (`Xenova/whisper-base` y
  `whisper-small`, **Apache-2.0**) se descargan aparte; el runtime son
  `@huggingface/transformers` (Apache-2.0) y `onnxruntime-node` (MIT). `@huggingface/transformers`
  arrastra `sharp`, cuyos binarios precompilados de libvips (`@img/sharp-libvips-*`) son
  **LGPL-3.0-or-later**: Parlante no los usa, pero quien redistribuya una instalación que los
  contenga debe respetar esa licencia para esa biblioteca. Detalle en
  [`docs/MODELS.md`](docs/MODELS.md).
- El resto de dependencias de producción usan licencias permisivas; `pnpm licenses list --prod`
  las enumera.
