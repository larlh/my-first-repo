import { AudioLines } from 'lucide-react';
import { defineFeature } from '@/shell';
import { translations } from './i18n';

/** Voice library with a listening desk (master prompt §3.3). */
export default defineFeature({
  id: 'voices',
  routes: [
    {
      path: '/voices',
      layout: 'app',
      lazy: () => import('./VoicesPage'),
      titleKey: 'title',
      width: 'wide',
    },
  ],
  nav: [
    {
      to: '/voices',
      labelKey: 'nav.voices',
      icon: AudioLines,
      section: 'library',
      order: 25,
      end: true,
    },
  ],
  i18n: translations,
});
