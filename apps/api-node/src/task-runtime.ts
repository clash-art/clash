import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { Worker as Thread } from "node:worker_threads";
import { Pool } from "pg";
import {
  FlowProducer,
  Queue,
  Worker,
  DelayedError,
  createPostgresBackend,
  runMigrations,
  type Job,
} from "bullmq";
import type {
  CloudDurableRunCoordinator,
  CloudDurableRunJournal,
} from "@clash/shared-runtime/cloud-run-coordinator";
import type {
  DurableRunIdentity,
  DurableRunRecord,
} from "@clash/shared-runtime/durable-run-engine";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import type { ReplicaNotificationPublisher } from "./replica-log.ts";
import { apiNodeLog, errorFacts } from "./log.ts";

const RUN_QUEUE = "cloud-generation";
const CHECKPOINT_QUEUE = "cloud-checkpoint";
type Stage = "provider" | "stage" | "publish";
interface RunTask {
  identity: DurableRunIdentity;
  stage: Stage;
}
const key = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const LIVE_JOB_STATES = new Set([
  "active",
  "waiting",
  "waiting-children",
  "delayed",
  "prioritized",
]);
const asError = (error: unknown, fallback: string): Error =>
  error instanceof Error ? error : Error(fallback, { cause: error });

/** Explicit deployment operation, never run by HTTP or worker startup. */
export async function migrateTaskQueue(
  connectionString: string,
): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    try {
      await runMigrations(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
function reached(run: DurableRunRecord, stage: Stage): boolean {
  if (
    run.phase === "succeeded" ||
    (run.phase === "failed" &&
      (run.projectedAt !== undefined ||
        (run.projectionFailure !== undefined &&
          run.nextAttemptAt === undefined &&
          !run.activeAttempt)))
  )
    return true;
  if (stage === "provider") return run.phase === "finalizing";
  if (stage === "stage")
    return run.phase === "finalizing" && run.stagedOutput !== undefined;
  return false;
}

/** BullMQ owns jobs/dependencies. The shared engine remains the only business state machine. */
export function createNodeTaskRuntime(options: {
  connectionString: string;
  db: PostgresTransactionPort;
  coordinator?: CloudDurableRunCoordinator;
  journal?: CloudDurableRunJournal;
  onError?: (error: Error) => void;
  lockDuration?: number;
  stalledInterval?: number;
  /** Job attempts per flow step; defaults to the production value. */
  attempts?: number;
  /** Recovery sweep cadence; defaults to the production value. */
  recoveryIntervalMs?: number;
}) {
  if (Boolean(options.coordinator) !== Boolean(options.journal))
    throw Error("Coordinator and journal must be supplied together");
  const connection = { connectionString: options.connectionString, max: 5 };
  const flows = new FlowProducer({ connection }, createPostgresBackend);
  const runs = new Queue(RUN_QUEUE, { connection }, createPostgresBackend);
  const snapshots = new Queue(
    CHECKPOINT_QUEUE,
    { connection },
    createPostgresBackend,
  );
  const workers: Array<Pick<Worker, "waitUntilReady" | "pause" | "close">> = [];
  const threads = new Set<Thread>();
  const onError =
    options.onError ??
    // Inspect the retained job and business journal.
    ((error: Error) =>
      apiNodeLog
        .child("task-runtime")
        .error("task_runtime.error", errorFacts(error)));
  flows.on("error", onError);
  runs.on("error", onError);
  snapshots.on("error", onError);
  const jobOptions = {
    attempts: options.attempts ?? 20,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: false,
    removeOnFail: false,
  };
  const recoveryIntervalMs = options.recoveryIntervalMs ?? 15_000;
  // A run has two BullMQ generations: the dispatch flow and one recovery
  // flow. The recovery ids are stable per identity, so concurrent sweeps on
  // several workers converge on the same jobs instead of stacking flows.
  const jobIdFor = (
    identity: DurableRunIdentity,
    stage: Stage,
    recovery = false,
  ) =>
    key(
      recovery
        ? [identity.actionRunId, identity.outputSlot, stage, "recovery"]
        : [identity.actionRunId, identity.outputSlot, stage],
    );
  // One construction for initial dispatch and recovery.
  const flowFor = (identity: DurableRunIdentity, recovery = false) => {
    const node = (stage: Stage) => ({
      name: stage,
      queueName: RUN_QUEUE,
      data: { identity, stage },
      opts: {
        ...jobOptions,
        jobId: jobIdFor(identity, stage, recovery),
        failParentOnFailure: true,
      },
    });
    return {
      ...node("publish"),
      children: [{ ...node("stage"), children: [node("provider")] }],
    };
  };
  const jobState = async (jobId: string) =>
    (await (await runs.getJob(jobId))?.getState()) ?? "missing";
  let started = false;
  const stopping = new AbortController();
  let dispatchLoop: Promise<void> | undefined;
  let recoveryLoop: Promise<void> | undefined;
  const checkpointPublisher: ReplicaNotificationPublisher = {
    async publish(event) {
      await snapshots.add("compact", event, {
        ...jobOptions,
        jobId: key(["checkpoint", event.projectId, event.cursor]),
      });
      // ACK means durable handoff to BullMQ, NOT snapshot coverage. Concurrent newer
      // offsets remain in the outbox through its cursor/lease fence.
    },
  };
  return {
    checkpointPublisher,
    async dispatchRuns() {
      if (!options.coordinator) return 0;
      return options.db.transaction(async (tx) => {
        const rows = await tx.query<{
          action_run_id: string;
          output_slot: string;
        }>(
          "SELECT action_run_id,output_slot FROM cloud_run_dispatch ORDER BY action_run_id,output_slot LIMIT 32 FOR UPDATE SKIP LOCKED",
        );
        for (const row of rows.rows) {
          const identity = {
            actionRunId: row.action_run_id,
            outputSlot: row.output_slot,
          };
          await flows.add(flowFor(identity));
          await tx.query(
            "DELETE FROM cloud_run_dispatch WHERE action_run_id=$1 AND output_slot=$2",
            [identity.actionRunId, identity.outputSlot],
          );
        }
        return rows.rows.length;
      });
    },
    async recoverRuns() {
      if (!options.coordinator || !options.journal) return 0;
      const journal = options.journal;
      const due = await options.coordinator.coordinate({
        type: "recoverable",
      });
      if (due.kind !== "recoverable") return 0;
      let scheduled = 0;
      for (const identity of due.identities) {
        // One rejected identity must not starve the rows after it; the row
        // stays due and the next sweep retries it.
        try {
          const run = await journal.load(identity);
          if (!run || reached(run, "publish")) continue;
          const recoveryJobId = jobIdFor(identity, "publish", true);
          const [baseState, recoveryState] = await Promise.all([
            jobState(jobIdFor(identity, "publish")),
            jobState(recoveryJobId),
          ]);
          if (
            LIVE_JOB_STATES.has(baseState) ||
            LIVE_JOB_STATES.has(recoveryState)
          )
            continue;
          if (recoveryState === "failed" || recoveryState === "completed") {
            // Each stage only advances the shared engine until it reaches its
            // phase, so reviving the publish job alone drives the run to a
            // terminal state (deadline_exceeded once deadlineAt has passed).
            try {
              await (await runs.getJob(recoveryJobId))!.retry(recoveryState, {
                resetAttemptsMade: true,
                resetAttemptsStarted: true,
              });
            } catch (error) {
              // Another worker's sweep revived it first: not a failure.
              if (LIVE_JOB_STATES.has(await jobState(recoveryJobId))) continue;
              throw error;
            }
          } else {
            await flows.add(flowFor(identity, true));
          }
          scheduled += 1;
        } catch (error) {
          onError(asError(error, "Run recovery failed"));
        }
      }
      return scheduled;
    },
    async start() {
      if (started) return;
      started = true;
      const settings = {
        connection,
        concurrency: 4,
        maxStalledCount: 10,
        ...(options.lockDuration ? { lockDuration: options.lockDuration } : {}),
        ...(options.stalledInterval
          ? { stalledInterval: options.stalledInterval }
          : {}),
      };
      if (options.coordinator && options.journal) {
        const coordinator = options.coordinator,
          journal = options.journal;
        const worker = new Worker(
          RUN_QUEUE,
          async (job: Job<RunTask>, token) => {
            const { identity, stage } = job.data;
            if (!["provider", "stage", "publish"].includes(stage))
              throw Error("Invalid generation stage");
            const before = await journal.load(identity);
            if (!before) throw Error("Missing generation journal");
            if (reached(before, stage)) return { phase: before.phase };
            const result = await coordinator.coordinate({
              type: "advance",
              identity,
            });
            if (
              result.kind === "terminal" ||
              (result.kind === "progressed" && reached(result.run, stage))
            )
              return { phase: result.run.phase };
            const wakeAt =
              result.kind === "waiting" ? result.wakeAt : Date.now() + 100;
            await job.moveToDelayed(Math.max(Date.now(), wakeAt), token);
            throw new DelayedError();
          },
          settings,
          createPostgresBackend,
        );
        worker.on("error", onError);
        worker.on("failed", (job, error) => {
          if (job) {
            const attempts = job.opts.attempts ?? 1;
            if (job.attemptsMade >= attempts)
              apiNodeLog
                .child("task-runtime")
                .error("task_runtime.run_attempts_exhausted", {
                  actionRunId: job.data.identity.actionRunId,
                  outputSlot: job.data.identity.outputSlot,
                  stage: job.data.stage,
                  attemptsMade: job.attemptsMade,
                  attempts,
                  ...errorFacts(error),
                });
          }
          onError(error);
        });
        workers.push(worker);
      }
      const snapshotWorker = new Worker(
        CHECKPOINT_QUEUE,
        async (job) => {
          return await new Promise<number>((resolve, reject) => {
            const thread = new Thread(
              new URL("./checkpoint-thread.ts", import.meta.url),
              {
                workerData: {
                  connectionString: options.connectionString,
                  ...job.data,
                },
                execArgv: ["--import", "tsx"],
              },
            );
            threads.add(thread);
            let settled = false;
            thread.once("message", (value) => {
              settled = true;
              if (typeof value === "number") resolve(value);
              else reject(Error("Checkpoint worker failed"));
            });
            thread.once("error", reject);
            thread.once("exit", () => {
              threads.delete(thread);
              if (!settled)
                reject(Error("Checkpoint thread exited before publication"));
            });
          });
        },
        { ...settings, concurrency: 1 },
        createPostgresBackend,
      );
      snapshotWorker.on("error", onError);
      snapshotWorker.on("failed", (_job, error) => onError(error));
      workers.push(snapshotWorker);
      await Promise.all(workers.map((w) => w.waitUntilReady()));
      if (options.coordinator && options.journal) {
        dispatchLoop = (async () => {
          while (!stopping.signal.aborted) {
            try {
              await this.dispatchRuns();
            } catch (error) {
              onError(asError(error, "Run dispatch failed"));
            }
            try {
              await delay(1000, undefined, { signal: stopping.signal });
            } catch {
              if (!stopping.signal.aborted)
                throw Error("Dispatch timer failed");
            }
          }
        })();
        recoveryLoop = (async () => {
          while (!stopping.signal.aborted) {
            try {
              await delay(recoveryIntervalMs, undefined, {
                signal: stopping.signal,
              });
            } catch {
              if (!stopping.signal.aborted)
                throw Error("Recovery timer failed");
              break;
            }
            try {
              await this.recoverRuns();
            } catch (error) {
              onError(asError(error, "Run recovery sweep failed"));
            }
          }
        })();
      }
    },
    async close() {
      stopping.abort();
      await Promise.all([dispatchLoop, recoveryLoop]);
      // Stop acquisition first; terminate CPU workers so a bounded shutdown can retry their jobs.
      await Promise.all(workers.map((w) => w.pause(true)));
      await Promise.all([...threads].map((t) => t.terminate()));
      await Promise.all(workers.map((w) => w.close()));
      await flows.close();
      await runs.close();
      await snapshots.close();
    },
  };
}
