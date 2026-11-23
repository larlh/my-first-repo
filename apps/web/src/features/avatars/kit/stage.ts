import { estimateSpeechMs, sceneRuntimeFromTranscript } from '@parlante/shared';
import type { AvatarFraming, SceneRuntime } from '@parlante/shared';
import { computeAvatarState } from '@parlante/renderer';
import type { AvatarState, PixelBox } from '@parlante/renderer';

/* Pure pieces of the animated avatar preview (`AvatarStage`): which pose to draw at a given
 * instant and where. The pose always comes from `computeAvatarState` of @parlante/renderer —
 * the function the Studio preview and the export use — so a card in the library moves exactly
 * like the avatar will in a video. */

/** What a stage is doing. */
export type StageMode =
  /** Breathing, blinking, looking around. */
  | 'idle'
  /** Mouthing a sample line in a loop, without sound (hover / focus of a card). */
  | 'demo'
  /** Following real audio: the caller supplies the runtime and a clock. */
  | 'speech';

/** Silent sample lines for the `demo` mode (never shown as text, only mouthed). */
export const DEMO_LINES = {
  es: 'Hola, soy tu avatar. Escribe un guion y lo cuento por ti, con la voz que elijas.',
  en: 'Hi, I am your avatar. Write a script and I will tell it for you, in the voice you choose.',
} as const;

/** Pause between two repetitions of the demo line (ms). */
export const DEMO_GAP_MS = 1400;

const demoCache = new Map<string, SceneRuntime>();

/** Runtime (visemes + words) of a line that has no audio: estimated like a TTS-less scene. */
export function demoRuntime(text: string, language: string = 'es'): SceneRuntime {
  const key = `${language}\n${text}`;
  const cached = demoCache.get(key);
  if (cached) return cached;
  const runtime = sceneRuntimeFromTranscript(text, estimateSpeechMs(text), language);
  demoCache.set(key, runtime);
  return runtime;
}

/**
 * Position inside a looping demo: the time since the line started, or a negative number
 * during the pause before the next repetition. Never negative zero.
 */
export function loopedSpeechMs(
  elapsedMs: number,
  audioMs: number,
  gapMs: number = DEMO_GAP_MS,
): number {
  if (!(audioMs > 0)) return -1;
  const period = audioMs + gapMs;
  const position = ((elapsedMs % period) + period) % period;
  return position < audioMs ? position : position - period;
}

export interface StagePoseInput {
  mode: StageMode;
  /** Time since the stage started animating (ms). */
  elapsedMs: number;
  /** Stable seed so every avatar blinks on its own rhythm. */
  seed: string;
  /** `demo`: the estimated runtime of the sample line. `speech`: the synthesized one. */
  runtime?: SceneRuntime | null;
  /** `speech`: position of the audio (ms), negative or null when it is not playing. */
  speechMs?: number | null;
}

/** Pose of the avatar for one animation frame. */
export function stagePose(input: StagePoseInput): AvatarState {
  const { mode, elapsedMs, seed } = input;
  const runtime = mode === 'idle' ? null : (input.runtime ?? null);
  let speechMs = -1;
  if (runtime && mode === 'demo') speechMs = loopedSpeechMs(elapsedMs, runtime.audioDurationMs);
  else if (runtime && mode === 'speech') speechMs = input.speechMs ?? -1;
  return computeAvatarState({ runtime, speechMs, sceneMs: Math.max(0, elapsedMs), seed });
}

/**
 * Box the rig is drawn in. Rigs anchor to the bottom-centre of their box, so the box is the
 * whole canvas for a portrait card; wide canvases keep a portrait-ish box in the middle so
 * the character is not stretched thin by its framing rules.
 */
export function stageBox(width: number, height: number, framing: AvatarFraming): PixelBox {
  const maxAspect = framing === 'half' ? 0.8 : 1.15;
  const w = Math.min(width, height * maxAspect);
  return { x: (width - w) / 2, y: 0, w, h: height };
}

/** Canvas backing-store size for a CSS box: device pixels, capped to keep 20 cards cheap. */
export function backingSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxSide = 900,
): { width: number; height: number; scale: number } {
  const dpr = Math.min(2, Math.max(1, devicePixelRatio || 1));
  const longest = Math.max(cssWidth, cssHeight) * dpr;
  const scale = longest > maxSide ? (dpr * maxSide) / longest : dpr;
  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
    scale,
  };
}
