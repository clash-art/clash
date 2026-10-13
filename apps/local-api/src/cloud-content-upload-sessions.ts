import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { CloudContentUploadSession } from "@clash/asset-sdk/delivery";

const nodeRequire = createRequire(import.meta.url);
/** Matches the cloud staging session lifetime; older rows can never resume. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Host-restart memory of an in-flight multipart upload ID for one immutable
 * object. The cloud session alone knows which parts it holds, so no part list
 * is mirrored here. The ID is transport state, not authorization. */
export function cloudContentUploadSession(
  dataDir: string,
  key: string,
  now = Date.now,
): CloudContentUploadSession {
  const use = async <T>(
    run: (db: import("node:sqlite").DatabaseSync) => T,
  ): Promise<T> => {
    await mkdir(dataDir, { recursive: true });
    const { DatabaseSync } = nodeRequire(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const db = new DatabaseSync(join(dataDir, "local.sqlite"));
    try {
      db.exec(`PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS cloud_content_upload_session (
          session_key TEXT PRIMARY KEY,
          upload_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );`);
      return run(db);
    } finally {
      db.close();
    }
  };
  return {
    load: () =>
      use((db) => {
        db.prepare(
          "DELETE FROM cloud_content_upload_session WHERE created_at <= ?",
        ).run(now() - TTL_MS);
        const row = db
          .prepare(
            "SELECT upload_id FROM cloud_content_upload_session WHERE session_key = ?",
          )
          .get(key);
        return typeof row?.upload_id === "string" ? row.upload_id : undefined;
      }),
    save: (uploadId) =>
      use((db) => {
        db.prepare(
          "INSERT OR REPLACE INTO cloud_content_upload_session (session_key, upload_id, created_at) VALUES (?, ?, ?)",
        ).run(key, uploadId, now());
      }),
    clear: () =>
      use((db) => {
        db.prepare(
          "DELETE FROM cloud_content_upload_session WHERE session_key = ?",
        ).run(key);
      }),
  };
}
