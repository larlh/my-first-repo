# Pruebas de extremo a extremo

Recorren el producto de verdad: la web, la API y el worker arrancados a la vez contra una base de
datos recién creada, con Playwright como librería y **sin interceptar la red**. Lo que se
comprueba es lo que un usuario vería, oiría o descargaría.

```bash
pnpm e2e e2e/core.mjs                 # = bash scripts/e2e.sh e2e/core.mjs
E2E_ONLY=journey,share pnpm e2e e2e/core.mjs
pnpm e2e e2e/perf.mjs                 # tiempos de render (30 s a 720p y 1080p) y memoria del worker
pnpm e2e e2e/dictation.mjs            # dictado por micrófono con el modelo local (se salta si no está instalado)
pnpm e2e e2e/voices.mjs               # solo el recorrido de las voces neuronales (es la sección `neural` de core.mjs)
E2E_TTS_PROVIDER=espeak pnpm e2e e2e/core.mjs   # la misma pila solo con la voz de reserva
```

**Qué voz usa la pila.** La que tendría una instalación sin claves: las voces neuronales locales
si están instaladas en la máquina (`pnpm voices:setup`) y, si no, eSpeak NG. Los scripts no dan
por supuesta ninguna: leen de `GET /api/voices` cuál es la voz por defecto (`isDefault`) y
esperan ese proveedor en la interfaz, en la API y en los vídeos. Sin voces neuronales, los
pasos que las necesitan se saltan y la salida lo dice en un recuadro («VOCES NEURONALES NO
DISPONIBLES…»); el resto del recorrido pasa igual con eSpeak.

`scripts/e2e.sh` crea la base de datos `parlante_e2e_<id>`, migra, arranca API, worker y web
(por defecto el bundle de producción servido con `vite preview`; `E2E_WEB_MODE=dev` usa el
servidor de desarrollo), espera a que respondan, ejecuta los scripts que reciba y al salir —también
si algo falla— para los procesos, borra la base de datos, las claves de Redis de su prefijo y sus
archivos. Si un script falla, deja los registros y las capturas en el directorio que imprime.

| Variable                        | Para qué                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2E_API_PORT` / `E2E_WEB_PORT` | Puertos (4211 / 5211)                                                                                                                                |
| `E2E_HOOK_PORT`                 | Puerto del receptor local de webhooks (puerto de la API + 50)                                                                                        |
| `E2E_WEB_MODE`                  | `build` (por defecto) o `dev`                                                                                                                        |
| `E2E_KEEP=1`                    | No borrar nada al terminar (depuración)                                                                                                              |
| `E2E_TTS_PROVIDER`              | `TTS_PROVIDER` de la pila (por defecto `neural`: voces locales, nunca un proveedor externo aunque haya claves; `espeak` = solo la reserva)           |
| `E2E_VOICE_CLONE_PROVIDER`      | `VOICE_CLONE_PROVIDER` de la pila (por defecto `local`; `chatterbox` clona con el motor de voz local, que debe estar arrancado: `pnpm voice-engine`) |
| `E2E_ONLY`                      | Secciones de `core.mjs` a ejecutar, separadas por comas                                                                                              |
| `PLAYWRIGHT_MODULE`             | Ruta de Playwright si no está en el workspace ni en `NODE_PATH`                                                                                      |

Requisitos: PostgreSQL y Redis (`pnpm services`), `ffmpeg`/`ffprobe` y Playwright con Chromium.

## Qué cubre `core.mjs`

| Sección    | Recorrido                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `journey`  | Registro → panel → Studio (dos escenas, texto, avatar 2D, voz, fondo, música, subtítulos) → la vista previa dibuja y suena → autoguardado y recarga → render con progreso → reproducir → MP4/SRT/VTT → ffprobe → vista previa = exportación |
| `formats`  | 16:9 → 9:16 cambiando el formato en el Studio; 1:1 desde una plantilla integrada con sus variables                                                                                                                                          |
| `share`    | Enlace público sin sesión (móvil), con y sin descarga, visitas, enlace apagado                                                                                                                                                              |
| `credits`  | Coste anunciado = coste cobrado, cancelar devuelve el saldo, sin saldo se rechaza                                                                                                                                                           |
| `settings` | Invitación aceptada con una segunda cuenta, roles, clave de API contra `/v1`, webhook firmado entregado a un receptor local                                                                                                                 |
| `assets`   | Subir imagen, vídeo y audio, usarlos en una escena y renderizar; tipos no admitidos; archivo borrado en uso                                                                                                                                 |
| `neural`   | Las voces neuronales locales de principio a fin (es `voices.mjs`, más abajo). Se salta con aviso si la pila no las tiene                                                                                                                    |

El recorrido principal (`journey`) narra con la voz masculina por defecto de la pila (neuronal
si está instalada), comprueba que su preescucha tiene señal y que el vídeo, la ficha y la página
pública nombran al proveedor que la generó. La petición a la API pública pide a propósito la voz
de reserva (`espeak:es-f1`): eSpeak NG debe seguir funcionando cuando ya no es la voz por defecto.

## Qué cubre `ai.mjs`

Bibliotecas y funciones de IA, con los proveedores locales y, si está arrancado, el motor
neuronal. Secciones (`E2E_AI_ONLY=…`): `avatars`, `voices`, `script` (guionista y guardia SSRF
de «URL → guion»), `clone` (clonado de voz con consentimiento y revocación), `interactive`,
`batch`, `translate`, `engine` (qué ve el usuario con el motor parado) y `photo` (avatar desde
foto y desde descripción, y un render fotorrealista corto). La cabecera del script documenta
todas sus variables.

Con la voz por defecto de la pila: la biblioteca la lista primero con su etiqueta («Neuronal
local» o «Modo básico»), la preescucha suena y nombra a quien la generó, y los borradores del
guionista y de la ficha de un avatar, la respuesta del avatar interactivo, los vídeos de un lote
y el doblaje de una traducción salen con esa voz y lo dicen (`providers.tts`). Con voces
neuronales hay un paso más que sintetiza en español e inglés, con voz femenina y masculina, y
comprueba que eSpeak sigue contestando cuando se pide por su nombre. El render fotorrealista
comprueba además que el vídeo lleva la voz (nivel medido en el MP4) y que dice qué conductor
movió los labios (`providers.lipsync.mode`: `audio` o `visemes`), en la API y en la ficha.

```bash
E2E_ALLOW_PRIVATE_URLS=false pnpm e2e e2e/ai.mjs          # sin motor: los pasos fotorrealistas se saltan con aviso

pnpm avatar-engine &                                       # con el motor (minutos de CPU)
E2E_ENGINE=1 E2E_AVATAR_ENGINE_URL=http://127.0.0.1:8090 \
  E2E_AVATAR_ENGINE_WORK_DIR="$PWD/data/avatar-engine" AVATAR_PORTRAIT_SIZE=512 \
  E2E_ALLOW_PRIVATE_URLS=false pnpm e2e e2e/ai.mjs
```

`core.mjs` necesita `ALLOW_PRIVATE_URLS=true` (su receptor de webhooks está en `127.0.0.1`) y el
paso SSRF de `ai.mjs` necesita la protección activa. Si se lanzan los dos en la misma pasada
(`pnpm e2e e2e/core.mjs e2e/ai.mjs`), ese paso de `ai.mjs` se salta con aviso; para cubrirlo,
lanza `ai.mjs` aparte con `E2E_ALLOW_PRIVATE_URLS=false`.

## Qué cubre `dictation.mjs`

El dictado por micrófono con el motor **local**, de verdad: Chromium se lanza con un micrófono
simulado (`--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`,
`--use-file-for-fake-audio-capture=<wav>%noloop`) que «oye» un WAV; la web lo capta, corta la
frase y la envía a la API, y el modelo Whisper instalado en la máquina la transcribe. La frase
la sintetiza el propio producto (`POST /api/tts/synthesize`, con la voz inglesa por defecto de
la pila: neuronal si está instalada, eSpeak NG si no): no interviene ninguna grabación de una
persona. Está en inglés porque el modelo entiende bien también la voz inglesa de eSpeak, y mal
la española; el texto se compara por palabras (≥ 80 % de coincidencia), porque lo que se prueba
es el recorrido, no la precisión del modelo.

| Paso         | Qué comprueba                                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preferencias | Motor local disponible, automático por defecto, qué sale del equipo con cada motor, aviso previo del motor del navegador, idioma del dictado guardado por usuario             |
| Exclusiones  | El nombre tiene micrófono; el correo (solo lectura) y las contraseñas, no                                                                                                     |
| Título       | Título de un vídeo nuevo: botón pulsado, nivel de entrada, proveedor nombrado, texto en el campo sin punto final, Esc detiene; el vídeo se crea con ese título                |
| Studio       | Guion dictado en el idioma de la voz de la escena, autoguardado, deshacer / rehacer, sigue ahí tras recargar; título de la barra (campo fuera del kit) sustituye la selección |
| Guionista    | El texto entra en la posición del cursor, entre dos frases                                                                                                                    |
| Interactivo  | El mensaje dictado se envía al avatar y este contesta, en voz alta, con la voz por defecto de la pila                                                                         |
| Red          | Cada dictado fue una petición real a `/api/dictation/transcribe`, contestada 200 por el proveedor local                                                                       |

Si el modelo no está instalado (`pnpm dictation:setup`), el script lo dice en un recuadro bien
visible y termina sin fallar. El motor del **navegador** (Web Speech API) necesita el servicio
de voz del fabricante del navegador y no se puede ejercitar aquí: lo cubren los tests de la web
con un doble de `SpeechRecognition`.

Dos cosas que conviene saber:

- El receptor de webhooks escucha en `127.0.0.1`, así que la pila de pruebas arranca con
  `ALLOW_PRIVATE_URLS=true`. Ese interruptor levanta la protección SSRF, está apagado por defecto
  y la API y el worker se niegan a arrancar con él si `NODE_ENV=production`.
- Lo único que los scripts escriben directamente en la base de datos es el saldo del caso «sin
  créditos» (`leaveCredits` en `lib.mjs`, a través del libro mayor): no hay ninguna acción del
  producto que gaste créditos sin renderizar durante minutos.

## Qué cubre `voices.mjs`

Las voces neuronales locales con los modelos reales instalados en la máquina
(`pnpm voices:setup`); `core.mjs` lo ejecuta como su sección `neural`: la API las lista primero y las marca como voz
por defecto; la biblioteca las etiqueta como «Neuronal local» y explica las que faltan; una
preescucha suena (nivel medido en el WAV y en la salida de audio del navegador) y mueve al
presentador; un vídeo nuevo empieza con la voz neuronal; en la vista previa del Studio la boca
del avatar 2D está abierta donde el modelo pronuncia una vocal abierta y cerrada en sus pausas
(instantes tomados de la línea de tiempo que devuelve el modelo); la exportación reutiliza el
audio de la vista previa (la caché no crece, el primer subtítulo empieza con la primera palabra)
y el MP4 lleva la voz.
