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
import { GatewayError } from "@clash/gateway-core";

import type { AdminAuthBindings } from "../admin-auth";

export const ADMIN_AUTH_BASE_PATH = "/api/admin-auth";
export const ADMIN_API_PREFIX = "/api/v1/admin";
export const ADMIN_COOKIE_PREFIX = "clash-admin";
/** Better Auth's default prefix, which the product instances use. */
const PRODUCT_COOKIE_PREFIX = "better-auth";

/** Admin account ids are distinguishable from product user ids wherever they are recorded. */
export function newAdminAccountId(): string {
  return `adm_${crypto.randomUUID().replaceAll("-", "")}`;
}

const underPrefix = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
export const isAdminApiPath = (path: string) => underPrefix(path, ADMIN_API_PREFIX);
export const isAdminAuthPath = (path: string) => underPrefix(path, ADMIN_AUTH_BASE_PATH);

function cookieNames(request: Request): Set<string> {
  const names = new Set<string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(eq + 1).trim()) names.add(part.slice(0, eq).trim());
  }
  return names;
}

function hasSessionCookie(request: Request, prefix: string): boolean {
  const names = cookieNames(request);
  return names.has(`${prefix}.session_token`) || names.has(`__Secure-${prefix}.session_token`);
}

export const presentsAdminSession = (request: Request) => hasSessionCookie(request, ADMIN_COOKIE_PREFIX);

/** A product credential the request presents, by kind; validity is not checked. */
export function presentedProductCredential(request: Request): "token" | "product_session" | null {
  if (request.headers.get("authorization")?.trim() || request.headers.get("x-api-key")?.trim()) return "token";
  return hasSessionCookie(request, PRODUCT_COOKIE_PREFIX) ? "product_session" : null;
}

export interface AdminIdentity {
  /** admin_accounts.id (`adm_…`). */
  id: string;
  email: string;
  name: string;
  /** The account's role; its permissions are services/gateway-authz.ts. */
  role: string;
}

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

/**
 * The /api/v1/admin/* gate. A token (any Authorization or x-api-key header)
 * is refused even next to a valid admin session: admin routes never read one,
 * so presenting one is the wrong identity kind. A product session cookie next
 * to a valid admin session is not: a browser signed in to both the product
 * and the console carries both cookies, and the admin one decides.
 */
export async function resolveAdminRequest(
  request: Request,
  env: AdminAuthBindings,
): Promise<{ admin: AdminIdentity } | { error: GatewayError }> {
  const presented = presentedProductCredential(request);
  const wrongKind = (kind: string) =>
    new GatewayError("GATEWAY_ADMIN_SESSION_REQUIRED", { details: { presented: kind } });
  if (presented === "token") return { error: wrongKind("token") };
  const admin = await verifyAdminSession(request, env);
  if (admin) return { admin };
  if (presented === "product_session") return { error: wrongKind("product_session") };
  return { error: new GatewayError("GATEWAY_AUTH_REQUIRED") };
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
