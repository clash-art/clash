/**
 * Better Auth session cookie verification without importing better-auth
 * (issues #135, #138). Shared by api-cf (params read from the live Better
 * Auth context) and the lean metadata Worker (params derived from the same
 * config, pinned by a contract test against Better Auth).
 */
import type { D1Database } from "@cloudflare/workers-types";

export interface FastSession {
  sessionId: string;
  userId: string;
  expiresAt: number;
  userName: string | null;
  userImage: string | null;
}

export interface SessionCookieParams {
  cookieName: string;
  dontRememberCookieName: string;
  key: CryptoKey;
  expiresInMs: number;
  updateAgeMs: number;
}

export async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/** Better Auth defaults (we set neither cookiePrefix, expiresIn nor updateAge). */
export const BETTER_AUTH_SESSION_DEFAULTS = {
  cookiePrefix: "better-auth",
  expiresInSeconds: 60 * 60 * 24 * 7,
  updateAgeSeconds: 60 * 60 * 24,
} as const;

const leanParams = new Map<string, Promise<SessionCookieParams>>();

/** Params for a Worker that does not load better-auth. Secure-cookie rule
 * (better-auth createCookieGetter): `__Secure-` prefix when its baseURL is
 * https; with no baseURL it depends on NODE_ENV at build time, so that case
 * must be pinned explicitly with BETTER_AUTH_SECURE_COOKIES ("true"/"false")
 * to match the Worker that issues the cookie. Returns null when the config
 * cannot be derived safely (caller defers to Better Auth). */
export function leanSessionCookieParams(env: {
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECURE_COOKIES?: string;
  BETTER_AUTH_SECRET?: string;
  AUTH_SECRET?: string;
}): Promise<SessionCookieParams> | null {
  const secret = env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET;
  if (!secret) return null;
  const pinned = env.BETTER_AUTH_SECURE_COOKIES;
  const secure =
    pinned === "true" ? true
    : pinned === "false" ? false
    : env.BETTER_AUTH_URL ? env.BETTER_AUTH_URL.startsWith("https://")
    : null;
  if (secure === null) return null;
  const cacheKey = `${secure}:${secret}`;
  let params = leanParams.get(cacheKey);
  if (!params) {
    const d = BETTER_AUTH_SESSION_DEFAULTS;
    const prefix = `${secure ? "__Secure-" : ""}${d.cookiePrefix}`;
    params = hmacKey(secret).then((key) => ({
      cookieName: `${prefix}.session_token`,
      dontRememberCookieName: `${prefix}.dont_remember`,
      key,
      expiresInMs: d.expiresInSeconds * 1000,
      updateAgeMs: d.updateAgeSeconds * 1000,
    }));
    leanParams.set(cacheKey, params);
  }
  return params;
}

function readCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Same acceptance rules as better-call `getSignedCookie`. */
async function unsignedToken(value: string, key: CryptoKey): Promise<string | null> {
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const token = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (signature.length !== 44 || !signature.endsWith("=")) return null;
  const bytes = base64ToBytes(signature);
  if (!bytes) return null;
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    new TextEncoder().encode(token),
  );
  return ok ? token : null;
}

/** One `sessions JOIN users` query. "fallback": Better Auth must handle it
 * (expired: it deletes the row; refresh due: it extends expires_at). */
export async function verifySessionCookie(
  request: Request,
  db: D1Database,
  params: SessionCookieParams,
): Promise<FastSession | null | "fallback"> {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  const signed = readCookie(cookieHeader, params.cookieName);
  if (!signed) return null;
  const token = await unsignedToken(signed, params.key);
  if (!token) return null;
  const row = await db.prepare(
    `SELECT s.id AS session_id, s.user_id, s.expires_at, u.name AS user_name, u.image AS user_image
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? LIMIT 1`,
  )
    .bind(token)
    .first<{
      session_id: string;
      user_id: string;
      expires_at: number;
      user_name: string | null;
      user_image: string | null;
    }>();
  if (!row) return null;
  const expiresAt = Number(row.expires_at);
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return "fallback";
  const refreshDue = expiresAt - params.expiresInMs + params.updateAgeMs <= now;
  if (refreshDue && !readCookie(cookieHeader, params.dontRememberCookieName))
    return "fallback";
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    expiresAt,
    userName: row.user_name,
    userImage: row.user_image,
  };
}
