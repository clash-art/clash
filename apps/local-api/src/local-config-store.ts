import { createRequire } from "node:module";
import { chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLocalSqliteConnection } from "./local-sqlite-connection.js";

type SqlitePrimitive = string | number | null;

type SqliteStatement = {
  run(...params: SqlitePrimitive[]): unknown;
  get(...params: SqlitePrimitive[]): Record<string, unknown> | undefined;
};

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

export interface SqliteLocalConfigStore {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, updatedAt?: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const require = createRequire(import.meta.url);

// `createRequire` rather than a bare `require`: this package is ESM (`"type": "module"`), and a
// bare `require` in a file that also uses `import` leaves the module kind ambiguous. Node and tsx
// both refuse it -- `tsx` reports ERR_AMBIGUOUS_MODULE_SYNTAX and will not load the file at all,
// which is why a throwaway script that imported this module could not be run.
//
// Still lazy, which is the point: `node:sqlite` is loaded on the first call below, not at import
// time. It is an experimental built-in, so paying for it only when a database is actually opened
// keeps the cost off every consumer that merely imports this module.
const nodeRequire = createRequire(import.meta.url);

function sqlitePath(dataDir: string): string {
  return join(dataDir, "local.sqlite");
}

function openDatabase(path: string): SqliteDatabase {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);
  return db;
}

function applySchema(db: SqliteDatabase): void {
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS local_config (
      key TEXT PRIMARY KEY NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    COMMIT;
  `);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function createSqliteLocalConfigStore(dataDir: string): SqliteLocalConfigStore {
  const path = sqlitePath(dataDir);

  const connection = createLocalSqliteConnection({
    dataDir,
    path,
    open: openDatabase,
    prepare: applySchema,
  });

  async function withDb<T>(task: (db: SqliteDatabase) => T): Promise<T> {
    return connection.use(task);
  }

  return {
    async getJson<T>(key: string) {
      if (!(await exists(path))) return null;
      return withDb((db) => {
        const row = db.prepare("SELECT value_json FROM local_config WHERE key = ?").get(key);
        if (typeof row?.value_json !== "string") return null;
        try {
          return JSON.parse(row.value_json) as T;
        } catch {
          return null;
        }
      });
    },

    async setJson(key, value, updatedAt = new Date().toISOString()) {
      await withDb((db) => {
        db.prepare(`
          INSERT INTO local_config (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `).run(key, JSON.stringify(value), updatedAt);
      });
    },

    async delete(key) {
      if (!(await exists(path))) return;
      await withDb((db) => {
        db.prepare("DELETE FROM local_config WHERE key = ?").run(key);
      });
    },
  };
}
