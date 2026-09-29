import type { PostgresQueryPort } from "@clash/shared-runtime/project-authorization-postgres";
import { randomUUID } from "node:crypto";
import { LoroDoc } from "loro-crdt";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { createRelayStore } from "./relay-store.ts";
import { cursorNumber } from "./checkpoint-store.ts";

/** A short-lived command replica over the same log as browser edits. Holding
 * the log head serializes CAS evaluation and append with every other producer. */
export async function withProjectDocument<T>(
  db: PostgresTransactionPort,
  ownerId: string,
  projectId: string,
  mutate: boolean,
  work: (doc: LoroDoc, tx: PostgresQueryPort) => T | Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Mutations also touch project.updated_at. Acquire the write lock up front:
    // two SHARE holders cannot safely upgrade after competing for the head lock.
    const owner = await tx.query(
      "SELECT id FROM project WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE",
      [projectId, ownerId],
    );
    if (!owner.rows.length) throw Error("Project not found");
    await tx.query(
      "INSERT INTO project_replica_head(project_id) VALUES($1) ON CONFLICT DO NOTHING",
      [projectId],
    );
    const head = await tx.query<{ cursor: string }>(
      "SELECT cursor FROM project_replica_head WHERE project_id=$1 FOR UPDATE",
      [projectId],
    );
    const through = cursorNumber(head.rows[0]!.cursor);
    const transaction: PostgresTransactionPort = {
      query: tx.query.bind(tx),
      transaction: async (callback) => callback(tx),
    };
    const store = createRelayStore(transaction, projectId);
    const snapshot = await store.loadCheckpoint();
    const doc = new LoroDoc();
    try {
      if (snapshot) doc.import(snapshot.data);
      let cursor = snapshot?.cursor ?? 0;
      const pending = new Map<`${number}`, number>();
      while (cursor < through) {
        const page = await store.readAfter(cursor, through, 256);
        if (!page.length) throw Error("Project replica log is incomplete");
        for (const event of page) {
          if (event.cursor !== cursor + 1)
            throw Error("Project replica log is incomplete");
          if (event.update.byteLength) {
            const imported = doc.import(event.update);
            for (const [peer, span] of imported.pending ?? [])
              pending.set(peer, Math.max(pending.get(peer) ?? 0, span.end));
          }
          cursor = event.cursor;
        }
      }
      const before = doc.version();
      try {
        for (const [peer, end] of pending)
          if ((before.get(peer) ?? 0) < end)
            throw Error("Project replica has unresolved dependencies");
        const result = await work(doc, tx);
        if (mutate) {
          doc.commit();
          await store.append(
            randomUUID(),
            doc.export({ mode: "update", from: before }),
          );
          await tx.query(
            "UPDATE project SET updated_at=CURRENT_TIMESTAMP WHERE id=$1",
            [projectId],
          );
        }
        return result;
      } finally {
        before.free();
      }
    } finally {
      doc.free();
    }
  });
}
