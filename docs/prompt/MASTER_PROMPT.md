# Prompt maestro — Parlante (plataforma de vídeo con avatares IA)

> Este documento es el contrato que gobierna a todo el equipo de agentes. Cada agente lo lee
> completo antes de tocar un archivo. Si algo de tu encargo contradice este documento, gana
> este documento; si el documento está equivocado, dilo en tu informe en vez de improvisar.

## 1. Misión

Construir **Parlante**: una aplicación web completa, original y ejecutable que ofrece las
prestaciones de una plataforma de generación de vídeo con avatares IA (la categoría de producto
de HeyGen, Synthesia, D-ID): escribir un guion, elegir avatar y voz, componer escenas, y obtener
un MP4 con el avatar hablando sincronizado, además de traducción de vídeo, plantillas, kit de
marca, API pública y avatar interactivo en tiempo real.

Es un producto **original**: nombre, marca, diseño, textos, avatares y API propios. No se copia
la marca, los assets, los textos ni la forma exacta de la API de ningún producto existente.

**Listo significa**: un usuario clona el repo, ejecuta los comandos del README, se registra,
crea un vídeo de varias escenas en el Studio, lo renderiza y descarga un MP4 reproducible con
audio, labios sincronizados y subtítulos — **sin ninguna clave de API externa**. Con claves, los
mismos flujos usan proveedores de mayor calidad.

## 2. Restricción central de diseño: proveedores intercambiables

No hay GPU ni se pueden descargar modelos. Por eso toda capacidad de IA vive detrás de una
interfaz con (a) una implementación **local** que funciona offline y sin claves, y (b)
adaptadores a servicios externos que se activan por variable de entorno.

| Capacidad | Local (por defecto, sin claves) | Adaptadores externos |
|---|---|---|
| TTS | espeak-ng (paquete npm WASM o binario del sistema) con fonemas → visemas | ElevenLabs, OpenAI TTS |
| Avatar parlante | Avatares 2D paramétricos dibujados en Canvas2D, boca dirigida por visemas, parpadeo, micro-movimiento | Interfaz `LipSyncProvider` para endpoint externo (vídeo fotorrealista) |
| Avatar desde foto | Foto del usuario animada con deformación de mandíbula/boca + movimiento sutil | `LipSyncProvider` externo |
| LLM (guiones, traducción) | Heurística determinista / plantillas, marcada claramente como "modo básico" | Anthropic Claude |
| STT | Transcripción aportada por el usuario (SRT/VTT/texto) | OpenAI Whisper API |
| Clonado de voz | Perfil de voz (tono/velocidad estimados → voz local parametrizada) | ElevenLabs |
| Almacenamiento | Disco local | S3 compatible |

Regla de honestidad: la UI y la API indican siempre qué proveedor produjo un resultado y nunca
presentan el modo básico como si fuera el de alta calidad.

## 3. Alcance funcional

**Nivel 1 — debe funcionar de extremo a extremo y estar verificado:**

1. Cuentas: registro, login, logout, sesión por cookie; workspaces con miembros y roles
   (owner, admin, editor, viewer).
2. Biblioteca de avatares: ≥ 8 avatares de stock diversos (edad, tono de piel, pelo, ropa,
   estilo) con vista previa animada; filtro y búsqueda.
3. Biblioteca de voces: voces en ≥ 8 idiomas (es, en, fr, de, it, pt, y más), preescucha,
   control de velocidad y tono.
4. Studio: editor multiescena con guion por escena, avatar (posición, escala, encuadre),
   fondos (color, degradado, imagen, vídeo), capas de texto, imagen y forma, transiciones,
   música de fondo, subtítulos automáticos, formatos 16:9 / 9:16 / 1:1, vista previa en vivo
   que usa **el mismo código de render** que la exportación, autoguardado, deshacer/rehacer.
5. Render: cola de trabajos con progreso, MP4 H.264 + AAC a 720p/1080p, miniatura, SRT y VTT.
6. Vídeos: listado, detalle con reproductor, descarga, duplicar, borrar, página pública para
   compartir por enlace.
7. Plantillas: ≥ 6 plantillas integradas (explicativo, anuncio vertical, formación, noticia,
   presentación de producto, saludo) y "guardar como plantilla".
8. Assets: subida y gestión de imágenes, vídeo y audio.
9. API pública v1 con claves de API, webhooks firmados (`video.completed`, `video.failed`) y
   documentación OpenAPI servida por la propia API.
10. Créditos: libro mayor de uso por workspace, planes (free/creator/team) con límites
    aplicados; pagos reales fuera de alcance (adaptador de facturación simulado).

**Nivel 2 — debe funcionar; se acepta menor pulido:**

11. Guionista IA: tema o URL + tono + duración + idioma → guion dividido en escenas.
12. Traducción de vídeo: subir vídeo → transcripción → traducción → doblaje TTS → mezcla →
    subtítulos; varios idiomas destino por trabajo.
13. Kit de marca: logo, colores y tipografía aplicables a un vídeo.
14. Avatar desde foto y clonado de voz, ambos con **consentimiento obligatorio** (apartado 5).
15. Vídeo personalizado en lote: variables `{{nombre}}` + CSV → N vídeos.
16. Avatar interactivo: conversación en tiempo real en el navegador (texto → LLM → TTS →
    avatar con labios sincronizados usando el renderer en cliente).

**Fuera de alcance:** pagos reales, apps móviles, SSO, edición colaborativa en tiempo real.

## 4. Arquitectura

Monorepo pnpm + TypeScript estricto. Node 22. Código y comentarios en inglés; UI en español
(por defecto) e inglés mediante i18n.

```
packages/shared     Esquemas zod y tipos: Composition, entidades, DTOs de API, payloads de
                    colas, interfaces de proveedores, visemas, errores, planes. Fuente de verdad.
packages/db         Drizzle ORM + PostgreSQL: esquema, migraciones, seed.
packages/renderer   Render isomórfico Canvas2D (navegador y Node con @napi-rs/canvas):
                    renderFrame(ctx, composition, t, runtime), rigs de avatares, subtítulos.
packages/providers  TTS, LLM, STT, traducción, lip-sync, clonado, almacenamiento.
packages/templates  Plantillas integradas como datos Composition.
apps/api            Fastify: REST v1, auth, módulos por dominio autocargados, OpenAPI, colas.
apps/worker         BullMQ: render, traducción, lote, avatar-foto, clonado, webhooks. ffmpeg.
apps/web            Vite + React + Tailwind + TanStack Query + React Router; features
                    autocargadas por glob.
```

Decisiones fijadas (no se reabren sin motivo de peso documentado):

- **Composition** (JSON validado con zod) es el único formato de documento de vídeo. Editor,
  API, plantillas y worker hablan Composition.
- El **renderer es isomórfico y determinista**: misma entrada + mismo `t` ⇒ mismo fotograma.
  Nada de `Date.now()` ni aleatoriedad sin semilla dentro del render.
- Pipeline de render: por escena TTS → audio + línea de tiempo de visemas y palabras → render
  de fotogramas → ffmpeg (H.264/AAC, `+faststart`) → miniatura + SRT/VTT.
- Coordenadas de capas normalizadas (0..1) respecto al lienzo; 30 fps.
- Postgres + Drizzle; Redis + BullMQ. Contraseñas con scrypt de `node:crypto`; sesiones en BD;
  claves de API guardadas como hash; webhooks firmados con HMAC-SHA256.
- Fuentes empaquetadas vía npm (@fontsource) y registradas igual en navegador y Node.

## 5. Seguridad y uso responsable (obligatorio, no negociable)

- Avatar desde foto y clonado de voz exigen una declaración de consentimiento explícita
  (casilla + nombre de quien consiente), guardada como `ConsentRecord` con fecha, usuario e IP.
  Sin registro de consentimiento, la API rechaza la operación.
- Punto de extensión de moderación de guiones (`ModerationProvider`) invocado antes de
  renderizar; implementación local con lista de bloqueo básica.
- Validación zod en toda entrada; autorización por workspace en **cada** consulta (nunca
  devolver ni mutar recursos de otro workspace); límites de tamaño y tipo en subidas;
  comprobación de tipo real del archivo; rutas de archivo nunca derivadas de entrada sin
  sanear; argumentos de ffmpeg nunca construidos por concatenación de cadenas de usuario
  (usar arrays de argumentos); límite de peticiones; cabeceras seguras; cookies httpOnly +
  SameSite; protección SSRF en webhooks y en "URL → guion" (bloquear IPs privadas/loopback).
- Ningún secreto en el repo. `.env.example` documenta todas las variables.

## 6. Reglas de trabajo para cada agente

1. Lee este documento, `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md` y `docs/OWNERSHIP.md`
   (cuando existan) antes de escribir.
2. **Propiedad de directorios**: escribe solo dentro de los directorios que te asigna tu
   encargo. Si necesitas un cambio fuera (p. ej. un campo nuevo en `packages/shared`), hazlo
   solo si es aditivo y compatible, y decláralo en tu informe; si no es aditivo, no lo hagas:
   repórtalo.
3. **No ejecutes `git commit`, `git push`, `git stash`, `git checkout` ni `git reset`.** Otros
   agentes trabajan a la vez en el mismo árbol. El orquestador hace los commits.
4. Dependencias: usa las ya instaladas. Si de verdad necesitas una nueva, añádela con
   `pnpm --filter <paquete> add <dep>` y decláralo en tu informe; si pnpm falla por
   concurrencia, espera unos segundos y reintenta.
5. No dejes `TODO`, funciones vacías ni datos simulados en rutas que el usuario ejecuta. Si
   algo no se puede hacer, implementa la degradación honesta del apartado 2 y documéntala.
6. **Verifica antes de informar**: `typecheck`, `lint` y tests de tu paquete en verde, y además
   ejercita de verdad lo que construiste (renderiza un fotograma, llama al endpoint, abre la
   página con Playwright). "Compila" no es "funciona".
7. Tests: unitarios con vitest para la lógica; de integración para endpoints (BD real de
   test); nunca desactives ni omitas un test para llegar a verde.
8. Servicios locales: `scripts/dev-services.sh` arranca Postgres y Redis. No mates procesos
   que no hayas lanzado tú. Usa los puertos de tu encargo para servidores de prueba.
9. Informe final (es tu valor de retorno, no un mensaje para humanos): qué construiste, qué
   verificaste y cómo (comandos y resultado real), qué quedó sin hacer o degradado y por qué,
   cambios hechos fuera de tu propiedad, dependencias añadidas. Si un test falla, dilo con la
   salida. No afirmes nada que no hayas comprobado.

## 7. Barras de calidad

- TypeScript `strict`, sin `any` implícito, sin `@ts-ignore` injustificado.
- Errores de API con forma única `{ error: { code, message, details? } }` y códigos de
  `packages/shared`.
- UI: identidad visual propia y cuidada (no un panel genérico), accesible por teclado, estados
  de carga/vacío/error en cada vista, responsive hasta 1024 px en el Studio y móvil en el
  resto, modo claro y oscuro.
- Rendimiento del render: ≥ 1× tiempo real a 720p en 4 núcleos como objetivo.
- Cada paquete expone scripts `build`, `typecheck`, `lint`, `test`.
