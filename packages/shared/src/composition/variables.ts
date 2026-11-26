import { VARIABLE_NAME_REGEX } from './schema';
import type { Composition, VariableDef } from './schema';

/** Matches `{{ name }}` placeholders (whitespace tolerant). */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*\}\}/g;

/** Unique placeholder names found in a text, in order of first appearance. */
export function extractPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined && !found.includes(name)) found.push(name);
  }
  return found;
}

/** Replace placeholders using `values`; unknown placeholders are handled by `onMissing`. */
export function interpolate(
  text: string,
  values: Record<string, string>,
  onMissing: (name: string) => string = (name) => `{{${name}}}`,
): string {
  return text.replace(PLACEHOLDER, (_m, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? (values[name] ?? '') : onMissing(name),
  );
}

/** Every text that supports placeholders: TTS script text, audio transcript, text layers. */
function forEachText(
  composition: Composition,
  visit: (text: string, set: (next: string) => void) => void,
): void {
  for (const scene of composition.scenes) {
    const script = scene.script;
    if (script.kind === 'tts') {
      visit(script.text, (next) => {
        script.text = next;
      });
    } else if (script.kind === 'audio') {
      visit(script.transcript, (next) => {
        script.transcript = next;
      });
    }
    for (const layer of scene.layers) {
      if (layer.type === 'text') {
        visit(layer.text, (next) => {
          layer.text = next;
        });
      }
    }
  }
}

/** Placeholder names used anywhere in the document (declared or not). */
export function listUsedVariables(composition: Composition): string[] {
  const names: string[] = [];
  forEachText(composition, (text) => {
    for (const name of extractPlaceholders(text)) if (!names.includes(name)) names.push(name);
  });
  return names;
}

/**
 * Reconcile `composition.variables` with the placeholders actually used: keeps declared
 * definitions (label/default), adds missing ones, drops unused ones. Returns a new array.
 */
export function syncVariableDefs(composition: Composition): VariableDef[] {
  const used = listUsedVariables(composition);
  return used.map(
    (name) =>
      composition.variables.find((v) => v.name === name) ?? { name, label: '', defaultValue: '' },
  );
}

export interface VariableCheck {
  /** Used in the document but absent from `values` and without a non-empty default. */
  missing: string[];
  /** Present in `values` but not used by the document. */
  unknown: string[];
}

export function checkVariableValues(
  composition: Composition,
  values: Record<string, string>,
): VariableCheck {
  const used = listUsedVariables(composition);
  const defaults = new Map(composition.variables.map((v) => [v.name, v.defaultValue]));
  return {
    missing: used.filter(
      (name) =>
        !Object.prototype.hasOwnProperty.call(values, name) && (defaults.get(name) ?? '') === '',
    ),
    unknown: Object.keys(values).filter((name) => !used.includes(name)),
  };
}

/**
 * Return a copy of the composition with every placeholder replaced.
 * Resolution order: `values[name]` → declared default → empty string.
 * The result has no placeholders and an empty `variables` list (it is a concrete video).
 */
export function applyVariables(
  composition: Composition,
  values: Record<string, string>,
): Composition {
  const copy = structuredClone(composition);
  const defaults: Record<string, string> = {};
  for (const v of copy.variables) defaults[v.name] = v.defaultValue;
  const merged = { ...defaults, ...values };
  forEachText(copy, (text, set) => set(interpolate(text, merged, () => '')));
  copy.variables = [];
  return copy;
}

export function isValidVariableName(name: string): boolean {
  return VARIABLE_NAME_REGEX.test(name);
}
