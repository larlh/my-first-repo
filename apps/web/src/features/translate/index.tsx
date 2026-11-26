import { Languages } from 'lucide-react';
import { defineFeature } from '@/shell';
import { translations } from './i18n';

/**
 * Video translation (master prompt §3.12): upload or pick a video, choose target languages
 * (capped by the plan), supply the transcript when speech recognition is manual, see the cost
 * in credits, follow the progress per language and play / download the results.
 */
export default defineFeature({
  id: 'translate',
  routes: [
    {
      path: '/translate',
      layout: 'app',
      lazy: () => import('./TranslationsPage'),
      titleKey: 'titles.list',
    },
    {
      path: '/translate/new',
      layout: 'app',
      lazy: () => import('./NewTranslationPage'),
      titleKey: 'titles.create',
      minRole: 'editor',
    },
    {
      path: '/translate/:translationId',
      layout: 'app',
      lazy: () => import('./TranslationDetailPage'),
      titleKey: 'titles.detail',
      width: 'wide',
    },
  ],
  nav: [{ to: '/translate', labelKey: 'nav.translate', icon: Languages, section: 'ai', order: 20 }],
  i18n: translations,
});
