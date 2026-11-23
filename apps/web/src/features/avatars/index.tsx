import { UsersRound } from 'lucide-react';
import { defineFeature } from '@/shell';
import { translations } from './i18n';

/**
 * Avatar library (master prompt §3.2 and §2b). Also hosts the kit shared by the other library
 * features (`./kit`: animated avatar stage, consent form, engine panel, voice preview…).
 */
export default defineFeature({
  id: 'avatars',
  routes: [
    {
      path: '/avatars',
      layout: 'app',
      lazy: () => import('./AvatarsPage'),
      titleKey: 'title',
      width: 'wide',
    },
  ],
  nav: [
    {
      to: '/avatars',
      labelKey: 'nav.avatars',
      icon: UsersRound,
      section: 'library',
      order: 20,
      end: true,
    },
  ],
  i18n: translations,
});
