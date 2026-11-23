import { Settings, UserRound } from 'lucide-react';
import { defineFeature } from '@/shell';
import type { FeatureRoute } from '@/shell';
import SettingsPage from './SettingsPage';
import { translations } from './i18n';
import { SECTIONS, SETTINGS_ROOT, sectionPath } from './sections';

/**
 * Settings (master prompt §3.1, §3.9, §3.10, §5): profile and preferences, workspace, members
 * and invitations, simulated billing with the credit ledger, consent records, API keys and
 * webhooks, plus the link to the OpenAPI docs of the public API.
 *
 * Every `/settings/<section>` path renders the same small frame (`SettingsPage`, bundled
 * eagerly so the section navigation stays mounted between sections); each section is a lazy
 * chunk. Role gating happens inside the sections, which explain what is missing instead of
 * showing a bare "no access" page. `/invite/:token` is the public landing page of the
 * invitation links the API generates.
 */
const sectionRoutes: FeatureRoute[] = SECTIONS.map((section) => ({
  path: section.path,
  layout: 'app',
  component: SettingsPage,
  titleKey: `sections.${section.id}.label`,
}));

export default defineFeature({
  id: 'settings',
  routes: [
    { path: SETTINGS_ROOT, layout: 'app', component: SettingsPage, titleKey: 'title' },
    ...sectionRoutes,
    {
      path: '/invite/:token',
      layout: 'public',
      lazy: () => import('./InvitePage'),
      titleKey: 'invite.tab',
    },
  ],
  nav: [
    {
      to: SETTINGS_ROOT,
      labelKey: 'nav.settings',
      icon: Settings,
      section: 'workspace',
      order: 90,
    },
    {
      to: sectionPath('profile'),
      labelKey: 'nav.profile',
      icon: UserRound,
      section: 'account',
      order: 20,
    },
  ],
  i18n: translations,
});
