/**
 * One-query Better Auth session check for api-cf (issue #135). Parameters
 * (cookie name incl. `__Secure-` rule, secret, expiresIn, updateAge) come
 * from the live Better Auth context so they cannot drift from the config;
 * the check itself lives in ./session-cookie (no better-auth import).
 */
import type { D1Database } from "@cloudflare/workers-types";
import { createAuth, type AuthBindings } from "../auth";
import {
  hmacKey,
  verifySessionCookie,
  type FastSession,
  type SessionCookieParams,
} from "./session-cookie";

export type { FastSession };

const paramsByEnv = new WeakMap<object, Promise<SessionCookieParams>>();

export async function betterAuthSessionCookieParams(env: AuthBindings): Promise<SessionCookieParams> {
  let pending = paramsByEnv.get(env);
  if (!pending) {
    pending = (async () => {
      const ctx = await createAuth(env).$context;
      return {
        cookieName: ctx.authCookies.sessionToken.name,
        dontRememberCookieName: ctx.authCookies.dontRememberToken.name,
        key: await hmacKey(ctx.secret),
        expiresInMs: ctx.sessionConfig.expiresIn * 1000,
        updateAgeMs: ctx.sessionConfig.updateAge * 1000,
      };
    })();
    pending.catch(() => paramsByEnv.delete(env));
    paramsByEnv.set(env, pending);
  }
  return pending;
}

export async function verifySessionFast(
  request: Request,
  env: AuthBindings & { DB: D1Database },
): Promise<FastSession | null | "fallback"> {
  if (!request.headers.get("cookie")) return null;
  let params: SessionCookieParams;
  try {
    params = await betterAuthSessionCookieParams(env);
  } catch {
    return "fallback";
  }
  return verifySessionCookie(request, env.DB, params);
}
