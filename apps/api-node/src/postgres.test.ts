import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { createPostgresDatabase } from "./postgres.ts";
it("uses a reserved connection, rolls back failures, and releases it for the next transaction", async () => {
  const sql = new PGlite();
  let leased = false;
  const pool = {
    query: sql.query.bind(sql),
    async connect() {
      if (leased) throw Error("Connection leaked");
      leased = true;
      return {
        query: sql.query.bind(sql),
        release() {
          leased = false;
        },
      };
    },
  };
  const db = createPostgresDatabase(pool);
  try {
    await sql.exec("CREATE TABLE probe (id text PRIMARY KEY)");
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO probe VALUES ('rollback')");
        throw Error("abort");
      }),
    ).rejects.toThrow("abort");
    await db.transaction((tx) =>
      tx.query("INSERT INTO probe VALUES ('committed')"),
    );
    expect((await sql.query("SELECT id FROM probe")).rows).toEqual([
      { id: "committed" },
    ]);
  } finally {
    await sql.close();
  }
});
