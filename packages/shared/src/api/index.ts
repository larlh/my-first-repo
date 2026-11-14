import {
  batchRoutes,
  interactiveRoutes,
  photoAvatarRoutes,
  scriptWriterRoutes,
  translationRoutes,
  voiceCloneRoutes,
} from './ai';
import {
  assetRoutes,
  avatarRoutes,
  brandKitRoutes,
  shareRoutes,
  templateRoutes,
  videoRoutes,
  voiceRoutes,
} from './content';
import type { RouteDef } from './contract';
import {
  apiKeyRoutes,
  authRoutes,
  billingRoutes,
  consentRoutes,
  memberRoutes,
  webhookRoutes,
  workspaceRoutes,
} from './identity';
import { publicV1Routes } from './public-v1';
import { systemRoutes } from './system';

export * from './contract';
export * from './system';
export * from './identity';
export * from './content';
export * from './ai';
export * from './public-v1';

/**
 * The complete API surface, grouped by module. `api.videos.render` is a RouteDef.
 * Adding an endpoint = adding a RouteDef to the group of its module (additive change).
 */
export const api = {
  system: systemRoutes,
  auth: authRoutes,
  workspaces: workspaceRoutes,
  members: memberRoutes,
  apiKeys: apiKeyRoutes,
  webhooks: webhookRoutes,
  billing: billingRoutes,
  consents: consentRoutes,
  videos: videoRoutes,
  share: shareRoutes,
  assets: assetRoutes,
  avatars: avatarRoutes,
  voices: voiceRoutes,
  templates: templateRoutes,
  brandKits: brandKitRoutes,
  scriptWriter: scriptWriterRoutes,
  translations: translationRoutes,
  batches: batchRoutes,
  interactive: interactiveRoutes,
  photoAvatars: photoAvatarRoutes,
  voiceClones: voiceCloneRoutes,
  v1: publicV1Routes,
} as const;

export type ApiContract = typeof api;

/** Flat list of every route (docs, tests, contract checks). */
export function allRoutes(): { group: string; name: string; route: RouteDef }[] {
  const out: { group: string; name: string; route: RouteDef }[] = [];
  for (const [group, routes] of Object.entries(api)) {
    for (const [name, def] of Object.entries(routes as Record<string, RouteDef>)) {
      out.push({ group, name, route: def });
    }
  }
  return out;
}
