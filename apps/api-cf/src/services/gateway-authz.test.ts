/**
 * The admin permission matrix (#353) as properties from the design (REPORT
 * §9): platform grants are separate from tenant roles, owner holds every
 * tenant permission, only owner changes roles, read-only roles never write,
 * and a tenant role never reaches another tenant or a platform resource. The
 * route suite (routes/v1/admin/gateway-console.test.ts) proves the server
 * enforces this module for every role and action.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  GATEWAY_PLATFORM_PERMISSIONS,
  GATEWAY_TENANT_PERMISSIONS,
  GATEWAY_TENANT_ROLES,
  authorizeGatewayAccess,
  tenantRolePermissions,
  type GatewayAccess,
} from "./gateway-authz";

const WRITES = GATEWAY_TENANT_PERMISSIONS.filter((permission) => !permission.endsWith(".read"));

const access = (role: string, tenantId = "team:a"): GatewayAccess => ({
  userId: "u",
  platformRoles: [],
  memberships: [{ tenantId, role }],
});

describe("gateway permission matrix", () => {
  it("gives the owner every tenant permission and only the owner roles.write", () => {
    expect([...tenantRolePermissions("owner")].sort()).toEqual([...GATEWAY_TENANT_PERMISSIONS].sort());
    for (const role of GATEWAY_TENANT_ROLES)
      expect(tenantRolePermissions(role).includes("roles.write"), role).toBe(role === "owner");
  });

  it("orders the roles: every role reads its tenant, viewer and support never write", () => {
    for (const role of GATEWAY_TENANT_ROLES) expect(tenantRolePermissions(role), role).toContain("tenant.read");
    for (const role of ["viewer", "support"])
      expect(tenantRolePermissions(role).filter((permission) => WRITES.includes(permission)), role).toEqual([]);
    // Finance handles money, not limits; admin handles limits, not purchases.
    expect(tenantRolePermissions("finance")).toEqual(expect.arrayContaining(["budgets.write", "billing.purchase"]));
    expect(tenantRolePermissions("finance")).not.toContain("limits.write");
    expect(tenantRolePermissions("admin")).toEqual(expect.arrayContaining(["budgets.write", "limits.write"]));
    expect(tenantRolePermissions("admin")).not.toContain("billing.purchase");
  });

  it("grants nothing to `member`, unknown roles, or a role in another tenant", () => {
    for (const role of ["member", "platform_admin", "root", ""]) expect(tenantRolePermissions(role), role).toEqual([]);
    for (const permission of GATEWAY_TENANT_PERMISSIONS) {
      expect(authorizeGatewayAccess(access("owner"), permission, "team:b")).toBeNull();
      expect(authorizeGatewayAccess(access("owner"), permission)).toBeNull();
    }
  });

  it("never lets a tenant role hold a platform permission", () => {
    for (const role of GATEWAY_TENANT_ROLES)
      for (const permission of GATEWAY_PLATFORM_PERMISSIONS)
        expect(authorizeGatewayAccess(access(role), permission, "team:a"), `${role} ${permission}`).toBeNull();
  });

  it("gives platform_admin every permission on every tenant, under its own role", () => {
    const staff: GatewayAccess = { userId: "s", platformRoles: ["platform_admin"], memberships: [] };
    for (const permission of [...GATEWAY_PLATFORM_PERMISSIONS, ...GATEWAY_TENANT_PERMISSIONS])
      expect(authorizeGatewayAccess(staff, permission, "team:any")).toEqual({ userId: "s", role: "platform_admin" });
  });

  it("records the caller's tenant role as the actor role", () => {
    expect(authorizeGatewayAccess(access("finance"), "budgets.write", "team:a")).toEqual({ userId: "u", role: "finance" });
  });
});

describe("the retired environment-variable admin grant (#352 stopgap) is gone", () => {
  // Built from parts so this file does not match itself.
  const retired = ["GATEWAY", "ADMIN", "USER", "IDS"].join("_");
  const repo = resolve(__dirname, "../../../..");
  const roots = ["apps/api-cf/src", "apps/api-cf/scripts", "apps/api-cf/wrangler.toml", "apps/web/app", "apps/web/wrangler.toml", "apps/docs/guide", "packages/gateway-core/src", "packages/web-ui/src"];

  function files(path: string): string[] {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return [];
    if (stat.isFile()) return [path];
    return readdirSync(path).flatMap((entry) => (entry === "node_modules" ? [] : files(join(path, entry))));
  }

  it("is not read, configured or documented anywhere", () => {
    const hits = roots
      .flatMap((root) => files(resolve(repo, root)))
      .filter((path) => /\.(ts|tsx|md|toml|json)$/.test(path))
      .filter((path) => readFileSync(path, "utf8").includes(retired))
      .map((path) => relative(repo, path));
    expect(hits).toEqual([]);
  });
});
