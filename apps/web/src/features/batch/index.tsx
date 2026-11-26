import { Rows3 } from 'lucide-react';
import { defineFeature } from '@/shell';
import { translations } from './i18n';

/**
 * Personalised videos in batch (master prompt §3.15): a video (or template) with
 * `{{variables}}` + a CSV → column mapping, row-by-row check, estimated cost, launch and
 * follow-up of the batch with its videos.
 */
export default defineFeature({
  id: 'batch',
  routes: [
    { path: '/batch', layout: 'app', lazy: () => import('./BatchesPage'), titleKey: 'titles.list' },
    {
      path: '/batch/new',
      layout: 'app',
      lazy: () => import('./NewBatchPage'),
      titleKey: 'titles.create',
      minRole: 'editor',
    },
    {
      path: '/batch/:batchId',
      layout: 'app',
      lazy: () => import('./BatchDetailPage'),
      titleKey: 'titles.detail',
      width: 'wide',
    },
  ],
  nav: [{ to: '/batch', labelKey: 'nav.batch', icon: Rows3, section: 'ai', order: 30 }],
  i18n: translations,
});
