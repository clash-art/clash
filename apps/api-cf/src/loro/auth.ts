/** Cloudflare adapters for the shared project transport authorization policy. */
import * as jose from "jose";
import {
  createProjectAuthenticator,
  type AuthResult,
  type ProjectAuthorizationPolicy,
  type ProjectAuthorizationStore,
  type SessionIdentity,
} from "@clash/shared-runtime/project-authorization";
import type { D1Database } from "@cloudflare/workers-types";
import { createAuth, type AuthBindings } from "../auth";
import { verifySessionFast } from "../services/session-fast";
import type { Env } from "../config";
import { serverLog } from "../logger";

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
        `SELECT t.user_id, t.name, u.name AS user_name, u.image AS user_image
           FROM api_token t LEFT JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ? LIMIT 1`,
      )
        .bind(tokenHash)
        .all<{
          user_id: string;
          name: string;
          user_name: string | null;
          user_image: string | null;
        }>();
      const row = results?.[0];
      return row
        ? {
            userId: row.user_id,
            name: row.name,
            userName: row.user_name ?? undefined,
            userAvatar: row.user_image ?? undefined,
          }
        : null;
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

/** Explicit external session authority (`BETTER_AUTH_ORIGIN`), for a
 * deployment whose Better Auth handler is not this Worker. */
async function fetchBetterAuthSession(
  request: Request,
  env: Env,
  origin: string,
): Promise<unknown> {
  const cookie = request.headers.get("cookie"),
    authorization = request.headers.get("authorization");
  const basePath = env.BETTER_AUTH_BASE_PATH ?? "/api/better-auth";
  const response = await fetch(new URL(`${basePath}/get-session`, origin), {
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(authorization ? { authorization } : {}),
      accept: "application/json",
    },
  });
  return response.ok ? response.json() : null;
}

/** Never derive the session authority from the request URL. Behind the Web
 * gateway's service binding that is the public Web origin, and a Worker cannot
 * `fetch` another Worker of its own account there: the loopback is answered
 * with an error, every browser cookie reads as "no session", and /sync returns
 * 401. This Worker shares the D1 and BETTER_AUTH_SECRET that issued the
 * cookie, so it validates in-process exactly as `/api/*` does. */
async function getBetterAuthSession(
  request: Request,
  env: Env,
): Promise<SessionIdentity | null> {
  if (!request.headers.has("cookie") && !request.headers.has("authorization"))
    return null;
  if (!env.BETTER_AUTH_ORIGIN) {
    // Issue #135: one JOIN instead of getSession's two queries. The row was
    // just read from the session authority, so the caller can skip its
    // separate session recheck.
    try {
      const fast = await verifySessionFast(request, env as unknown as AuthBindings & { DB: D1Database });
      if (fast === null) return null;
      if (fast !== "fallback")
        return {
          session: { id: fast.sessionId, expiresAt: fast.expiresAt },
          user: {
            id: fast.userId,
            ...(fast.userName ? { name: fast.userName } : {}),
            ...(fast.userImage ? { image: fast.userImage } : {}),
          },
          authorityChecked: true,
        };
    } catch (error) {
      serverLog
        .child("project-auth")
        .warn("project_auth.fast_session_failed", { error });
    }
  }
  let value: unknown;
  try {
    value = env.BETTER_AUTH_ORIGIN
      ? await fetchBetterAuthSession(request, env, env.BETTER_AUTH_ORIGIN)
      : await createAuth(env as unknown as AuthBindings).api.getSession({
          headers: new Headers(request.headers),
        });
  } catch (error) {
    // A missing secret or unreachable authority is a deployment fault, not a
    // signed-out browser; it must be visible in the Worker logs.
    serverLog
      .child("project-auth")
      .error("project_auth.session_lookup_failed", { error });
    return null;
  }
  const { session, user } = (value ?? {}) as {
    session?: { id?: unknown; expiresAt?: unknown };
    user?: { id?: unknown; name?: unknown; image?: unknown };
  };
  const expiresAt =
    session?.expiresAt instanceof Date
      ? session.expiresAt.getTime()
      : session?.expiresAt;
  if (
    typeof user?.id !== "string" ||
    !user.id ||
    typeof session?.id !== "string" ||
    !session.id ||
    (typeof expiresAt !== "string" && typeof expiresAt !== "number")
  )
    return null;
  return {
    session: { id: session.id, expiresAt },
    user: {
      id: user.id,
      ...(typeof user.name === "string" ? { name: user.name } : {}),
      ...(typeof user.image === "string" ? { image: user.image } : {}),
    },
  };
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
  policy?: ProjectAuthorizationPolicy,
): Promise<AuthResult> {
  return authenticator(env).authenticate(request, projectId, policy);
}

export async function revalidateProjectConnection(
  env: Env,
  auth: AuthResult,
): Promise<boolean> {
  return authenticator(env).revalidate(auth);
}
