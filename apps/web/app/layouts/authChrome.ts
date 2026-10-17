/**
 * The layout loader's answer can be stale between revalidations (sign-in,
 * sign-out, an API 401); the shared session is the fresher source once known.
 * `sessionSignedIn` is null while unknown and in local-user runtimes.
 */
export function getEffectiveChromeAuth(
  loaderAuthenticated: boolean,
  sessionSignedIn: boolean | null,
) {
  return sessionSignedIn ?? loaderAuthenticated;
}
