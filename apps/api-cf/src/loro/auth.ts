/** Cloudflare adapters for the shared project transport authorization policy. */
import * as jose from "jose";
import {
  createProjectAuthenticator,
  type AuthResult,
  type ProjectAuthorizationStore,
  type SessionIdentity,
} from "@clash/shared-runtime/project-authorization";
import type { Env } from "../config";

export type {
  AuthResult,
  ProjectConnectionAuthorization,
} from "@clash/shared-runtime/project-authorization";

export function createD1ProjectAuthorizationStore(
  env: Pick<Env, "DB">,
): ProjectAuthorizationStore {
  return {
    async readProject(projectId) {
      if (!env.DB) throw new Error("Project authority unavailable");
      const { results } = await env.DB.prepare(
        "SELECT owner_id, deleted_at FROM project WHERE id = ? LIMIT 1",
      )
        .bind(projectId)
        .all<{ owner_id: string; deleted_at: number | null }>();
      const row = results?.[0];
      return row ? { ownerId: row.owner_id, deletedAt: row.deleted_at } : null;
    },
    async readApiToken(tokenHash) {
      const { results } = await env.DB.prepare(
        "SELECT user_id, name FROM api_token WHERE token_hash = ? LIMIT 1",
      )
        .bind(tokenHash)
        .all<{ user_id: string; name: string }>();
      const row = results?.[0];
      return row ? { userId: row.user_id, name: row.name } : null;
    },
    async touchApiToken(tokenHash) {
      await env.DB.prepare(
        "UPDATE api_token SET last_used_at = unixepoch() WHERE token_hash = ?",
      )
        .bind(tokenHash)
        .run();
    },
    async readSession(sessionId) {
      const { results } = await env.DB.prepare(
        "SELECT user_id, expires_at FROM sessions WHERE id = ? LIMIT 1",
      )
        .bind(sessionId)
        .all<{ user_id: string; expires_at: number }>();
      const row = results?.[0];
      return row ? { userId: row.user_id, expiresAt: row.expires_at } : null;
    },
  };
}

async function getBetterAuthSession(
  request: Request,
  env: Env,
): Promise<SessionIdentity | null> {
  const cookie = request.headers.get("cookie"),
    authorization = request.headers.get("authorization");
  if (!cookie && !authorization) return null;
  const origin = env.BETTER_AUTH_ORIGIN ?? new URL(request.url).origin;
  const basePath = env.BETTER_AUTH_BASE_PATH ?? "/api/better-auth";
  const response = await fetch(new URL(`${basePath}/get-session`, origin), {
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(authorization ? { authorization } : {}),
      accept: "application/json",
    },
  });
  if (!response.ok) return null;
  const value = (await response.json()) as Partial<SessionIdentity> | null;
  if (!value?.user?.id || !value.session?.id || !value.session.expiresAt)
    return null;
  return value as SessionIdentity;
}

function authenticator(env: Env) {
  const secret = env.JWT_SECRET;
  return createProjectAuthenticator({
    store: createD1ProjectAuthorizationStore(env),
    development: env.ENVIRONMENT === "development",
    resolveSession: (request) => getBetterAuthSession(request, env),
    ...(secret
      ? {
          verifyJwt: async (token: string) => {
            const { payload } = await jose.jwtVerify(
              token,
              new TextEncoder().encode(secret),
              { algorithms: ["HS256"] },
            );
            return payload;
          },
        }
      : {}),
  });
}

export async function authenticateRequest(
  request: Request,
  env: Env,
  projectId: string,
): Promise<AuthResult> {
  return authenticator(env).authenticate(request, projectId);
}

export async function revalidateProjectConnection(
  env: Env,
  auth: AuthResult,
): Promise<boolean> {
  return authenticator(env).revalidate(auth);
}
