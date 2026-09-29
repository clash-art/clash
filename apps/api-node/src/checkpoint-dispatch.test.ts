import { PGlite } from "@electric-sql/pglite";
import { LoroDoc } from "loro-crdt";
import { expect, it } from "vitest";
import { migrateDatabase } from "./migrations.ts";
import { createPostgresReplicaLog } from "./replica-log.ts";
import { loadProjectCheckpoint } from "./checkpoint.ts";
import { createCheckpointPublisher } from "./checkpoint.ts";
import { createPostgresOutbox, dispatchOutboxBatch } from "./replica-log.ts";
it("checkpoints dirty projects while isolating a corrupt project and retaining replay history", async () => {
  const db = new PGlite();
  const doc = new LoroDoc();
  try {
    await migrateDatabase(db);
    await createPostgresReplicaLog(db, "bad").append({
      id: "bad",
      update: new Uint8Array([255, 0]),
    });
    doc.getMap("metadata").set("name", "Durable project");
    doc.commit();
    const good = createPostgresReplicaLog(db, "good");
    const saved = await good.append({
      id: "good",
      update: doc.export({ mode: "update" }),
    });
    await db.query(
      "UPDATE project_replica_outbox SET lease_until=CURRENT_TIMESTAMP - interval '1 second' WHERE kind='checkpoint'",
    );
    await dispatchOutboxBatch(
      createPostgresOutbox(db, "checkpoint"),
      createCheckpointPublisher(db),
      { limit: 16, leaseMs: 30000 },
    );
    expect(await loadProjectCheckpoint(db, "bad")).toBeNull();
    expect((await loadProjectCheckpoint(db, "good"))?.cursor).toBe(
      saved.event.cursor,
    );
    expect(await good.readAfter(0)).toEqual([saved.event]);
  } finally {
    doc.free();
    await db.close();
  }
});
