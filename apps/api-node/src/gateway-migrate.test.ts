import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  classifyMigration,
  loadMigrations,
  MigrationError,
  runMigrations,
  type MigrationDatabase,
} from "./migrations.ts";

const migrationTable = async (db: PGlite) =>
  (
    await db.query<{ name: string | null }>(
      "SELECT to_regclass('cloud_schema_migration')::text AS name",
    )
  ).rows[0]?.name;

/** PGlite as a MigrationDatabase that records every statement it is sent. */
function recording(db: PGlite) {
  const statements: string[] = [];
  let transactions = 0;
  const port: MigrationDatabase = {
    transaction: (work) => {
      transactions += 1;
      return db.transaction((tx) =>
        work({
          query: (sql, parameters) => {
            statements.push(sql);
            return tx.query(sql, parameters) as never;
          },
          exec: (sql) => {
            statements.push(sql);
            return tx.exec(sql);
          },
        }),
      );
    },
  };
  return { port, statements, transactions: () => transactions };
}

describe("gateway migrate one-shot (#377)", () => {
  it("plans a fresh database without writing, then applies every migration once", async () => {
    const db = new PGlite();
    try {
      const release = (await loadMigrations()).map((migration) => migration.id);
      const plan = await runMigrations(db, { plan: true });
      expect(plan.bootstrap).toBe(true);
      expect(plan.pending.map((migration) => migration.id)).toEqual(release);
      expect(plan.appliedNow).toEqual([]);
      expect(await migrationTable(db)).toBeNull();

      const first = await runMigrations(db);
      expect(first.appliedNow).toEqual(release);
      const recorded = await db.query<{ id: string }>(
        "SELECT id FROM cloud_schema_migration ORDER BY id",
      );
      expect(recorded.rows.map((row) => row.id)).toEqual([...release].sort());

      // One-shot: a second run (another replica's init job) is a no-op.
      const second = await runMigrations(db);
      expect(second).toMatchObject({
        bootstrap: false,
        appliedNow: [],
        pending: [],
        ahead: [],
      });
      expect(second.applied).toEqual(release);
    } finally {
      await db.close();
    }
  });

  it("takes the advisory lock first, in one transaction, and releases it", async () => {
    const db = new PGlite();
    try {
      const { port, statements, transactions } = recording(db);
      await runMigrations(port, {
        lockTimeoutMs: 1500,
        migrations: [{ id: "a", sql: "CREATE TABLE lock_probe (id text)" }],
      });
      expect(transactions()).toBe(1);
      expect(statements[0]).toMatch(/^SET LOCAL lock_timeout = 1500$/);
      expect(statements[1]).toMatch(
        /pg_advisory_xact_lock\(hashtext\('clash:cloud:migrations'\)\)/,
      );
      const locks = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'",
      );
      expect(locks.rows[0]?.n).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("maps a lock timeout to MIGRATION_LOCK_TIMEOUT", async () => {
    const lockNotAvailable = Object.assign(
      Error("canceling statement due to lock timeout"),
      { code: "55P03" },
    );
    const db: MigrationDatabase = {
      transaction: (work) =>
        work({
          query: async (sql) => {
            if (sql.includes("pg_advisory_xact_lock")) throw lockNotAvailable;
            return { rows: [] } as never;
          },
          exec: async () => undefined,
        }),
    };
    await expect(
      runMigrations(db, { lockTimeoutMs: 10, migrations: [] }),
    ).rejects.toMatchObject({ code: "MIGRATION_LOCK_TIMEOUT" });
    await expect(
      runMigrations(db, { lockTimeoutMs: 0, migrations: [] }),
    ).rejects.toThrow(RangeError);
  });

  it("refuses pending contract migrations on a live database unless allowed, atomically", async () => {
    const db = new PGlite();
    try {
      const base = [
        { id: "a", sql: "CREATE TABLE probe (id text, legacy text)" },
      ];
      await runMigrations(db, { migrations: base });
      const next = [
        ...base,
        { id: "b", sql: "ALTER TABLE probe ADD COLUMN note text" },
        { id: "c", sql: "ALTER TABLE probe DROP COLUMN legacy" },
      ];
      const plan = await runMigrations(db, { plan: true, migrations: next });
      expect(plan.pending.map(({ id, phase }) => ({ id, phase }))).toEqual([
        { id: "b", phase: "expand" },
        { id: "c", phase: "contract" },
      ]);

      const refused = await runMigrations(db, { migrations: next }).catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(MigrationError);
      expect(refused).toMatchObject({
        code: "MIGRATION_CONTRACT_REFUSED",
        migrationIds: ["c"],
      });
      // Nothing applied, not even the expand step before it.
      const columns = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'probe' ORDER BY column_name",
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        "id",
        "legacy",
      ]);

      const allowed = await runMigrations(db, {
        migrations: next,
        allowContract: true,
      });
      expect(allowed.appliedNow).toEqual(["b", "c"]);
    } finally {
      await db.close();
    }
  });

  it("applies contract steps on a bootstrap database and honours the declared marker", async () => {
    const db = new PGlite();
    try {
      const bootstrap = await runMigrations(db, {
        migrations: [
          { id: "a", sql: "CREATE TABLE t (id text)" },
          { id: "b", sql: "DROP TABLE t" },
        ],
      });
      expect(bootstrap.appliedNow).toEqual(["a", "b"]);
      await expect(
        runMigrations(db, {
          migrations: [
            { id: "a", sql: "CREATE TABLE t (id text)" },
            { id: "b", sql: "DROP TABLE t" },
            {
              id: "c",
              sql: "-- migration-phase: contract\nCREATE INDEX IF NOT EXISTS noop ON cloud_schema_migration (applied_at)",
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "MIGRATION_CONTRACT_REFUSED" });
    } finally {
      await db.close();
    }
  });

  it("reports a database ahead of this release (rollback) and stays a no-op", async () => {
    const db = new PGlite();
    try {
      const newer = [
        { id: "a", sql: "CREATE TABLE t (id text)" },
        { id: "b", sql: "ALTER TABLE t ADD COLUMN v text" },
      ];
      await runMigrations(db, { migrations: newer });
      const older = await runMigrations(db, { migrations: newer.slice(0, 1) });
      expect(older).toMatchObject({
        applied: ["a"],
        pending: [],
        ahead: ["b"],
        appliedNow: [],
      });
    } finally {
      await db.close();
    }
  });

  it("refuses an edited applied migration with MIGRATION_CHECKSUM_MISMATCH", async () => {
    const db = new PGlite();
    try {
      await runMigrations(db, {
        migrations: [{ id: "a", sql: "CREATE TABLE t (id text)" }],
      });
      await expect(
        runMigrations(db, {
          plan: true,
          migrations: [{ id: "a", sql: "CREATE TABLE t2 (id text)" }],
        }),
      ).rejects.toMatchObject({
        code: "MIGRATION_CHECKSUM_MISMATCH",
        migrationIds: ["a"],
      });
    } finally {
      await db.close();
    }
  });
});

describe("expand/contract classification", () => {
  const phase = (sql: string) => classifyMigration(sql).phase;

  it("treats statements the previous release cannot survive as contract", () => {
    for (const sql of [
      "DROP TABLE IF EXISTS old_table;",
      "DROP VIEW v;",
      "TRUNCATE gateway_rate_window;",
      "ALTER TABLE t DROP COLUMN legacy;",
      "ALTER TABLE t DROP legacy;",
      "ALTER TABLE t ADD COLUMN v text, DROP COLUMN IF EXISTS legacy;",
      "ALTER TABLE t RENAME COLUMN a TO b;",
      "ALTER TABLE t RENAME TO t2;",
      "ALTER TABLE t ALTER COLUMN a TYPE bigint;",
      "ALTER TABLE t ALTER COLUMN a SET DATA TYPE bigint;",
      "ALTER TABLE t ALTER COLUMN a SET NOT NULL;",
      "ALTER TABLE t ADD COLUMN a text NOT NULL;",
    ])
      expect(phase(sql), sql).toBe("contract");
  });

  it("treats additive and widening statements as expand", () => {
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS t (id text PRIMARY KEY, n numeric(10,2) NOT NULL);",
      "ALTER TABLE t ADD COLUMN a text;",
      "ALTER TABLE t ADD COLUMN kind text NOT NULL DEFAULT 'x';",
      "ALTER TABLE t ADD CONSTRAINT t_check CHECK (a IS NOT NULL);",
      "ALTER TABLE t DROP CONSTRAINT t_check;",
      "ALTER TABLE t ALTER COLUMN a DROP NOT NULL;",
      "ALTER TABLE t ALTER COLUMN a SET DEFAULT 'y';",
      "DROP INDEX IF EXISTS t_idx;",
      "CREATE INDEX t_idx ON t (a);",
      // Comments, literals and function bodies are not statements.
      "-- DROP TABLE t;\n/* TRUNCATE t; */ INSERT INTO t (a) VALUES ('DROP TABLE t; RENAME');",
      "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'no'; DROP TABLE t; END $$ LANGUAGE plpgsql;",
    ])
      expect(phase(sql), sql).toBe("expand");
  });

  it("lets a migration declare contract when the scanner cannot see it", () => {
    expect(
      phase(
        "-- migration-phase: contract\nALTER TABLE t ADD CONSTRAINT narrower CHECK (a <> '');",
      ),
    ).toBe("contract");
  });
});
