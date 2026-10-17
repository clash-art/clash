/**
 * Issue #154: GET /api/better-auth/get-session for the web Worker.
 *
 * Still answered by Better Auth, with three cheaper paths in front of it:
 *  1. Cookie-cache hit (signed `session_data`, at most maxAge old): Better
 *     Auth answers without touching D1.
 *  2. Cache miss with read replicas enabled (`D1_READ_REPLICAS=auto`): the
 *     lookup goes through the D1 Sessions API (`first-unconstrained`), so it
 *     can hit the nearest replica. A replica can lag the primary, which would
 *     make a just-created session look missing, so a null answer is re-run
 *     against the primary before it is returned (the rule meta uses, #140).
 *     A refresh write issued by Better Auth through the Sessions handle is
 *     still sent to the primary by D1.
 *  3. Otherwise Better Auth runs against the primary as before.
 */
import { createAuth, runWithD1, type AuthBindings } from "./better-auth.server";

export interface GetSessionEnv extends AuthBindings {
  D1_READ_REPLICAS?: string;
}

const SESSION_TOKEN_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

export function isGetSessionRequest(request: Request, path: string): boolean {
  return path === "/api/better-auth/get-session" && request.method === "GET";
}

export async function handleGetSession(request: Request, env: GetSessionEnv): Promise<Response> {
  const auth = createAuth(env);
  const db = env.DB as Partial<Pick<D1Database, "withSession">>;
  const hasToken = SESSION_TOKEN_COOKIE.test(request.headers.get("cookie") ?? "");
  if (env.D1_READ_REPLICAS === "auto" && hasToken && typeof db.withSession === "function") {
    const replica = db.withSession("first-unconstrained");
    const response = await runWithD1(replica, () => auth.handler(request.clone() as Request));
    if (response.status === 200) {
      const body = await response.text();
      if (body.trim() !== "null" && body.trim() !== "") {
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    }
    // Null (missing on the replica) or an error: let the primary decide.
    // This drops the replica answer, including any cookie-clearing headers.
  }
  return auth.handler(request);
}
