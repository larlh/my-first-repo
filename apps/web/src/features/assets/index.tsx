import { FolderOpen, MousePointerClick } from 'lucide-react';
import { defineFeature } from '@/shell';
import type { FeatureRoute, NavItem } from '@/shell';
import { translations } from './i18n';

/* Development-only playground of the picker (never part of a production build). */
const devRoutes: FeatureRoute[] = import.meta.env.DEV
  ? [{ path: '/dev/asset-picker', layout: 'app', lazy: () => import('./PickerDemoPage') }]
  : [];
const devNav: NavItem[] = import.meta.env.DEV
  ? [
      {
        to: '/dev/asset-picker',
        labelKey: 'nav.pickerDemo',
        icon: MousePointerClick,
        section: 'dev',
        order: 30,
      },
    ]
  : [];

/**
 * Asset library (master prompt §3.8): upload and manage the images, video and audio that
 * compositions use. Other features open the reusable picker exported by `./picker`:
 *
 *   import { AssetPicker } from '@/features/assets/picker';
 */
export default defineFeature({
  id: 'assets',
  routes: [
    {
      path: '/assets',
      layout: 'app',
      lazy: () => import('./AssetsPage'),
      titleKey: 'title',
      width: 'wide',
    },
    ...devRoutes,
  ],
  nav: [
    { to: '/assets', labelKey: 'nav.assets', icon: FolderOpen, section: 'library', order: 40 },
    ...devNav,
  ],
  i18n: translations,
});
