/**
 * Hosted product origins for Better Auth CSRF / callback checks.
 *
 * Canonical product host is clash.art (BETTER_AUTH_URL). clash.video remains
 * listed during cutover so in-flight OAuth and bookmarks do not fail origin
 * checks while the Worker still answers (or 301s) on the legacy host.
 */
export const HOSTED_WEB_TRUSTED_ORIGINS = [
  "https://clash.art",
  "https://www.clash.art",
  "https://next.clash.art",
  "https://clash.video",
  "https://www.clash.video",
] as const;

export const AUTH_ERROR_PATH = "/login";

const LOCAL_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
] as const;

export function isLocalAuthBaseUrl(baseURL?: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(baseURL ?? "");
}

/** Origin of BETTER_AUTH_URL when it is an absolute http(s) URL. */
export function originFromAuthBaseUrl(baseURL?: string): string | undefined {
  if (!baseURL) return undefined;
  try {
    const url = new URL(baseURL);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Trusted browser origins for Better Auth. Always includes the baseURL origin
 * (better-auth also auto-adds it) plus explicit art/video hosts so art↔video
 * cutover is not half-broken when env lags.
 */
export function resolveTrustedOrigins(options: {
  baseURL?: string;
  includeLocalDev?: boolean;
  extra?: readonly string[];
}): string[] {
  const origins = new Set<string>(HOSTED_WEB_TRUSTED_ORIGINS);
  const fromBase = originFromAuthBaseUrl(options.baseURL);
  if (fromBase) origins.add(fromBase);
  if (options.includeLocalDev ?? isLocalAuthBaseUrl(options.baseURL)) {
    for (const origin of LOCAL_DEV_ORIGINS) origins.add(origin);
  }
  for (const origin of options.extra ?? []) {
    if (origin) origins.add(origin);
  }
  return [...origins];
}

/**
 * Clash-branded OAuth / API error landing. Better Auth appends `?error=…`.
 * Prefer absolute URL when baseURL is known so redirects stay on-product.
 */
export function resolveAuthErrorURL(baseURL?: string): string {
  const origin = originFromAuthBaseUrl(baseURL);
  if (origin) return `${origin}${AUTH_ERROR_PATH}`;
  return AUTH_ERROR_PATH;
}

/**
 * Hosts that should 301 to the canonical product origin (path + query kept).
 * Comma-separated env, e.g. `clash.video,www.clash.video`.
 */
export function resolveLegacyWebRedirect(
  requestUrl: URL,
  env: { LEGACY_WEB_REDIRECT_HOSTS?: string; BETTER_AUTH_URL?: string },
): string | null {
  const raw = env.LEGACY_WEB_REDIRECT_HOSTS?.trim();
  if (!raw) return null;
  const hosts = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const requestHost = requestUrl.host.toLowerCase();
  if (!hosts.includes(requestHost)) return null;
  const canonical = originFromAuthBaseUrl(env.BETTER_AUTH_URL);
  if (!canonical) return null;
  if (requestUrl.origin === canonical) return null;
  return `${canonical}${requestUrl.pathname}${requestUrl.search}`;
}
