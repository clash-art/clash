import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { migrateDatabase } from "./migrations.ts";
it("rolls back a failed migration and rejects edits to an applied migration", async () => {
  const db = new PGlite();
  try {
    await expect(
      migrateDatabase(db, [
        {
          id: "broken",
          sql: "CREATE TABLE rollback_probe (id text); SELECT missing_column;",
        },
      ]),
    ).rejects.toThrow();
    expect(
      (await db.query("SELECT to_regclass('rollback_probe') AS name")).rows,
    ).toEqual([{ name: null }]);
    await migrateDatabase(db, [
      { id: "ok", sql: "CREATE TABLE probe (id text)" },
    ]);
    await expect(
      migrateDatabase(db, [
        { id: "ok", sql: "CREATE TABLE changed (id text)" },
      ]),
    ).rejects.toThrow("checksum");
  } finally {
    await db.close();
  }
});
