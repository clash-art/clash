/**
 * The gateway control plane's role and permission matrix (#353, #392, #394,
 * #356; guide: apps/docs/guide/gateway-admin.md), shared by every adapter so
 * api-cf (D1) and api-node (Postgres) authorize the admin console with the
 * same data. Which role holds which permission is defined here and nowhere
 * else; each adapter only resolves the caller (a team role or an admin
 * account) and asks these tables. The admin credential gate
 * (`resolveGatewayAdminRequest`) is shared the same way.
 */
import { GatewayError } from "./errors.js";

/** Every role `tenant_member.role` may hold (#392). */
export const GATEWAY_TENANT_ROLES = ["owner", "member"] as const;
/**
 * Admin account roles (`admin_accounts.role`): admin accounts, never product
 * users (#394). `support_agent` (#356) triages abuse without any credential,
 * prompt or configuration access; it is not the team role #392 retired.
 */
export const GATEWAY_PLATFORM_ROLES = ["platform_admin", "support_agent"] as const;

export type GatewayTenantRole = (typeof GATEWAY_TENANT_ROLES)[number];
export type GatewayPlatformRole = (typeof GATEWAY_PLATFORM_ROLES)[number];

/** Actions on one tenant's resources. */
export const GATEWAY_TENANT_PERMISSIONS = [
  "usage.read_own",
  "budgets.read_own",
  "tenant.read",
  "usage.read",
  "budgets.read",
  "team.budgets.allocate",
  "keys.read",
  "limits.write",
  "team.members.read",
  "team.members.manage",
  "audit.read",
  "billing.read",
  "billing.purchase",
] as const;
export type GatewayTenantPermission = (typeof GATEWAY_TENANT_PERMISSIONS)[number];

/** Actions on platform resources or across tenants: admin accounts only. */
export const GATEWAY_PLATFORM_PERMISSIONS = [
  "tenants.list",
  "catalog.read",
  "catalog.write",
  "prices.read",
  "prices.write",
  "packages.read",
  "packages.write",
  "billing.rollover",
  "upstreams.read",
  "upstreams.write",
  "wallet.adjust",
  "subscription.limits.write",
  "admin_accounts.read",
  "admin_accounts.write",
  "usage.read_all",
  "audit.read_all",
  "abuse.read",
  // Suspending and lifting take a tenant or key id only: no key material (#356).
  "abuse.suspend",
  "abuse.thresholds.write",
  "prompts.view",
  "retention.purge",
  "reconciliation.read",
  "reconciliation.write",
  // The credential encryption key ring (#366): key ids and envelope counts, never key material.
  // Reported by Node hosts that hold a ring (#372); api-cf's /me never reports them.
  "encryption.read",
  "encryption.rotate",
] as const;
export type GatewayPlatformPermission = (typeof GATEWAY_PLATFORM_PERMISSIONS)[number];

/** Permissions over the encryption key ring: served only by a host that has one (api-node, #366). */
export const GATEWAY_KEY_RING_PERMISSIONS: readonly GatewayPlatformPermission[] = ["encryption.read", "encryption.rotate"];

export type GatewayPermission = GatewayTenantPermission | GatewayPlatformPermission;

/**
 * Tenant role -> tenant permissions. Owner: every tenant action (members and
 * roles, budget allocation, keys and limits, billing). Member: their own
 * usage and budget only.
 */
export const GATEWAY_TENANT_ROLE_PERMISSIONS: Readonly<Record<GatewayTenantRole, readonly GatewayTenantPermission[]>> = {
  owner: GATEWAY_TENANT_PERMISSIONS,
  member: ["usage.read_own", "budgets.read_own"],
};

/**
 * Admin account role -> permissions: platform_admin holds every permission,
 * on every tenant. support_agent (#356) reads tenants, members, budgets, usage,
 * audit and abuse signals and suspends or lifts by id; it holds nothing that
 * lists keys (`keys.read`), touches upstream credentials or retained prompts,
 * or changes thresholds, wallets, limits, catalog or admin accounts.
 */
export const GATEWAY_PLATFORM_ROLE_PERMISSIONS: Readonly<Record<GatewayPlatformRole, readonly GatewayPermission[]>> = {
  platform_admin: [...GATEWAY_PLATFORM_PERMISSIONS, ...GATEWAY_TENANT_PERMISSIONS],
  support_agent: [
    "tenants.list",
    "team.members.read",
    "budgets.read",
    "usage.read_all",
    "audit.read_all",
    "abuse.read",
    "abuse.suspend",
  ],
};

export function isGatewayTenantPermission(permission: string): permission is GatewayTenantPermission {
  return (GATEWAY_TENANT_PERMISSIONS as readonly string[]).includes(permission);
}

export function isGatewayTenantRole(role: string): role is GatewayTenantRole {
  return (GATEWAY_TENANT_ROLES as readonly string[]).includes(role);
}

export function isGatewayPlatformRole(role: string): role is GatewayPlatformRole {
  return (GATEWAY_PLATFORM_ROLES as readonly string[]).includes(role);
}

export function tenantRolePermissions(role: string): readonly GatewayTenantPermission[] {
  return isGatewayTenantRole(role) ? GATEWAY_TENANT_ROLE_PERMISSIONS[role] : [];
}

/** Every permission an admin account's role holds; none for an unknown role. */
export function adminRolePermissions(role: string): readonly GatewayPermission[] {
  return isGatewayPlatformRole(role) ? GATEWAY_PLATFORM_ROLE_PERMISSIONS[role] : [];
}

/**
 * The permissions `/me` reports to the console (#372): those the role holds
 * that this host serves. The console offers a page or action only for a
 * reported permission, so no host shows a page it cannot answer.
 */
export function adminConsolePermissions(role: string, served: (permission: GatewayPermission) => boolean): GatewayPermission[] {
  return adminRolePermissions(role).filter(served);
}

// ─── Admin identity gate (#394) ─────────────────────────────────────────────

/** The admin identity's own Better Auth base path, cookie prefix and API prefix, on every host. */
export const GATEWAY_ADMIN_AUTH_BASE_PATH = "/api/admin-auth";
export const GATEWAY_ADMIN_COOKIE_PREFIX = "clash-admin";
export const GATEWAY_ADMIN_API_PREFIX = "/api/v1/admin";
/** Better Auth's default prefix, which the product instances use. */
const PRODUCT_COOKIE_PREFIX = "better-auth";

/** A signed-in admin account (admin store, #394): never a product user. */
export interface GatewayAdminAccountIdentity {
  /** The admin account id (`adm_…`). */
  id: string;
  email: string;
  name: string;
  /** The account's role; its permissions are GATEWAY_PLATFORM_ROLE_PERMISSIONS. */
  role: string;
}

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

export const presentsGatewayAdminSession = (request: Request) => hasSessionCookie(request, GATEWAY_ADMIN_COOKIE_PREFIX);

/** A product credential the request presents, by kind; validity is not checked. */
export function presentedProductCredential(request: Request): "token" | "product_session" | null {
  if (request.headers.get("authorization")?.trim() || request.headers.get("x-api-key")?.trim()) return "token";
  return hasSessionCookie(request, PRODUCT_COOKIE_PREFIX) ? "product_session" : null;
}

/**
 * The /api/v1/admin/* gate, on every host. A token (any Authorization or
 * x-api-key header) is refused even next to a valid admin session: admin
 * routes never read one, so presenting one is the wrong identity kind. A
 * product session cookie next to a valid admin session is not: a browser
 * signed in to both the product and the console carries both cookies, and
 * the admin one decides. No credential is GATEWAY_AUTH_REQUIRED (401); the
 * wrong kind is GATEWAY_ADMIN_SESSION_REQUIRED (403).
 */
export async function resolveGatewayAdminRequest(
  request: Request,
  verifyAdminSession: (request: Request) => Promise<GatewayAdminAccountIdentity | null>,
): Promise<{ admin: GatewayAdminAccountIdentity } | { error: GatewayError }> {
  const presented = presentedProductCredential(request);
  const wrongKind = (kind: string) => new GatewayError("GATEWAY_ADMIN_SESSION_REQUIRED", { details: { presented: kind } });
  if (presented === "token") return { error: wrongKind("token") };
  const admin = presentsGatewayAdminSession(request) ? await verifyAdminSession(request) : null;
  if (admin) return { admin };
  if (presented === "product_session") return { error: wrongKind("product_session") };
  return { error: new GatewayError("GATEWAY_AUTH_REQUIRED") };
}
