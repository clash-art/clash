/** Bootstrap of the first platform admin against a fully migrated node:sqlite D1 schema. */
import { describe, expect, it } from "vitest";

import { createSqliteD1 } from "../../../web/app/test-support/sqlite-d1";
import {
  bootstrapWranglerArgs,
  parseBootstrapArgs,
  platformAdminBootstrapSql,
} from "./platform-admin-bootstrap";

describe("platform admin bootstrap", () => {
  it("grants once and audits once, however often it runs", () => {
    const { sqlite } = createSqliteD1();
    const sql = platformAdminBootstrapSql("user-first-admin");
    for (let run = 0; run < 3; run += 1) sqlite.exec(sql);
    expect(sqlite.prepare(`SELECT user_id, role, granted_by_user_id FROM gateway_platform_role`).all()).toEqual([
      { user_id: "user-first-admin", role: "platform_admin", granted_by_user_id: null },
    ]);
    expect(
      sqlite.prepare(`SELECT actor_user_id, action, target_id FROM gateway_admin_audit`).all(),
    ).toEqual([{ actor_user_id: "bootstrap", action: "platform_role.grant", target_id: "user-first-admin" }]);
  });

  it("refuses ids it cannot embed safely", () => {
    for (const id of ["", "x'; DROP TABLE users; --", "a b", "x".repeat(129)])
      expect(() => platformAdminBootstrapSql(id)).toThrow(/Refusing user id/);
  });

  it("targets a local or the staging D1 only", () => {
    expect(parseBootstrapArgs(["--user", "u1", "--local"])).toEqual({ userId: "u1", target: { kind: "local" }, dryRun: false });
    expect(parseBootstrapArgs(["--user", "u1", "--env", "staging", "--dry-run"])).toEqual({
      userId: "u1",
      target: { kind: "staging" },
      dryRun: true,
    });
    for (const argv of [
      ["--user", "u1", "--env", "production"],
      ["--user", "u1", "--remote"],
      ["--user", "u1", "--env=production"],
      ["--user", "u1"],
      ["--local"],
    ])
      expect(() => parseBootstrapArgs(argv), argv.join(" ")).toThrow();
    expect(bootstrapWranglerArgs({ kind: "local" }, "SELECT 1")).toContain("--local");
    const staging = bootstrapWranglerArgs({ kind: "staging" }, "SELECT 1");
    expect(staging).toEqual(expect.arrayContaining(["clash-staging", "--env", "staging"]));
    expect(staging).not.toContain("clash-d1");
  });
});
