import { MessagesSquare } from 'lucide-react';
import { defineFeature } from '@/shell';
import { translations } from './i18n';

/**
 * Interactive avatar (master prompt §3.16): a real-time conversation in the browser. The
 * person writes, the answer comes back as text + audio + viseme timeline and the avatar speaks
 * it on a canvas with the rigs of @parlante/renderer.
 */
export default defineFeature({
  id: 'interactive',
  routes: [
    {
      path: '/interactive',
      layout: 'app',
      lazy: () => import('./InteractivePage'),
      titleKey: 'page.tab',
    },
    {
      path: '/interactive/:sessionId',
      layout: 'app',
      lazy: () => import('./SessionPage'),
      titleKey: 'session.tab',
      width: 'wide',
    },
  ],
  nav: [
    {
      to: '/interactive',
      labelKey: 'nav.interactive',
      icon: MessagesSquare,
      section: 'ai',
      order: 40,
    },
  ],
  i18n: translations,
});
