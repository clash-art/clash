/**
 * Admin identity (#394; guide: apps/docs/guide/gateway-admin.md): who may use
 * /api/v1/admin/*, and the isolation between admin and product identities.
 *
 * - An admin is an admin account signed in through the admin Better Auth
 *   instance (src/admin-auth.ts, /api/admin-auth/*, `clash-admin.*` cookies,
 *   admin_* tables). It is never a product user.
 * - /api/v1/admin/* takes an admin session and nothing else
 *   (`resolveAdminRequest`, run by the /api/* middleware before any admin
 *   route): no credential is GATEWAY_AUTH_REQUIRED (401); a product session,
 *   a clsh_ / sk_gw_ token or any other Authorization header is
 *   GATEWAY_ADMIN_SESSION_REQUIRED (403), whatever else the request carries.
 * - Product routes never resolve an admin session as a user: the product
 *   verifiers read only the product cookie and tables. Where the product API
 *   requires an identity, a request that carries only an admin session is
 *   ADMIN_SESSION_NOT_ACCEPTED (403) (`adminSessionOnProductResponse`).
 *
 * Better Auth itself is loaded lazily, only for requests that present an
 * admin session cookie.
 */
import type { Context } from "hono";
import {
  GATEWAY_ADMIN_API_PREFIX,
  GATEWAY_ADMIN_AUTH_BASE_PATH,
  GATEWAY_ADMIN_COOKIE_PREFIX,
  GatewayError,
  presentedProductCredential,
  presentsGatewayAdminSession,
  resolveGatewayAdminRequest,
  type GatewayAdminAccountIdentity,
} from "@clash/gateway-core";

import type { AdminAuthBindings } from "../admin-auth";

// The paths, cookie prefix and credential gate are gateway-core's, shared
// with api-node's admin listener (#372).
export const ADMIN_AUTH_BASE_PATH = GATEWAY_ADMIN_AUTH_BASE_PATH;
export const ADMIN_API_PREFIX = GATEWAY_ADMIN_API_PREFIX;
export const ADMIN_COOKIE_PREFIX = GATEWAY_ADMIN_COOKIE_PREFIX;

/** Admin account ids are distinguishable from product user ids wherever they are recorded. */
export function newAdminAccountId(): string {
  return `adm_${crypto.randomUUID().replaceAll("-", "")}`;
}

const underPrefix = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
export const isAdminApiPath = (path: string) => underPrefix(path, ADMIN_API_PREFIX);
export const isAdminAuthPath = (path: string) => underPrefix(path, ADMIN_AUTH_BASE_PATH);

export const presentsAdminSession = presentsGatewayAdminSession;
export { presentedProductCredential };

/** admin_accounts.id (`adm_…`) and the account's role; its permissions are services/gateway-authz.ts. */
export type AdminIdentity = GatewayAdminAccountIdentity;

/** The admin account behind the request's admin session cookie, or null. */
export async function verifyAdminSession(request: Request, env: AdminAuthBindings): Promise<AdminIdentity | null> {
  if (!presentsAdminSession(request)) return null;
  const { createAdminAuth } = await import("../admin-auth");
  let session: unknown;
  try {
    session = await createAdminAuth(env).api.getSession({ headers: new Headers(request.headers) });
  } catch {
    return null;
  }
  const user = (session as { user?: Record<string, unknown> } | null)?.user;
  if (!user || typeof user.id !== "string" || typeof user.role !== "string") return null;
  if (user.disabledAt !== null && user.disabledAt !== undefined) return null;
  return {
    id: user.id,
    email: typeof user.email === "string" ? user.email : "",
    name: typeof user.name === "string" ? user.name : "",
    role: user.role,
  };
}

/** The /api/v1/admin/* gate (gateway-core `resolveGatewayAdminRequest`) over this Worker's admin sessions. */
export function resolveAdminRequest(
  request: Request,
  env: AdminAuthBindings,
): Promise<{ admin: AdminIdentity } | { error: GatewayError }> {
  return resolveGatewayAdminRequest(request, (r) => verifyAdminSession(r, env));
}

export const ADMIN_SESSION_NOT_ACCEPTED = "ADMIN_SESSION_NOT_ACCEPTED";

/** A product API refusing a request whose only credential is an admin session. */
export function adminSessionOnProductResponse(): Response {
  return Response.json(
    {
      error: "Admin sessions cannot use the product API; sign in with a product account.",
      code: ADMIN_SESSION_NOT_ACCEPTED,
    },
    { status: 403, headers: { "x-clash-error-code": ADMIN_SESSION_NOT_ACCEPTED, "cache-control": "no-store" } },
  );
}

const KEY = "clash.adminIdentity";

export function setAdminIdentity(c: Context<any>, admin: AdminIdentity): void {
  c.set(KEY as never, admin as never);
}

/** The admin the middleware verified for this request; GATEWAY_AUTH_REQUIRED without one. */
export function requireAdminIdentity(c: Context<any>): AdminIdentity {
  const admin = c.get(KEY as never) as AdminIdentity | undefined;
  if (!admin) throw new GatewayError("GATEWAY_AUTH_REQUIRED");
  return admin;
}
