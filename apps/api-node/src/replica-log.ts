import { randomUUID } from "node:crypto";
import type { EventLogPort, StoredReplicaEvent } from "@clash/replica";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import type { PostgresQueryPort } from "@clash/shared-runtime/project-authorization-postgres";

type EventRow = {
  event_id: string;
  cursor: string | number;
  update_bytes: Uint8Array;
};
function cursorNumber(value: string | number): number {
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw Error("Replica cursor outside supported range");
  return cursor;
}
function stored(row: EventRow): StoredReplicaEvent<Uint8Array> {
  return {
    id: row.event_id,
    cursor: cursorNumber(row.cursor),
    update: new Uint8Array(row.update_bytes),
  };
}
function identifier(value: string) {
  if (!value.trim() || value.length > 256)
    throw Error("Invalid replica identifier");
}

/** Authorized opaque byte log. CRDT validation happens during client/worker replay.
 * Notification and coalesced checkpoint intent commit atomically with each append. */
export function createPostgresReplicaLog(
  db: PostgresTransactionPort,
  projectId: string,
): EventLogPort<Uint8Array> {
  identifier(projectId);
  return {
    async append(event) {
      const eventId = event.id;
      identifier(eventId);
      if (event.metadata !== undefined)
        throw Error("Replica metadata is not supported by this binary log");
      // Own bytes across awaits; mutation by a caller cannot alter a pending append.
      const bytes = Buffer.from(event.update);
      return db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO project_replica_head (project_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [projectId],
        );
        const head = await tx.query<{ cursor: string | number }>(
          "SELECT cursor FROM project_replica_head WHERE project_id=$1 FOR UPDATE",
          [projectId],
        );
        const previous = await tx.query<EventRow>(
          "SELECT event_id,cursor,update_bytes FROM project_replica_event WHERE project_id=$1 AND event_id=$2",
          [projectId, eventId],
        );
        if (previous.rows[0]) {
          if (!Buffer.from(previous.rows[0].update_bytes).equals(bytes))
            throw Error(
              "Idempotency conflict: event ID reused with different bytes",
            );
          return { appended: false, event: stored(previous.rows[0]) };
        }
        const cursor = cursorNumber(cursorNumber(head.rows[0]!.cursor) + 1);
        await tx.query(
          "INSERT INTO project_replica_event (project_id,cursor,event_id,update_bytes) VALUES ($1,$2,$3,$4)",
          [projectId, cursor, eventId, bytes],
        );
        await tx.query(
          "INSERT INTO project_replica_outbox (project_id,cursor) VALUES ($1,$2)",
          [projectId, cursor],
        );
        await tx.query(
          `INSERT INTO project_replica_outbox(kind,project_id,cursor,lease_until)
           VALUES ('checkpoint',$1,$2,CURRENT_TIMESTAMP + interval '10 minutes')
           ON CONFLICT (project_id) WHERE kind='checkpoint'
           DO UPDATE SET cursor=excluded.cursor`,
          [projectId, cursor],
        );
        await tx.query(
          "UPDATE project_replica_head SET cursor=$2 WHERE project_id=$1",
          [projectId, cursor],
        );
        return {
          appended: true,
          event: { id: eventId, cursor, update: new Uint8Array(bytes) },
        };
      });
    },
    async readAfter(cursor) {
      cursorNumber(cursor);
      const { rows } = await db.query<EventRow>(
        "SELECT event_id,cursor,update_bytes FROM project_replica_event WHERE project_id=$1 AND cursor>$2 ORDER BY cursor",
        [projectId, cursor],
      );
      return rows.map(stored);
    },
    async truncateThrough(cursor) {
      cursorNumber(cursor);
      // Retain history/dedup evidence until verified checkpoint + retention policy is implemented.
    },
  };
}
export interface ReplicaNotification {
  projectId: string;
  cursor: number;
}
export interface OutboxLease extends ReplicaNotification {
  leaseId: string;
}
export interface ClaimOptions {
  limit: number;
  leaseMs: number;
}
export interface ReplicaOutbox {
  claim(options: ClaimOptions): Promise<OutboxLease[]>;
  ack(lease: OutboxLease): Promise<boolean>;
}
export interface ReplicaNotificationPublisher {
  publish(event: ReplicaNotification): Promise<void | number>;
}
export function createPostgresOutbox(
  db: PostgresTransactionPort,
  kind: "notification" | "checkpoint" = "notification",
): ReplicaOutbox {
  return {
    async claim({ limit, leaseMs }) {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000 ||
        !Number.isInteger(leaseMs) ||
        leaseMs < 1 ||
        leaseMs > 300000
      )
        throw Error("Invalid outbox claim limits");
      const leaseId = randomUUID();
      return db.transaction(async (tx) => {
        const { rows } = await tx.query<{
          project_id: string;
          cursor: string | number;
          lease_id: string;
        }>(
          `WITH candidates AS (
      SELECT project_id,cursor FROM project_replica_outbox WHERE kind=$4 AND lease_until <= CURRENT_TIMESTAMP
      ORDER BY lease_until,project_id,cursor LIMIT $1 FOR UPDATE SKIP LOCKED
     ) UPDATE project_replica_outbox o
       SET lease_id=$2,lease_until=CURRENT_TIMESTAMP + $3 * interval '1 millisecond',attempts=attempts+1
       FROM candidates c WHERE o.kind=$4 AND o.project_id=c.project_id AND o.cursor=c.cursor
       RETURNING o.project_id,o.cursor,o.lease_id`,
          [limit, leaseId, leaseMs, kind],
        );
        return rows.map((row) => ({
          projectId: row.project_id,
          cursor: cursorNumber(row.cursor),
          leaseId: row.lease_id,
        }));
      });
    },
    async ack(lease) {
      const { rows } = await db.query(
        `DELETE FROM project_replica_outbox WHERE project_id=$1
     AND (CASE WHEN kind='checkpoint' THEN cursor<=$2 ELSE cursor=$2 END)
     AND kind=$4 AND lease_id=$3 AND lease_until>CURRENT_TIMESTAMP RETURNING cursor`,
        [lease.projectId, lease.cursor, lease.leaseId, kind],
      );
      if (!rows.length && kind === "checkpoint") {
        // New appends raced the completed prefix. Preserve the successor and
        // schedule it after the coalescing interval, fenced by this lease ID.
        await db.query(
          `UPDATE project_replica_outbox
          SET lease_id=NULL,lease_until=CURRENT_TIMESTAMP + interval '10 minutes',attempts=0
          WHERE kind='checkpoint' AND project_id=$1 AND lease_id=$2 AND cursor>$3`,
          [lease.projectId, lease.leaseId, lease.cursor],
        );
      }
      return rows.length > 0;
    },
  };
}
/** Delivery is at least once: publish success followed by a crash may publish twice.
 * A notification wakes ALL interested gateways; it never transfers ownership of an event. */
export async function dispatchOutboxBatch(
  outbox: ReplicaOutbox,
  publisher: ReplicaNotificationPublisher,
  options: ClaimOptions & { signal?: AbortSignal },
) {
  const leases = await outbox.claim(options);
  const result = { published: 0, failed: 0, stale: 0 };
  for (const lease of leases) {
    if (options.signal?.aborted) break;
    try {
      const covered = await publisher.publish({
        projectId: lease.projectId,
        cursor: lease.cursor,
      });
      if (
        covered !== undefined &&
        (!Number.isSafeInteger(covered) || covered < lease.cursor)
      )
        throw Error("Publisher did not cover claimed offset");
      if (
        await outbox.ack(
          covered === undefined ? lease : { ...lease, cursor: covered },
        )
      )
        result.published++;
      else result.stale++;
    } catch {
      result.failed++;
    } // Leave leased work for retry; do not delete on publish failure.
  }
  return result;
}

export const REPLICA_NOTIFICATION_CHANNEL = "clash_replica_events";
/** PG is both the durable queue and wake-up transport. Payload contains no update bytes.
 * LISTEN clients must also poll/replay after connection loss or a missed notification. */
export function createPostgresNotificationPublisher(
  db: PostgresQueryPort,
): ReplicaNotificationPublisher {
  return {
    async publish(event) {
      identifier(event.projectId);
      cursorNumber(event.cursor);
      await db.query("SELECT pg_notify($1,$2)", [
        REPLICA_NOTIFICATION_CHANNEL,
        JSON.stringify(event),
      ]);
    },
  };
}
