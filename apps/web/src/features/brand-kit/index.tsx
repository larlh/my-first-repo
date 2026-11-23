import { Palette } from 'lucide-react';
import { defineFeature } from '@/shell';
import { translations } from './i18n';

/** Brand kit: logo, colours and typography with a live preview (master prompt §3.13). */
export default defineFeature({
  id: 'brand-kit',
  routes: [
    {
      path: '/brand-kit',
      layout: 'app',
      lazy: () => import('./BrandKitPage'),
      titleKey: 'title',
      width: 'wide',
    },
  ],
  nav: [
    { to: '/brand-kit', labelKey: 'nav.brandKit', icon: Palette, section: 'library', order: 50 },
  ],
  i18n: translations,
});
