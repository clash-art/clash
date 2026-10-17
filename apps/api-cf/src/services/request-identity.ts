/**
 * Per-request identity, resolved once by the `/api/*` middleware (issue: auth
 * verified twice per request). Routes read the result here instead of calling
 * better-auth `getSession` a second time, which cost two extra D1 round trips
 * (~85 ms each from a non-WNAM colo) on every request.
 *
 * Semantics are unchanged: session-only routes still accept only a Better Auth
 * session. A request the middleware authenticated by clsh_ API token falls
 * back to the old per-route session lookup (rare: token + cookie together).
 */
import type { Context } from "hono";
import { getUserIdFromRequest } from "./session";

export type ResolvedIdentity =
  | { via: "session"; userId: string }
  | { via: "api-token"; userId: string }
  | { via: "none"; userId: null };

const KEY = "clash.resolvedIdentity";

type AnyContext = Context<any>;

export function setResolvedIdentity(c: AnyContext, identity: ResolvedIdentity) {
  c.set(KEY as never, identity as never);
}

export function getResolvedIdentity(c: AnyContext): ResolvedIdentity | undefined {
  return c.get(KEY as never) as ResolvedIdentity | undefined;
}

/** Better Auth session user for this request, verified at most once. */
export async function sessionUserId(c: AnyContext): Promise<string | null> {
  const resolved = getResolvedIdentity(c);
  if (resolved?.via === "session") return resolved.userId;
  if (resolved?.via === "none") return null;
  // No middleware ran (route mounted standalone) or the request was
  // authenticated by API token: keep the original session-only lookup.
  return getUserIdFromRequest(c.req.raw, c.env as never, c.req.raw.cf as never);
}

export async function requireSessionUserId(c: AnyContext): Promise<string> {
  const userId = await sessionUserId(c);
  if (!userId) throw new Response("Unauthorized", { status: 401 });
  return userId;
}
