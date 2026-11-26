import type { AvatarFraming, PhotoAvatarRig } from '@parlante/shared';
import { createPhotoAvatarRig, getStockAvatarRig } from '@parlante/renderer';
import type { AvatarRig, PixelBox } from '@parlante/renderer';
import { loadBrowserImage } from '@parlante/renderer/browser';
import { useEffect, useState } from 'react';
import { toAppUrl } from '@/lib/api';

/* Drawable avatars for the AI tools (pickers and the interactive stage). The rigs are the
 * ones of @parlante/renderer — the code that draws the avatar in the Studio preview and in
 * the exported video — so what a picker or a conversation shows is the real character. */

/** The fields of an `Avatar` DTO a canvas needs. */
export interface StageAvatar {
  id: string;
  rendering: 'instant' | 'photoreal';
  /** Photoreal: portrait with its matte applied; the stand-in rig is built from it. */
  cutoutUrl?: string | null;
  rig?: PhotoAvatarRig | null;
  thumbnailUrl?: string | null;
}

export type RigStatus = 'ready' | 'loading' | 'missing';

/* Stand-in rigs of photoreal avatars by avatar id. Signed URLs change between responses, so a
 * loaded rig is kept for the id and dropped when its geometry changes or the load fails. */
const photoRigs = new Map<string, { key: string; rig: Promise<AvatarRig> }>();

function loadPhotoRig(id: string, url: string, geometry: PhotoAvatarRig): Promise<AvatarRig> {
  const key = JSON.stringify(geometry);
  const cached = photoRigs.get(id);
  if (cached && cached.key === key) return cached.rig;
  const rig = loadBrowserImage(toAppUrl(url)).then((image) =>
    createPhotoAvatarRig(id, image, geometry),
  );
  photoRigs.set(id, { key, rig });
  rig.catch(() => {
    if (photoRigs.get(id)?.rig === rig) photoRigs.delete(id);
  });
  return rig;
}

/**
 * The rig of an avatar: the built-in parametric rig for instant (2D) avatars, the Canvas
 * stand-in over the cut-out for photorealistic ones (loaded on demand).
 */
export function useAvatarRig(avatar: StageAvatar | null): {
  rig: AvatarRig | null;
  status: RigStatus;
} {
  const id = avatar?.id ?? null;
  const instant = avatar?.rendering === 'instant';
  const cutoutUrl = avatar?.cutoutUrl ?? null;
  const geometry = avatar?.rig ?? null;
  const geometryKey = geometry ? JSON.stringify(geometry) : '';
  const [loaded, setLoaded] = useState<{ id: string; rig: AvatarRig | null } | null>(null);

  useEffect(() => {
    if (id === null || instant || !cutoutUrl || !geometry) return;
    let alive = true;
    loadPhotoRig(id, cutoutUrl, geometry).then(
      (rig) => alive && setLoaded({ id, rig }),
      () => alive && setLoaded({ id, rig: null }),
    );
    return () => {
      alive = false;
    };
    // The signed URL changes on every response; the avatar id + geometry identify the rig.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, instant, geometryKey, cutoutUrl === null]);

  if (id === null) return { rig: null, status: 'missing' };
  if (instant) {
    const stock = getStockAvatarRig(id);
    return { rig: stock, status: stock ? 'ready' : 'missing' };
  }
  if (!cutoutUrl || !geometry) return { rig: null, status: 'missing' };
  if (!loaded || loaded.id !== id) return { rig: null, status: 'loading' };
  return { rig: loaded.rig, status: loaded.rig ? 'ready' : 'missing' };
}

/**
 * Box the rig is drawn in. Rigs anchor to the bottom-centre of their box and frame themselves
 * inside it; a wide canvas keeps a portrait-ish box in the middle so the character is not
 * shrunk by a box much wider than a person.
 */
export function stageBox(width: number, height: number, framing: AvatarFraming): PixelBox {
  const maxAspect = framing === 'half' ? 0.8 : 1.15;
  const w = Math.min(width, height * maxAspect);
  return { x: (width - w) / 2, y: 0, w, h: height };
}

/** Canvas backing-store size for a CSS box: device pixels, capped so a big stage stays cheap. */
export function backingSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxSide = 1280,
): { width: number; height: number } {
  const dpr = Math.min(2, Math.max(1, devicePixelRatio || 1));
  const longest = Math.max(cssWidth, cssHeight) * dpr;
  const scale = longest > maxSide ? (dpr * maxSide) / longest : dpr;
  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
  };
}
