import { z } from 'zod';

export const CONSENT_KINDS = ['photo_avatar', 'voice_clone'] as const;
export const ConsentKindSchema = z.enum(CONSENT_KINDS);
export type ConsentKind = z.infer<typeof ConsentKindSchema>;

/** Who is consenting relative to the person depicted / recorded. */
export const ConsentRelationshipSchema = z.enum(['self', 'authorized']);
export type ConsentRelationship = z.infer<typeof ConsentRelationshipSchema>;

/**
 * Versioned consent statements. The version AND the exact text shown are stored on the
 * ConsentRecord. To change the wording, add a new version (never edit a published one).
 */
export const CONSENT_STATEMENT_VERSION = '2026-01';

export const CONSENT_STATEMENTS: Record<ConsentKind, Record<string, { es: string; en: string }>> = {
  photo_avatar: {
    '2026-01': {
      es: 'Declaro que soy la persona que aparece en esta fotografía, o que cuento con su autorización expresa y verificable, y consiento que Parlante la utilice para generar un avatar animado. Entiendo que no puedo crear avatares de terceros sin su permiso, ni usarlos para suplantar, difamar o engañar.',
      en: 'I declare that I am the person shown in this photograph, or that I hold their explicit and verifiable authorisation, and I consent to Parlante using it to generate an animated avatar. I understand that I may not create avatars of other people without their permission, nor use them to impersonate, defame or deceive.',
    },
  },
  voice_clone: {
    '2026-01': {
      es: 'Declaro que la voz de esta grabación es la mía, o que cuento con la autorización expresa y verificable de su titular, y consiento que Parlante la analice para crear una voz sintética. Entiendo que no puedo clonar la voz de terceros sin su permiso, ni usarla para suplantar, defraudar o engañar.',
      en: 'I declare that the voice in this recording is my own, or that I hold the explicit and verifiable authorisation of its owner, and I consent to Parlante analysing it to create a synthetic voice. I understand that I may not clone the voice of other people without their permission, nor use it to impersonate, defraud or deceive.',
    },
  },
};

export function getConsentStatement(
  kind: ConsentKind,
  version: string = CONSENT_STATEMENT_VERSION,
): { es: string; en: string } | null {
  return CONSENT_STATEMENTS[kind][version] ?? null;
}
