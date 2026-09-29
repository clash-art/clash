import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { migrateDatabase } from "./migrations.ts";
import {
  createPostgresReplicaLog,
  createPostgresOutbox,
  dispatchOutboxBatch,
} from "./replica-log.ts";

it("atomically persists binary updates with outbox, deduplicates retries and replays per project", async () => {
  const db = new PGlite();
  try {
    await migrateDatabase(db);
    const a = createPostgresReplicaLog(db, "a");
    const b = createPostgresReplicaLog(db, "b");
    const bytes = new Uint8Array([0, 255, 1, 128]);
    const first = await a.append({ id: "one", update: bytes });
    const retry = await a.append({ id: "one", update: bytes });
    expect(retry).toEqual({ ...first, appended: false });
    await expect(
      a.append({ id: "one", update: new Uint8Array([2]) }),
    ).rejects.toThrow("Idempotency");
    const second = await a.append({ id: "two", update: new Uint8Array([3]) });
    await b.append({ id: "one", update: new Uint8Array([4]) });
    const reopened = createPostgresReplicaLog(db, "a");
    expect(await reopened.readAfter(first.event.cursor)).toEqual([
      second.event,
    ]);
    expect((await reopened.readAfter(0))[0]?.update).toEqual(bytes);
    const outbox = createPostgresOutbox(db);
    const deliveries = await outbox.claim({ limit: 20, leaseMs: 30000 });
    expect(deliveries.map((x) => [x.projectId, x.cursor])).toEqual(
      expect.arrayContaining([
        ["a", first.event.cursor],
        ["a", second.event.cursor],
      ]),
    );
    expect(
      deliveries
        .filter((x) => x.projectId === "a" && x.cursor === first.event.cursor)
        .map((x) => x.cursor),
    ).toEqual([first.event.cursor]);
  } finally {
    await db.close();
  }
});

it("does not acknowledge an append when its outbox write fails, and recovers without a cursor gap", async () => {
  const db = new PGlite();
  try {
    await migrateDatabase(db);
    const log = createPostgresReplicaLog(db, "rollback");
    const first = await log.append({
      id: "first",
      update: new Uint8Array([1]),
    });
    await db.exec(
      "ALTER TABLE project_replica_outbox ADD CONSTRAINT reject_test CHECK (project_id <> 'rollback') NOT VALID",
    );
    await expect(
      log.append({ id: "failed", update: new Uint8Array([2]) }),
    ).rejects.toThrow();
    expect(await log.readAfter(first.event.cursor)).toEqual([]);
    await db.exec(
      "ALTER TABLE project_replica_outbox DROP CONSTRAINT reject_test",
    );
    const recovered = await log.append({
      id: "failed",
      update: new Uint8Array([2]),
    });
    expect(recovered.event.cursor).toBe(first.event.cursor + 1);
  } finally {
    await db.close();
  }
});

it("keeps failed publishes replayable and fences late acknowledgements after a lease is reclaimed", async () => {
  const db = new PGlite();
  try {
    await migrateDatabase(db);
    const log = createPostgresReplicaLog(db, "p");
    const outbox = createPostgresOutbox(db);
    const saved = await log.append({ id: "one", update: new Uint8Array([1]) });
    const old = (await outbox.claim({ limit: 1, leaseMs: 30000 }))[0]!;
    expect(await outbox.claim({ limit: 1, leaseMs: 30000 })).toEqual([]);
    await db.exec(
      "UPDATE project_replica_outbox SET lease_until=CURRENT_TIMESTAMP - interval '1 second'",
    );
    const newer = (await outbox.claim({ limit: 1, leaseMs: 30000 }))[0]!;
    expect(await outbox.ack(old)).toBe(false);
    expect(await outbox.ack(newer)).toBe(true);
    await log.append({ id: "two", update: new Uint8Array([2]) });
    const failed = await dispatchOutboxBatch(
      outbox,
      {
        publish: async () => {
          throw Error("bus offline");
        },
      },
      { limit: 10, leaseMs: 30000 },
    );
    expect(failed.failed).toBe(1);
    expect((await log.readAfter(saved.event.cursor))[0]?.id).toBe("two");
    await db.exec(
      "UPDATE project_replica_outbox SET lease_until=CURRENT_TIMESTAMP - interval '1 second'",
    );
    const published: Array<{ projectId: string; cursor: number }> = [];
    await dispatchOutboxBatch(
      outbox,
      {
        publish: async (event) => {
          published.push(event);
        },
      },
      { limit: 10, leaseMs: 30000 },
    );
    expect(published).toEqual([
      { projectId: "p", cursor: saved.event.cursor + 1 },
    ]);
    expect(await outbox.claim({ limit: 10, leaseMs: 30000 })).toEqual([]);
  } finally {
    await db.close();
  }
});

it("wakes PG listeners with a cursor while keeping event bytes available for replay", async () => {
  const { createPostgresNotificationPublisher, REPLICA_NOTIFICATION_CHANNEL } =
    await import("./replica-log.ts");
  const db = new PGlite();
  try {
    await migrateDatabase(db);
    const notifications: string[] = [];
    const stop = await db.listen(REPLICA_NOTIFICATION_CHANNEL, (payload) => {
      notifications.push(payload);
    });
    const log = createPostgresReplicaLog(db, "notify");
    const event = await log.append({
      id: "event",
      update: new Uint8Array([1, 255]),
    });
    await dispatchOutboxBatch(
      createPostgresOutbox(db),
      createPostgresNotificationPublisher(db),
      { limit: 10, leaseMs: 30000 },
    );
    expect(notifications.map((text) => JSON.parse(text))).toEqual([
      { projectId: "notify", cursor: event.event.cursor },
    ]);
    expect((await log.readAfter(0))[0]?.update).toEqual(
      new Uint8Array([1, 255]),
    );
    await stop();
  } finally {
    await db.close();
  }
});

it("recovers committed bytes and unacknowledged delivery after closing and reopening the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clash-replica-log-"));
  let db = new PGlite(directory);
  try {
    await migrateDatabase(db);
    const saved = await createPostgresReplicaLog(db, "restart").append({
      id: "durable",
      update: new Uint8Array([0, 128, 255]),
    });
    await db.close();
    db = new PGlite(directory);
    expect(await createPostgresReplicaLog(db, "restart").readAfter(0)).toEqual([
      saved.event,
    ]);
    const leases = await createPostgresOutbox(db).claim({
      limit: 10,
      leaseMs: 30000,
    });
    expect(
      leases.map((x) => ({ projectId: x.projectId, cursor: x.cursor })),
    ).toEqual([{ projectId: "restart", cursor: saved.event.cursor }]);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
