import type { CloudContentUploadSession } from "@clash/asset-sdk/delivery";
import { createLocalSqliteConnection } from "./local-sqlite-connection.js";

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
  const connection = createLocalSqliteConnection({ dataDir });
  return {
    load: () =>
      connection.use(async (db) => {
        await db
          .prepare("DELETE FROM cloud_content_upload_session WHERE created_at <= ?")
          .run(now() - TTL_MS);
        const row = await db
          .prepare(
            "SELECT upload_id FROM cloud_content_upload_session WHERE session_key = ?",
          )
          .get(key);
        return typeof row?.upload_id === "string" ? row.upload_id : undefined;
      }),
    save: async (uploadId) => {
      await connection.db
        .prepare(
          "INSERT OR REPLACE INTO cloud_content_upload_session (session_key, upload_id, created_at) VALUES (?, ?, ?)",
        )
        .run(key, uploadId, now());
    },
    clear: async () => {
      await connection.db
        .prepare("DELETE FROM cloud_content_upload_session WHERE session_key = ?")
        .run(key);
    },
  };
}
