/* Shared kit of the library features (avatars, voices, templates, brand kit, photo avatar,
 * voice clone). It lives in the avatars feature and uses its i18n namespace (`avatars`, keys
 * under `kit.*`); the other library features import it from here:
 *
 *   import { AvatarStage, ConsentForm, EnginePanel, LIB_ROUTES } from '@/features/avatars/kit';
 */
export * from './AvatarStage';
export * from './Callout';
export * from './CompositionPlayer';
export * from './ConsentForm';
export * from './CostLine';
export * from './CountBadge';
export * from './EnginePanel';
export * from './FailureNote';
export * from './QualityNote';
export * from './consent';
export * from './engine';
export * from './failure';
export * from './preview';
export * from './routes';
export * from './stage';
export * from './useConsentRecord';
export * from './useDebounced';
export * from './useSourceAsset';
export * from './useSpeechPreview';
export * from './useStartVideo';
