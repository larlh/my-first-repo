import { defineFeature } from '@/shell';
import { translations } from './i18n';

/**
 * Public page of a shared video (master prompt §3.6). `/s/:token` is the URL the API puts in
 * `ShareLink.url`; `/share/:token` is kept as a readable alias of the same page.
 */
export default defineFeature({
  id: 'share',
  routes: [
    {
      path: '/s/:token',
      layout: 'public',
      lazy: () => import('./SharePage'),
      titleKey: 'titles.share',
    },
    {
      path: '/share/:token',
      layout: 'public',
      lazy: () => import('./SharePage'),
      titleKey: 'titles.share',
    },
  ],
  i18n: translations,
});
