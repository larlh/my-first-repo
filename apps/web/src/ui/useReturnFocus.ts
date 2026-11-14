import { useRef } from 'react';

/**
 * Remembers what had focus when an overlay opened and gives it back when the overlay closes.
 *
 * Radix does this on its own, except when something inside the overlay uses `autoFocus`:
 * React focuses that element before Radix records the "previous" one, so focus would be lost
 * to <body> on close. Capturing the opener at the open transition avoids that.
 */
export function useReturnFocus(open: boolean): (event: Event) => void {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== 'undefined') {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  wasOpen.current = open;

  return (event) => {
    const target = opener.current;
    opener.current = null;
    if (target && target.isConnected) {
      event.preventDefault();
      target.focus();
    }
  };
}
