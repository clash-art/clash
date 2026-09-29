import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { migrateDatabase } from "./migrations.ts";
import {
  createPostgresOutbox,
  createPostgresReplicaLog,
} from "./replica-log.ts";
import { runOutboxWorker } from "./outbox-worker.ts";
it("publishes queued work and shuts down without deleting unprocessed leases", async () => {
  const db = new PGlite();
  const stop = new AbortController();
  try {
    await migrateDatabase(db);
    const log = createPostgresReplicaLog(db, "worker");
    await log.append({ id: "one", update: new Uint8Array([1]) });
    const second = await log.append({ id: "two", update: new Uint8Array([2]) });
    const delivered: string[] = [];
    await runOutboxWorker({
      outbox: createPostgresOutbox(db),
      publisher: {
        publish: async (event) => {
          delivered.push(event.projectId);
          stop.abort();
        },
      },
      signal: stop.signal,
    });
    expect(delivered).toEqual(["worker"]);
    await db.exec(
      "UPDATE project_replica_outbox SET lease_until=CURRENT_TIMESTAMP - interval '1 second'",
    );
    const remaining = await createPostgresOutbox(db).claim({
      limit: 10,
      leaseMs: 30000,
    });
    expect(remaining.map((x) => x.cursor)).toEqual([second.event.cursor]);
  } finally {
    await db.close();
  }
});
