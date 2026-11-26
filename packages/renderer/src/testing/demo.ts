import { createComposition, estimateSpeechMs, estimateSpeechTimeline } from '@parlante/shared';
import type {
  AspectRatio,
  Composition,
  NewSceneInput,
  RenderRuntime,
  SubtitleStyle,
} from '@parlante/shared';
import { MapRenderAssets } from '../assets';
import { canvasAsImage, createNodeCanvas, createRawVideoSource } from '../node/index';
import type { AvatarClipSource, RenderImage } from '../types';
import { stubRig } from './stub-rig';

/* -------------------------------------------------------------------------------------------
 * Demo material for tests, golden frames, the benchmark and the screenshot script: a
 * realistic three-scene composition that uses every layer type, background type, transition
 * family and several animations, laid out for each aspect ratio, with fully synthetic assets
 * (drawn with the canvas — nothing is downloaded or read from other packages).
 * Node only. Not part of the package's public API.
 * ----------------------------------------------------------------------------------------- */

type Box = { x: number; y: number; w: number; h: number };

interface Layout {
  avatar: Box;
  logo: Box;
  title: Box;
  lead: Box;
  bar: Box;
  blob: Box;
  heading: Box;
  bullets: Box;
  photo: Box;
  star: Box;
  face: Box;
  rule: Box;
  pip: Box;
  quote: Box;
  badge: Box;
  triangle: Box;
  presenter: Box;
  titleSize: number;
  bodySize: number;
}

const LAYOUTS: Record<AspectRatio, Layout> = {
  '16:9': {
    avatar: { x: 0.56, y: 0.1, w: 0.4, h: 0.9 },
    logo: { x: 0.06, y: 0.08, w: 0.07, h: 0.125 },
    title: { x: 0.06, y: 0.23, w: 0.5, h: 0.29 },
    lead: { x: 0.06, y: 0.59, w: 0.46, h: 0.16 },
    bar: { x: 0.06, y: 0.545, w: 0.12, h: 0.012 },
    blob: { x: 0.5, y: -0.2, w: 0.7, h: 1.1 },
    heading: { x: 0.06, y: 0.08, w: 0.5, h: 0.12 },
    bullets: { x: 0.06, y: 0.24, w: 0.44, h: 0.42 },
    photo: { x: 0.56, y: 0.1, w: 0.36, h: 0.48 },
    star: { x: 0.87, y: 0.05, w: 0.08, h: 0.142 },
    face: { x: 0.8, y: 0.5, w: 0.16, h: 0.284 },
    rule: { x: 0.06, y: 0.21, w: 0.3, h: 0.01 },
    pip: { x: 0.05, y: 0.08, w: 0.3, h: 0.3 },
    quote: { x: 0.05, y: 0.44, w: 0.42, h: 0.26 },
    badge: { x: 0.4, y: 0.08, w: 0.2, h: 0.1 },
    triangle: { x: 0.37, y: 0.26, w: 0.06, h: 0.1 },
    presenter: { x: 0.58, y: 0.06, w: 0.38, h: 0.94 },
    titleSize: 0.088,
    bodySize: 0.042,
  },
  '9:16': {
    avatar: { x: 0.08, y: 0.42, w: 0.84, h: 0.58 },
    logo: { x: 0.08, y: 0.05, w: 0.16, h: 0.09 },
    title: { x: 0.08, y: 0.15, w: 0.84, h: 0.17 },
    lead: { x: 0.08, y: 0.35, w: 0.84, h: 0.09 },
    bar: { x: 0.08, y: 0.332, w: 0.24, h: 0.007 },
    blob: { x: -0.2, y: 0.35, w: 1.4, h: 0.8 },
    heading: { x: 0.08, y: 0.05, w: 0.84, h: 0.07 },
    bullets: { x: 0.08, y: 0.14, w: 0.84, h: 0.24 },
    photo: { x: 0.1, y: 0.4, w: 0.8, h: 0.3 },
    star: { x: 0.76, y: 0.37, w: 0.18, h: 0.101 },
    face: { x: 0.34, y: 0.62, w: 0.32, h: 0.18 },
    rule: { x: 0.08, y: 0.125, w: 0.5, h: 0.006 },
    pip: { x: 0.08, y: 0.05, w: 0.5, h: 0.16 },
    quote: { x: 0.08, y: 0.24, w: 0.84, h: 0.14 },
    badge: { x: 0.62, y: 0.07, w: 0.3, h: 0.05 },
    triangle: { x: 0.62, y: 0.14, w: 0.1, h: 0.05 },
    presenter: { x: 0.1, y: 0.4, w: 0.8, h: 0.6 },
    titleSize: 0.052,
    bodySize: 0.026,
  },
  '1:1': {
    avatar: { x: 0.5, y: 0.2, w: 0.48, h: 0.8 },
    logo: { x: 0.06, y: 0.06, w: 0.12, h: 0.12 },
    title: { x: 0.06, y: 0.22, w: 0.5, h: 0.25 },
    lead: { x: 0.06, y: 0.54, w: 0.44, h: 0.2 },
    bar: { x: 0.06, y: 0.495, w: 0.16, h: 0.011 },
    blob: { x: 0.35, y: -0.1, w: 0.9, h: 1.1 },
    heading: { x: 0.06, y: 0.06, w: 0.88, h: 0.1 },
    bullets: { x: 0.06, y: 0.2, w: 0.5, h: 0.44 },
    photo: { x: 0.58, y: 0.2, w: 0.36, h: 0.36 },
    star: { x: 0.84, y: 0.14, w: 0.12, h: 0.12 },
    face: { x: 0.66, y: 0.52, w: 0.24, h: 0.24 },
    rule: { x: 0.06, y: 0.165, w: 0.4, h: 0.009 },
    pip: { x: 0.06, y: 0.06, w: 0.4, h: 0.26 },
    quote: { x: 0.06, y: 0.38, w: 0.44, h: 0.3 },
    badge: { x: 0.52, y: 0.07, w: 0.3, h: 0.08 },
    triangle: { x: 0.86, y: 0.07, w: 0.08, h: 0.08 },
    presenter: { x: 0.5, y: 0.2, w: 0.5, h: 0.8 },
    titleSize: 0.07,
    bodySize: 0.034,
  },
};

export const DEMO_PHOTO = { source: 'stock' as const, stockId: 'demo-photo' };
export const DEMO_LOGO = { source: 'stock' as const, stockId: 'demo-logo' };
export const DEMO_PRODUCT = { source: 'stock' as const, stockId: 'demo-product' };
export const DEMO_LOOP = { source: 'stock' as const, stockId: 'demo-loop' };
/** Avatar id of the photorealistic presenter of scene 3 (its clip comes from `demoAssets`). */
export const DEMO_PHOTOREAL_AVATAR = 'real_demo';

export interface DemoOptions {
  aspect?: AspectRatio;
  subtitles?: Partial<SubtitleStyle>;
}

/** Three scenes (intro → data → closing), about 20 s with the demo runtime. */
export function demoComposition(options: DemoOptions = {}): Composition {
  const aspect = options.aspect ?? '16:9';
  const L = LAYOUTS[aspect];
  const tts = (text: string) => ({
    kind: 'tts' as const,
    text,
    voiceId: 'espeak:es-f1',
    language: 'es' as const,
  });

  const intro: NewSceneInput = {
    id: 'intro',
    name: 'Introducción',
    script: tts(
      'Hola, soy Lucía. En menos de un minuto te enseño cómo crear vídeos con avatares que hablan, sin cámaras ni estudio.',
    ),
    background: {
      type: 'gradient',
      gradient: {
        kind: 'linear',
        angle: 135,
        stops: [
          { offset: 0, color: '#151936' },
          { offset: 0.55, color: '#3b2f8f' },
          { offset: 1, color: '#7c5cff' },
        ],
      },
    },
    layers: [
      {
        id: 'blob',
        type: 'shape',
        shape: 'ellipse',
        box: L.blob,
        fill: '#ffffff',
        opacity: 0.07,
        z: -1,
      },
      {
        id: 'logo',
        type: 'image',
        src: DEMO_LOGO,
        box: L.logo,
        fit: 'contain',
        radius: 0.02,
        enter: { type: 'fade', durationMs: 500 },
      },
      {
        id: 'title',
        type: 'text',
        text: 'Vídeos con avatares en minutos',
        box: L.title,
        role: 'title',
        style: {
          fontFamily: 'Poppins',
          fontWeight: 800,
          fontSize: L.titleSize,
          align: 'left',
          verticalAlign: 'bottom',
          lineHeight: 1.08,
          shadow: { color: '#0b0d2666', blur: 0.012, offsetX: 0, offsetY: 0.006 },
        },
        enter: { type: 'slide-up', durationMs: 600, delayMs: 100, easing: 'ease-out' },
      },
      {
        id: 'bar',
        type: 'shape',
        shape: 'rect',
        box: L.bar,
        fill: '#ffb547',
        radius: 0.01,
        enter: { type: 'slide-right', durationMs: 500, delayMs: 350 },
      },
      {
        id: 'lead',
        type: 'text',
        text: 'Escribe el guion, elige presentador y exporta. Sin cámaras, sin estudio.',
        box: L.lead,
        role: 'body',
        style: {
          fontFamily: 'Inter',
          fontWeight: 500,
          fontSize: L.bodySize,
          align: 'left',
          verticalAlign: 'top',
          lineHeight: 1.35,
          color: '#e6e3ff',
        },
        enter: { type: 'fade', durationMs: 500, delayMs: 500 },
      },
      {
        id: 'avatar',
        type: 'avatar',
        avatarId: 'stock_lucia',
        box: L.avatar,
        framing: 'bust',
        enter: { type: 'fade', durationMs: 400 },
      },
    ],
  };

  const data: NewSceneInput = {
    id: 'data',
    name: 'Cómo funciona',
    transition: { type: 'slide-left', durationMs: 600 },
    script: tts(
      'Primero escribes el texto. Después eliges voz e idioma, ¡hay más de ocho! Y por último añades imágenes, formas y subtítulos.',
    ),
    background: { type: 'image', src: DEMO_PHOTO, fit: 'cover', blur: 0.014, dim: 0.45 },
    layers: [
      {
        id: 'heading',
        type: 'text',
        text: 'Cómo funciona',
        box: L.heading,
        role: 'title',
        style: {
          fontFamily: 'Montserrat',
          fontWeight: 800,
          fontSize: L.titleSize * 0.62,
          align: 'left',
          verticalAlign: 'middle',
          background: { color: '#7c5cff', padding: 0.018, radius: 0.016 },
        },
        enter: { type: 'slide-right', durationMs: 450, delayMs: 300 },
      },
      { id: 'rule', type: 'shape', shape: 'line', box: L.rule, fill: '#ffb547', z: 1 },
      {
        id: 'bullets',
        type: 'text',
        text: '1. Escribe el guion de cada escena\n2. Elige voz, idioma y velocidad\n3. Añade imágenes, formas y subtítulos\n4. Exporta en 16:9, 9:16 o 1:1',
        box: L.bullets,
        role: 'body',
        style: {
          fontFamily: 'Inter',
          fontWeight: 600,
          fontSize: L.bodySize,
          align: 'left',
          verticalAlign: 'top',
          lineHeight: 1.5,
          shadow: { color: '#000000aa', blur: 0.008, offsetX: 0, offsetY: 0.003 },
        },
        enter: { type: 'fade', durationMs: 600, delayMs: 700 },
        exit: { type: 'slide-left', durationMs: 400 },
      },
      {
        id: 'photo',
        type: 'image',
        src: DEMO_PRODUCT,
        box: L.photo,
        fit: 'cover',
        radius: 0.03,
        rotation: -3,
        enter: { type: 'zoom-in', durationMs: 500, delayMs: 500, easing: 'back-out' },
      },
      {
        id: 'star',
        type: 'shape',
        shape: 'star',
        box: L.star,
        fill: '#ffd84d',
        stroke: { color: '#1b1f3b', width: 0.004 },
        rotation: 12,
        z: 3,
        enter: { type: 'pop', durationMs: 450, delayMs: 1100 },
      },
      {
        id: 'face',
        type: 'avatar',
        avatarId: 'stock_mateo',
        box: L.face,
        framing: 'closeup',
        shape: 'circle',
        backdrop: '#ffb547',
        z: 2,
        enter: { type: 'pop', durationMs: 450, delayMs: 800 },
      },
    ],
  };

  const closing: NewSceneInput = {
    id: 'closing',
    name: 'Cierre',
    transition: { type: 'fade', durationMs: 500 },
    script: tts('Pruébalo hoy mismo. Tu primer vídeo está a un guion de distancia.'),
    background: { type: 'video', src: DEMO_LOOP, fit: 'cover', loop: true, dim: 0.3 },
    layers: [
      {
        id: 'pip',
        type: 'video',
        src: DEMO_LOOP,
        box: L.pip,
        fit: 'cover',
        radius: 0.025,
        trimStartMs: 500,
        enter: { type: 'zoom-out', durationMs: 400, delayMs: 300 },
      },
      {
        id: 'triangle',
        type: 'shape',
        shape: 'triangle',
        box: L.triangle,
        fill: '#ff5c8a',
        rotation: 90,
        opacity: 0.9,
      },
      {
        id: 'badge',
        type: 'text',
        text: 'Gratis para empezar',
        box: L.badge,
        role: 'caption',
        style: {
          fontFamily: 'JetBrains Mono',
          fontWeight: 700,
          fontSize: L.bodySize * 0.72,
          uppercase: true,
          letterSpacing: 0.08,
          color: '#151936',
          background: { color: '#ffd84d', padding: 0.012, radius: 0.05 },
        },
        rotation: -4,
      },
      {
        id: 'quote',
        type: 'text',
        text: '«Tu primer vídeo está a un guion de distancia»',
        box: L.quote,
        role: 'subtitle',
        style: {
          fontFamily: 'Playfair Display',
          fontWeight: 700,
          italic: true,
          fontSize: L.titleSize * 0.5,
          align: 'left',
          verticalAlign: 'top',
          lineHeight: 1.2,
          stroke: { color: '#151936', width: 0.004 },
          shadow: { color: '#00000099', blur: 0.01, offsetX: 0, offsetY: 0.004 },
        },
        enter: { type: 'slide-down', durationMs: 500, delayMs: 400 },
      },
      {
        id: 'presenter',
        type: 'avatar',
        avatarId: DEMO_PHOTOREAL_AVATAR,
        box: L.presenter,
        framing: 'half',
      },
    ],
  };

  const composition = createComposition({ aspect, scenes: [intro, data, closing] });
  return { ...composition, subtitles: { ...composition.subtitles, ...options.subtitles } };
}

/** Deterministic runtime for a composition: estimated speech timeline of every TTS scene. */
export function demoRuntime(composition: Composition): RenderRuntime {
  const runtime: RenderRuntime = { scenes: {} };
  for (const scene of composition.scenes) {
    if (scene.script.kind !== 'tts' || scene.script.text.trim() === '') continue;
    const audioDurationMs = estimateSpeechMs(scene.script.text, scene.script.speed);
    runtime.scenes[scene.id] = {
      audioDurationMs,
      ...estimateSpeechTimeline(scene.script.text, audioDurationMs, scene.script.language),
    };
  }
  return runtime;
}

/* ---------- synthetic assets ---------- */

function paintLandscape(width: number, height: number): RenderImage {
  const { canvas, ctx } = createNodeCanvas(width, height);
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#ff9966');
  sky.addColorStop(0.45, '#ffd3a3');
  sky.addColorStop(1, '#5a8fbf');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff4d6';
  ctx.beginPath();
  ctx.arc(width * 0.7, height * 0.36, height * 0.11, 0, Math.PI * 2);
  ctx.fill();
  const ridges = ['#7a6fa8', '#4f4a86', '#2f2d5c', '#1a1a3a'];
  ridges.forEach((color, r) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width; x += width / 64) {
      const y =
        height * (0.52 + r * 0.11) +
        Math.sin(x / (width * 0.11) + r * 1.7) * height * 0.05 +
        Math.sin(x / (width * 0.035) + r) * height * 0.014;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
  });
  // Fine detail (so blur, cover-cropping and resampling are visible in screenshots).
  ctx.strokeStyle = '#ffffff55';
  ctx.lineWidth = Math.max(1, height / 500);
  for (let i = 0; i < 40; i += 1) {
    const x = ((i * 0.6180339887) % 1) * width;
    const y = height * (0.08 + ((i * 0.3819660113) % 1) * 0.3);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + width * 0.03, y);
    ctx.stroke();
  }
  return canvasAsImage(canvas);
}

function paintLogo(size: number): RenderImage {
  const { canvas, ctx } = createNodeCanvas(size, size);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#7c5cff';
  ctx.beginPath();
  ctx.arc(size * 0.5, size * 0.46, size * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(size * 0.3, size * 0.62);
  ctx.lineTo(size * 0.22, size * 0.86);
  ctx.lineTo(size * 0.5, size * 0.72);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  for (const dx of [-0.13, 0, 0.13]) {
    ctx.beginPath();
    ctx.arc(size * (0.5 + dx), size * 0.46, size * 0.04, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvasAsImage(canvas);
}

function paintProduct(width: number, height: number): RenderImage {
  const { canvas, ctx } = createNodeCanvas(width, height);
  const wall = ctx.createLinearGradient(0, 0, width, height);
  wall.addColorStop(0, '#f6efe6');
  wall.addColorStop(1, '#d9c9b8');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, width, height);
  // A laptop on a desk.
  ctx.fillStyle = '#8a6a4f';
  ctx.fillRect(0, height * 0.74, width, height * 0.26);
  ctx.fillStyle = '#2b2f45';
  ctx.beginPath();
  ctx.roundRect(width * 0.24, height * 0.24, width * 0.52, height * 0.44, height * 0.025);
  ctx.fill();
  const screen = ctx.createLinearGradient(0, height * 0.26, 0, height * 0.66);
  screen.addColorStop(0, '#7c5cff');
  screen.addColorStop(1, '#2bd4c8');
  ctx.fillStyle = screen;
  ctx.fillRect(width * 0.26, height * 0.27, width * 0.48, height * 0.38);
  ctx.fillStyle = '#ffffffcc';
  ctx.beginPath();
  ctx.moveTo(width * 0.47, height * 0.39);
  ctx.lineTo(width * 0.47, height * 0.53);
  ctx.lineTo(width * 0.56, height * 0.46);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#c7ccd9';
  ctx.beginPath();
  ctx.roundRect(width * 0.16, height * 0.68, width * 0.68, height * 0.05, height * 0.02);
  ctx.fill();
  ctx.fillStyle = '#e85d4a';
  ctx.beginPath();
  ctx.arc(width * 0.88, height * 0.66, height * 0.07, 0, Math.PI * 2);
  ctx.fill();
  return canvasAsImage(canvas);
}

/** Frame `index` of the looping demo video: drifting colour bands and a moving marker. */
function loopFrame(index: number, frameCount: number, width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const phase = index / frameCount;
  const marker = Math.floor(phase * width);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const wave = Math.sin((x / width) * Math.PI * 4 + phase * Math.PI * 2 + (y / height) * 3);
      const band = 0.5 + 0.5 * wave;
      pixels[o] = Math.round(30 + 60 * band);
      pixels[o + 1] = Math.round(60 + 110 * band * (y / height));
      pixels[o + 2] = Math.round(120 + 110 * (1 - band));
      pixels[o + 3] = 255;
      if (Math.abs(x - marker) < 3 && y > height * 0.88) {
        pixels[o] = 255;
        pixels[o + 1] = 216;
        pixels[o + 2] = 77;
      }
    }
  }
  return pixels;
}

/** Generated frames of the loop video, shared by every `demoAssets()` (20 MB at most). */
const loopFrames = new Map<number, Uint8Array>();

/** A stylised "neural clip": a cut-out presenter (with alpha) that sways a little. */
function presenterClip(durationMs: number): AvatarClipSource {
  const size = 384;
  const { canvas, ctx } = createNodeCanvas(size, size);
  let drawn = -1;
  return {
    durationMs,
    width: size,
    height: size,
    originMs: 0,
    landmarks: {
      leftEye: { x: 0.43, y: 0.3 },
      rightEye: { x: 0.57, y: 0.3 },
      mouthLeft: { x: 0.45, y: 0.45 },
      mouthRight: { x: 0.55, y: 0.45 },
      chin: { x: 0.5, y: 0.52 },
    },
    frameAt(timeMs) {
      const frame = Math.floor((timeMs * 30) / 1000 + 1e-6);
      if (frame !== drawn) {
        drawn = frame;
        const sway = Math.sin(frame / 22) * size * 0.012;
        const open = 0.5 + 0.5 * Math.sin(frame / 2.3);
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = '#2d3a6b';
        ctx.beginPath();
        ctx.ellipse(size / 2 + sway * 0.4, size * 1.02, size * 0.4, size * 0.42, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#d9a37e';
        ctx.fillRect(size * 0.44 + sway * 0.7, size * 0.5, size * 0.12, size * 0.14);
        ctx.beginPath();
        ctx.ellipse(size / 2 + sway, size * 0.36, size * 0.15, size * 0.19, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#3a2618';
        ctx.beginPath();
        ctx.ellipse(
          size / 2 + sway,
          size * 0.25,
          size * 0.16,
          size * 0.11,
          0,
          Math.PI,
          Math.PI * 2,
        );
        ctx.fill();
        ctx.fillStyle = '#1b1b1b';
        for (const dx of [-0.07, 0.07]) {
          ctx.beginPath();
          ctx.arc(size * (0.5 + dx) + sway, size * 0.34, size * 0.012, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#7a2e2e';
        ctx.beginPath();
        ctx.ellipse(
          size / 2 + sway,
          size * 0.45,
          size * 0.045,
          size * (0.008 + 0.02 * open),
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      return canvasAsImage(canvas);
    },
  };
}

export interface DemoAssets {
  assets: MapRenderAssets;
  /** How many frames of the loop video have been read (tests of the media clock). */
  loopReads: () => number;
}

/**
 * Synthetic assets for `demoComposition`: three images, a looping video and a presenter clip.
 * `stubAvatars` replaces the stock rigs by `stubRig` (golden frames must not change when the
 * stock drawings are retouched).
 */
export function demoAssets(composition?: Composition, stubAvatars = false): DemoAssets {
  const assets = new MapRenderAssets();
  if (stubAvatars) {
    assets.setAvatar('stock_lucia', stubRig('stock_lucia', '#2e4f8a'));
    assets.setAvatar('stock_mateo', stubRig('stock_mateo', '#2e7d6b'));
  }
  assets.setImage('stock:demo-photo', paintLandscape(1600, 1000));
  assets.setImage('stock:demo-logo', paintLogo(256));
  assets.setImage('stock:demo-product', paintProduct(800, 600));
  const loop = { width: 320, height: 180, fps: 30, frameCount: 90 };
  let reads = 0;
  assets.setVideo(
    'stock:demo-loop',
    createRawVideoSource({
      ...loop,
      readFrame: (index) => {
        reads += 1;
        let pixels = loopFrames.get(index);
        if (!pixels) {
          pixels = loopFrame(index, loop.frameCount, loop.width, loop.height);
          loopFrames.set(index, pixels);
        }
        return pixels;
      },
    }),
  );
  for (const scene of composition?.scenes ?? []) {
    for (const layer of scene.layers) {
      if (layer.type === 'avatar' && layer.avatarId === DEMO_PHOTOREAL_AVATAR) {
        assets.setAvatarClip(scene.id, layer.id, presenterClip(60_000));
      }
    }
  }
  return { assets, loopReads: () => reads };
}

/** Convenience: composition + runtime + assets for an aspect ratio. */
export function demoProject(options: DemoOptions & { stubAvatars?: boolean } = {}): {
  composition: Composition;
  runtime: RenderRuntime;
  assets: MapRenderAssets;
} {
  const composition = demoComposition(options);
  return {
    composition,
    runtime: demoRuntime(composition),
    assets: demoAssets(composition, options.stubAvatars).assets,
  };
}
