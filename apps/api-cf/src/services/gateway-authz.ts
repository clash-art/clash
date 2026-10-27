/**
 * Authorization for the model gateway control plane (#353, #392, #394; guide:
 * apps/docs/guide/gateway-admin.md). Every /api/v1/admin/gateway route and
 * every tenant billing route authorizes through this module, so the server
 * refuses with a coded 403 whatever the UI shows.
 *
 * Two identities, never mixed (services/admin-identity.ts enforces it before
 * any route runs):
 *
 * - Product users, verified by the `/api/*` middleware (Better Auth session or
 *   `clsh_` token), act through team roles: `tenant_member.role`, only
 *   `owner` or `member` (0038), on that tenant only. They never reach a
 *   platform resource or another tenant, and never the admin console.
 * - Admin accounts (`admin_accounts`, 0040), signed in through the admin
 *   Better Auth instance, act through their account role: `platform_admin`,
 *   which holds every permission on every tenant, or `support_agent` (#356), which
 *   triages abuse and suspends by id without credential access. They never reach a product
 *   route. The first one is bootstrapped explicitly
 *   (apps/api-cf/scripts/gateway-admin-account.ts); there is no
 *   environment-variable grant and no grant on a product user.
 *
 * Checks name a permission (`budgets.read`, `team.members.manage`, ...);
 * which role holds which permission is data, in the two role tables below
 * and nowhere else.
 *
 * Failures are coded: GATEWAY_AUTH_REQUIRED (401), GATEWAY_FORBIDDEN (403,
 * details.permission names the missing permission).
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { Context } from "hono";
import { GatewayError } from "@clash/gateway-core";
import { z } from "zod";

import type { Env } from "../config";
import { GATEWAY_PLATFORM_ROLES, GATEWAY_TENANT_ROLES } from "../domain/requests";
import type { GatewayAdminActor } from "../gateway/d1-admin-audit";
import { requireAdminIdentity, type AdminIdentity } from "./admin-identity";
import { gatewayParam } from "./gateway-admin";
import { gatewayErrorResponse } from "./gateway-tokens";
import { getResolvedIdentity } from "./request-identity";

export { GATEWAY_PLATFORM_ROLES, GATEWAY_TENANT_ROLES };
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
  "holds.sweep",
  "reconciliation.read",
  "reconciliation.write",
] as const;
export type GatewayPlatformPermission = (typeof GATEWAY_PLATFORM_PERMISSIONS)[number];

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

function isTenantRole(role: string): role is GatewayTenantRole {
  return (GATEWAY_TENANT_ROLES as readonly string[]).includes(role);
}

function isPlatformRole(role: string): role is GatewayPlatformRole {
  return (GATEWAY_PLATFORM_ROLES as readonly string[]).includes(role);
}

export function tenantRolePermissions(role: string): readonly GatewayTenantPermission[] {
  return isTenantRole(role) ? GATEWAY_TENANT_ROLE_PERMISSIONS[role] : [];
}

/** Every permission an admin account's role holds; none for an unknown role. */
export function adminRolePermissions(role: string): readonly GatewayPermission[] {
  return isPlatformRole(role) ? GATEWAY_PLATFORM_ROLE_PERMISSIONS[role] : [];
}

export interface GatewayMembership {
  tenantId: string;
  role: string;
}

/** What one product user may do: their team memberships. */
export interface GatewayAccess {
  userId: string;
  memberships: GatewayMembership[];
}

/** Read a product user's team memberships. */
export async function loadGatewayAccess(db: D1Database, userId: string): Promise<GatewayAccess> {
  const { results } = await db
    .prepare(`SELECT tenant_id, role FROM tenant_member WHERE user_id = ? ORDER BY tenant_id`)
    .bind(userId)
    .all<{ tenant_id: string; role: string }>();
  return { userId, memberships: results.map((row) => ({ tenantId: row.tenant_id, role: row.role })) };
}

/**
 * The product-user actor allowed to perform a tenant `permission` on
 * `tenantId`, or null: the caller's role in that tenant only.
 */
export function authorizeGatewayAccess(
  access: GatewayAccess,
  permission: GatewayPermission,
  tenantId?: string,
): GatewayAdminActor | null {
  if (!isGatewayTenantPermission(permission) || tenantId === undefined) return null;
  const membership = access.memberships.find((entry) => entry.tenantId === tenantId);
  if (!membership || !tenantRolePermissions(membership.role).includes(permission)) return null;
  return { kind: "user", id: access.userId, role: membership.role };
}

/** The admin-account actor allowed to perform `permission`, or null. */
export function authorizeAdminAccess(
  admin: Pick<AdminIdentity, "id" | "role">,
  permission: GatewayPermission,
): GatewayAdminActor | null {
  return adminRolePermissions(admin.role).includes(permission) ? { kind: "admin", id: admin.id, role: admin.role } : null;
}

export function requireGatewayUserId(c: Context<{ Bindings: Env }>): string {
  const resolved = getResolvedIdentity(c);
  if (!resolved?.userId) throw new GatewayError("GATEWAY_AUTH_REQUIRED");
  return resolved.userId;
}

const forbidden = (permission: GatewayPermission, tenantId?: string) =>
  new GatewayError("GATEWAY_FORBIDDEN", { details: { permission, ...(tenantId !== undefined ? { tenantId } : {}) } });

/** Throws GATEWAY_FORBIDDEN unless the signed-in product user's team role allows `permission` on `tenantId`. */
export async function requireTenantPermission(
  c: Context<{ Bindings: Env }>,
  permission: GatewayTenantPermission,
  tenantId: string,
): Promise<GatewayAdminActor> {
  const actor = authorizeGatewayAccess(await loadGatewayAccess(c.env.DB, requireGatewayUserId(c)), permission, tenantId);
  if (!actor) throw forbidden(permission, tenantId);
  return actor;
}

/** Throws GATEWAY_FORBIDDEN unless the signed-in admin account's role allows `permission`. */
export function requireAdminPermission(c: Context<{ Bindings: Env }>, permission: GatewayPermission): GatewayAdminActor {
  const actor = authorizeAdminAccess(requireAdminIdentity(c), permission);
  if (!actor) throw forbidden(permission);
  return actor;
}

type AdminContext = Context<{ Bindings: Env }>;
const TenantIdSchema = z.string().min(1).max(256);

const NO_STORE = { "cache-control": "no-store" };
export const adminJson = (c: AdminContext, body: unknown, status: 200 | 201 = 200) => c.json(body, status, NO_STORE);

/**
 * An admin console route (/api/v1/admin/*): the caller is the admin account
 * the middleware verified, and `permission` must come from its role. Any
 * failure is its coded response.
 */
export const platformRoute =
  (
    permission: GatewayPermission,
    handler: (c: AdminContext, actor: GatewayAdminActor) => Promise<Response>,
  ) =>
  async (c: AdminContext) => {
    try {
      return await handler(c, requireAdminPermission(c, permission));
    } catch (error) {
      return gatewayErrorResponse(error);
    }
  };

/** A product tenant route under `/tenants/:tenantId`: the caller's team role there. */
export const tenantRoute =
  (
    permission: GatewayTenantPermission,
    handler: (c: AdminContext, actor: GatewayAdminActor, tenantId: string) => Promise<Response>,
  ) =>
  async (c: AdminContext) => {
    try {
      const tenantId = gatewayParam(TenantIdSchema, c.req.param("tenantId"), "tenantId");
      return await handler(c, await requireTenantPermission(c, permission, tenantId), tenantId);
    } catch (error) {
      return gatewayErrorResponse(error);
    }
  };
