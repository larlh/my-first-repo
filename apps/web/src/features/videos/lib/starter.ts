import { DEFAULT_STOCK_AVATAR_ID } from '@parlante/renderer';
import { baseLanguage, compositionFromScript, defaultVoiceId } from '@parlante/shared';
import type { AspectRatio, Composition } from '@parlante/shared';

/**
 * The document of a video started "from scratch".
 *
 * A literally blank composition (one black scene, no narration, no avatar) left a first-time
 * visitor in front of a dark rectangle whose render was three silent seconds. The starter is
 * what the product is about instead: a presenter, a voice in the language of the interface and
 * one example line, laid out by the same script → Composition function the script writer and
 * the public API use. Everything in it can be changed or removed in the Studio.
 */
export function starterComposition(input: {
  aspect: AspectRatio;
  /** UI locale; decides the narration language and its default local voice. */
  locale: string;
  /** Example narration, already in that language. */
  script: string;
}): Composition {
  const language = baseLanguage(input.locale) ?? 'es';
  return compositionFromScript([{ text: input.script }], {
    avatarId: DEFAULT_STOCK_AVATAR_ID,
    voiceId: defaultVoiceId(language),
    language,
    aspect: input.aspect,
  });
}
