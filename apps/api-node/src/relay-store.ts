import type { ReplicaRelayStore } from "@clash/replica/replica-relay";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { loadProjectCheckpoint, cursorNumber } from "./checkpoint-store.ts";
import { createPostgresReplicaLog } from "./replica-log.ts";
export function createRelayStore(
  db: PostgresTransactionPort,
  projectId: string,
): ReplicaRelayStore {
  const log = createPostgresReplicaLog(db, projectId);
  return {
    async head() {
      const { rows } = await db.query<{ cursor: string }>(
        "SELECT cursor FROM project_replica_head WHERE project_id=$1",
        [projectId],
      );
      return rows[0] ? cursorNumber(rows[0].cursor) : 0;
    },
    loadCheckpoint: () => loadProjectCheckpoint(db, projectId),
    async readAfter(after, through, limit) {
      const { rows } = await db.query<{
        event_id: string;
        cursor: string;
        update_bytes: Uint8Array;
      }>(
        `WITH page AS (
    SELECT event_id,cursor,update_bytes FROM project_replica_event WHERE project_id=$1 AND cursor>$2 AND cursor<=$3 ORDER BY cursor LIMIT $4
   ), sized AS (SELECT *,sum(octet_length(update_bytes)) OVER(ORDER BY cursor) AS bytes,row_number() OVER(ORDER BY cursor) AS n FROM page)
   SELECT event_id,cursor,update_bytes FROM sized WHERE bytes<=4194304 OR n=1 ORDER BY cursor`,
        [projectId, after, through, limit],
      );
      return rows.map((row) => ({
        id: row.event_id,
        cursor: cursorNumber(row.cursor),
        update: new Uint8Array(row.update_bytes),
      }));
    },
    async append(id, update) {
      return (await log.append({ id, update })).event.cursor;
    },
  };
}
