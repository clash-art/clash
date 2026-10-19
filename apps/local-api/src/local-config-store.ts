import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createLocalSqliteConnection } from "./local-sqlite-connection.js";

export interface SqliteLocalConfigStore {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, updatedAt?: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function sqlitePath(dataDir: string): string {
  return join(dataDir, "local.sqlite");
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

  const connection = createLocalSqliteConnection({ dataDir });

  return {
    async getJson<T>(key: string) {
      if (!(await exists(path))) return null;
      const row = await connection.db
        .prepare("SELECT value_json FROM local_config WHERE key = ?")
        .get(key);
      if (typeof row?.value_json !== "string") return null;
      try {
        return JSON.parse(row.value_json) as T;
      } catch {
        return null;
      }
    },

    async setJson(key, value, updatedAt = new Date().toISOString()) {
      await connection.db.prepare(`
        INSERT INTO local_config (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(key, JSON.stringify(value), updatedAt);
    },

    async delete(key) {
      if (!(await exists(path))) return;
      await connection.db.prepare("DELETE FROM local_config WHERE key = ?").run(key);
    },
  };
}
