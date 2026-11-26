import { Film, Plus } from 'lucide-react';
import { defineFeature } from '@/shell';
import { translations } from './i18n';

/**
 * Video library (master prompt §3.6): list with search / status filter / pagination and live
 * render progress, the detail page (player, subtitles, downloads, share link, provenance) and
 * the "new video" chooser behind the sidebar call to action.
 */
export default defineFeature({
  id: 'videos',
  routes: [
    {
      path: '/videos',
      layout: 'app',
      lazy: () => import('./VideosPage'),
      titleKey: 'titles.list',
      width: 'wide',
    },
    {
      path: '/videos/new',
      layout: 'app',
      lazy: () => import('./NewVideoPage'),
      titleKey: 'titles.create',
      minRole: 'editor',
    },
    {
      path: '/videos/:videoId',
      layout: 'app',
      lazy: () => import('./VideoDetailPage'),
      titleKey: 'titles.detail',
    },
  ],
  nav: [
    {
      to: '/videos/new',
      labelKey: 'nav.create',
      icon: Plus,
      section: 'main',
      cta: true,
      minRole: 'editor',
    },
    { to: '/videos', labelKey: 'nav.videos', icon: Film, section: 'library', order: 10 },
  ],
  i18n: translations,
});
