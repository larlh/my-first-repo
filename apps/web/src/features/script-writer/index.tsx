import { ScrollText } from 'lucide-react';
import { defineFeature } from '@/shell';
import { translations } from './i18n';

/**
 * AI script writer (master prompt §3.11): topic or URL + tone + duration + language → an
 * editable script split into scenes → "create a video with this script". The folder also
 * hosts the kit shared by the four AI tools (`./kit`).
 */
export default defineFeature({
  id: 'script-writer',
  routes: [
    {
      path: '/script-writer',
      layout: 'app',
      lazy: () => import('./ScriptWriterPage'),
      titleKey: 'page.tab',
      minRole: 'editor',
    },
  ],
  nav: [
    {
      to: '/script-writer',
      labelKey: 'nav.scriptWriter',
      icon: ScrollText,
      section: 'ai',
      order: 10,
      minRole: 'editor',
    },
  ],
  i18n: translations,
});
