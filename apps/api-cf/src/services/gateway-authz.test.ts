/**
 * The gateway permission matrix (#353, #392, #394): team roles are `owner`
 * and `member` only, held by product users; the platform role is
 * `platform_admin` only, held by admin accounts. Owner holds every tenant
 * permission, member reads only their own usage and budget, a tenant role
 * never reaches another tenant or a platform resource, and an admin account
 * holds everything. The route suites (routes/v1/admin/gateway-console.test.ts,
 * routes/v1/admin/admin-identity.test.ts) prove the server enforces this
 * module.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_ACCOUNT_ROLES } from "@clash/shared-cloud-schema/admin-auth";
import { TENANT_MEMBER_ROLES } from "@clash/shared-cloud-schema/app";

import {
  GATEWAY_PLATFORM_PERMISSIONS,
  GATEWAY_PLATFORM_ROLES,
  GATEWAY_TENANT_PERMISSIONS,
  GATEWAY_TENANT_ROLES,
  adminRolePermissions,
  authorizeAdminAccess,
  authorizeGatewayAccess,
  tenantRolePermissions,
  type GatewayAccess,
} from "./gateway-authz";

const access = (role: string, tenantId = "team:a"): GatewayAccess => ({
  userId: "u",
  memberships: [{ tenantId, role }],
});

describe("gateway permission matrix", () => {
  it("has exactly two team roles and one admin account role", () => {
    expect([...GATEWAY_TENANT_ROLES]).toEqual(["owner", "member"]);
    // The Drizzle mirrors of the D1 columns (0038, 0040) hold the same roles.
    expect([...TENANT_MEMBER_ROLES]).toEqual([...GATEWAY_TENANT_ROLES]);
    expect([...GATEWAY_PLATFORM_ROLES]).toEqual(["platform_admin"]);
    expect([...ADMIN_ACCOUNT_ROLES]).toEqual([...GATEWAY_PLATFORM_ROLES]);
  });

  it("gives the owner every tenant permission, including member management and budget allocation", () => {
    expect([...tenantRolePermissions("owner")].sort()).toEqual([...GATEWAY_TENANT_PERMISSIONS].sort());
    for (const permission of ["team.members.manage", "team.budgets.allocate"] as const)
      expect(authorizeGatewayAccess(access("owner"), permission, "team:a")).toEqual({ kind: "user", id: "u", role: "owner" });
  });

  it("lets a member read only their own usage and budget", () => {
    const own = ["usage.read_own", "budgets.read_own"];
    expect([...tenantRolePermissions("member")].sort()).toEqual(own.sort());
    for (const permission of GATEWAY_TENANT_PERMISSIONS)
      expect(authorizeGatewayAccess(access("member"), permission, "team:a") !== null, permission).toBe(own.includes(permission));
  });

  it("grants nothing to unknown roles, or to a role in another tenant", () => {
    for (const role of ["platform_admin", "root", ""]) expect(tenantRolePermissions(role), role).toEqual([]);
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

  it("gives an admin account every permission, as an admin actor under its account role", () => {
    for (const permission of [...GATEWAY_PLATFORM_PERMISSIONS, ...GATEWAY_TENANT_PERMISSIONS])
      expect(authorizeAdminAccess({ id: "adm_s", role: "platform_admin" }, permission)).toEqual({
        kind: "admin",
        id: "adm_s",
        role: "platform_admin",
      });
    expect([...adminRolePermissions("platform_admin")].sort()).toEqual(
      [...GATEWAY_PLATFORM_PERMISSIONS, ...GATEWAY_TENANT_PERMISSIONS].sort(),
    );
  });

  it("grants nothing to an admin account with an unknown role, and no platform role to a product user", () => {
    for (const role of ["owner", "member", "root", ""]) {
      expect(adminRolePermissions(role), role).toEqual([]);
      expect(authorizeAdminAccess({ id: "adm_x", role }, "catalog.read"), role).toBeNull();
    }
    // A product user's grants are team memberships only: no shape carries a platform role.
    expect(Object.keys(access("owner")).sort()).toEqual(["memberships", "userId"]);
  });
});

describe("platform_admin is no longer a grant on product users (#394)", () => {
  // Built from parts so this file does not match itself.
  const retiredTable = ["gateway", "platform", "role"].join("_");
  const roots = ["apps/api-cf/src", "apps/api-cf/scripts", "apps/web/app", "apps/web/workers", "packages/gateway-core/src", "packages/shared-cloud-schema/src", "packages/web-ui/src"];
  // The migration test seeds the dropped table on purpose.
  const allowed = new Set(["apps/api-cf/src/gateway/admin-accounts-migration.test.ts"]);

  it("is not read or written anywhere outside the migration that drops it", () => {
    const hits = roots
      .flatMap((root) => files(resolve(repo, root)))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .filter((path) => !allowed.has(relative(repo, path)))
      .filter((path) => readFileSync(path, "utf8").includes(retiredTable))
      .map((path) => relative(repo, path));
    expect(hits).toEqual([]);
  });
});

const repo = resolve(__dirname, "../../../..");

function files(path: string): string[] {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return [path];
  return readdirSync(path).flatMap((entry) => (entry === "node_modules" ? [] : files(join(path, entry))));
}

describe("the retired environment-variable admin grant (#352 stopgap) is gone", () => {
  // Built from parts so this file does not match itself.
  const retired = ["GATEWAY", "ADMIN", "USER", "IDS"].join("_");
  const roots = ["apps/api-cf/src", "apps/api-cf/scripts", "apps/api-cf/wrangler.toml", "apps/web/app", "apps/web/wrangler.toml", "apps/docs/guide", "packages/gateway-core/src", "packages/web-ui/src"];

  it("is not read, configured or documented anywhere", () => {
    const hits = roots
      .flatMap((root) => files(resolve(repo, root)))
      .filter((path) => /\.(ts|tsx|md|toml|json)$/.test(path))
      .filter((path) => readFileSync(path, "utf8").includes(retired))
      .map((path) => relative(repo, path));
    expect(hits).toEqual([]);
  });
});

describe("the removed team roles (#392) are gone", () => {
  // Built from parts so this file does not match itself. `admin` alone is an
  // ordinary word (the /admin console), so the patterns look for role usage.
  const removed = ["ad" + "min", "fin" + "ance", "sup" + "port", "vie" + "wer"].join("|");
  const patterns = [
    // role: "x", role = 'x', actorRole === "x", role IN ('x' ...
    new RegExp(`role\\w*["'\`]?\\s*(?:[:=,(]|===|IN)+\\s*\\(?\\s*["'\`](?:${removed})["'\`]`, "i"),
    // A role list or matrix next to owner: "owner", "x" / `owner`, `x` / owner · x / | owner | x |
    new RegExp(`\\bowner\\b["'\`]?\\s*[,·|/]\\s*["'\`]?(?:${removed})\\b`, "i"),
    // A team row written with the role: INSERT INTO tenant_member (...) VALUES (?, ?, 'x')
    new RegExp(`tenant_(?:member|invite)\\b[^;]{0,160}'(?:${removed})'`, "i"),
    // The removed permissions and role constants.
    /\broles\.write\b|(?<!team\.)\bmembers\.read\b|\bbudgets\.write\b|\bGATEWAY_MEMBER_ROLES\b|\bADMIN_MEMBER_ROLES\b/,
  ];
  const quoted = new RegExp(`["'\`](?:${["fin" + "ance", "sup" + "port", "vie" + "wer"].join("|")})["'\`]`);
  const roots = [
    "apps/api-cf/src",
    "apps/api-cf/scripts",
    "apps/web/app",
    "apps/web/workers",
    "apps/docs/guide",
    "packages/gateway-core/src",
    "packages/shared-cloud-schema/src",
    "packages/web-ui/src",
  ];
  // The migration that maps legacy rows to `member` and its test name them on
  // purpose; earlier migrations under apps/web/drizzle are historical SQL and
  // stay unchanged (AGENTS.md), so they are not scanned.
  const allowed = new Set(["apps/api-cf/src/gateway/team-roles-migration.test.ts", "apps/api-cf/src/services/gateway-authz.test.ts"]);

  it("catches each usage form it is meant to", () => {
    const role = "fin" + "ance";
    for (const sample of [
      `{ role: "${role}" }`,
      `VALUES (?, ?, '${role}')`,
      `WHEN m.role IN ('${role}')`,
      `["owner", "${role}"]`,
      `| owner | ${role} |`,
      `\`owner\`, \`${role}\``,
      `"budgets.write"`,
      `INSERT INTO tenant_member (tenant_id, user_id, role) VALUES (?, ?, '${"ad" + "min"}')`,
    ])
      expect(patterns.some((pattern) => pattern.test(sample)) || quoted.test(sample), sample).toBe(true);
    expect(patterns.some((pattern) => pattern.test(`path: "admin"`))).toBe(false);
    expect(patterns.some((pattern) => pattern.test(`"team.members.read"`))).toBe(false);
  });

  it("is not referenced in source, tests or docs", () => {
    const hits = roots
      .flatMap((root) => files(resolve(repo, root)))
      .filter((path) => /\.(ts|tsx|md|json|sql)$/.test(path))
      .filter((path) => !allowed.has(relative(repo, path)))
      .flatMap((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .map((line, index) => ({ line, at: `${relative(repo, path)}:${index + 1}` }))
          .filter(({ line }) => patterns.some((pattern) => pattern.test(line)) || quoted.test(line))
          .map(({ at, line }) => `${at} ${line.trim()}`),
      );
    expect(hits).toEqual([]);
  });
});
