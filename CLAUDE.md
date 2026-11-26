# Parlante — guía rápida para agentes

Plataforma de vídeo con avatares IA. Monorepo pnpm + TypeScript estricto, Node 22.

**Antes de escribir, lee:** `docs/prompt/MASTER_PROMPT.md` (contrato del proyecto),
`docs/CONTRACTS.md` (contratos y patrones copiables) y `docs/OWNERSHIP.md` (qué directorios son
tuyos). Contexto general: `docs/ARCHITECTURE.md`.

## Comandos

```bash
pnpm install
pnpm services                  # Postgres + Redis locales (idempotente; = bash scripts/dev-services.sh)
pnpm db:migrate                # aplica migraciones a DATABASE_URL        pnpm db:seed
pnpm dev                       # api :4000 + worker + web :5173           (dev:api | dev:worker | dev:web)
pnpm avatar-engine             # motor neuronal local :8090 (opcional; avatares fotorrealistas)

pnpm -r typecheck              # todos los paquetes
pnpm lint                      # ESLint de todo el repo (0 avisos)
pnpm -r test                   # todos los tests       pnpm --filter @parlante/<paquete> test
pnpm --filter @parlante/api exec vitest run src/modules/<mod>   # un módulo
pnpm db:generate --name <motivo>   # nueva migración tras tocar packages/db/src/schema.ts
pnpm format                    # Prettier
```

Los tests de `db`, `jobs`, `api` y `worker` crean una base de datos propia por ejecución
(necesitan `pnpm services`); varios agentes pueden lanzarlos a la vez.

## Convenciones

- Código y comentarios en inglés. UI en español (por defecto) e inglés con i18n.
- **Escribe solo en tus directorios.** Fuera de ellos, solo cambios aditivos y declarados en el
  informe (CONTRACTS §14).
- **No ejecutes** `git commit`, `push`, `stash`, `checkout` ni `reset`: el orquestador hace los commits.
- Contratos en `packages/shared` (zod). Importa de `@parlante/shared` y, solo en Node, de
  `@parlante/shared/node`. Helpers de consulta (`eq`, `and`, `sql`…) de `@parlante/db`, nunca de
  `drizzle-orm`.
- API: un módulo = `apps/api/src/modules/<nombre>/index.ts` con `defineModule` +
  `defineRoute(app, api.grupo.ruta, handler)`. Toda consulta filtra por `auth.workspaceId`;
  recurso ajeno = 404. Errores con `AppError(code, …)`.
- Worker: un job = `apps/worker/src/jobs/<nombre>/index.ts` con `defineJob`. Carga filas por
  ids + `workspaceId`, sé idempotente, persiste progreso en la fila, define `onFinalFailure`.
- Web: un feature = `apps/web/src/features/<nombre>/index.tsx` con `defineFeature` (ver
  `apps/web/README.md`).
- Lógica que necesitan API **y** worker vive en `packages/jobs` (`startRender`, `resolveVoice`,
  `synthesizeCached`…). No la dupliques.
- Render determinista: nada de `Date.now()` ni `Math.random()` en `packages/renderer`.
- Archivos: claves solo con `storageKeys`; URLs solo con `fileUrl(key)`; ffmpeg con arrays de
  argumentos (`runFfmpeg`), nunca cadenas concatenadas.
- IA siempre detrás de un proveedor (`ctx.providers.*`) con implementación local; cada
  resultado dice qué proveedor lo produjo.
- Dependencias nuevas: `pnpm --filter <paquete> add <dep>` y decláralo.
- Sin `TODO`, funciones vacías ni datos simulados en rutas que el usuario ejecuta.
- Verifica antes de informar: `typecheck`, `lint`, tests y además ejercítalo de verdad
  (renderiza un fotograma, llama al endpoint, abre la página con Playwright).
