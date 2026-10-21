/**
 * Authorization for the model gateway control plane (#353; guide:
 * apps/docs/guide/gateway-admin.md). Every /api/v1/admin/gateway route and
 * every tenant billing route authorizes through this module, so the server
 * refuses with a coded 403 whatever the UI shows.
 *
 * Identity is the user the `/api/*` middleware verified (Better Auth session
 * or `clsh_` token); no caller header is read as identity.
 *
 * Two separate kinds of grant, both stored in D1:
 *
 * - Tenant roles: `tenant_member.role` of one tenant. They act on that tenant
 *   only and never reach platform resources (catalog, price book, upstream
 *   accounts, packages) or another tenant.
 * - Platform roles: `gateway_platform_role` (0036). `platform_admin` holds
 *   every platform permission, and every tenant permission on every tenant.
 *   The first one is bootstrapped explicitly
 *   (apps/api-cf/scripts/gateway-platform-admin.ts); there is no
 *   environment-variable grant.
 *
 * Failures are coded: GATEWAY_AUTH_REQUIRED (401), GATEWAY_FORBIDDEN (403,
 * details.permission names the missing permission).
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { Context } from "hono";
import { GatewayError } from "@clash/gateway-core";
import { z } from "zod";

import type { Env } from "../config";
import { GATEWAY_MEMBER_ROLES, GATEWAY_PLATFORM_ROLES, GATEWAY_TENANT_ROLES } from "../domain/requests";
import type { GatewayAdminActor } from "../gateway/d1-admin-audit";
import { gatewayParam } from "./gateway-admin";
import { gatewayErrorResponse } from "./gateway-tokens";
import { getResolvedIdentity } from "./request-identity";

export { GATEWAY_MEMBER_ROLES, GATEWAY_PLATFORM_ROLES, GATEWAY_TENANT_ROLES };
export type GatewayTenantRole = (typeof GATEWAY_TENANT_ROLES)[number];
export type GatewayMemberRole = (typeof GATEWAY_MEMBER_ROLES)[number];
export type GatewayPlatformRole = (typeof GATEWAY_PLATFORM_ROLES)[number];

/** Actions on one tenant's resources. */
export const GATEWAY_TENANT_PERMISSIONS = [
  "tenant.read",
  "usage.read",
  "budgets.read",
  "budgets.write",
  "keys.read",
  "limits.write",
  "members.read",
  "roles.write",
  "audit.read",
  "billing.read",
  "billing.purchase",
] as const;
export type GatewayTenantPermission = (typeof GATEWAY_TENANT_PERMISSIONS)[number];

/** Actions on platform resources or across tenants: `platform_admin` only. */
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
  "platform_roles.read",
  "platform_roles.write",
  "usage.read_all",
  "audit.read_all",
  "abuse.read",
  "prompts.view",
  "retention.purge",
] as const;
export type GatewayPlatformPermission = (typeof GATEWAY_PLATFORM_PERMISSIONS)[number];

export type GatewayPermission = GatewayTenantPermission | GatewayPlatformPermission;

/**
 * The permission matrix: tenant role -> tenant actions. Owner: everything,
 * including roles. Admin: budgets, keys and limits, no roles or purchases.
 * Finance: budgets and purchases, no limits or roles. Support: read usage,
 * keys and audit. Viewer: read-only overview, usage, budgets and members.
 */
export const GATEWAY_TENANT_ROLE_PERMISSIONS: Readonly<Record<GatewayTenantRole, readonly GatewayTenantPermission[]>> = {
  owner: GATEWAY_TENANT_PERMISSIONS,
  admin: [
    "tenant.read",
    "usage.read",
    "budgets.read",
    "budgets.write",
    "keys.read",
    "limits.write",
    "members.read",
    "audit.read",
    "billing.read",
  ],
  finance: [
    "tenant.read",
    "usage.read",
    "budgets.read",
    "budgets.write",
    "keys.read",
    "members.read",
    "audit.read",
    "billing.read",
    "billing.purchase",
  ],
  support: ["tenant.read", "usage.read", "budgets.read", "keys.read", "members.read", "audit.read"],
  viewer: ["tenant.read", "usage.read", "budgets.read", "members.read"],
};

export const GATEWAY_PLATFORM_ROLE_PERMISSIONS: Readonly<Record<GatewayPlatformRole, readonly GatewayPermission[]>> = {
  platform_admin: [...GATEWAY_PLATFORM_PERMISSIONS, ...GATEWAY_TENANT_PERMISSIONS],
};

export function isGatewayTenantPermission(permission: string): permission is GatewayTenantPermission {
  return (GATEWAY_TENANT_PERMISSIONS as readonly string[]).includes(permission);
}

function isTenantRole(role: string): role is GatewayTenantRole {
  return (GATEWAY_TENANT_ROLES as readonly string[]).includes(role);
}

export function tenantRolePermissions(role: string): readonly GatewayTenantPermission[] {
  return isTenantRole(role) ? GATEWAY_TENANT_ROLE_PERMISSIONS[role] : [];
}

export interface GatewayMembership {
  tenantId: string;
  role: string;
}

/** What one user may do: their platform grants and tenant memberships. */
export interface GatewayAccess {
  userId: string;
  platformRoles: GatewayPlatformRole[];
  memberships: GatewayMembership[];
}

export const isPlatformAdmin = (access: GatewayAccess) => access.platformRoles.includes("platform_admin");

/** Read a user's grants in one round trip. */
export async function loadGatewayAccess(db: D1Database, userId: string): Promise<GatewayAccess> {
  const [platform, members] = await db.batch([
    db.prepare(`SELECT role FROM gateway_platform_role WHERE user_id = ? ORDER BY role`).bind(userId),
    db.prepare(`SELECT tenant_id, role FROM tenant_member WHERE user_id = ? ORDER BY tenant_id`).bind(userId),
  ]);
  return {
    userId,
    platformRoles: ((platform?.results ?? []) as Array<{ role: string }>)
      .map((row) => row.role)
      .filter((role): role is GatewayPlatformRole => (GATEWAY_PLATFORM_ROLES as readonly string[]).includes(role)),
    memberships: ((members?.results ?? []) as Array<{ tenant_id: string; role: string }>).map((row) => ({
      tenantId: row.tenant_id,
      role: row.role,
    })),
  };
}

/**
 * The actor allowed to perform `permission` (on `tenantId` for a tenant
 * permission), or null. A platform permission is never granted by a tenant
 * role; a tenant permission is granted by the caller's role in that tenant
 * only, or by platform_admin.
 */
export function authorizeGatewayAccess(
  access: GatewayAccess,
  permission: GatewayPermission,
  tenantId?: string,
): GatewayAdminActor | null {
  for (const role of access.platformRoles)
    if (GATEWAY_PLATFORM_ROLE_PERMISSIONS[role].includes(permission)) return { userId: access.userId, role };
  if (!isGatewayTenantPermission(permission) || tenantId === undefined) return null;
  const membership = access.memberships.find((entry) => entry.tenantId === tenantId);
  if (!membership || !tenantRolePermissions(membership.role).includes(permission)) return null;
  return { userId: access.userId, role: membership.role };
}

export function requireGatewayUserId(c: Context<{ Bindings: Env }>): string {
  const resolved = getResolvedIdentity(c);
  if (!resolved?.userId) throw new GatewayError("GATEWAY_AUTH_REQUIRED");
  return resolved.userId;
}

/** Throws GATEWAY_FORBIDDEN unless the signed-in caller may perform `permission`. */
export async function requireGatewayPermission(
  c: Context<{ Bindings: Env }>,
  permission: GatewayPermission,
  tenantId?: string,
): Promise<GatewayAdminActor> {
  const access = await loadGatewayAccess(c.env.DB, requireGatewayUserId(c));
  const actor = authorizeGatewayAccess(access, permission, tenantId);
  if (!actor)
    throw new GatewayError("GATEWAY_FORBIDDEN", {
      details: { permission, ...(tenantId !== undefined ? { tenantId } : {}) },
    });
  return actor;
}

type AdminContext = Context<{ Bindings: Env }>;
const TenantIdSchema = z.string().min(1).max(256);

const NO_STORE = { "cache-control": "no-store" };
export const adminJson = (c: AdminContext, body: unknown, status: 200 | 201 = 200) => c.json(body, status, NO_STORE);

/** A platform route: `permission` must be a platform grant. Any failure is its coded response. */
export const platformRoute =
  (
    permission: GatewayPlatformPermission,
    handler: (c: AdminContext, actor: GatewayAdminActor) => Promise<Response>,
  ) =>
  async (c: AdminContext) => {
    try {
      return await handler(c, await requireGatewayPermission(c, permission));
    } catch (error) {
      return gatewayErrorResponse(error);
    }
  };

/** A tenant route under `/tenants/:tenantId`: the caller's role there, or platform_admin. */
export const tenantRoute =
  (
    permission: GatewayTenantPermission,
    handler: (c: AdminContext, actor: GatewayAdminActor, tenantId: string) => Promise<Response>,
  ) =>
  async (c: AdminContext) => {
    try {
      const tenantId = gatewayParam(TenantIdSchema, c.req.param("tenantId"), "tenantId");
      return await handler(c, await requireGatewayPermission(c, permission, tenantId), tenantId);
    } catch (error) {
      return gatewayErrorResponse(error);
    }
  };

/**
 * A read that is tenant-scoped with `?tenantId=` (tenant permission) and
 * platform-wide without it (platform permission).
 */
export const scopedRoute =
  (
    permissions: { tenant: GatewayTenantPermission; platform: GatewayPlatformPermission },
    handler: (c: AdminContext, actor: GatewayAdminActor, tenantId: string | undefined) => Promise<Response>,
  ) =>
  async (c: AdminContext) => {
    try {
      const raw = c.req.query("tenantId");
      const tenantId = raw === undefined ? undefined : gatewayParam(TenantIdSchema, raw, "tenantId");
      const actor = await requireGatewayPermission(
        c,
        tenantId === undefined ? permissions.platform : permissions.tenant,
        tenantId,
      );
      return await handler(c, actor, tenantId);
    } catch (error) {
      return gatewayErrorResponse(error);
    }
  };
