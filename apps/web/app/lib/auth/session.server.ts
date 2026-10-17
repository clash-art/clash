import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { createAuth, type AuthBindings } from "./better-auth.server";

export const DEV_USER_ID = "dev-user";

type AuthSession = {
  user?: {
    id?: string | null;
  } | null;
} | null;

export interface SessionEnv extends AuthBindings {
  NODE_ENV?: string;
  SKIP_LOGIN?: string;
}

export async function getUserIdFromRequest(
  request: Request,
  env: SessionEnv,
  cf?: IncomingRequestCfProperties,
): Promise<string | null> {
  if (env.SKIP_LOGIN === "true") return DEV_USER_ID;
  const auth = createAuth(env, cf);
  try {
    // Server-side authorization reads the sessions table, never the cookie
    // cache (issue #154), so a revoked session is rejected immediately.
    const session = (await auth.api.getSession({
      headers: new Headers(request.headers),
      query: { disableCookieCache: true },
    })) as AuthSession;
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

export async function getUserIdOrDev(
  request: Request,
  env: SessionEnv,
  cf?: IncomingRequestCfProperties,
): Promise<string> {
  const userId = await getUserIdFromRequest(request, env, cf);
  if (userId) return userId;
  if (env.NODE_ENV === "development" && env.SKIP_LOGIN === "true") {
    return DEV_USER_ID;
  }
  throw new Response("Unauthorized", { status: 401 });
}

export async function requireUserId(
  request: Request,
  env: SessionEnv,
  cf?: IncomingRequestCfProperties,
): Promise<string> {
  const userId = await getUserIdFromRequest(request, env, cf);
  if (!userId) throw new Response("Unauthorized", { status: 401 });
  return userId;
}
