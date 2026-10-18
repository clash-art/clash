import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createLocalSqliteConnection } from "./local-sqlite-connection.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

async function fixture() {
  const dataDir = join(
    await mkdtemp(join(tmpdir(), "clash-sqlite-connection-")),
    "local-api",
  );
  const path = join(dataDir, "local.sqlite");
  let opens = 0;
  let prepares = 0;
  const connection = createLocalSqliteConnection({
    dataDir,
    path,
    open: (target) => {
      opens += 1;
      return new DatabaseSync(target);
    },
    prepare: (database) => {
      prepares += 1;
      database.exec(
        "PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS item (id TEXT PRIMARY KEY);",
      );
    },
  });
  return { dataDir, path, connection, counts: () => ({ opens, prepares }) };
}

describe("createLocalSqliteConnection", () => {
  it("opens and prepares the database once for consecutive and concurrent tasks", async () => {
    const { connection, counts } = await fixture();
    await connection.use((db) => db.prepare("INSERT INTO item VALUES ('a')").run());
    const rows = await Promise.all(
      [1, 2, 3].map(() =>
        connection.use((db) => db.prepare("SELECT id FROM item").all()),
      ),
    );
    expect(rows).toEqual([[{ id: "a" }], [{ id: "a" }], [{ id: "a" }]]);
    expect(counts()).toEqual({ opens: 1, prepares: 1 });
    await connection.close();
  });

  it("reopens and prepares again when the database file is removed", async () => {
    const { path, connection, counts } = await fixture();
    await connection.use((db) => db.prepare("INSERT INTO item VALUES ('a')").run());
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${path}${suffix}`, { force: true });

    const rows = await connection.use((db) =>
      db.prepare("SELECT id FROM item").all(),
    );
    expect(rows).toEqual([]);
    expect(counts()).toEqual({ opens: 2, prepares: 2 });
    await connection.close();
  });

  it("retries a failed open on the next task", async () => {
    const dataDir = join(
      await mkdtemp(join(tmpdir(), "clash-sqlite-connection-")),
      "local-api",
    );
    let fail = true;
    const connection = createLocalSqliteConnection({
      dataDir,
      path: join(dataDir, "local.sqlite"),
      open: (target) => {
        if (fail) throw new Error("locked");
        return new DatabaseSync(target);
      },
    });
    await expect(connection.use(() => 1)).rejects.toThrow("locked");
    fail = false;
    await expect(connection.use(() => 2)).resolves.toBe(2);
    await connection.close();
  });
});
