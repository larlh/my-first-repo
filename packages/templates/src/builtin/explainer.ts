import { createComposition, defaultVoiceId } from '@parlante/shared';
import type { BuiltinTemplate } from '@parlante/shared';

/**
 * EXAMPLE built-in template (valid, renderable). Owner: content — refine it and add the others
 * (ad, training, news, product, greeting) as sibling files registered in ../registry.ts.
 *
 * Conventions for templates:
 *  - Give layers and scenes STABLE, readable ids (they are regenerated when a video is created).
 *  - Tag restylable layers with `role` (title/subtitle/body/caption/logo/accent) and brandable
 *    colour backgrounds with `brandRole`, so brand kits apply cleanly.
 *  - Only reference stock avatars (`stock_…`), local voices (`defaultVoiceId(lang)`) and stock
 *    assets (`{ source: 'stock', stockId }`) — never workspace assets.
 *  - Use `{{variables}}` for the parts users personalise and declare them in `variables`.
 */
export const explainerTemplate: BuiltinTemplate = {
  id: 'builtin_explainer',
  name: { es: 'Vídeo explicativo', en: 'Explainer video' },
  description: {
    es: 'Presenta una idea en tres pasos: problema, solución y llamada a la acción.',
    en: 'Present an idea in three steps: problem, solution and call to action.',
  },
  category: 'explainer',
  tags: ['explicativo', '16:9', 'tres escenas'],
  composition: createComposition({
    aspect: '16:9',
    scenes: [
      {
        id: 'intro',
        name: 'Introducción',
        script: {
          kind: 'tts',
          text: 'Hola, soy Lucía. En menos de un minuto te explico {{tema}}.',
          voiceId: defaultVoiceId('es', 'female'),
          language: 'es',
        },
        background: {
          type: 'gradient',
          gradient: {
            kind: 'linear',
            angle: 135,
            stops: [
              { offset: 0, color: '#1b1f3b' },
              { offset: 1, color: '#3b2f8f' },
            ],
          },
        },
        layers: [
          {
            id: 'avatar',
            type: 'avatar',
            avatarId: 'stock_lucia',
            box: { x: 0.56, y: 0.1, w: 0.4, h: 0.9 },
            enter: { type: 'fade', durationMs: 400 },
          },
          {
            id: 'title',
            type: 'text',
            role: 'title',
            text: '{{tema}}',
            box: { x: 0.06, y: 0.28, w: 0.48, h: 0.26 },
            style: { fontFamily: 'Poppins', fontSize: 0.085, fontWeight: 700, align: 'left' },
            enter: { type: 'slide-up', durationMs: 500 },
          },
          {
            id: 'accent',
            type: 'shape',
            role: 'accent',
            shape: 'rect',
            fill: '#ffb547',
            box: { x: 0.06, y: 0.57, w: 0.14, h: 0.012 },
            radius: 0.006,
          },
        ],
      },
      {
        id: 'solution',
        name: 'La solución',
        transition: { type: 'fade', durationMs: 500 },
        script: {
          kind: 'tts',
          text: 'La clave está en tres ideas sencillas que puedes aplicar hoy mismo.',
          voiceId: defaultVoiceId('es', 'female'),
          language: 'es',
        },
        background: { type: 'color', color: '#0f1224', brandRole: 'background' },
        layers: [
          {
            id: 'avatar',
            type: 'avatar',
            avatarId: 'stock_lucia',
            box: { x: 0.04, y: 0.1, w: 0.4, h: 0.9 },
          },
          {
            id: 'heading',
            type: 'text',
            role: 'subtitle',
            text: 'Tres ideas clave',
            box: { x: 0.48, y: 0.2, w: 0.46, h: 0.14 },
            style: { fontFamily: 'Poppins', fontSize: 0.06, fontWeight: 700, align: 'left' },
          },
          {
            id: 'body',
            type: 'text',
            role: 'body',
            text: '1. Empieza por el problema\n2. Muestra el resultado\n3. Invita a actuar',
            box: { x: 0.48, y: 0.36, w: 0.46, h: 0.34 },
            style: { fontSize: 0.042, fontWeight: 500, align: 'left', lineHeight: 1.5 },
          },
        ],
      },
      {
        id: 'cta',
        name: 'Llamada a la acción',
        transition: { type: 'slide-left', durationMs: 500 },
        script: {
          kind: 'tts',
          text: '¿Empezamos? Visita {{web}} y da el primer paso.',
          voiceId: defaultVoiceId('es', 'female'),
          language: 'es',
        },
        background: { type: 'color', color: '#6d5efc', brandRole: 'primary' },
        layers: [
          {
            id: 'avatar',
            type: 'avatar',
            avatarId: 'stock_lucia',
            shape: 'circle',
            backdrop: '#ffffff26',
            framing: 'closeup',
            box: { x: 0.08, y: 0.25, w: 0.28, h: 0.5 },
          },
          {
            id: 'cta-text',
            type: 'text',
            role: 'title',
            text: '{{web}}',
            box: { x: 0.42, y: 0.36, w: 0.5, h: 0.28 },
            style: { fontFamily: 'Poppins', fontSize: 0.08, fontWeight: 800, align: 'left' },
          },
        ],
      },
    ],
  }),
};

explainerTemplate.composition.variables = [
  { name: 'tema', label: 'Tema del vídeo', defaultValue: 'cómo funciona Parlante' },
  { name: 'web', label: 'Página web', defaultValue: 'parlante.example' },
];
