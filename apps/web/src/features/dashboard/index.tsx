import { House } from 'lucide-react';
import { PATHS, defineFeature } from '@/shell';
import { translations } from './i18n';

/**
 * Home page: three ways to start a video, the latest videos with their render state, and the
 * credits and plan usage of the workspace. An empty workspace gets a guide to the first video.
 */
export default defineFeature({
  id: 'dashboard',
  routes: [
    {
      path: PATHS.home,
      layout: 'app',
      lazy: () => import('./DashboardPage'),
      titleKey: 'titles.home',
      width: 'wide',
    },
  ],
  nav: [
    { to: PATHS.home, labelKey: 'nav.home', icon: House, section: 'main', order: 0, end: true },
  ],
  i18n: translations,
});
