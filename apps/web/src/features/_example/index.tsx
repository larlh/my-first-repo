import { FlaskConical, Palette } from 'lucide-react';
import { defineFeature } from '@/shell';

/**
 * Minimal feature used as the copy-paste pattern (see apps/web/README.md). It is `devOnly`:
 * production builds do not mount it.
 *
 * A feature = one folder in src/features with an index that default-exports a manifest:
 * routes (lazy pages), navigation entries and its own i18n namespace. Nothing else to edit.
 */
export default defineFeature({
  id: 'example',
  devOnly: true,
  routes: [
    {
      path: '/dev/example',
      layout: 'app',
      lazy: () => import('./ExamplePage'),
      titleKey: 'title',
    },
  ],
  nav: [
    { to: '/dev/example', labelKey: 'nav.example', icon: FlaskConical, section: 'dev', order: 10 },
    { to: '/dev/ui', labelKey: 'nav.ui', icon: Palette, section: 'dev', order: 20 },
  ],
  i18n: {
    es: {
      title: 'Feature de ejemplo',
      nav: { example: 'Feature de ejemplo', ui: 'Catálogo de componentes' },
      description:
        'Patrón mínimo de un feature: manifiesto, página cargada bajo demanda, sesión, consulta tipada, mutación y sondeo de un trabajo.',
      session: {
        title: 'Sesión y workspace',
        user: 'Usuario',
        workspace: 'Workspace',
        role: 'Rol',
        plan: 'Plan',
        credits: 'Créditos',
      },
      capabilities: {
        title: 'Proveedores activos',
        text: 'GET /api/capabilities — qué proveedor atiende cada capacidad de IA en este servidor.',
        empty: 'El servidor no ha declarado proveedores.',
      },
      ping: {
        title: 'Viaje de ida y vuelta al worker',
        text: 'Encola un trabajo de prueba y sondea su estado hasta que el worker responde. Requiere rol de administrador.',
        action: 'Enviar ping',
        label: 'Ping al worker',
        done: 'El worker ha respondido',
        failed: 'El ping ha fallado',
        echo: 'Eco: {{echo}}',
      },
    },
    en: {
      title: 'Example feature',
      nav: { example: 'Example feature', ui: 'Component catalogue' },
      description:
        'Smallest possible feature: manifest, lazily loaded page, session, typed query, mutation and job polling.',
      session: {
        title: 'Session and workspace',
        user: 'User',
        workspace: 'Workspace',
        role: 'Role',
        plan: 'Plan',
        credits: 'Credits',
      },
      capabilities: {
        title: 'Active providers',
        text: 'GET /api/capabilities — which provider serves each AI capability on this server.',
        empty: 'The server declared no providers.',
      },
      ping: {
        title: 'Round trip to the worker',
        text: 'Queues a test job and polls its state until the worker answers. Needs the admin role.',
        action: 'Send ping',
        label: 'Worker ping',
        done: 'The worker answered',
        failed: 'The ping failed',
        echo: 'Echo: {{echo}}',
      },
    },
  },
});
