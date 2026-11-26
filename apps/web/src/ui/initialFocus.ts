/**
 * Where focus lands when a dialog or drawer opens.
 *
 * Radix focuses the first tabbable element of the panel, which in our layout is always the
 * close button of the header: a keyboard user who opened "Rename" had to tab past it to reach
 * the field, and a screen reader announced "Close" instead of the content. The order here is:
 *
 *   1. whatever already holds focus inside the panel (React's `autoFocus` ran first);
 *   2. an element marked `data-autofocus` (for controls that are not form fields);
 *   3. the first enabled text field / select / listbox trigger of the body;
 *   4. the first enabled control of the body (a segmented control, a link, a button);
 *   5. the LAST enabled button of the footer — the main action, since footers put "Cancel" first;
 *   6. otherwise Radix's default.
 */
const FIELD = [
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="range"]):not([type="button"]):not([type="submit"])',
  'textarea',
  'select',
  '[role="combobox"]',
  '[contenteditable="true"]',
].join(',');

const CONTROL = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function usable(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.matches(':disabled, [aria-disabled="true"], [aria-hidden="true"], [hidden]')) {
    return false;
  }
  if (element.tabIndex < 0 && !element.matches(FIELD)) return false;
  // Skip what is inside a hidden branch (closed <details>, `hidden` wrappers, sr-only inputs).
  return (
    element.closest('[hidden], [aria-hidden="true"], details:not([open]) > :not(summary)') === null
  );
}

function first(root: ParentNode | null, selector: string): HTMLElement | null {
  if (!root) return null;
  for (const element of root.querySelectorAll(selector)) if (usable(element)) return element;
  return null;
}

function last(root: ParentNode | null, selector: string): HTMLElement | null {
  if (!root) return null;
  const all = [...root.querySelectorAll(selector)].filter(usable);
  return all.at(-1) ?? null;
}

/** `onOpenAutoFocus` handler shared by `Dialog` and `Drawer`. */
export function focusInitialControl(
  event: Event,
  body: HTMLElement | null,
  footer: HTMLElement | null,
): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && (body?.contains(active) || footer?.contains(active))) {
    event.preventDefault();
    return;
  }
  const target =
    first(body, '[data-autofocus]') ??
    first(footer, '[data-autofocus]') ??
    first(body, FIELD) ??
    first(body, CONTROL) ??
    last(footer, 'button, a[href]');
  if (!target) return;
  event.preventDefault();
  target.focus({ preventScroll: true });
  // A prefilled text field is selected so typing replaces it (rename dialogs).
  if (target instanceof HTMLInputElement && target.value !== '' && !target.readOnly) {
    try {
      target.select();
    } catch {
      // Not a text-like input: nothing to select.
    }
  }
}
