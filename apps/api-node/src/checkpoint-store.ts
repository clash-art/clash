import type { CheckpointPort, ReplicaCheckpoint } from "@clash/replica";
import type { PostgresQueryPort } from "@clash/shared-runtime/project-authorization-postgres";
export function cursorNumber(value: string | number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw Error("Invalid checkpoint cursor");
  return n;
}
export async function loadProjectCheckpoint(
  db: PostgresQueryPort,
  projectId: string,
): Promise<ReplicaCheckpoint<Uint8Array> | null> {
  const { rows } = await db.query<{
    cursor: string | number;
    snapshot_bytes: Uint8Array;
  }>(
    "SELECT cursor,snapshot_bytes FROM project_replica_checkpoint WHERE project_id=$1",
    [projectId],
  );
  return rows[0]
    ? {
        cursor: cursorNumber(rows[0].cursor),
        data: new Uint8Array(rows[0].snapshot_bytes),
      }
    : null;
}
/** Internal port: only publish a full snapshot proven to cover this committed prefix. */
export function createPostgresCheckpointStore(
  db: PostgresQueryPort,
  projectId: string,
): CheckpointPort<Uint8Array> {
  return {
    load: () => loadProjectCheckpoint(db, projectId),
    async save(checkpoint) {
      cursorNumber(checkpoint.cursor);
      await db.query(
        `INSERT INTO project_replica_checkpoint (project_id,cursor,snapshot_bytes)
    SELECT project_id,$2,$3 FROM project_replica_head WHERE project_id=$1 AND cursor >= $2
    ON CONFLICT (project_id) DO UPDATE SET cursor=excluded.cursor,snapshot_bytes=excluded.snapshot_bytes,updated_at=CURRENT_TIMESTAMP
    WHERE project_replica_checkpoint.cursor < excluded.cursor`,
        [projectId, checkpoint.cursor, Buffer.from(checkpoint.data)],
      );
    },
  };
}
