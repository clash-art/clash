import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SqlConnection } from "./postgres.ts";
export interface Migration {
  id: string;
  sql: string;
}
export interface MigrationDatabase {
  transaction<T>(work: (tx: SqlConnection) => Promise<T>): Promise<T>;
}
export async function loadMigrations(): Promise<Migration[]> {
  return Promise.all(
    [
      "0001_project_admission.sql",
      "0002_api_tokens.sql",
      "0003_replica_log.sql",
      "0004_replica_checkpoint.sql",
      "0005_replica_batch.sql",
      "0006_client_checkpoint.sql",
      "0007_retire_checkpoint_tasks.sql",
      "0008_checkpoint_outbox.sql",
      "0009_cloud_runs.sql",
      "0010_auth.sql",
      "0011_personal_assets.sql",
      "0012_project_resources.sql",
    ].map(async (id) => ({
      id,
      sql: await readFile(
        new URL(
          `../../../packages/shared-cloud-schema/postgres/${id}`,
          import.meta.url,
        ),
        "utf8",
      ),
    })),
  );
}
export async function migrateDatabase(
  db: MigrationDatabase,
  migrations?: Migration[],
): Promise<void> {
  const entries = migrations ?? (await loadMigrations());
  await db.transaction(async (tx) => {
    // Serializes migration runners across processes; the lock ends with this transaction.
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext('clash:cloud:migrations'))",
    );
    await tx.query(
      "CREATE TABLE IF NOT EXISTS cloud_schema_migration (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    for (const migration of entries) {
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      const previous = await tx.query<{ checksum: string }>(
        "SELECT checksum FROM cloud_schema_migration WHERE id=$1",
        [migration.id],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].checksum !== checksum)
          throw Error(`Migration checksum mismatch: ${migration.id}`);
        continue;
      }
      await tx.exec(migration.sql);
      await tx.query(
        "INSERT INTO cloud_schema_migration (id,checksum) VALUES ($1,$2)",
        [migration.id, checksum],
      );
    }
  });
}
