import {
  metrics,
  type Counter,
  type Histogram,
  type Meter,
} from "@opentelemetry/api";
import type { DurableRunRecord } from "@clash/shared-runtime/durable-run-engine";
import type { PostgresQueryPort } from "@clash/shared-runtime/project-authorization-postgres";

/**
 * api-node business metrics on the OTel Metrics API. Attributes are bounded
 * enums only: never project, run or user identifiers.
 *
 * Instruments are created on first use, not at import: the metrics API has no
 * proxy provider, so a meter taken before the NodeSDK bootstrap registers its
 * MeterProvider would stay a no-op for the life of the process.
 */
interface Instruments {
  outboxDispatched: Counter;
  generationDuration: Histogram;
  budgetRolled: Counter;
  budgetRolloverLag: Histogram;
}

let instruments: Instruments | undefined;

function meter(): Meter {
  return metrics.getMeter("@clash/api-node");
}

function current(): Instruments {
  return (instruments ??= {
    outboxDispatched: meter().createCounter("clash.outbox.dispatched", {
      description: "Outbox items handled per claim, by queue and outcome.",
      unit: "{item}",
    }),
    generationDuration: meter().createHistogram("clash.generation.duration", {
      description: "Durable generation runs from creation to a terminal phase.",
      unit: "s",
    }),
    budgetRolled: meter().createCounter("clash.gateway.budget.rolled", {
      description: "Gateway budgets moved into a new period.",
      unit: "{budget}",
    }),
    budgetRolloverLag: meter().createHistogram(
      "clash.gateway.budget.rollover_lag",
      {
        description: "Seconds the oldest rolled budget was past reset_at, per tick.",
        unit: "s",
      },
    ),
  });
}

/** Test hook: drop cached instruments after swapping the global provider. */
export function resetMetricsForTest(): void {
  instruments = undefined;
}

export type OutboxQueue = "notification" | "checkpoint";

export function recordOutboxDispatch(
  queue: OutboxQueue,
  result: { published: number; failed: number; stale: number },
): void {
  for (const outcome of ["published", "failed", "stale"] as const)
    if (result[outcome] > 0)
      current().outboxDispatched.add(result[outcome], {
        "clash.outbox.queue": queue,
        "clash.outbox.outcome": outcome,
      });
}

/**
 * Report pending outbox rows per queue as an observable gauge. The count is
 * read once per metric export interval, only while a reader is attached.
 * Call after telemetry bootstrap (process start), for the reason above.
 */
export function observeOutboxBacklog(db: PostgresQueryPort): void {
  meter()
    .createObservableGauge("clash.outbox.backlog", {
      description: "Rows waiting in project_replica_outbox, by queue.",
      unit: "{item}",
    })
    .addCallback(async (observer) => {
      const { rows } = await db.query<{
        kind: string;
        pending: string | number;
      }>(
        "SELECT kind, count(*) AS pending FROM project_replica_outbox GROUP BY kind",
      );
      for (const row of rows)
        observer.observe(Number(row.pending), {
          "clash.outbox.queue": row.kind,
        });
    });
}

const TERMINAL = new Set<DurableRunRecord["phase"]>(["succeeded", "failed"]);

/** Record a run's terminal transition; non-terminal or repeated writes are ignored. */
export function recordGenerationTransition(
  previous: Pick<DurableRunRecord, "phase">,
  next: Pick<DurableRunRecord, "phase" | "createdAt" | "updatedAt">,
): void {
  if (TERMINAL.has(previous.phase) || !TERMINAL.has(next.phase)) return;
  current().generationDuration.record(
    Math.max(0, next.updatedAt - next.createdAt) / 1000,
    { "clash.generation.outcome": next.phase },
  );
}

let lastRolloverBacklog = 0;
let rolloverBacklogObserved = false;

/** Record one rollover tick: rolled count, lag, and the due backlog gauge. */
export function recordBudgetRollover(result: {
  rolled: number;
  backlog: number;
  maxLagS: number;
}): void {
  if (result.rolled > 0) {
    current().budgetRolled.add(result.rolled);
    current().budgetRolloverLag.record(result.maxLagS);
  }
  lastRolloverBacklog = result.backlog;
  if (!rolloverBacklogObserved) {
    rolloverBacklogObserved = true;
    meter()
      .createObservableGauge("clash.gateway.budget.rollover_backlog", {
        description: "Gateway budgets past reset_at after the last tick.",
        unit: "{budget}",
      })
      .addCallback((observer) => observer.observe(lastRolloverBacklog));
  }
}
