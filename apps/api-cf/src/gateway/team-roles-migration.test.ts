/**
 * Migration 0038 (#392): team roles become owner and member only. Rows that
 * hold a role from earlier releases (the #353 console roles) become `member`,
 * re-running the file changes nothing, and D1 refuses any other role from
 * then on. This file names the removed roles on purpose; the source scan in
 * services/gateway-authz.test.ts allows it.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WEB_DRIZZLE_MIGRATIONS } from "../../../web/app/test-support/sqlite-d1";

const MIGRATION = "0038_gateway_team_roles.sql";
const LEGACY_ROLES = ["admin", "finance", "support", "viewer"];

function apply(db: DatabaseSync, file: string) {
  for (const part of readFileSync(join(WEB_DRIZZLE_MIGRATIONS, file), "utf8").split("--> statement-breakpoint"))
    if (part.trim()) db.exec(part);
}

/** A database migrated up to (not including) 0038, holding every legacy role. */
function beforeMigration() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(WEB_DRIZZLE_MIGRATIONS).filter((f) => f.endsWith(".sql")).sort())
    if (file < MIGRATION) apply(db, file);
  db.prepare(`INSERT INTO tenant (id, owner_user_id, name, kind) VALUES ('team:t', 'u-owner', 'T', 'team')`).run();
  for (const role of ["owner", "member", ...LEGACY_ROLES])
    db.prepare(`INSERT INTO tenant_member (tenant_id, user_id, role, updated_at) VALUES ('team:t', ?, ?, 1)`).run(`u-${role}`, role);
  for (const role of ["member", ...LEGACY_ROLES])
    db.prepare(
      `INSERT INTO tenant_invite (id, tenant_id, email, role, token_hash, invited_by_user_id, expires_at, updated_at)
       VALUES (?, 'team:t', ?, ?, ?, 'u-owner', 9999999999, 1)`,
    ).run(`inv-${role}`, `${role}@example.test`, role, `hash-${role}`);
  return db;
}

const rows = (db: DatabaseSync, table: "tenant_member" | "tenant_invite") =>
  db.prepare(`SELECT ${table === "tenant_member" ? "user_id" : "id"} AS id, role, updated_at FROM ${table} ORDER BY id`).all() as Array<{
    id: string;
    role: string;
    updated_at: number;
  }>;

describe("0038 team roles migration", () => {
  it("maps every legacy team role to member and leaves owner and member rows untouched", () => {
    const db = beforeMigration();
    apply(db, MIGRATION);
    const members = Object.fromEntries(rows(db, "tenant_member").map((row) => [row.id, row]));
    expect(members["u-owner"]).toMatchObject({ role: "owner", updated_at: 1 });
    expect(members["u-member"]).toMatchObject({ role: "member", updated_at: 1 });
    for (const role of LEGACY_ROLES) {
      expect(members[`u-${role}`]?.role, role).toBe("member");
      expect(members[`u-${role}`]?.updated_at, role).toBeGreaterThan(1);
    }
    const invites = Object.fromEntries(rows(db, "tenant_invite").map((row) => [row.id, row]));
    expect(invites["inv-member"]).toMatchObject({ role: "member", updated_at: 1 });
    for (const role of LEGACY_ROLES) expect(invites[`inv-${role}`]?.role, role).toBe("member");
  });

  it("is idempotent: a second run changes nothing", () => {
    const db = beforeMigration();
    apply(db, MIGRATION);
    const once = { members: rows(db, "tenant_member"), invites: rows(db, "tenant_invite") };
    apply(db, MIGRATION);
    expect({ members: rows(db, "tenant_member"), invites: rows(db, "tenant_invite") }).toEqual(once);
  });

  it("refuses any other role afterwards, on insert and update of both tables", () => {
    const db = beforeMigration();
    apply(db, MIGRATION);
    for (const role of [...LEGACY_ROLES, "platform_admin"]) {
      expect(() => db.prepare(`INSERT INTO tenant_member (tenant_id, user_id, role) VALUES ('team:t', 'u-new', ?)`).run(role)).toThrow(
        /owner or member/,
      );
      expect(() => db.prepare(`UPDATE tenant_member SET role = ? WHERE user_id = 'u-member'`).run(role)).toThrow(/owner or member/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO tenant_invite (id, tenant_id, email, role, token_hash, invited_by_user_id, expires_at)
             VALUES ('inv-new', 'team:t', 'n@example.test', ?, 'hash-new', 'u-owner', 9999999999)`,
          )
          .run(role),
      ).toThrow(/owner or member/);
      expect(() => db.prepare(`UPDATE tenant_invite SET role = ? WHERE id = 'inv-member'`).run(role)).toThrow(/owner or member/);
    }
    db.prepare(`UPDATE tenant_member SET role = 'owner' WHERE user_id = 'u-member'`).run();
    db.prepare(`INSERT INTO tenant_member (tenant_id, user_id, role) VALUES ('team:t', 'u-new', 'member')`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tenant_member WHERE role NOT IN ('owner', 'member')`).get()).toEqual({ n: 0 });
  });
});
