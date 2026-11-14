/**
 * Paths the shell itself links or redirects to. The pages behind them belong to features; a
 * feature that owns one of these simply registers a route with the same path.
 */
export const PATHS = {
  /** Landing place after login. A feature may own `/`; otherwise the shell redirects to the first nav entry. */
  home: '/',
  /** Where guards send anonymous visitors (`?next=<path>` carries the way back). */
  login: '/login',
  register: '/register',
  /** Linked from the credit balance in the sidebar when a feature registers it. */
  billing: '/settings/billing',
  /** Component catalogue (development only). */
  devUi: '/dev/ui',
  /** Preview of the public page frame (development only). */
  devAuth: '/dev/auth',
} as const;

/** Only same-site relative paths are accepted as redirect targets (no open redirects). */
export function safeNextPath(
  raw: string | null | undefined,
  fallback: string = PATHS.home,
): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback;
  if (raw === PATHS.login || raw.startsWith(`${PATHS.login}?`)) return fallback;
  return raw;
}

/** Login URL that returns to `from` afterwards. */
export function loginPathFor(from: string): string {
  const next = safeNextPath(from, '');
  return next && next !== PATHS.home
    ? `${PATHS.login}?next=${encodeURIComponent(next)}`
    : PATHS.login;
}
