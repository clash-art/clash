import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createNodeTaskRuntime } from "./task-runtime.ts";
import { databaseUrl } from "./config.ts";
import { openPostgres } from "./postgres.ts";
import {
  createPostgresNotificationPublisher,
  createPostgresOutbox,
  dispatchOutboxBatch,
  type ReplicaOutbox,
  type ReplicaNotificationPublisher,
} from "./replica-log.ts";

export async function runOutboxWorker(options: {
  outbox: ReplicaOutbox;
  publisher: ReplicaNotificationPublisher;
  signal: AbortSignal;
  onError?: () => void;
  claim?: { limit: number; leaseMs: number };
}): Promise<void> {
  while (!options.signal.aborted) {
    let pause = true;
    try {
      const result = await dispatchOutboxBatch(
        options.outbox,
        options.publisher,
        { limit: 32, leaseMs: 30000, ...options.claim, signal: options.signal },
      );
      pause = result.published === 0 || result.failed > 0 || result.stale > 0;
      if (result.failed > 0) options.onError?.();
    } catch {
      options.onError?.();
    }
    if (pause && !options.signal.aborted) {
      try {
        await delay(1000, undefined, { signal: options.signal });
      } catch (error) {
        if (!options.signal.aborted) throw error;
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => stop.abort());
  try {
    const database = openPostgres({
      connectionString: databaseUrl(process.env),
    });
    const tasks = createNodeTaskRuntime({
      connectionString: databaseUrl(process.env),
      db: database.db,
    });
    try {
      await tasks.start();
      await Promise.all([
        runOutboxWorker({
          outbox: createPostgresOutbox(database.db),
          publisher: createPostgresNotificationPublisher(database.db),
          signal: stop.signal,
          onError: () =>
            console.error(
              "Replica notification failed; queued work will retry",
            ),
        }),
        runOutboxWorker({
          outbox: createPostgresOutbox(database.db, "checkpoint"),
          publisher: tasks.checkpointPublisher,
          signal: stop.signal,
          claim: { limit: 1, leaseMs: 300000 },
          onError: () =>
            console.error(
              "Checkpoint task failed; queued work and log retained for retry",
            ),
        }),
      ]);
    } finally {
      await tasks.close();
      await database.close();
    }
  } catch {
    console.error("Replica outbox worker failed");
    process.exitCode = 1;
  }
}
