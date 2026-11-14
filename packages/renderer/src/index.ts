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
export * from './easing';
export * from './fonts';
export * from './assets';
export * from './random';
export * from './avatars/index';
