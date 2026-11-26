import { defineFeature } from '@/shell';
import { translations } from './i18n';

/**
 * Studio (master prompt §3.4): the multi-scene video editor. Full-screen, editors and above.
 * The live preview draws with `renderFrame` from @parlante/renderer — the same code as the
 * export — and plays the narration returned by POST /api/tts/synthesize.
 */
export default defineFeature({
  id: 'studio',
  routes: [
    {
      path: '/studio/:videoId',
      layout: 'fullscreen',
      lazy: () => import('./StudioPage'),
      titleKey: 'titles.studio',
      minRole: 'editor',
    },
  ],
  i18n: translations,
});
