import type { D1Database, IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { loadAuth, type AuthBindings } from "./auth-loader";
import { verifySessionFast } from "./session-fast";

export const DEV_USER_ID = "dev-user";

import { getUserIdFromApiToken } from "./api-token";
export { getUserIdFromApiToken };

export interface SessionEnv extends AuthBindings {
  NODE_ENV?: string;
  SKIP_LOGIN?: string;
}

/** Better Auth session behind a request; `sessionId` is null only for SKIP_LOGIN. */
export interface SessionIdentity {
  userId: string;
  sessionId: string | null;
}

function stringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== "object") return null;
  const found = (value as Record<string, unknown>)[field];
  return typeof found === "string" ? found : null;
}

export async function getSessionIdentity(
  request: Request,
  env: SessionEnv,
  cf?: IncomingRequestCfProperties,
): Promise<SessionIdentity | null> {
  if (env.SKIP_LOGIN === "true") return { userId: DEV_USER_ID, sessionId: null };
  try {
    const fast = await verifySessionFast(request, env);
    if (fast !== "fallback")
      return fast ? { userId: fast.userId, sessionId: fast.sessionId } : null;
  } catch {
    // fall through to the full Better Auth path
  }
  const { createAuth } = await loadAuth();
  const auth = createAuth(env, cf);
  try {
    const session: unknown = await auth.api.getSession({
      headers: new Headers(request.headers),
    });
    const record =
      session && typeof session === "object"
        ? (session as Record<string, unknown>)
        : null;
    const userId = stringField(record?.user, "id");
    return userId
      ? { userId, sessionId: stringField(record?.session, "id") }
      : null;
  } catch {
    return null;
  }
}

export async function getUserIdFromRequest(
  request: Request,
  env: SessionEnv,
  cf?: IncomingRequestCfProperties,
): Promise<string | null> {
  return (await getSessionIdentity(request, env, cf))?.userId ?? null;
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
