import { createComposition, defaultVoiceId } from '@parlante/shared';
import type { AspectRatio, Composition, NewLayerInput, NewSceneInput } from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * Compositions for the tests and the demo script of the render job: a realistic three-scene
 * video (avatar, headline, stock background, transitions, subtitles, music) laid out for each
 * aspect ratio, and a minimal one-scene video.
 * ----------------------------------------------------------------------------------------- */

type Box = { x: number; y: number; w: number; h: number };

const LAYOUT: Record<AspectRatio, { avatar: Box; title: Box; note: Box; titleSize: number }> = {
  '16:9': {
    avatar: { x: 0.54, y: 0.12, w: 0.4, h: 0.88 },
    title: { x: 0.06, y: 0.16, w: 0.46, h: 0.32 },
    note: { x: 0.06, y: 0.52, w: 0.42, h: 0.14 },
    titleSize: 0.08,
  },
  '9:16': {
    avatar: { x: 0.1, y: 0.4, w: 0.8, h: 0.6 },
    title: { x: 0.08, y: 0.07, w: 0.84, h: 0.16 },
    note: { x: 0.1, y: 0.25, w: 0.8, h: 0.08 },
    titleSize: 0.045,
  },
  '1:1': {
    avatar: { x: 0.2, y: 0.32, w: 0.6, h: 0.68 },
    title: { x: 0.08, y: 0.06, w: 0.84, h: 0.18 },
    note: { x: 0.1, y: 0.24, w: 0.8, h: 0.08 },
    titleSize: 0.06,
  },
};

export interface DemoOptions {
  aspect?: AspectRatio;
  avatarId?: string;
  /** Stock music id, or null for no music. */
  music?: string | null;
  subtitles?: boolean;
}

export const DEMO_SCRIPTS = [
  'Hola, soy tu presentadora virtual. Bienvenida a Parlante.',
  'Escribe un guion, elige un avatar y una voz, y compón tus escenas.',
  'En un momento tendrás tu vídeo listo para compartir. ¡Hasta pronto!',
] as const;

/** Three scenes with a talking avatar, text, a stock background, transitions and music. */
export function demoComposition(options: DemoOptions = {}): Composition {
  const aspect = options.aspect ?? '16:9';
  const layout = LAYOUT[aspect];
  const avatarId = options.avatarId ?? 'stock_lucia';
  const voiceId = defaultVoiceId('es', 'female');
  const align = aspect === '16:9' ? ('left' as const) : ('center' as const);
  const scene = (
    index: number,
    title: string,
    note: string,
    background: string,
    transition: NewSceneInput['transition'],
  ): NewSceneInput => {
    const layers: NewLayerInput[] = [
      {
        type: 'avatar',
        name: 'Avatar',
        avatarId,
        box: layout.avatar,
        framing: 'bust',
        z: 1,
      },
      {
        type: 'text',
        name: 'Título',
        text: title,
        box: layout.title,
        z: 2,
        style: { fontFamily: 'Poppins', fontSize: layout.titleSize, fontWeight: 700, align },
        enter: { type: 'slide-up', durationMs: 500 },
      },
      {
        type: 'text',
        name: 'Nota',
        text: note,
        box: layout.note,
        z: 3,
        style: {
          fontSize: layout.titleSize * 0.42,
          fontWeight: 500,
          align,
          color: '#101828',
          background: { color: '#ffd166', padding: 0.014, radius: 0.012 },
        },
        enter: { type: 'fade', durationMs: 400, delayMs: 300 },
      },
    ];
    return {
      name: `Escena ${index + 1}`,
      background: { type: 'image', src: { source: 'stock', stockId: background }, dim: 0.15 },
      script: { kind: 'tts', text: DEMO_SCRIPTS[index] ?? '', voiceId, language: 'es-ES' },
      transition,
      layers,
    };
  };
  const composition = createComposition({
    aspect,
    scenes: [
      scene(0, 'Bienvenida a Parlante', 'Vídeo con avatares IA', 'bg-aurora', { type: 'none' }),
      scene(1, 'Tres pasos', 'Guion · Avatar · Voz', 'bg-ocean', {
        type: 'fade',
        durationMs: 500,
      }),
      scene(2, 'Listo para compartir', 'MP4 · SRT · VTT', 'bg-sunset', {
        type: 'slide-left',
        durationMs: 500,
      }),
    ],
  });
  composition.subtitles.enabled = options.subtitles ?? true;
  const music = options.music === undefined ? 'music-corporate-rise' : options.music;
  if (music) {
    composition.music = {
      src: { source: 'stock', stockId: music },
      volume: 0.2,
      ducking: true,
      fadeInMs: 500,
      fadeOutMs: 1500,
      loop: true,
    };
  }
  return composition;
}

/** One short scene: an avatar saying `text` (default: about a second of speech). */
export function shortComposition(
  options: { avatarId?: string; text?: string; aspect?: AspectRatio; fixedSeconds?: number } = {},
): Composition {
  const aspect = options.aspect ?? '16:9';
  const composition = createComposition({
    aspect,
    scenes: [
      {
        name: 'Escena',
        background: { type: 'color', color: '#1d2b53' },
        script: {
          kind: 'tts',
          text: options.text ?? 'Hola mundo.',
          voiceId: defaultVoiceId('es', 'female'),
          language: 'es-ES',
        },
        ...(options.fixedSeconds
          ? { duration: { mode: 'fixed' as const, seconds: options.fixedSeconds } }
          : {}),
        layers: [
          {
            type: 'avatar',
            name: 'Avatar',
            avatarId: options.avatarId ?? 'stock_lucia',
            box: LAYOUT[aspect].avatar,
            framing: 'bust',
          },
        ],
      },
    ],
  });
  return composition;
}
