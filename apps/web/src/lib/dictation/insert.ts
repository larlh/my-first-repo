/* Where dictated text goes and how: eligibility of a field, the text that results from
 * inserting a phrase at the caret, and the DOM write that makes React (and every other
 * listener) see the change exactly as if it had been typed. */

export type DictationElement = HTMLInputElement | HTMLTextAreaElement;

/** What decides whether a field offers dictation (props of the kit control or a raw element). */
export interface FieldTraits {
  /** `<input type>`; undefined for a textarea or a plain text input. */
  type?: string | undefined;
  readOnly?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Marked as holding a secret (API key, webhook secret, token…). */
  secret?: boolean | undefined;
  autoComplete?: string | undefined;
  inputMode?: string | undefined;
  pattern?: string | undefined;
}

export type ExclusionReason =
  'type' | 'readonly' | 'disabled' | 'secret' | 'autocomplete' | 'inputmode' | 'pattern';

const TEXT_TYPES = new Set(['', 'text', 'search']);
const BLOCKED_AUTOCOMPLETE =
  /(^|\s)(email|username|new-password|current-password|one-time-code|url|tel(-[a-z-]+)?|cc-[a-z-]+|bday(-[a-z]+)?|postal-code)(\s|$)/;
const BLOCKED_INPUT_MODES = new Set(['numeric', 'decimal', 'tel', 'email', 'url', 'none']);

/**
 * Why a field must not offer dictation, or null when it may. Always excluded: passwords,
 * e-mail, URL, numbers, dates and every other non-text input type; read-only and disabled
 * fields; anything marked as a secret; fields with a format constraint.
 */
export function exclusionOf(traits: FieldTraits): ExclusionReason | null {
  if (traits.secret) return 'secret';
  if (!TEXT_TYPES.has((traits.type ?? '').toLowerCase())) return 'type';
  if (traits.disabled) return 'disabled';
  if (traits.readOnly) return 'readonly';
  if (traits.autoComplete && BLOCKED_AUTOCOMPLETE.test(traits.autoComplete.toLowerCase())) {
    return 'autocomplete';
  }
  if (traits.inputMode && BLOCKED_INPUT_MODES.has(traits.inputMode.toLowerCase())) {
    return 'inputmode';
  }
  if (traits.pattern) return 'pattern';
  return null;
}

/** Same check on a live element (the state may have changed since the control rendered). */
export function elementExclusion(element: DictationElement): ExclusionReason | null {
  const isInput = element instanceof HTMLInputElement;
  return exclusionOf({
    type: isInput ? element.type : undefined,
    readOnly: element.readOnly,
    disabled: element.disabled || element.closest('fieldset:disabled') !== null,
    secret: element.dataset.secret !== undefined || element.dataset.dictation === 'off',
    autoComplete: element.getAttribute('autocomplete') ?? undefined,
    inputMode: element.getAttribute('inputmode') ?? undefined,
    pattern: isInput ? element.pattern || undefined : undefined,
  });
}

export interface InsertionOptions {
  /** `maxLength` of the field; negative or undefined = no limit. */
  maxLength?: number | undefined;
  /** Single-line field (title, name, search): no line breaks, no full stop at the end. */
  singleLine?: boolean | undefined;
}

export interface Insertion {
  /** Value of the field after the insertion. */
  value: string;
  /** Caret position after the inserted text. */
  caret: number;
  /** What was actually written (spacing included); '' when nothing fitted. */
  inserted: string;
  /** The text did not fit entirely in `maxLength`. */
  truncated: boolean;
}

const SENTENCE_START = /(^|[.!?…¿¡\n])[\s"'«“(]*$/u;
const OPENERS = new Set(['(', '[', '{', '¿', '¡', '«', '“', '‘']);
const NO_SPACE_BEFORE = /^[,.;:!?…)\]}»”%]/u;
const NO_SPACE_AFTER_CARET = /^[\s,.;:!?…)\]}»”]/u;

/** Trim, collapse whitespace and adapt a transcribed phrase to the kind of field. */
export function normalizeDictated(raw: string, singleLine: boolean): string {
  let text = raw.replace(singleLine ? /\s+/gu : /[^\S\n]+/gu, ' ').trim();
  if (singleLine && /[^.]\.$/u.test(text)) text = text.slice(0, -1);
  return text;
}

function capitalize(text: string): string {
  const first = text.codePointAt(0);
  if (first === undefined) return text;
  const head = String.fromCodePoint(first);
  const upper = head.toLocaleUpperCase();
  // Only single letters: «ß» → «SS» and similar expansions are left alone.
  return upper.length === head.length && upper !== head ? upper + text.slice(head.length) : text;
}

/**
 * Text that results from dictating `raw` over the selection `[start, end)` of `value`:
 * replaces the selection (or inserts at the caret), adds the spaces a person would type,
 * capitalises the first letter at the start of a sentence and respects `maxLength`.
 */
export function composeInsertion(
  value: string,
  start: number,
  end: number,
  raw: string,
  options: InsertionOptions = {},
): Insertion {
  const from = Math.max(0, Math.min(start, end, value.length));
  const to = Math.max(from, Math.min(Math.max(start, end), value.length));
  const before = value.slice(0, from);
  const after = value.slice(to);
  const unchanged: Insertion = { value, caret: to, inserted: '', truncated: false };

  let text = normalizeDictated(raw, options.singleLine ?? false);
  if (text === '') return unchanged;
  if (SENTENCE_START.test(before)) text = capitalize(text);

  const previous = before.slice(-1);
  const needsLeading =
    before !== '' && !/\s/u.test(previous) && !OPENERS.has(previous) && !NO_SPACE_BEFORE.test(text);
  const needsTrailing = after !== '' && !NO_SPACE_AFTER_CARET.test(after);
  let piece = (needsLeading ? ' ' : '') + text + (needsTrailing ? ' ' : '');

  let truncated = false;
  const limit = options.maxLength;
  if (limit !== undefined && limit >= 0) {
    const room = limit - before.length - after.length;
    if (room <= 0) return { ...unchanged, truncated: true };
    if (piece.length > room) {
      truncated = true;
      let cut = piece.slice(0, room);
      // Never write half a word: when the limit falls inside one, end on the previous word.
      const nextChar = piece.charAt(room);
      if (nextChar !== '' && !/\s/u.test(nextChar)) {
        cut = cut.slice(0, Math.max(0, cut.lastIndexOf(' ')));
      }
      piece = cut.trimEnd();
      if (piece.trim() === '') return { ...unchanged, truncated: true };
    }
  }

  return {
    value: before + piece + after,
    caret: before.length + piece.length,
    inserted: piece,
    truncated,
  };
}

function nativeValueSetter(element: DictationElement): ((value: string) => void) | undefined {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  return setter ? (value) => setter.call(element, value) : undefined;
}

function selectionOf(element: DictationElement): [number, number] {
  try {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    if (start !== null && end !== null) return [start, end];
  } catch {
    // Input types without a selection API never get here (they are excluded), but be safe.
  }
  return [element.value.length, element.value.length];
}

/**
 * Write a dictated phrase into a field through the same path as typing.
 *
 * When the field has the focus the text goes in with the browser's own `insertText` editing
 * command: the native undo stack keeps working and the browser fires the same `beforeinput` /
 * `input` events as a keystroke. Otherwise (field not focused, or no editing commands) the
 * value is set through the native setter and an `input` event is dispatched, which is what
 * React and form libraries listen to. Either way `onChange` handlers run as for typed text.
 */
export function insertDictated(element: DictationElement, raw: string): Insertion {
  const [start, end] = selectionOf(element);
  const result = composeInsertion(element.value, start, end, raw, {
    maxLength: element.maxLength,
    singleLine: element instanceof HTMLInputElement,
  });
  if (result.inserted === '') return result;

  const doc = element.ownerDocument;
  if (doc.activeElement === element && typeof doc.execCommand === 'function') {
    try {
      element.setSelectionRange(start, end);
      if (doc.execCommand('insertText', false, result.inserted)) return result;
    } catch {
      // No editing commands here: write the value below.
    }
  }

  const setValue = nativeValueSetter(element);
  if (setValue) setValue(result.value);
  else element.value = result.value;
  element.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      inputType: 'insertText',
      data: result.inserted,
    }),
  );
  try {
    element.setSelectionRange(result.caret, result.caret);
  } catch {
    // Not focusable right now (detached, hidden): the value is written all the same.
  }
  return result;
}
