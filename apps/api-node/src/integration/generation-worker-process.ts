import { setTimeout as delay } from "node:timers/promises";
import { createCloudDurableRunCoordinator } from "@clash/shared-runtime/cloud-run-coordinator";
import { createBoundedRetryPolicy } from "@clash/shared-runtime/durable-run-engine";
import { openPostgres } from "../postgres.ts";
import { createPostgresRunJournal } from "../durable-run-journal.ts";
import { createNodeTaskRuntime } from "../task-runtime.ts";

const database = openPostgres({ connectionString: process.env.DATABASE_URL! });
const journal = createPostgresRunJournal(database.db);
const effect = async (operation: string) => {
  await database.db.query(
    "INSERT INTO test_effect(operation) VALUES ($1) ON CONFLICT DO NOTHING",
    [operation],
  );
};
const coordinator = createCloudDurableRunCoordinator({
  ownerId: "node",
  journal,
  provider: {
    submit: async () => {
      await effect("submit");
      return {
        status: "completed",
        outputs: [{ slot: "video", kind: "value", value: "result" }],
      };
    },
    poll: async () => {
      throw Error("Unexpected poll");
    },
  },
  outputStore: {
    stage: async () => {
      await database.db.query(
        "INSERT INTO test_attempt(operation) VALUES ('stage')",
      );
      await effect("stage");
      if (process.env.CRASH_STAGE === "yes") {
        process.send?.({ type: "stage" });
        await new Promise(() => {});
      }
      return { key: "immutable-video" };
    },
  },
  publisher: {
    publish: async () => {
      await effect("publish");
    },
    publishFailure: async () => {
      await effect("failed");
    },
  },
  attemptTimeoutMs: { stage: 1500 },
  retryPolicy: createBoundedRetryPolicy({
    maxFailures: { submit: 3, poll: 3, stage: 3, publish: 3 },
    baseDelayMs: 20,
    maxDelayMs: 100,
  }),
});
const runtime = createNodeTaskRuntime({
  connectionString: process.env.DATABASE_URL!,
  db: database.db,
  journal,
  coordinator,
  lockDuration: 1000,
  stalledInterval: 500,
});
let stopped = false;
process.once("SIGTERM", () => {
  stopped = true;
});
try {
  await runtime.start();
  process.send?.({ type: "ready" });
  while (!stopped) {
    await runtime.dispatchRuns();
    await delay(100);
  }
} finally {
  await runtime.close();
  await database.close();
}
