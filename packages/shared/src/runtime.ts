import { z } from 'zod';
import { VisemeSchema } from './visemes';

/* -------------------------------------------------------------------------------------------
 * Render runtime: everything the renderer needs besides the Composition, produced by the audio
 * stage (TTS or uploaded audio analysis). One SceneRuntime per scene.
 *
 * ALL TIMES ARE RELATIVE TO THE START OF THE SCENE'S NARRATION AUDIO (not the scene, not the
 * video). The narration starts `scene.paddingStartMs` after the scene starts — see
 * `computeTimeline` in packages/renderer for the mapping.
 * ----------------------------------------------------------------------------------------- */

/** The mouth takes shape `viseme` at `tMs` and holds it until the next cue. Sorted by tMs. */
export const VisemeCueSchema = z.object({
  tMs: z.number().min(0),
  viseme: VisemeSchema,
});
export type VisemeCue = z.infer<typeof VisemeCueSchema>;

/** A spoken word (with attached punctuation) and when it is said. Sorted by tMs. */
export const WordCueSchema = z.object({
  tMs: z.number().min(0),
  durMs: z.number().min(0),
  text: z.string(),
});
export type WordCue = z.infer<typeof WordCueSchema>;

export const SceneRuntimeSchema = z.object({
  /** Length of the narration audio in ms (0 when the scene has no narration). */
  audioDurationMs: z.number().min(0),
  visemes: z.array(VisemeCueSchema),
  words: z.array(WordCueSchema),
});
export type SceneRuntime = z.infer<typeof SceneRuntimeSchema>;

/** Runtime for a whole composition: sceneId → SceneRuntime. Scenes may be missing (= silent). */
export const RenderRuntimeSchema = z.object({
  scenes: z.record(z.string(), SceneRuntimeSchema),
});
export type RenderRuntime = z.infer<typeof RenderRuntimeSchema>;

export const EMPTY_SCENE_RUNTIME: SceneRuntime = Object.freeze({
  audioDurationMs: 0,
  visemes: [],
  words: [],
}) as SceneRuntime;

export const EMPTY_RENDER_RUNTIME: RenderRuntime = Object.freeze({ scenes: {} }) as RenderRuntime;
