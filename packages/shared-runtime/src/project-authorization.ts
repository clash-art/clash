/** Project transport authentication and non-secret connection revocation evidence. */
/** Backend-neutral authority records. Adapters normalize database columns here. */
export interface ProjectAuthorizationStore {
  readProject(
    projectId: string,
  ): Promise<{ ownerId: string; deletedAt: number | null } | null>;
  readApiToken(
    tokenHash: string,
  ): Promise<{ userId: string; name?: string } | null>;
  touchApiToken(tokenHash: string): Promise<void>;
  readSession(
    sessionId: string,
  ): Promise<{ userId: string; expiresAt: number } | null>;
}
export interface ProjectAuthenticatorOptions {
  store: ProjectAuthorizationStore;
  development?: boolean;
  resolveSession?: (request: Request) => Promise<SessionIdentity | null>;
  /** Must verify signature/algorithm before returning claims; never just decode. */
  verifyJwt?: (
    token: string,
  ) => Promise<{ sub?: unknown; projectId?: unknown; exp?: unknown }>;
}

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

async function assertProjectOwner(
  options: ProjectAuthenticatorOptions,
  projectId: string,
  userId: string,
) {
  const row = await options.store.readProject(projectId);
  if (!row || row.ownerId !== userId || row.deletedAt != null)
    throw new Error("Forbidden");
}

/** Recheck before accepting a command or delivering private data. JWTs have a
 * finite lifetime and current Project ownership, not invented per-JWT revocation.
 * Better Auth and API credentials additionally require their current authority record. */
export async function revalidateProjectConnection(
  options: ProjectAuthenticatorOptions,
  auth: AuthResult,
): Promise<boolean> {
  try {
    if (!auth?.authorization || !auth.userId || !auth.projectId) return false;
    const proof = auth.authorization;
    if (proof.kind === "development") return options.development === true;
    if (options.development !== true)
      await assertProjectOwner(options, auth.projectId, auth.userId);
    if (proof.kind === "jwt")
      return Number.isFinite(proof.expiresAt) && proof.expiresAt > Date.now();
    if (proof.kind === "api-token") {
      const token = await options.store.readApiToken(proof.tokenHash);
      return token?.userId === auth.userId;
    }
    if (proof.kind === "session") {
      if (!Number.isFinite(proof.expiresAt) || proof.expiresAt <= Date.now())
        return false;
      const session = await options.store.readSession(proof.sessionId);
      return session?.userId === auth.userId && session.expiresAt > Date.now();
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

/** Identity-only authentication for admitting a not-yet-hosted Project. */
export async function authenticateApiToken(
  request: Request,
  store: ProjectAuthorizationStore,
) {
  const rawToken = request.headers
    .get("authorization")
    ?.match(/^Bearer (.+)$/i)?.[1];
  if (!rawToken?.startsWith("clsh_")) throw new Error("Unauthorized");
  const tokenHash = await sha256(rawToken);
  const row = await store.readApiToken(tokenHash);
  if (!row?.userId) throw new Error("Unauthorized");
  void store.touchApiToken(tokenHash).catch(() => {});
  return { userId: row.userId, name: row.name, tokenHash };
}

export type SessionIdentity = {
  session: { id: string; expiresAt: string | number };
  user: { id: string; name?: string; image?: string };
};
export async function authenticateRequest(
  request: Request,
  options: ProjectAuthenticatorOptions,
  projectId: string,
): Promise<AuthResult> {
  const development = options.development === true;
  const rawToken = request.headers
    .get("authorization")
    ?.match(/^Bearer (.+)$/i)?.[1];
  const verifyOwnership = async (userId: string) => {
    if (!development) await assertProjectOwner(options, projectId, userId);
  };

  // Known API credentials are resolved locally, never sent to a session service.
  if (rawToken?.startsWith("clsh_")) {
    const row = await authenticateApiToken(request, options.store);
    const tokenHash = row.tokenHash;
    await verifyOwnership(row.userId);
    return {
      userId: row.userId,
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
    const session = await options.resolveSession?.(request);
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
      if (
        !development &&
        !(await revalidateProjectConnection(options, identity))
      )
        throw new Error("Unauthorized");
      return identity;
    }
  }

  if (rawToken && options.verifyJwt) {
    const payload = await options.verifyJwt(rawToken);
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.projectId !== "string" ||
      !payload.projectId ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp * 1000 <= Date.now()
    )
      throw new Error("Invalid JWT payload: missing required fields or expiry");
    if (payload.projectId !== projectId) throw new Error("Project ID mismatch");
    await verifyOwnership(payload.sub);
    return {
      userId: payload.sub,
      projectId,
      authorization: { kind: "jwt", expiresAt: (payload.exp as number) * 1000 },
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

/** One policy implementation for D1 and Node authorities. */
export function createProjectAuthenticator(
  options: ProjectAuthenticatorOptions,
) {
  return {
    authenticate: (request: Request, projectId: string) =>
      authenticateRequest(request, options, projectId),
    revalidate: (identity: AuthResult) =>
      revalidateProjectConnection(options, identity),
  };
}
