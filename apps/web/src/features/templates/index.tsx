import { LayoutTemplate } from 'lucide-react';
import { defineFeature } from '@/shell';
import { translations } from './i18n';

/** Template gallery: built-in and custom templates, live preview, "use template" (§3.7). */
export default defineFeature({
  id: 'templates',
  routes: [
    {
      path: '/templates',
      layout: 'app',
      lazy: () => import('./TemplatesPage'),
      titleKey: 'title',
      width: 'wide',
    },
  ],
  nav: [
    {
      to: '/templates',
      labelKey: 'nav.templates',
      icon: LayoutTemplate,
      section: 'library',
      order: 15,
    },
  ],
  i18n: translations,
});
