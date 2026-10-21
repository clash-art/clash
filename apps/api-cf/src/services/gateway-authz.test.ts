/**
 * The gateway permission matrix (#353, #392): team roles are `owner` and
 * `member` only, the platform role is `platform_admin` only; owner holds
 * every tenant permission, member reads only their own usage and budget, a
 * tenant role never reaches another tenant or a platform resource, and
 * platform_admin holds everything. The route suite
 * (routes/v1/admin/gateway-console.test.ts) proves the server enforces this
 * module.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TENANT_MEMBER_ROLES } from "@clash/shared-cloud-schema/app";

import {
  GATEWAY_PLATFORM_PERMISSIONS,
  GATEWAY_PLATFORM_ROLES,
  GATEWAY_TENANT_PERMISSIONS,
  GATEWAY_TENANT_ROLES,
  authorizeGatewayAccess,
  tenantRolePermissions,
  type GatewayAccess,
} from "./gateway-authz";

const access = (role: string, tenantId = "team:a"): GatewayAccess => ({
  userId: "u",
  platformRoles: [],
  memberships: [{ tenantId, role }],
});

describe("gateway permission matrix", () => {
  it("has exactly two team roles and one platform role", () => {
    expect([...GATEWAY_TENANT_ROLES]).toEqual(["owner", "member"]);
    // The Drizzle mirror of the D1 column (0038) holds the same roles.
    expect([...TENANT_MEMBER_ROLES]).toEqual([...GATEWAY_TENANT_ROLES]);
    expect([...GATEWAY_PLATFORM_ROLES]).toEqual(["platform_admin"]);
  });

  it("gives the owner every tenant permission, including member management and budget allocation", () => {
    expect([...tenantRolePermissions("owner")].sort()).toEqual([...GATEWAY_TENANT_PERMISSIONS].sort());
    for (const permission of ["team.members.manage", "team.budgets.allocate"] as const)
      expect(authorizeGatewayAccess(access("owner"), permission, "team:a")).toEqual({ userId: "u", role: "owner" });
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

  it("gives platform_admin every permission on every tenant, under its own role", () => {
    const staff: GatewayAccess = { userId: "s", platformRoles: ["platform_admin"], memberships: [] };
    for (const permission of [...GATEWAY_PLATFORM_PERMISSIONS, ...GATEWAY_TENANT_PERMISSIONS])
      expect(authorizeGatewayAccess(staff, permission, "team:any")).toEqual({ userId: "s", role: "platform_admin" });
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
