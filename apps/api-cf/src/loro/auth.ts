/** Project transport authentication and non-secret connection revocation evidence. */
import * as jose from "jose";
import type { Env } from "../config";

export type ProjectConnectionAuthorization =
  | { kind: "api-token"; tokenHash: string }
  | { kind: "jwt"; expiresAt: number }
  | { kind: "session"; sessionId: string; expiresAt: number }
  | { kind: "development" };

export interface AuthResult {
  userId: string;
  projectId: string;
  userName?: string;
  userAvatar?: string;
  /** Safe to retain across WebSocket hibernation; never a raw token or cookie. */
  authorization: ProjectConnectionAuthorization;
}

async function assertProjectOwner(env: Env, projectId: string, userId: string) {
  if (!env.DB) throw new Error("Project authority unavailable");
  const { results } = await env.DB.prepare(
    "SELECT owner_id, deleted_at FROM project WHERE id = ? LIMIT 1",
  )
    .bind(projectId)
    .all<{ owner_id: string; deleted_at: number | null }>();
  const row = results?.[0];
  if (!row || row.owner_id !== userId || row.deleted_at != null)
    throw new Error("Forbidden");
}

/** Recheck before accepting a command or delivering private data. JWTs have a
 * finite lifetime and current Project ownership, not invented per-JWT revocation.
 * Better Auth and API credentials additionally require their current D1 record. */
export async function revalidateProjectConnection(
  env: Env,
  auth: AuthResult,
): Promise<boolean> {
  try {
    if (!auth?.authorization || !auth.userId || !auth.projectId) return false;
    const proof = auth.authorization;
    if (proof.kind === "development") return env.ENVIRONMENT === "development";
    if (env.ENVIRONMENT !== "development")
      await assertProjectOwner(env, auth.projectId, auth.userId);
    if (proof.kind === "jwt")
      return Number.isFinite(proof.expiresAt) && proof.expiresAt > Date.now();
    if (proof.kind === "api-token") {
      const { results } = await env.DB.prepare(
        "SELECT user_id FROM api_token WHERE token_hash = ? LIMIT 1",
      )
        .bind(proof.tokenHash)
        .all<{ user_id: string }>();
      return results?.[0]?.user_id === auth.userId;
    }
    if (proof.kind === "session") {
      if (!Number.isFinite(proof.expiresAt) || proof.expiresAt <= Date.now())
        return false;
      const { results } = await env.DB.prepare(
        "SELECT user_id, expires_at FROM sessions WHERE id = ? LIMIT 1",
      )
        .bind(proof.sessionId)
        .all<{ user_id: string; expires_at: number }>();
      const session = results?.[0];
      return (
        session?.user_id === auth.userId && session.expires_at > Date.now()
      );
    }
    return false;
  } catch {
    return false;
  }
}

async function sha256(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

type SessionIdentity = {
  session: { id: string; expiresAt: string | number };
  user: { id: string; name?: string; image?: string };
};
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

export async function authenticateRequest(
  request: Request,
  env: Env,
  projectId: string,
): Promise<AuthResult> {
  const development = env.ENVIRONMENT === "development";
  const rawToken = request.headers
    .get("authorization")
    ?.match(/^Bearer (.+)$/i)?.[1];
  const verifyOwnership = async (userId: string) => {
    if (!development) await assertProjectOwner(env, projectId, userId);
  };

  // Known API credentials are resolved locally, never sent to a session service.
  if (rawToken?.startsWith("clsh_")) {
    const tokenHash = await sha256(rawToken);
    const { results } = await env.DB.prepare(
      "SELECT user_id, name FROM api_token WHERE token_hash = ? LIMIT 1",
    )
      .bind(tokenHash)
      .all<{ user_id: string; name: string }>();
    const row = results?.[0];
    if (!row?.user_id) throw new Error("Unauthorized");
    await verifyOwnership(row.user_id);
    void env.DB.prepare(
      "UPDATE api_token SET last_used_at = unixepoch() WHERE token_hash = ?",
    )
      .bind(tokenHash)
      .run()
      .catch(() => {});
    return {
      userId: row.user_id,
      projectId,
      userName: row.name || "CLI",
      authorization: { kind: "api-token", tokenHash },
    };
  }

  // Browser cookie sessions retain precedence over a separate JWT credential.
  if (
    request.headers.has("cookie") ||
    (rawToken && rawToken.split(".").length !== 3)
  ) {
    const session = await getBetterAuthSession(request, env);
    if (session) {
      await verifyOwnership(session.user.id);
      const expiresAt =
        typeof session.session.expiresAt === "number"
          ? session.session.expiresAt
          : Date.parse(session.session.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
        throw new Error("Unauthorized");
      const identity: AuthResult = {
        userId: session.user.id,
        projectId,
        userName: session.user.name,
        userAvatar: session.user.image,
        authorization: {
          kind: "session",
          sessionId: session.session.id,
          expiresAt,
        },
      };
      if (!development && !(await revalidateProjectConnection(env, identity)))
        throw new Error("Unauthorized");
      return identity;
    }
  }

  if (rawToken && env.JWT_SECRET) {
    const { payload } = await jose.jwtVerify(
      rawToken,
      new TextEncoder().encode(env.JWT_SECRET),
      { algorithms: ["HS256"] },
    );
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.projectId !== "string" ||
      !payload.projectId ||
      !Number.isFinite(payload.exp)
    )
      throw new Error("Invalid JWT payload: missing required fields or expiry");
    if (payload.projectId !== projectId) throw new Error("Project ID mismatch");
    await verifyOwnership(payload.sub);
    return {
      userId: payload.sub,
      projectId,
      authorization: { kind: "jwt", expiresAt: payload.exp! * 1000 },
    };
  }
  if (development && !rawToken && !request.headers.has("cookie"))
    return {
      userId: "dev-user",
      projectId,
      authorization: { kind: "development" },
    };
  throw new Error("Unauthorized");
}
