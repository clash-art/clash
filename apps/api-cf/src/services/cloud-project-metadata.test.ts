import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createD1ProjectMetadataStore } from "./cloud-project-metadata.js";

// Run the actual conditional statement against SQLite through a D1-shaped adapter.
function database(path: string) {
  const db = new DatabaseSync(path);
  return {
    close: () => db.close(),
    query(sql: string, args: (string | number | null)[] = []) {
      db.prepare(sql).run(...args);
    },
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        bind(...args: (string | number | null)[]) {
          return {
            async run() {
              return { meta: { changes: statement.run(...args).changes } };
            },
            async first() {
              return statement.get(...args) ?? null;
            },
          };
        },
      };
    },
  };
}

const metadata = {
  projectId: "project",
  name: "Current",
  description: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  deletedAt: null,
};

describe("D1 project metadata writes", () => {
  it("rejects stale writes, accepts equal timestamps and null timestamps, and reports missing projects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metadata-"));
    const db = database(join(dir, "test.sqlite"));
    try {
      db.query(
        "CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, description TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER)",
      );
      db.query("INSERT INTO project VALUES (?, ?, NULL, ?, ?, NULL)", [
        metadata.projectId,
        metadata.name,
        Date.parse(metadata.createdAt) / 1000,
        Date.parse(metadata.updatedAt) / 1000,
      ]);
      const store = createD1ProjectMetadataStore(db as unknown as D1Database);
      await expect(
        store.write({
          ...metadata,
          name: "Stale",
          updatedAt: metadata.createdAt,
        }),
      ).resolves.toEqual({ status: "stale", current: metadata });
      expect(await store.read(metadata.projectId)).toEqual(metadata);
      const equal = { ...metadata, name: "Equal timestamp edit" };
      await expect(store.write(equal)).resolves.toEqual({ status: "written" });
      expect(await store.read(metadata.projectId)).toEqual(equal);
      db.query("UPDATE project SET updated_at = NULL");
      await expect(store.write(metadata)).resolves.toEqual({
        status: "written",
      });
      await expect(
        store.write({ ...metadata, projectId: "missing" }),
      ).resolves.toEqual({ status: "not-found" });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
