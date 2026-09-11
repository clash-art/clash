import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const nodeRequire = createRequire(import.meta.url);

/** Machine/profile identity, independent of the process discovery Host id.
 * Existing process-UUID admissions require explicit re-admission; choosing the
 * latest row could silently adopt another replica's authorization. */
export async function getLocalReplicaId(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const { DatabaseSync } = nodeRequire(
    "node:sqlite",
  ) as typeof import("node:sqlite");
  const db = new DatabaseSync(join(dataDir, "local.sqlite"));
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS local_replica_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        replica_id TEXT NOT NULL
      );`);
    db.prepare(
      "INSERT OR IGNORE INTO local_replica_identity (singleton, replica_id) VALUES (1, ?)",
    ).run(randomUUID());
    const row = db
      .prepare(
        "SELECT replica_id FROM local_replica_identity WHERE singleton = 1",
      )
      .get();
    if (typeof row?.replica_id !== "string" || !row.replica_id.trim())
      throw new Error(
        "Local replica identity is invalid; inspect the Host store.",
      );
    return row.replica_id;
  } finally {
    db.close();
  }
}
