/* Strings of the `share` namespace (public page of a shared video). */

const es = {
  titles: { share: 'Vídeo compartido' },
  loading: 'Cargando el vídeo…',
  captions: 'Subtítulos',
  sharedBy: 'Compartido por {{workspace}}',
  download: 'Descargar MP4',
  meta: { description: 'Vídeo compartido por {{workspace}}. Hecho con Parlante.' },
  made: {
    title: 'Cómo se hizo',
    aiGenerated: 'Generado por IA',
    aiGeneratedNote:
      'Este vídeo contiene un presentador sintético animado por inteligencia artificial. No es una grabación de una persona real.',
    capability: {
      tts: 'Voz',
      voiceClone: 'Voz clonada',
      lipsync: 'Avatar',
      portrait: 'Retrato',
    },
  },
  gone: {
    title: 'Este enlace ya no está disponible',
    text: 'Quien compartió el vídeo ha desactivado el enlace, ha caducado o la dirección está incompleta. Pídele uno nuevo.',
    action: 'Conocer Parlante',
  },
  footer: {
    made: 'Hecho con Parlante',
    pitch: 'Vídeos con avatares que hablan, a partir de un guion. Sin cámara ni micrófono.',
    cta: 'Crea el tuyo gratis',
    toApp: 'Ir a mis vídeos',
  },
};

export type ShareTranslations = typeof es;

const en: ShareTranslations = {
  titles: { share: 'Shared video' },
  loading: 'Loading the video…',
  captions: 'Subtitles',
  sharedBy: 'Shared by {{workspace}}',
  download: 'Download MP4',
  meta: { description: 'Video shared by {{workspace}}. Made with Parlante.' },
  made: {
    title: 'How it was made',
    aiGenerated: 'AI-generated',
    aiGeneratedNote:
      'This video contains a synthetic presenter animated by artificial intelligence. It is not a recording of a real person.',
    capability: {
      tts: 'Voice',
      voiceClone: 'Cloned voice',
      lipsync: 'Avatar',
      portrait: 'Portrait',
    },
  },
  gone: {
    title: 'This link is no longer available',
    text: 'Whoever shared the video turned the link off, it expired, or the address is incomplete. Ask them for a new one.',
    action: 'Meet Parlante',
  },
  footer: {
    made: 'Made with Parlante',
    pitch: 'Videos with talking avatars, straight from a script. No camera, no microphone.',
    cta: 'Make yours for free',
    toApp: 'Go to my videos',
  },
};

export const translations = { es, en };
