import type { Role } from '@parlante/shared';
import {
  CreditCard,
  KeyRound,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Users,
  Warehouse,
  Webhook,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/* The sections of the settings area. One entry drives the manifest routes, the section
 * navigation and the page frame, so they cannot drift apart. */

export type SectionId =
  | 'profile'
  | 'preferences'
  | 'workspace'
  | 'members'
  | 'billing'
  | 'consents'
  | 'apiKeys'
  | 'webhooks';

export type SectionGroup = 'account' | 'workspace' | 'developers';

export interface SectionDef {
  id: SectionId;
  path: string;
  icon: LucideIcon;
  group: SectionGroup;
  /** Role needed to SEE the content. Lower roles get an explanation instead of the data. */
  minRole?: Role;
}

export const SETTINGS_ROOT = '/settings';

export const SECTIONS: readonly SectionDef[] = [
  { id: 'profile', path: '/settings/profile', icon: UserRound, group: 'account' },
  { id: 'preferences', path: '/settings/preferences', icon: SlidersHorizontal, group: 'account' },
  { id: 'workspace', path: '/settings/workspace', icon: Warehouse, group: 'workspace' },
  { id: 'members', path: '/settings/members', icon: Users, group: 'workspace' },
  { id: 'billing', path: '/settings/billing', icon: CreditCard, group: 'workspace' },
  {
    id: 'consents',
    path: '/settings/consents',
    icon: ShieldCheck,
    group: 'workspace',
    minRole: 'admin',
  },
  {
    id: 'apiKeys',
    path: '/settings/api-keys',
    icon: KeyRound,
    group: 'developers',
    minRole: 'admin',
  },
  {
    id: 'webhooks',
    path: '/settings/webhooks',
    icon: Webhook,
    group: 'developers',
    minRole: 'admin',
  },
];

export const SECTION_GROUPS: readonly SectionGroup[] = ['account', 'workspace', 'developers'];

export const DEFAULT_SECTION = SECTIONS[0] as SectionDef;

export function sectionPath(id: SectionId): string {
  return (SECTIONS.find((section) => section.id === id) ?? DEFAULT_SECTION).path;
}

/** Section served by a location path (`/settings/api-keys/` → apiKeys), or null. */
export function sectionFromPath(pathname: string): SectionDef | null {
  const clean = pathname.replace(/\/+$/, '');
  return SECTIONS.find((section) => section.path === clean) ?? null;
}
