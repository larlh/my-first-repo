import { Mic } from 'lucide-react';
import { defineFeature } from '@/shell';
import { translations } from './i18n';

/** Clone a voice from a sample, with mandatory consent (master prompt §3.14, §5). */
export default defineFeature({
  id: 'voice-clone',
  routes: [
    {
      path: '/voices/clone',
      layout: 'app',
      lazy: () => import('./CloneVoicePage'),
      titleKey: 'title',
      minRole: 'editor',
      width: 'wide',
    },
  ],
  nav: [
    {
      to: '/voices/clone',
      labelKey: 'nav.voiceClone',
      icon: Mic,
      section: 'ai',
      order: 70,
      minRole: 'editor',
    },
  ],
  i18n: translations,
});
