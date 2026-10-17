/**
 * One-query Better Auth session check (issue #135).
 *
 * `auth.api.getSession` costs two sequential D1 round trips (session row,
 * then user row). This does the same check with one JOIN, and it reads its
 * parameters from the live Better Auth context, so they cannot drift from the
 * auth config: cookie name (including the `__Secure-` prefix rule), signing
 * secret, `expiresIn` and `updateAge`.
 *
 * Whenever Better Auth itself would do more than read, this returns
 * "fallback" and the caller runs the real `getSession`. Those cases are an
 * expired session (Better Auth deletes the row) and a session due for its
 * sliding refresh (Better Auth extends `expires_at`). Revocation stays
 * immediate: a deleted session row or user fails the JOIN.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { createAuth, type AuthBindings } from "../auth";

export interface FastSession {
  sessionId: string;
  userId: string;
  expiresAt: number;
  userName: string | null;
  userImage: string | null;
}

interface AuthParams {
  cookieName: string;
  dontRememberCookieName: string;
  key: CryptoKey;
  expiresInMs: number;
  updateAgeMs: number;
}

const paramsByEnv = new WeakMap<object, Promise<AuthParams>>();

async function authParams(env: AuthBindings): Promise<AuthParams> {
  let pending = paramsByEnv.get(env);
  if (!pending) {
    pending = (async () => {
      const ctx = await createAuth(env).$context;
      return {
        cookieName: ctx.authCookies.sessionToken.name,
        dontRememberCookieName: ctx.authCookies.dontRememberToken.name,
        key: await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(ctx.secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["verify"],
        ),
        expiresInMs: ctx.sessionConfig.expiresIn * 1000,
        updateAgeMs: ctx.sessionConfig.updateAge * 1000,
      };
    })();
    pending.catch(() => paramsByEnv.delete(env));
    paramsByEnv.set(env, pending);
  }
  return pending;
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

export async function verifySessionFast(
  request: Request,
  env: AuthBindings & { DB: D1Database },
): Promise<FastSession | null | "fallback"> {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  let params: AuthParams;
  try {
    params = await authParams(env);
  } catch {
    return "fallback";
  }
  const signed = readCookie(cookieHeader, params.cookieName);
  if (!signed) return null;
  const token = await unsignedToken(signed, params.key);
  if (!token) return null;
  const row = await env.DB.prepare(
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
