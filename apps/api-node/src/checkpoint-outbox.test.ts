import { PGlite } from "@electric-sql/pglite";
import { LoroDoc } from "loro-crdt";
import { expect, it } from "vitest";
import { migrateDatabase } from "./migrations.ts";
import {
  createPostgresReplicaLog,
  createPostgresOutbox,
  dispatchOutboxBatch,
} from "./replica-log.ts";
import { buildProjectCheckpoint, loadProjectCheckpoint } from "./checkpoint.ts";

it("coalesces committed offsets into delayed durable work and preserves appends racing completion", async () => {
  const db = new PGlite();
  const doc = new LoroDoc();
  try {
    await migrateDatabase(db);
    const log = createPostgresReplicaLog(db, "p");
    const append = async (id: string) => {
      doc.getMap("m").set(id, true);
      doc.commit();
      return log.append({ id, update: doc.export({ mode: "update" }) });
    };
    await append("one");
    await append("two");
    const queue = createPostgresOutbox(db, "checkpoint");
    expect(await queue.claim({ limit: 1, leaseMs: 30000 })).toEqual([]);
    const queued = await db.query<{ cursor: string }>(
      "SELECT cursor FROM project_replica_outbox WHERE kind='checkpoint' AND project_id='p'",
    );
    expect(queued.rows.map((r) => Number(r.cursor))).toEqual([2]);
    await db.query(
      "UPDATE project_replica_outbox SET lease_until=CURRENT_TIMESTAMP - interval '1 second' WHERE kind='checkpoint'",
    );
    const lease = (await queue.claim({ limit: 1, leaseMs: 30000 }))[0]!;
    expect(lease.cursor).toBe(2);
    const covered = await buildProjectCheckpoint(db, "p");
    await append("three");
    expect(await queue.ack({ ...lease, cursor: covered! })).toBe(false);
    await db.query(
      "UPDATE project_replica_outbox SET lease_until=CURRENT_TIMESTAMP - interval '1 second' WHERE kind='checkpoint'",
    );
    const restarted = createPostgresOutbox(db, "checkpoint");
    const retried = (await restarted.claim({ limit: 1, leaseMs: 30000 }))[0]!;
    expect(await queue.ack(lease)).toBe(false);
    const next = await buildProjectCheckpoint(db, "p");
    expect(await restarted.ack({ ...retried, cursor: next! })).toBe(true);
    expect((await loadProjectCheckpoint(db, "p"))?.cursor).toBe(3);
    expect(await log.readAfter(0)).toHaveLength(3);
    await append("four");
    await db.query(
      "UPDATE project_replica_outbox SET lease_until=CURRENT_TIMESTAMP - interval '1 second' WHERE kind='checkpoint'",
    );
    expect(
      (
        await dispatchOutboxBatch(
          restarted,
          {
            publish: async () => {
              throw Error("compute failed");
            },
          },
          { limit: 1, leaseMs: 30000 },
        )
      ).failed,
    ).toBe(1);
    expect(
      (
        await db.query(
          "SELECT cursor FROM project_replica_outbox WHERE kind='checkpoint'",
        )
      ).rows,
    ).not.toEqual([]);
    await db.query(
      "ALTER TABLE project_replica_outbox ADD CONSTRAINT reject_checkpoint_test CHECK (kind <> 'checkpoint' OR project_id <> 'rollback-checkpoint') NOT VALID",
    );
    const rollback = createPostgresReplicaLog(db, "rollback-checkpoint");
    await expect(
      rollback.append({
        id: "retry",
        update: doc.export({ mode: "snapshot" }),
      }),
    ).rejects.toThrow();
    expect(await rollback.readAfter(0)).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT cursor FROM project_replica_outbox WHERE project_id='rollback-checkpoint'",
        )
      ).rows,
    ).toEqual([]);
    await db.query(
      "ALTER TABLE project_replica_outbox DROP CONSTRAINT reject_checkpoint_test",
    );
    expect(
      (
        await rollback.append({
          id: "retry",
          update: doc.export({ mode: "snapshot" }),
        })
      ).event.cursor,
    ).toBe(1);
  } finally {
    doc.free();
    await db.close();
  }
});
