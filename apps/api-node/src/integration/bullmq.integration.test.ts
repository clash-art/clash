import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { createCloudDurableRunCoordinator } from "@clash/shared-runtime/cloud-run-coordinator";
import { createBoundedRetryPolicy } from "@clash/shared-runtime/durable-run-engine";
import { openPostgres } from "../postgres.ts";
import { migrateDatabase } from "../migrations.ts";
import { createPostgresRunJournal } from "../durable-run-journal.ts";
import { migrateTaskQueue, createNodeTaskRuntime } from "../task-runtime.ts";
import {
  createPostgresReplicaLog,
  createPostgresOutbox,
  dispatchOutboxBatch,
} from "../replica-log.ts";
import { loadProjectCheckpoint } from "../checkpoint-store.ts";

async function until(check: () => Promise<boolean>, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(25);
  }
  throw Error("Condition did not become true");
}
it("runs shared generation phases and checkpoint work through real PG BullMQ with two workers", async () => {
  const input = process.env.CLUSTER_POSTGRES_URL;
  if (!input) throw Error("Use the disposable PostgreSQL runner");
  const url = new URL(input);
  if (!["localhost", "127.0.0.1"].includes(url.hostname))
    throw Error("Loopback only");
  const admin = new Pool({ connectionString: input });
  const name = `bull_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const database = openPostgres({ connectionString: url.href });
  const db = database.db;
  const runtimes: ReturnType<typeof createNodeTaskRuntime>[] = [];
  const doc = new LoroDoc();
  try {
    await migrateDatabase(db);
    await migrateTaskQueue(url.href);
    const journal = createPostgresRunJournal(db);
    const effects: string[] = [];
    const errors: Error[] = [];
    let projectionAttempts = 0;
    let polls = 0;
    const coordinator = createCloudDurableRunCoordinator({
      ownerId: "node",
      journal,
      provider: {
        submit: async ({ run }) => {
          if (run.actionRunId === "failed-run")
            return {
              status: "failed",
              error: {
                code: "invalid_request",
                retryable: false,
                requestState: "rejected",
                message: "Rejected input",
              },
            };
          effects.push("submit");
          return {
            status: "accepted",
            pollState: { id: "provider-1" },
            retryAfterMs: 150,
          };
        },
        poll: async () => {
          polls++;
          return polls < 2
            ? {
                status: "accepted",
                pollState: { id: "provider-1" },
                retryAfterMs: 150,
              }
            : {
                status: "completed",
                outputs: [
                  {
                    slot: "video",
                    kind: "value",
                    value: "video-bytes-reference",
                  },
                ],
              };
        },
      },
      outputStore: {
        stage: async () => {
          effects.push("stage");
          return { key: "immutable-object" };
        },
      },
      publisher: {
        publish: async () => {
          effects.push("publish");
        },
        publishFailure: async () => {
          if (++projectionAttempts === 1)
            throw Error("Temporary projection outage");
          effects.push("failure");
        },
      },
      retryPolicy: createBoundedRetryPolicy({
        maxFailures: { submit: 2, poll: 2, stage: 2, publish: 2 },
        baseDelayMs: 20,
        maxDelayMs: 100,
      }),
    });
    for (let i = 0; i < 2; i++) {
      const runtime = createNodeTaskRuntime({
        connectionString: url.href,
        db,
        coordinator,
        journal,
        onError: (error) => errors.push(error),
      });
      runtimes.push(runtime);
      await runtime.start();
    }
    const identity = { actionRunId: "video-run", outputSlot: "video" };
    await coordinator.coordinate({
      type: "create",
      ...identity,
      executorInput: {},
      deadlineAt: Date.now() + 30000,
    });
    await runtimes[0]!.dispatchRuns();
    // Simulate a dispatch process dying after Flow creation but before outbox ACK.
    await db.query(
      "INSERT INTO cloud_run_dispatch(action_run_id,output_slot) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [identity.actionRunId, identity.outputSlot],
    );
    await runtimes[1]!.dispatchRuns();
    await until(
      async () => (await journal.load(identity))?.phase === "succeeded",
    );
    expect(effects).toEqual(["submit", "stage", "publish"]);
    expect(polls).toBeGreaterThan(1);
    const failedIdentity = { actionRunId: "failed-run", outputSlot: "video" };
    await coordinator.coordinate({
      type: "create",
      ...failedIdentity,
      executorInput: {},
      deadlineAt: Date.now() + 30000,
    });
    await until(
      async () =>
        (await journal.load(failedIdentity))?.projectedAt !== undefined,
    );
    expect((await journal.load(failedIdentity))?.phase).toBe("failed");
    expect(effects).toEqual(["submit", "stage", "publish", "failure"]);
    expect(projectionAttempts).toBeGreaterThan(1);
    doc.getMap("m").set("first", true);
    doc.commit();
    const log = createPostgresReplicaLog(db, "project");
    await log.append({ id: "first", update: doc.export({ mode: "update" }) });
    await db.query(
      "UPDATE project_replica_outbox SET lease_until=CURRENT_TIMESTAMP WHERE kind='checkpoint'",
    );
    await dispatchOutboxBatch(
      createPostgresOutbox(db, "checkpoint"),
      runtimes[0]!.checkpointPublisher,
      { limit: 1, leaseMs: 10000 },
    );
    doc.getMap("m").set("tail", true);
    doc.commit();
    await log.append({ id: "tail", update: doc.export({ mode: "update" }) });
    await db.query(
      "UPDATE project_replica_outbox SET lease_until=CURRENT_TIMESTAMP WHERE kind='checkpoint' AND lease_id IS NULL",
    );
    await dispatchOutboxBatch(
      createPostgresOutbox(db, "checkpoint"),
      runtimes[1]!.checkpointPublisher,
      { limit: 1, leaseMs: 10000 },
    );
    await until(
      async () => (await loadProjectCheckpoint(db, "project"))?.cursor === 2,
    );
    const snapshot = await loadProjectCheckpoint(db, "project");
    const restored = new LoroDoc();
    try {
      restored.import(snapshot!.data);
      expect(restored.toJSON()).toEqual(doc.toJSON());
    } finally {
      restored.free();
    }
    // A storage failure must retry the handed-off job, without requiring a new append.
    await db.query(
      "ALTER TABLE project_replica_checkpoint ADD CONSTRAINT reject_transient CHECK (project_id <> 'transient')",
    );
    await createPostgresReplicaLog(db, "transient").append({
      id: "retry",
      update: doc.export({ mode: "update" }),
    });
    await db.query(
      "UPDATE project_replica_outbox SET lease_until=CURRENT_TIMESTAMP WHERE kind='checkpoint' AND lease_id IS NULL",
    );
    await dispatchOutboxBatch(
      createPostgresOutbox(db, "checkpoint"),
      runtimes[0]!.checkpointPublisher,
      { limit: 10, leaseMs: 10000 },
    );
    await until(async () => errors.length > 0);
    expect(await loadProjectCheckpoint(db, "transient")).toBeNull();
    await db.query(
      "ALTER TABLE project_replica_checkpoint DROP CONSTRAINT reject_transient",
    );
    await until(
      async () => (await loadProjectCheckpoint(db, "transient"))?.cursor === 1,
    );
    // A duplicate old intent after a newer snapshot cannot regress its cursor.
    await runtimes[0]!.checkpointPublisher.publish({
      projectId: "project",
      cursor: 1,
    });
    expect((await loadProjectCheckpoint(db, "project"))?.cursor).toBe(2);
  } finally {
    await Promise.all(runtimes.map((r) => r.close()));
    doc.free();
    await database.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});

it("recovers a killed stage worker without replaying completed Provider work", async () => {
  const input = process.env.CLUSTER_POSTGRES_URL!;
  const url = new URL(input);
  if (!["localhost", "127.0.0.1"].includes(url.hostname))
    throw Error("Loopback only");
  const admin = new Pool({ connectionString: input });
  const name = `crash_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const database = openPostgres({ connectionString: url.href });
  const children: ChildProcess[] = [];
  let output = "";
  const launch = (crash: boolean) => {
    const child = fork(
      new URL("./generation-worker-process.ts", import.meta.url),
      [],
      {
        execArgv: ["--import", "tsx"],
        env: {
          ...process.env,
          DATABASE_URL: url.href,
          CRASH_STAGE: crash ? "yes" : "no",
          TSX_TSCONFIG_PATH: new URL(
            "../../tsconfig.check.json",
            import.meta.url,
          ).pathname,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.push(child);
    child.stderr?.on("data", (d) => {
      output += String(d);
    });
    return child;
  };
  try {
    await migrateDatabase(database.db);
    await migrateTaskQueue(url.href);
    await database.db.query(
      "CREATE TABLE test_effect(operation text PRIMARY KEY)",
    );
    await database.db.query("CREATE TABLE test_attempt(operation text)");
    const journal = createPostgresRunJournal(database.db);
    const identity = { actionRunId: "crash-video", outputSlot: "video" };
    await journal.create({
      schemaVersion: 1,
      ...identity,
      owner: { realm: "cloud", id: "node" },
      executorInput: {},
      revision: 0,
      phase: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deadlineAt: Date.now() + 60000,
      attemptCounts: { submit: 0, poll: 0, stage: 0, publish: 0 },
      failureCounts: { submit: 0, poll: 0, stage: 0, publish: 0 },
    });
    const first = launch(true);
    await until(
      async () =>
        (
          await database.db.query(
            "SELECT * FROM test_effect WHERE operation='stage'",
          )
        ).rows.length > 0,
    );
    const exited = once(first, "exit");
    first.kill("SIGKILL");
    await exited;
    launch(false);
    await until(
      async () => (await journal.load(identity))?.phase === "succeeded",
      30000,
    );
    expect(
      (
        await database.db.query(
          "SELECT operation FROM test_effect ORDER BY operation",
        )
      ).rows,
    ).toEqual([
      { operation: "publish" },
      { operation: "stage" },
      { operation: "submit" },
    ]);
    expect((await journal.load(identity))?.attemptCounts.submit).toBe(1);
    expect(
      (await database.db.query("SELECT * FROM test_attempt")).rows.length,
    ).toBeGreaterThan(1);
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    await database.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
