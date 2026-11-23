/* Shared kit of the AI tools (script writer, translation, batch, interactive avatar). It
 * lives in the script-writer feature and uses its i18n namespace (`script-writer`, keys
 * under `kit.*`); the other three tools import it from here:
 *
 *   import { AvatarPicker, ModeNotice, TOOL_ROUTES } from '@/features/script-writer/kit';
 */
export * from './AvatarCanvas';
export * from './AvatarPicker';
export * from './CreditCost';
export * from './ModeNotice';
export * from './Notice';
export * from './Step';
export * from './VoiceSelect';
export * from './avatar';
export * from './catalog';
export * from './languages';
export * from './routes';
export * from './useStoredErrorText';
