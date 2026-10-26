/**
 * Migration 0043 (#350): dual-key rotation columns and circuit-breaker
 * health. An account rotated in place before 0043 keeps counting from its
 * version number (a `v3` account's next version is `v4`, never a reused
 * `v2`), and the triggers refuse a draining version without a secret or equal
 * to the active one.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WEB_DRIZZLE_MIGRATIONS } from "../../../web/app/test-support/sqlite-d1";

const MIGRATION = "0043_gateway_upstream_keys.sql";

function apply(db: DatabaseSync, file: string) {
  for (const part of readFileSync(join(WEB_DRIZZLE_MIGRATIONS, file), "utf8").split("--> statement-breakpoint"))
    if (part.trim()) db.exec(part);
}

function migratedBefore() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(WEB_DRIZZLE_MIGRATIONS).filter((f) => f.endsWith(".sql")).sort())
    if (file < MIGRATION) apply(db, file);
  return db;
}

const insertAccount = (db: DatabaseSync, id: string, keyVersion: string) =>
  db
    .prepare(`INSERT INTO gateway_upstream_account (id, provider_id, secret_ref, key_version) VALUES (?, 'official', 'GATEWAY_UPSTREAM_A', ?)`)
    .run(id, keyVersion);

describe("0043 upstream key vault migration", () => {
  it("carries an in-place rotated account's version number into key_serial and starts with no draining version", () => {
    const db = migratedBefore();
    insertAccount(db, "gwu-v3", "v3");
    insertAccount(db, "gwu-v1", "v1");
    insertAccount(db, "gwu-named", "legacy");
    apply(db, MIGRATION);
    expect(
      db.prepare(`SELECT id, key_version, key_serial, draining_key_version FROM gateway_upstream_account ORDER BY id`).all(),
    ).toEqual([
      { id: "gwu-named", key_version: "legacy", key_serial: 1, draining_key_version: null },
      { id: "gwu-v1", key_version: "v1", key_serial: 1, draining_key_version: null },
      { id: "gwu-v3", key_version: "v3", key_serial: 3, draining_key_version: null },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM gateway_upstream_health`).get()).toEqual({ n: 0 });
  });

  it("refuses a draining version without a secret, a secret without a version, or the active version draining", () => {
    const db = migratedBefore();
    apply(db, MIGRATION);
    insertAccount(db, "gwu-a", "v2");
    const update = (set: string) => () => db.prepare(`UPDATE gateway_upstream_account SET ${set} WHERE id = 'gwu-a'`).run();
    expect(update(`draining_key_version = 'v1'`)).toThrow(/draining key version/);
    expect(update(`draining_secret_ref = 'GATEWAY_UPSTREAM_OLD'`)).toThrow(/draining key version/);
    expect(update(`draining_key_version = 'v2', draining_secret_ref = 'GATEWAY_UPSTREAM_OLD'`)).toThrow(/draining key version/);
    expect(
      () =>
        db
          .prepare(
            `INSERT INTO gateway_upstream_account (id, provider_id, secret_ref, key_version, draining_key_version)
             VALUES ('gwu-b', 'official', 'GATEWAY_UPSTREAM_B', 'v2', 'v1')`,
          )
          .run(),
    ).toThrow(/draining key version/);
    update(`draining_key_version = 'v1', draining_encrypted_credentials = 'sealed'`)();
    update(`draining_key_version = NULL, draining_encrypted_credentials = NULL`)();
  });

  it("refuses a negative failure count", () => {
    const db = migratedBefore();
    apply(db, MIGRATION);
    expect(() =>
      db.prepare(`INSERT INTO gateway_upstream_health (account_id, consecutive_failures) VALUES ('gwu-a', -1)`).run(),
    ).toThrow(/CHECK/);
  });
});
