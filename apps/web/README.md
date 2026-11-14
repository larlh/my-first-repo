# @parlante/web

Aplicación web de Parlante: Vite + React 19 + React Router 7 + TanStack Query 5 + Tailwind 4.

Este paquete tiene dos partes con dueños distintos:

| Parte            | Carpeta                                                                        | Quién la toca                                                |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Shell** (base) | `src/app`, `src/lib`, `src/ui`, `src/components`, `src/styles`, `src/shell.ts` | agente `base-web`                                            |
| **Features**     | `src/features/<nombre>/`                                                       | un agente por feature; **nunca editan archivos compartidos** |

Un feature se añade creando una carpeta. No hay que registrar nada en el router, el menú ni i18n.

## Arrancar

```bash
pnpm services                       # Postgres + Redis (raíz del repo)
pnpm dev:api                        # API en :4000
pnpm --filter @parlante/web dev     # web en http://localhost:5173
```

| Script                                       | Qué hace                                            |
| -------------------------------------------- | --------------------------------------------------- |
| `pnpm dev`                                   | Servidor de desarrollo en el puerto 5173 (estricto) |
| `pnpm build`                                 | `tsc --noEmit` + build de producción en `dist/`     |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | Comprobaciones (vitest + Testing Library, jsdom)    |

### Variables de entorno

Todas opcionales (ver `.env.example`; copiar a `apps/web/.env.local` para cambiarlas).

| Variable                | Por defecto             | Uso                                                                                                                                                                               |
| ----------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_PROXY_TARGET` | `http://localhost:4000` | A dónde reenvía el servidor de Vite las rutas de la API. Solo la lee `vite.config.ts`.                                                                                            |
| `VITE_API_URL`          | _(vacío)_               | URL base que usa el navegador para la API. Vacío = mismo origen (proxy). Rellenar solo si web y API viven en orígenes distintos; ese origen debe estar en `WEB_ORIGIN` de la API. |

### Proxy

En desarrollo (y en `vite preview`) se reenvían a la API: `/api` (API propia **y archivos firmados** `/api/files/*`), `/v1`, `/health`, `/docs` y `/openapi.json`. Así la cookie de sesión y los medios son del mismo origen.

La API devuelve URLs de archivo absolutas (`http://localhost:4000/api/files/...`). `toAppUrl(url)` (`@/lib/api`) las pasa al origen de la app en desarrollo, de modo que `fetch()` de subtítulos no necesita CORS y los canvas que dibujan imágenes o vídeo siguen siendo legibles. `VideoPlayer` ya lo aplica; úsalo también antes de dibujar un asset en un canvas.

## Añadir un feature (patrón copiable)

Ejemplo vivo: `src/features/_example` (solo se monta en desarrollo; visítalo en `/dev/example`).

```
src/features/videos/
  index.tsx          manifiesto (export default)
  VideosPage.tsx     página (export default), cargada bajo demanda
  ...                lo que necesite el feature
```

```tsx
// src/features/videos/index.tsx
import { Film, Plus } from 'lucide-react';
import { defineFeature } from '@/shell';

export default defineFeature({
  id: 'videos', // único, kebab-case; también es el namespace de i18n
  routes: [
    {
      path: '/videos',
      layout: 'app',
      lazy: () => import('./VideosPage'),
      titleKey: 'title',
      width: 'wide',
    },
    { path: '/videos/:videoId', layout: 'app', lazy: () => import('./VideoDetailPage') },
    {
      path: '/studio/:videoId',
      layout: 'fullscreen',
      lazy: () => import('./StudioPage'),
      minRole: 'editor',
    },
    { path: '/share/:token', layout: 'public', lazy: () => import('./SharePage') },
  ],
  nav: [
    { to: '/videos', labelKey: 'nav.videos', icon: Film, section: 'library', order: 10 },
    { to: '/videos/new', labelKey: 'nav.create', icon: Plus, section: 'main', cta: true },
  ],
  i18n: {
    es: { title: 'Vídeos', nav: { videos: 'Vídeos', create: 'Crear vídeo' } },
    en: { title: 'Videos', nav: { videos: 'Videos', create: 'Create video' } },
  },
});
```

```tsx
// src/features/videos/VideosPage.tsx
import { useTranslation } from 'react-i18next';
import { api, useApiInfiniteQuery } from '@/lib/api';
import { EmptyState, ErrorState, LoadMore, PageHeader, Skeleton } from '@/ui';

export default function VideosPage() {
  const { t } = useTranslation('videos');
  const videos = useApiInfiniteQuery(api.videos.list, { query: { limit: 24 } });

  return (
    <>
      <PageHeader title={t('title')} />
      {videos.isPending ? (
        <Skeleton className="h-40" />
      ) : videos.isError ? (
        <ErrorState error={videos.error} onRetry={() => void videos.refetch()} />
      ) : videos.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul>
          {videos.items.map((video) => (
            <li key={video.id}>{video.title}</li>
          ))}
        </ul>
      )}
      <LoadMore
        hasMore={videos.hasNextPage}
        loading={videos.isFetchingNextPage}
        onLoadMore={() => void videos.fetchNextPage()}
      />
    </>
  );
}
```

### Manifiesto

`routes[]`

| Campo                | Significado                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`               | Ruta absoluta de React Router (`/videos/:videoId`). No puede repetirse entre features.                                                                              |
| `layout`             | `app` = requiere sesión, dentro del layout con barra lateral · `fullscreen` = requiere sesión, sin cromo (Studio) · `public` = sin sesión (login, vídeo compartido) |
| `lazy` / `component` | Página cargada bajo demanda (`() => import('./Page')`, export default) o componente directo                                                                         |
| `minRole`            | Rol mínimo (`viewer` < `editor` < `admin` < `owner`); por debajo se muestra «sin acceso»                                                                            |
| `guestOnly`          | Solo `public`: con sesión iniciada redirige a `?next=` o al inicio (login, registro)                                                                                |
| `titleKey`           | Clave i18n (namespace del feature) para el título de la pestaña                                                                                                     |
| `width`              | Solo `app`: `default` (76rem) · `wide` (galerías, tablas) · `full` (sin márgenes; la página se maqueta sola)                                                        |

`nav[]`

| Campo                    | Significado                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `to`, `labelKey`, `icon` | Destino, clave i18n del feature e icono de `lucide-react`                                                                                  |
| `section`                | `main` · `library` · `ai` · `workspace` (grupos de la barra lateral, en ese orden) · `account` (menú de usuario) · `dev` (solo desarrollo) |
| `order`                  | Posición dentro del grupo (ascendente; por defecto 100)                                                                                    |
| `minRole`                | Oculta la entrada por debajo de ese rol                                                                                                    |
| `end`                    | Activa solo en la ruta exacta                                                                                                              |
| `cta`                    | La entrada se pinta como EL botón principal de la barra lateral («Crear vídeo»). Una por aplicación.                                       |

`i18n`: `{ es: {...}, en: {...} }`, ambos obligatorios. `devOnly: true` monta el feature solo en desarrollo.

Los manifiestos inválidos (id repetido, ruta duplicada, ruta sin página…) no rompen la app: se omiten y se listan con `console.error` al arrancar.

### Rutas que el shell conoce (`PATHS` en `@/shell`)

| Ruta                | Para qué                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`            | Destino de las guardas cuando no hay sesión (`/login?next=<ruta>`). **Debe aportarla el feature de autenticación** (`layout: 'public', guestOnly: true`). |
| `/register`         | Convención para el registro                                                                                                                               |
| `/`                 | Si ningún feature la registra, el shell redirige a la primera entrada de navegación                                                                       |
| `/settings/billing` | Si algún feature la registra, el saldo de créditos de la barra lateral enlaza a ella                                                                      |

Tras un login/registro correcto: `useSessionState().setSession(respuesta)` y `navigate(useNextPath())`. Para el marco visual de las páginas públicas con formulario usa `<AuthShell>` (vista previa en `/dev/auth`).

## Qué ofrece el shell

| Import                      | Contenido                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@/shell`                   | `defineFeature`, `PATHS`, `useNextPath`, `safeNextPath`, `RequireRole`, `AuthShell`, `PublicPreferences`, `DocumentTitle`, `PageLoader` |
| `@/ui`                      | Kit de componentes (catálogo en `/dev/ui`) y `cn()`                                                                                     |
| `@/components/*`            | `Logo`, `VideoPlayer`, `JobStatus` / `JobStatusBadge`, `ProviderBadge`                                                                  |
| `@/lib/api`                 | Cliente tipado, hooks de TanStack Query, subida con progreso, `ApiError`, `toAppUrl`, `downloadUrl`                                     |
| `@/lib/session`             | `useSession()`, `useSessionState()`                                                                                                     |
| `@/lib/jobs`                | `useJobPolling`, `jobPhaseOf`, `EtaEstimator`                                                                                           |
| `@/lib/format`              | `useFormat()` y funciones de fechas, duraciones, tamaños, números, precios                                                              |
| `@/lib/i18n`, `@/lib/theme` | `changeLocale`, `currentLocale`, `useTheme()`                                                                                           |

### Cliente de API

Se deriva de la tabla de rutas de `@parlante/shared` (`api`): los tipos de `params`, `query` y `body` son los tipos de **entrada** de zod, y la respuesta el de **salida**. Si shared añade una ruta, existe aquí sin tocar nada.

```ts
import {
  api,
  apiClient,
  useApiQuery,
  useApiMutation,
  useApiInfiniteQuery,
  useUpload,
  isApiError,
} from '@/lib/api';

// Imperativo
const video = await apiClient.videos.get({ params: { videoId } });

// Hooks (clave de caché: ['api', route.path, { params, query }])
const query = useApiQuery(api.videos.get, { params: { videoId } }, { enabled: Boolean(videoId) });
const rename = useApiMutation(api.videos.update, {
  invalidates: [api.videos.list, api.videos.get],
});
rename.mutate({ params: { videoId }, body: { title } });
const list = useApiInfiniteQuery(api.assets.list, { query: { kind: 'image' } }); // list.items, list.fetchNextPage

// Subida multipart con progreso y cancelación
const { upload, progress, status, cancel } = useUpload(api.assets.upload, {
  invalidates: [api.assets.list],
});
await upload({ file, fields: { name: file.name } });
```

- Las cookies van incluidas (`credentials: 'include'`).
- Todo error es un `ApiError` con `code`, `status`, `message`, `details`, `issues` y `fieldErrors` (para formularios). Códigos propios del cliente: `NETWORK_ERROR`, `ABORTED`, `INVALID_RESPONSE`.
- Un `401 UNAUTHENTICATED` en una ruta de sesión vacía la sesión y las guardas llevan a `/login?next=…`. No hay que tratarlo en cada pantalla.
- `<ErrorState error={e} />` y `useErrorText()` traducen los códigos al idioma de la UI.
- En desarrollo, cada respuesta se comprueba contra el esquema de la ruta y se avisa por consola si la API se desvía del contrato.

### Sesión y workspace

```ts
const { user, workspace, role, plan, credits, can, switchWorkspace, logout, refresh, setLocale } =
  useSession();
if (can('editor')) {
  /* … */
}
```

`useSession()` es para rutas `app`/`fullscreen` (nada es nulo). En páginas públicas usa `useSessionState()` (`status`: `loading | authenticated | anonymous | error`). Después de una operación que gasta créditos llama a `refresh()`.

### Trabajos asíncronos

```tsx
const job = useJobPolling(
  api.videos.get,
  { params: { videoId } },
  {
    select: (v) => ({ status: v.status, progress: v.progress, etaSec: v.renderEtaSec }),
    onSettled: (video, phase) => phase === 'completed' && toast.success(t('rendered')),
  },
);
<JobStatus
  label={video.title}
  status={job.phase}
  progress={job.progress}
  etaSec={job.etaSec}
  etaEstimated={job.etaEstimated}
  stage={t(`stage.${video.renderStage}`)}
/>;
```

Sondea mientras el recurso está en cola o en proceso y se detiene solo. Si la API no informa de tiempo restante, lo estima a partir del ritmo observado y lo marca como aproximado (`etaEstimated`).

### i18n

Español por defecto e inglés. Orden de detección: elección guardada → idioma del navegador → `es`. El namespace `shell` es del shell y del kit; cada feature usa el suyo (`useTranslation('<id>')`). No escribas textos visibles sin traducir.

## Sistema de diseño — «Cabina»

La dirección visual es la cabina de grabación: **papel cálido y tinta berenjena** en lugar de gris sobre blanco, una única **señal bermellón** («en el aire») que siempre lleva texto en tinta, y **azafrán** para créditos y destacados. La barra lateral es tinta en los dos temas.

- **Tipografías** (empaquetadas con @fontsource): _Bricolage Grotesque_ condensada para titulares (`h1`–`h4` y la utilidad `display`), _Instrument Sans_ para la interfaz, _JetBrains Mono_ para código y tiempos.
- **Tokens** en `src/styles/tokens.css` (variables CSS) expuestos como utilidades de Tailwind.
- **Tema**: `html[data-theme="light|dark"]`; sigue al sistema y se puede fijar (persistido en `localStorage`). Los tokens cambian solos: **no hace falta la variante `dark:`**.

| Para       | Utilidades                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------- |
| Fondos     | `bg-bg` (página) · `bg-bg-sunken` · `bg-surface` (tarjetas) · `bg-surface-2` · `bg-surface-3` |
| Texto      | `text-fg` · `text-fg-muted` · `text-fg-subtle`                                                |
| Bordes     | `border-line` · `border-line-strong` · `border-line-control` (controles de formulario)        |
| Señal      | `bg-accent text-accent-fg` · `hover:bg-accent-hover` · `bg-accent-soft text-accent-text`      |
| Azafrán    | `bg-saffron text-saffron-fg` · `bg-saffron-soft text-saffron-text`                            |
| Estado     | `success` · `warning` · `danger` · `info`, cada uno con `-soft` y `-text`                     |
| Inverso    | `bg-inverse text-inverse-fg`                                                                  |
| Vídeo      | `bg-media text-on-media` (siempre oscuro) · `bg-scrim` (velo de modales)                      |
| Forma      | `rounded-xs                                                                                   | sm   | md    | lg  | xl  | 2xl`·`shadow-xs | sm  | md  | lg` |
| Tipografía | `display` · `eyebrow` · `nums` (cifras tabulares) · `font-display                             | sans | mono` |
| Textura    | `booth-grid` (trama de puntos de la marca) · `shimmer`                                        |

Reglas (las hace cumplir `src/design-lint.test.ts`, que también recorre `src/features`):

1. **Nada de clases de paleta de Tailwind** (`bg-white`, `text-gray-500`, `border-slate-200`…): rompen el modo oscuro. Usa tokens. Excepción deliberada: `design-lint-ignore` en la misma línea.
2. Los tokens mantienen contraste WCAG AA en ambos temas (el test lo calcula).
3. El texto sobre `bg-accent` es siempre `text-accent-fg` (tinta), nunca blanco.

Consejos de maquetación:

- Dentro de un grid CSS, una tabla o un contenido ancho necesita `min-w-0` en su celda (o `grid-cols-[minmax(0,1fr)]`) para no ensanchar la página en móvil.
- El foco visible es global (anillo de 2 px); no lo quites. En superficies oscuras fijas cambia su color con `[--ring:var(--saffron)]`.

### Kit de componentes (`@/ui`)

`Button`, `IconButton`, `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `Slider`, `Tabs`/`TabPanel`, `SegmentedControl`, `Dialog`, `Drawer`, `ConfirmDialog` + `useConfirm()`, `Menu*` (menú desplegable), `Popover*`, `Tooltip`, `toast` + `Toaster`, `Badge`, `Avatar` (alias `UserAvatar`), `Card*`, `Table*`, `LoadMore`, `Skeleton`, `SkeletonText`, `EmptyState`, `ErrorState`, `ProgressBar`, `Spinner`, `VoiceBars`, `FileDropzone`, `ColorPicker`, `PageHeader`, `Field`, `Label`.

Todos funcionan con teclado, tienen foco visible y roles/nombres ARIA (los interactivos complejos se apoyan en Radix). Catálogo con ejemplos en ambos temas: **`/dev/ui`** (solo en desarrollo; `?view=light|dark|both`).

Cada vista debe cubrir sus estados: carga (`Skeleton`/`VoiceBars`), vacío (`EmptyState`) y error (`ErrorState` con reintento).

## Estructura

```
src/
  main.tsx, index.css, fonts.css   entrada; fonts.css = fuentes para composiciones de vídeo (canvas)
  shell.ts                         superficie pública del shell para los features
  app/                             registro de features (import.meta.glob), router, guardas, layouts, páginas de sistema, /dev/*
  lib/                             api, session, i18n, theme, format, jobs
  ui/                              kit de componentes
  components/                      Logo, VideoPlayer, JobStatus, ProviderBadge
  styles/                          tokens.css, base.css
  features/                        un directorio por feature (autocargado)
```
