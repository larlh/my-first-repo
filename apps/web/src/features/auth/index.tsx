import { Building2 } from 'lucide-react';
import { PATHS, defineFeature } from '@/shell';
import { translations } from './i18n';

/**
 * Accounts (master prompt §3.1): sign in, sign up, sign out and the workspace chooser. The
 * shell guards send anonymous visitors to `/login?next=<path>`; both forms return there.
 */
export default defineFeature({
  id: 'auth',
  routes: [
    {
      path: PATHS.login,
      layout: 'public',
      guestOnly: true,
      lazy: () => import('./LoginPage'),
      titleKey: 'titles.login',
    },
    {
      path: PATHS.register,
      layout: 'public',
      guestOnly: true,
      lazy: () => import('./RegisterPage'),
      titleKey: 'titles.register',
    },
    {
      path: '/logout',
      layout: 'public',
      lazy: () => import('./LogoutPage'),
      titleKey: 'titles.logout',
    },
    {
      path: '/workspaces',
      layout: 'app',
      lazy: () => import('./WorkspacesPage'),
      titleKey: 'titles.workspaces',
    },
  ],
  nav: [
    {
      to: '/workspaces',
      labelKey: 'nav.workspaces',
      icon: Building2,
      section: 'account',
      order: 10,
    },
  ],
  i18n: translations,
});
