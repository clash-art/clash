/**
 * Authorization of the Node gateway admin API (#371; guide:
 * apps/docs/guide/gateway-admin.md#node-admin-listener). Every admin route
 * checks one named permission through `authorizeGatewayAdmin`; which role
 * holds which permission is data, in GATEWAY_ADMIN_ROLE_PERMISSIONS below and
 * nowhere else.
 *
 * Permission names are the hosted console's (apps/api-cf/src/services/
 * gateway-authz.ts) wherever the action is the same; `keys.revoke` is the one
 * Node addition (the hosted console only views keys).
 *
 * #371: a single platform admin role/identity. No tenant_admin / viewer /
 * support matrix — team owner/member stay in the product, not this admin RBAC.
 * `platform_admin` holds every permission on every tenant.
 *
 * `prompts.view` is listed for parity with hosted and still refused on a
 * self-host node: Node retains no request or response body (decisions 8 and
 * 10), so the route answers GATEWAY_PROMPT_ACCESS_DISABLED.
 *
 * An admin is never a product user (#394): the identity is an admin token
 * (gateway-admin-tokens.ts). Failures are coded: GATEWAY_FORBIDDEN (403,
 * details.permission and tenantId).
 */
import { GatewayError } from "@clash/gateway-core";

export const GATEWAY_ADMIN_ROLES = ["platform_admin"] as const;
export type GatewayAdminRole = (typeof GATEWAY_ADMIN_ROLES)[number];

/** Reads on one tenant's resources. */
export const GATEWAY_ADMIN_TENANT_READS = [
  "tenant.read",
  "team.members.read",
  "budgets.read",
  "keys.read",
  "usage.read",
  "audit.read",
] as const;
/** Changes to one tenant's resources. */
export const GATEWAY_ADMIN_TENANT_WRITES = [
  "team.budgets.allocate",
  "keys.revoke",
] as const;
/** Reads of platform resources or across tenants. */
export const GATEWAY_ADMIN_PLATFORM_READS = [
  "tenants.list",
  "catalog.read",
  "prices.read",
  "packages.read",
  "upstreams.read",
  "usage.read_all",
  "audit.read_all",
  "abuse.read",
  "admin_accounts.read",
] as const;
/** Changes to platform resources. */
export const GATEWAY_ADMIN_PLATFORM_WRITES = [
  "catalog.write",
  "prices.write",
  "packages.write",
  "billing.rollover",
  "upstreams.write",
  "wallet.adjust",
  "admin_accounts.write",
  // Suspending and lifting take a tenant or key id only (as hosted, #356).
  "abuse.suspend",
  "prompts.view",
] as const;

export type GatewayAdminTenantPermission =
  | (typeof GATEWAY_ADMIN_TENANT_READS)[number]
  | (typeof GATEWAY_ADMIN_TENANT_WRITES)[number];
export type GatewayAdminPlatformPermission =
  | (typeof GATEWAY_ADMIN_PLATFORM_READS)[number]
  | (typeof GATEWAY_ADMIN_PLATFORM_WRITES)[number];
export type GatewayAdminPermission =
  | GatewayAdminTenantPermission
  | GatewayAdminPlatformPermission;

const TENANT_PERMISSIONS: readonly string[] = [
  ...GATEWAY_ADMIN_TENANT_READS,
  ...GATEWAY_ADMIN_TENANT_WRITES,
];

export const GATEWAY_ADMIN_ROLE_PERMISSIONS: Readonly<
  Record<GatewayAdminRole, readonly GatewayAdminPermission[]>
> = {
  platform_admin: [
    ...GATEWAY_ADMIN_PLATFORM_READS,
    ...GATEWAY_ADMIN_PLATFORM_WRITES,
    ...GATEWAY_ADMIN_TENANT_READS,
    ...GATEWAY_ADMIN_TENANT_WRITES,
  ],
};

export function isGatewayAdminRole(role: string): role is GatewayAdminRole {
  return (GATEWAY_ADMIN_ROLES as readonly string[]).includes(role);
}

export const isTenantPermission = (
  permission: GatewayAdminPermission,
): permission is GatewayAdminTenantPermission =>
  TENANT_PERMISSIONS.includes(permission);

export interface GatewayAdminPrincipal {
  /** gateway_admin_token.id (`gat_…`). */
  id: string;
  role: string;
}

/** The audit actor of an authorized admin (gateway_admin_audit actor_*). */
export interface GatewayAdminActor {
  kind: "admin";
  id: string;
  role: string;
}

/** Every permission the principal's role holds. */
export function gatewayAdminPermissions(
  principal: GatewayAdminPrincipal,
): readonly GatewayAdminPermission[] {
  return isGatewayAdminRole(principal.role)
    ? GATEWAY_ADMIN_ROLE_PERMISSIONS[principal.role]
    : [];
}

/**
 * The actor allowed to perform `permission` (on `tenantId` for a tenant
 * permission), or null. A tenant permission always names its tenant.
 */
export function authorizeGatewayAdmin(
  principal: GatewayAdminPrincipal,
  permission: GatewayAdminPermission,
  tenantId?: string,
): GatewayAdminActor | null {
  if (!gatewayAdminPermissions(principal).includes(permission)) return null;
  if (isTenantPermission(permission) && !tenantId) return null;
  return { kind: "admin", id: principal.id, role: principal.role };
}

/** authorizeGatewayAdmin, or a coded GATEWAY_FORBIDDEN naming the permission. */
export function requireGatewayAdmin(
  principal: GatewayAdminPrincipal,
  permission: GatewayAdminPermission,
  tenantId?: string,
): GatewayAdminActor {
  const actor = authorizeGatewayAdmin(principal, permission, tenantId);
  if (!actor)
    throw new GatewayError("GATEWAY_FORBIDDEN", {
      details: { permission, ...(tenantId ? { tenantId } : {}) },
    });
  return actor;
}
