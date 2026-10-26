/**
 * Migration 0046 (#356): the abuse tables refuse what the port never writes
 * (a second active suspension of one subject, an auto suspension without its
 * signal, a threshold whose suspendAt is below alertAt), and admin_accounts
 * is rebuilt to admit the `support_agent` role with every existing row, its
 * disabled state and the unique email index intact.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATEWAY_ABUSE_MAX_WINDOW_MINUTES, GATEWAY_ABUSE_SIGNALS } from "@clash/gateway-core";
import { ADMIN_ACCOUNT_ROLES } from "@clash/shared-cloud-schema/admin-auth";

import { WEB_DRIZZLE_MIGRATIONS } from "../../../web/app/test-support/sqlite-d1";

const MIGRATION = "0046_gateway_abuse.sql";

function apply(db: DatabaseSync, file: string) {
  for (const part of readFileSync(join(WEB_DRIZZLE_MIGRATIONS, file), "utf8").split("--> statement-breakpoint"))
    if (part.trim()) db.exec(part);
}

/** A database migrated up to (not including) 0046, with an enabled and a disabled admin account. */
function beforeMigration() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(WEB_DRIZZLE_MIGRATIONS).filter((f) => f.endsWith(".sql")).sort())
    if (file < MIGRATION) apply(db, file);
  const insert = db.prepare(
    `INSERT INTO admin_accounts (id, name, email, email_verified, role, disabled_at, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'platform_admin', ?, 10, 20)`,
  );
  insert.run("adm_on", "On", "on@admin.test", null);
  insert.run("adm_off", "Off", "off@admin.test", 30);
  return db;
}

describe("0046 abuse migration", () => {
  it("keeps every admin account through the rebuild and admits exactly the admin account roles", () => {
    const db = beforeMigration();
    const before = db.prepare(`SELECT * FROM admin_accounts ORDER BY id`).all();
    apply(db, MIGRATION);
    expect(db.prepare(`SELECT * FROM admin_accounts ORDER BY id`).all()).toEqual(before);
    const insert = db.prepare(`INSERT INTO admin_accounts (id, name, email, role, updated_at) VALUES (?, 'A', ?, ?, 1)`);
    // The D1 column admits what the Drizzle mirror and the authz module name.
    for (const role of ADMIN_ACCOUNT_ROLES) insert.run(`adm_${role}`, `${role}@admin.test`, role);
    expect(() => insert.run("adm_root", "root@admin.test", "root")).toThrow(/CHECK/);
    expect(() => insert.run("adm_dup", "on@admin.test", ADMIN_ACCOUNT_ROLES[1])).toThrow(/UNIQUE/);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'admin_accounts%'`).all()).toEqual([
      { name: "admin_accounts" },
    ]);
  });

  it("allows one active suspension per subject, and an auto suspension only with its signal", () => {
    const db = beforeMigration();
    apply(db, MIGRATION);
    const insert = db.prepare(
      `INSERT INTO gateway_suspension (id, subject_kind, subject_id, tenant_id, source, signal, reason, actor_kind, actor_id, created_at, lifted_at)
       VALUES (?, ?, 'gwk_1', 'team:a', ?, ?, 'r', 'admin', 'adm_on', 1, ?)`,
    );
    insert.run("gws_1", "key", "manual", null, null);
    expect(() => insert.run("gws_2", "key", "manual", null, null)).toThrow(/UNIQUE/);
    // Lifted history does not count; another subject kind with the same id is another subject.
    insert.run("gws_3", "key", "manual", null, 5);
    insert.run("gws_4", "tenant", "manual", null, null);
    expect(() => insert.run("gws_5", "client", "manual", null, 5)).toThrow(/CHECK/);
    expect(() => insert.run("gws_6", "key", "auto", null, 5)).toThrow(/CHECK/);
    insert.run("gws_7", "key", "auto", "velocity", 5);
  });

  it("refuses a threshold the gateway-core schema refuses: suspendAt below alertAt, a window past the longest", () => {
    const db = beforeMigration();
    apply(db, MIGRATION);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO gateway_abuse_threshold (signal, window_minutes, alert_at, suspend_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 'adm_on')`,
    );
    insert.run("velocity", 5, 10, null);
    insert.run("velocity", GATEWAY_ABUSE_MAX_WINDOW_MINUTES, 10, 10);
    for (const signal of GATEWAY_ABUSE_SIGNALS) insert.run(signal, 1, 1, null);
    for (const [signal, window, alertAt, suspendAt] of [
      ["velocity", 5, 10, 9],
      ["velocity", 0, 10, null],
      ["velocity", GATEWAY_ABUSE_MAX_WINDOW_MINUTES + 1, 10, null],
      ["velocity", 5, 0, null],
      ["bogus", 5, 10, null],
    ] as const)
      expect(() => insert.run(signal, window, alertAt, suspendAt), `${signal} ${window} ${alertAt} ${suspendAt}`).toThrow(/CHECK/);
  });
});
