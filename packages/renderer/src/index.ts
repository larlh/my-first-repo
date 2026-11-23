/**
 * @parlante/renderer — isomorphic, deterministic Canvas2D renderer.
 *
 *   import { renderFrame, computeTimeline, MapRenderAssets } from '@parlante/renderer';
 *   import { nodePlatform, renderFrameToPng } from '@parlante/renderer/node';       // Node only
 *   import { browserPlatform } from '@parlante/renderer/browser';                   // browser only
 */
export * from './types';
export * from './timeline';
export * from './render-frame';
export * from './subtitles';
export * from './subtitle-draw';
export * from './media';
export * from './matte';
export * from './easing';
export * from './animation';
export { clearTextLayoutCache, layoutTextBlock, wrapText } from './text';
export type { TextBlock, TextLine } from './text';
export {
  setCanvasFactory,
  canCreateCanvas,
  clearRenderCaches,
  setRenderCacheBudget,
  renderCacheStats,
} from './cache';
export type { CanvasFactory } from './cache';
export { drawBackground, drawPlaceholder } from './background';
export type { DrawTarget } from './background';
export * from './fonts';
export * from './assets';
export * from './random';
export * from './avatars/index';
