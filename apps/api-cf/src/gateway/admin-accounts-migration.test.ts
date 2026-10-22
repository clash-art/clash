/**
 * Migration 0040 (#394): platform_admin stops being a grant on product users.
 * Every existing grant is dropped with one audit row each (actor kind
 * `migration`), the grant table is gone, historical audit rows keep their
 * actor id and gain the right actor kind, the audit log stays append-only,
 * and the admin store starts empty (admin accounts are re-created with the
 * bootstrap script, never derived from product users).
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WEB_DRIZZLE_MIGRATIONS } from "../../../web/app/test-support/sqlite-d1";

const MIGRATION = "0040_gateway_admin_accounts.sql";

function apply(db: DatabaseSync, file: string) {
  for (const part of readFileSync(join(WEB_DRIZZLE_MIGRATIONS, file), "utf8").split("--> statement-breakpoint"))
    if (part.trim()) db.exec(part);
}

/** A database migrated up to (not including) 0040, with two product-user grants and earlier audit rows. */
function beforeMigration() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(WEB_DRIZZLE_MIGRATIONS).filter((f) => f.endsWith(".sql")).sort())
    if (file < MIGRATION) apply(db, file);
  db.prepare(`INSERT INTO users (id, name, email) VALUES ('u-staff', 'Staff', 'staff@example.test')`).run();
  db.prepare(`INSERT INTO gateway_platform_role (user_id, role, granted_by_user_id) VALUES ('u-staff', 'platform_admin', NULL)`).run();
  db.prepare(`INSERT INTO gateway_platform_role (user_id, role, granted_by_user_id) VALUES ('u-other', 'platform_admin', 'u-staff')`).run();
  const audit = db.prepare(
    `INSERT INTO gateway_admin_audit (id, tenant_id, actor_user_id, actor_role, action, target_type, target_id, occurred_at)
     VALUES (?, '', ?, ?, ?, 'platform_role', ?, 1)`,
  );
  audit.run("gwa-boot", "bootstrap", "bootstrap", "platform_role.grant", "u-staff");
  audit.run("gwa-user", "u-staff", "platform_admin", "platform_role.grant", "u-other");
  return db;
}

const tables = (db: DatabaseSync) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((row) => row.name);

describe("0040 admin accounts migration", () => {
  it("drops every product-user platform_admin grant, auditing each, and creates the separate admin store empty", () => {
    const db = beforeMigration();
    apply(db, MIGRATION);
    expect(tables(db)).not.toContain("gateway_platform_role");
    expect(tables(db)).toEqual(expect.arrayContaining(["admin_accounts", "admin_sessions", "admin_credentials", "admin_verifications"]));
    expect(db.prepare(`SELECT COUNT(*) AS n FROM admin_accounts`).get()).toEqual({ n: 0 });
    const dropped = db
      .prepare(`SELECT actor_kind, actor_id, action, target_id, before_json FROM gateway_admin_audit WHERE action = 'platform_role.drop' ORDER BY target_id`)
      .all();
    expect(dropped).toEqual([
      {
        actor_kind: "migration",
        actor_id: "0040_gateway_admin_accounts",
        action: "platform_role.drop",
        target_id: "u-other",
        before_json: JSON.stringify({ role: "platform_admin", grantedByUserId: "u-staff" }),
      },
      {
        actor_kind: "migration",
        actor_id: "0040_gateway_admin_accounts",
        action: "platform_role.drop",
        target_id: "u-staff",
        before_json: JSON.stringify({ role: "platform_admin", grantedByUserId: null }),
      },
    ]);
    // The product user itself is untouched: only the grant is gone.
    expect(db.prepare(`SELECT id, email FROM users`).all()).toEqual([{ id: "u-staff", email: "staff@example.test" }]);
  });

  it("keeps earlier audit rows, naming their actor kind, and the log append-only", () => {
    const db = beforeMigration();
    apply(db, MIGRATION);
    expect(
      db.prepare(`SELECT id, actor_kind, actor_id FROM gateway_admin_audit WHERE id IN ('gwa-boot', 'gwa-user') ORDER BY id`).all(),
    ).toEqual([
      { id: "gwa-boot", actor_kind: "bootstrap", actor_id: "bootstrap" },
      { id: "gwa-user", actor_kind: "user", actor_id: "u-staff" },
    ]);
    expect(() => db.prepare(`UPDATE gateway_admin_audit SET reason = 'x' WHERE id = 'gwa-user'`).run()).toThrow(/append-only/);
  });

  it("lets admin accounts hold only the known role", () => {
    const db = beforeMigration();
    apply(db, MIGRATION);
    const insert = db.prepare(`INSERT INTO admin_accounts (id, name, email, role) VALUES (?, 'A', ?, ?)`);
    insert.run("adm_a", "a@admin.test", "platform_admin");
    expect(() => insert.run("adm_b", "b@admin.test", "owner")).toThrow(/CHECK/);
    expect(() => insert.run("adm_c", "a@admin.test", "platform_admin")).toThrow(/UNIQUE/);
  });
});
