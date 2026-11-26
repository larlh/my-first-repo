import { UserRoundPlus } from 'lucide-react';
import { defineFeature } from '@/shell';
import { translations } from './i18n';

/**
 * Create a photorealistic avatar from a photo (consent required) or from a description, with
 * the state of the local neural engine (master prompt §2b, §3.14, §5).
 */
export default defineFeature({
  id: 'photo-avatar',
  routes: [
    {
      path: '/avatars/new',
      layout: 'app',
      lazy: () => import('./NewAvatarPage'),
      titleKey: 'title',
      minRole: 'editor',
      width: 'wide',
    },
  ],
  nav: [
    {
      to: '/avatars/new',
      labelKey: 'nav.photoAvatar',
      icon: UserRoundPlus,
      section: 'ai',
      order: 60,
      minRole: 'editor',
    },
  ],
  i18n: translations,
});
