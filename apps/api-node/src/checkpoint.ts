import { LoroStateAdapter } from "@clash/replica/loro";
import type { PostgresQueryPort } from "@clash/shared-runtime/project-authorization-postgres";
import {
  cursorNumber,
  createPostgresCheckpointStore,
} from "./checkpoint-store.ts";
export {
  loadProjectCheckpoint,
  createPostgresCheckpointStore,
} from "./checkpoint-store.ts";
/** Capture a committed head, replay immutable pages without holding a write lock,
 * then publish monotonically. New appends remain a tail beyond this checkpoint. */
export async function buildProjectCheckpoint(
  db: PostgresQueryPort,
  projectId: string,
  options: { pageSize?: number; signal?: AbortSignal } = {},
): Promise<number | null> {
  const pageSize = options.pageSize ?? 256;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 4096)
    throw Error("Invalid checkpoint page size");
  const store = createPostgresCheckpointStore(db, projectId);
  const prior = await store.load();
  const { rows } = await db.query<{ cursor: string | number }>(
    "SELECT cursor FROM project_replica_head WHERE project_id=$1",
    [projectId],
  );
  if (!rows[0]) return null;
  const target = cursorNumber(rows[0].cursor);
  if (prior && prior.cursor >= target) return prior.cursor;
  const adapter = new LoroStateAdapter();
  const doc = prior ? adapter.restore(prior.data) : adapter.create();
  const pending = new Map<`${number}`, number>();
  let covered = prior?.cursor ?? 0;
  try {
    while (covered < target) {
      options.signal?.throwIfAborted();
      const page = await db.query<{
        cursor: string | number;
        update_bytes: Uint8Array;
      }>(
        `SELECT cursor,update_bytes FROM project_replica_event
     WHERE project_id=$1 AND cursor>$2 AND cursor<=$3 ORDER BY cursor LIMIT $4`,
        [projectId, covered, target, pageSize],
      );
      if (page.rows.length === 0)
        throw Error("Missing replica log before checkpoint target");
      for (const row of page.rows) {
        const cursor = cursorNumber(row.cursor);
        if (cursor !== covered + 1)
          throw Error("Missing replica log before checkpoint target");
        covered = cursor;
      }
      const updates = page.rows
        .map((row) => new Uint8Array(row.update_bytes))
        .filter((bytes) => bytes.byteLength > 0);
      if (updates.length > 0) {
        const status = doc.importBatch(updates);
        for (const [peer, span] of status.pending ?? [])
          pending.set(peer, Math.max(pending.get(peer) ?? 0, span.end));
      }
    }
    const version = doc.version();
    try {
      for (const [peer, end] of pending)
        if ((version.get(peer) ?? 0) < end)
          throw Error("Missing Loro dependencies; checkpoint not published");
    } finally {
      version.free();
    }
    options.signal?.throwIfAborted();
    await store.save({ cursor: target, data: adapter.checkpoint(doc) });
    return target;
  } finally {
    doc.free();
  }
}

/** Handler registered with the existing durable outbox executor. */
export function createCheckpointPublisher(
  db: PostgresQueryPort,
  signal?: AbortSignal,
) {
  return {
    async publish(event: {
      projectId: string;
      cursor: number;
    }): Promise<number> {
      const covered = await buildProjectCheckpoint(db, event.projectId, {
        signal,
      });
      if (covered === null || covered < event.cursor)
        throw Error("Checkpoint did not cover durable task");
      return covered;
    },
  };
}
