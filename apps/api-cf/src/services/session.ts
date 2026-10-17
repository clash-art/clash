import type { D1Database, IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { createAuth, type AuthBindings } from "../auth";

export const DEV_USER_ID = "dev-user";

import { getUserIdFromApiToken } from "./api-token";
export { getUserIdFromApiToken };

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
    const session: unknown = await auth.api.getSession({
      headers: new Headers(request.headers),
    });
    const user = session && typeof session === "object" && "user" in session ? session.user : null;
    return user && typeof user === "object" && "id" in user && typeof user.id === "string"
      ? user.id
      : null;
  } catch {
    return null;
  }
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
