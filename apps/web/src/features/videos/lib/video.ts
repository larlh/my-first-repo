import { creditsForRender, resolutionAllowed } from '@parlante/shared';
import type {
  AspectRatio,
  Capability,
  Composition,
  PlanId,
  Provenance,
  ProviderRef,
  Resolution,
  Video,
  VideoStatus,
  VideoSummary,
} from '@parlante/shared';

/* Pure helpers about a video and its render state. No React, no I/O. */

/** Queued or rendering: worth polling, and the output is not final. */
export function isVideoActive(video: { status: VideoStatus }): boolean {
  return video.status === 'queued' || video.status === 'rendering';
}

/**
 * The composition changed after the last render: the MP4 on screen no longer matches what the
 * Studio shows. Only meaningful once something has been rendered.
 */
export function isOutdated(
  video: Pick<Video, 'revision' | 'renderedRevision' | 'videoUrl'>,
): boolean {
  return (
    video.videoUrl !== null &&
    video.renderedRevision !== null &&
    video.revision > video.renderedRevision
  );
}

/** A share link can only be created for a video with a finished output. */
export function canShare(video: Pick<Video, 'status' | 'videoUrl'>): boolean {
  return video.status === 'completed' && video.videoUrl !== null;
}

export const RESOLUTIONS: readonly Resolution[] = ['720p', '1080p'];

export interface RenderQuote {
  resolution: Resolution;
  /** Credits the render will reserve (settled to the real duration afterwards). */
  credits: number;
  /** The plan of the workspace allows this resolution. */
  allowed: boolean;
  /** The balance covers the reservation. */
  affordable: boolean;
}

/** What rendering `video` would cost at each resolution, for a plan and a balance. */
export function quoteRender(
  video: Pick<Video, 'estimatedDurationMs' | 'usesPhotorealAvatars'>,
  plan: PlanId,
  balance: number,
): RenderQuote[] {
  return RESOLUTIONS.map((resolution) => {
    const credits = creditsForRender(video.estimatedDurationMs, resolution, {
      photoreal: video.usesPhotorealAvatars,
    });
    return {
      resolution,
      credits,
      allowed: resolutionAllowed(plan, resolution),
      affordable: credits <= balance,
    };
  });
}

/** Tailwind aspect utility of a poster / player frame. */
export const ASPECT_CLASS: Record<AspectRatio, string> = {
  '16:9': 'aspect-video',
  '9:16': 'aspect-[9/16]',
  '1:1': 'aspect-square',
};

/** Duration to show on a card: the real one once rendered, nothing before. */
export function cardDurationMs(video: Pick<VideoSummary, 'durationMs'>): number | null {
  return video.durationMs !== null && video.durationMs > 0 ? video.durationMs : null;
}

/** Order in which provenance is listed: what the viewer hears and sees first. */
const CAPABILITY_ORDER: readonly Capability[] = [
  'tts',
  'voiceClone',
  'lipsync',
  'portrait',
  'llm',
  'translation',
  'stt',
  'moderation',
  'storage',
];

export interface ProvenanceEntry {
  capability: Capability;
  provider: ProviderRef;
}

/** Provenance as an ordered list (unknown capabilities from a newer API go last). */
export function listProvenance(providers: Provenance | null | undefined): ProvenanceEntry[] {
  if (!providers) return [];
  const entries = Object.entries(providers) as [Capability, ProviderRef | undefined][];
  return entries
    .filter((entry): entry is [Capability, ProviderRef] => entry[1] !== undefined)
    .map(([capability, provider]) => ({ capability, provider }))
    .sort((a, b) => rank(a.capability) - rank(b.capability));
}

function rank(capability: Capability): number {
  const index = CAPABILITY_ORDER.indexOf(capability);
  return index === -1 ? CAPABILITY_ORDER.length : index;
}

/** True when any AI part of the output came from a local "modo básico" provider. */
export function hasBasicProvider(entries: readonly ProvenanceEntry[]): boolean {
  return entries.some(
    (entry) => entry.provider.quality === 'basic' && entry.capability !== 'storage',
  );
}

/** Safe file name for a download built from the video title. */
export function downloadFileName(title: string, extension: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 _-]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return `${base === '' ? 'video' : base}.${extension}`;
}

/** Base language (`es`, `en`…) of the narration: the first scene that has one. */
export function narrationLanguage(composition: Pick<Composition, 'scenes'>): string | null {
  for (const scene of composition.scenes) {
    const script = scene.script;
    if ((script.kind === 'tts' || script.kind === 'audio') && script.language) {
      return script.language.slice(0, 2).toLowerCase();
    }
  }
  return null;
}
