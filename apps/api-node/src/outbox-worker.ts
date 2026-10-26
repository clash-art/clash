import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createNodeTaskRuntime, routeRunCoordinators } from "./task-runtime.ts";
import { createPostgresRunJournal } from "./durable-run-journal.ts";
import {
  NODE_GATEWAY_SETTLE_OWNER,
  createNodeGatewaySettleCoordinator,
} from "./gateway-settle.ts";
import { NODE_GENERATION_OWNER } from "./generation.ts";
import { databaseUrl, publicUrl, renderServerUrl } from "./config.ts";
import { createHttpRenderServerPort } from "@clash/shared-runtime/render-server";
import { createFsAssetDeliveryStore } from "@clash/shared-runtime/fs-asset-delivery-store";
import { sweepFsProjectAssetImportStaging } from "@clash/shared-runtime/fs-import-staging-sweep";
import { createNodeTimelineRenderService } from "./timeline-render.ts";
import { openPostgres } from "./postgres.ts";
import {
  createPostgresNotificationPublisher,
  createPostgresOutbox,
  dispatchOutboxBatch,
  type ReplicaOutbox,
  type ReplicaNotificationPublisher,
} from "./replica-log.ts";
import { shutdownNodeTelemetry } from "@clash/shared-telemetry/node";
import { apiNodeLog, errorFacts } from "./log.ts";
import {
  observeOutboxBacklog,
  recordOutboxDispatch,
  type OutboxQueue,
} from "./metrics.ts";

const log = apiNodeLog.child("outbox-worker");
const IMPORT_STAGING_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Periodically remove abandoned chunked-import staging from the asset disk. */
export async function runProjectAssetImportStagingSweep(options: {
  assetDirectory: string;
  signal: AbortSignal;
  intervalMs?: number;
}): Promise<void> {
  // Same root as the import-session routes in project-assets.ts.
  const store = createFsAssetDeliveryStore(
    join(resolve(options.assetDirectory), "import-sessions"),
  );
  const intervalMs = options.intervalMs ?? IMPORT_STAGING_SWEEP_INTERVAL_MS;
  while (!options.signal.aborted) {
    await sweepFsProjectAssetImportStaging(store, log);
    try {
      await delay(intervalMs, undefined, { signal: options.signal });
    } catch (error) {
      if (!options.signal.aborted) throw error;
    }
  }
}

export async function runOutboxWorker(options: {
  outbox: ReplicaOutbox;
  publisher: ReplicaNotificationPublisher;
  signal: AbortSignal;
  onError?: (error?: Error) => void;
  /** Metric label for this outbox; defaults to the notification queue. */
  queue?: OutboxQueue;
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
      recordOutboxDispatch(options.queue ?? "notification", result);
      pause = result.published === 0 || result.failed > 0 || result.stale > 0;
      if (result.failed > 0) options.onError?.();
    } catch (error) {
      options.onError?.(
        error instanceof Error
          ? error
          : Error("Outbox dispatch failed", { cause: error }),
      );
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
    // `on`, not `once`: a remaining listener keeps tsx's hidden signal
    // handler from exiting before the workers drain.
    process.on(signal, () => stop.abort());
  try {
    const database = openPostgres({
      connectionString: databaseUrl(process.env),
    });
    observeOutboxBacklog(database.pool);
    // Timeline renders run here when RENDER_SERVER_URL is set; otherwise the
    // API answers request_timeline_render with 501 and no runs are queued.
    const renderOrigin = renderServerUrl(process.env);
    const assetDirectory = process.env.CLOUD_ASSET_DIR ?? "data/assets";
    const render = renderOrigin
      ? createNodeTimelineRenderService(database.db, {
          renderServer: createHttpRenderServerPort(renderOrigin),
          mediaSecret: process.env.BETTER_AUTH_SECRET!,
          publicUrl: publicUrl(process.env),
          assetDirectory,
        })
      : undefined;
    // Gateway settle runs (#399, N2) always run here: the api role journals
    // them with their outbox row, this runtime delivers and recovers them.
    const journal = createPostgresRunJournal(database.db);
    const tasks = createNodeTaskRuntime({
      connectionString: databaseUrl(process.env),
      db: database.db,
      journal,
      coordinator: routeRunCoordinators(journal, {
        [NODE_GATEWAY_SETTLE_OWNER]: createNodeGatewaySettleCoordinator({
          db: database.db,
          journal,
        }),
        ...(render ? { [NODE_GENERATION_OWNER]: render.coordinator } : {}),
      }),
    });
    try {
      await tasks.start();
      await Promise.all([
        runOutboxWorker({
          outbox: createPostgresOutbox(database.db),
          publisher: createPostgresNotificationPublisher(database.db),
          signal: stop.signal,
          // Queued work will retry.
          onError: (error) =>
            log.error("outbox.dispatch_failed", {
              queue: "notification",
              ...(error ? errorFacts(error) : {}),
            }),
        }),
        runOutboxWorker({
          outbox: createPostgresOutbox(database.db, "checkpoint"),
          publisher: tasks.checkpointPublisher,
          signal: stop.signal,
          queue: "checkpoint",
          claim: { limit: 1, leaseMs: 300000 },
          // Queued work and log are retained for retry.
          onError: (error) =>
            log.error("outbox.dispatch_failed", {
              queue: "checkpoint",
              ...(error ? errorFacts(error) : {}),
            }),
        }),
        runProjectAssetImportStagingSweep({
          assetDirectory,
          signal: stop.signal,
        }),
      ]);
    } finally {
      await tasks.close();
      await database.close();
    }
  } catch (error) {
    log.error("outbox.worker_failed", errorFacts(error));
    process.exitCode = 1;
  } finally {
    await shutdownNodeTelemetry();
  }
}
