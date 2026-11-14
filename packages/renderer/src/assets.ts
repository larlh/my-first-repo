import type { AvatarRig } from './avatars/types';
import { getStockAvatarRig } from './avatars/registry';
import type { RenderAssets, RenderImage, VideoFrameSource } from './types';

/**
 * Simple in-memory RenderAssets. Fill it before rendering:
 *
 *   const assets = new MapRenderAssets();
 *   assets.setImage(mediaRefKey(ref), await platform.loadImage(bytes));
 *   assets.setVideo(key, frameSource);
 *   assets.setAvatar(avatarId, createPhotoAvatarRig(avatarId, portrait, rig));   // stand-in
 *   assets.setAvatarClip(sceneId, layerId, clipFrames);                          // exports
 *
 * Stock avatars (`stock_…`) resolve automatically from the built-in registry.
 */
export class MapRenderAssets implements RenderAssets {
  private readonly images = new Map<string, RenderImage>();
  private readonly videos = new Map<string, VideoFrameSource>();
  private readonly avatars = new Map<string, AvatarRig>();
  private readonly avatarClips = new Map<string, VideoFrameSource>();

  setImage(key: string, image: RenderImage): this {
    this.images.set(key, image);
    return this;
  }

  setVideo(key: string, source: VideoFrameSource): this {
    this.videos.set(key, source);
    return this;
  }

  setAvatar(avatarId: string, rig: AvatarRig): this {
    this.avatars.set(avatarId, rig);
    return this;
  }

  /** Neural clip for the avatar layer `layerId` of scene `sceneId` (photoreal exports). */
  setAvatarClip(sceneId: string, layerId: string, source: VideoFrameSource): this {
    this.avatarClips.set(`${sceneId}/${layerId}`, source);
    return this;
  }

  avatarClip(sceneId: string, layerId: string): VideoFrameSource | null {
    return this.avatarClips.get(`${sceneId}/${layerId}`) ?? null;
  }

  image(key: string): RenderImage | null {
    return this.images.get(key) ?? null;
  }

  video(key: string): VideoFrameSource | null {
    return this.videos.get(key) ?? null;
  }

  avatar(avatarId: string): AvatarRig | null {
    return this.avatars.get(avatarId) ?? getStockAvatarRig(avatarId);
  }
}

/** RenderAssets with only the built-in stock avatars (enough for avatar-only previews). */
export const EMPTY_ASSETS: RenderAssets = new MapRenderAssets();
