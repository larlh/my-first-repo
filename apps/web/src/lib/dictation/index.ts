/* Dictation by microphone. The kit controls (`@/ui` Input, Textarea, DictationButton) are the
 * way to offer it in a field; this module is the engine room they share. */
export { dictation, DictationController } from './controller';
export type {
  DictationAnnouncement,
  DictationFieldState,
  DictationGlobalState,
  DictationPhase,
  DictationRuntimeDeps,
  DictationTarget,
} from './controller';
export { chooseEngine, noEngineAtAll } from './engine-choice';
export type { EngineChoice, EngineChoiceInput } from './engine-choice';
export { useDictationField, useDictationState } from './hooks';
export { composeInsertion, elementExclusion, exclusionOf, insertDictated } from './insert';
export type { DictationElement, ExclusionReason, FieldTraits } from './insert';
export { DEFAULT_DICTATION_PREFERENCES } from './preferences';
export type { DictationPreferences } from './preferences';
export { DictationRuntime } from './runtime';
export type {
  DictationEngineId,
  DictationError,
  DictationErrorCode,
  EnginePreference,
} from './types';
