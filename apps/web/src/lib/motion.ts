/** True when the person asked the system for less motion (`prefers-reduced-motion: reduce`). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * `behavior` for programmatic scrolling. The global stylesheet already switches CSS animations,
 * transitions and `scroll-behavior` off under reduced motion, but an explicit
 * `scrollTo({ behavior: 'smooth' })` from script ignores that rule.
 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
