import type { Capability, Provenance, ProviderRef } from '@parlante/shared';

/** What a visitor of the public page is told about: how the video sounds and looks. */
const PUBLIC_CAPABILITIES: readonly Capability[] = ['tts', 'voiceClone', 'lipsync', 'portrait'];

export interface PublicProvenanceEntry {
  capability: Capability;
  provider: ProviderRef;
}

/**
 * Provenance shown on the public page, in a fixed order. Internals (storage, moderation…) are
 * left out: they say nothing about the content a visitor is watching.
 */
export function listProvenance(providers: Provenance | null | undefined): PublicProvenanceEntry[] {
  if (!providers) return [];
  return PUBLIC_CAPABILITIES.flatMap((capability) => {
    const provider = providers[capability];
    return provider ? [{ capability, provider }] : [];
  });
}
