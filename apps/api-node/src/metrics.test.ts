import { PGlite } from "@electric-sql/pglite";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migrations.ts";
import {
  observeOutboxBacklog,
  recordGenerationTransition,
  recordOutboxDispatch,
  resetMetricsForTest,
} from "./metrics.ts";
import { createPostgresReplicaLog } from "./replica-log.ts";

let exporter: InMemoryMetricExporter;
let reader: PeriodicExportingMetricReader;
let provider: MeterProvider;

beforeEach(() => {
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 3_600_000,
  });
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  resetMetricsForTest();
});

afterEach(async () => {
  await provider.shutdown();
  metrics.disable();
  resetMetricsForTest();
});

async function collected(name: string): Promise<MetricData | undefined> {
  await reader.forceFlush();
  return exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name)
    .at(-1);
}

describe("recordGenerationTransition", () => {
  const run = { createdAt: 1_000, updatedAt: 4_000 };

  it("records the creation-to-terminal duration once, on entering a terminal phase", async () => {
    recordGenerationTransition({ phase: "queued" }, { phase: "polling", ...run });
    recordGenerationTransition({ phase: "polling" }, { phase: "succeeded", ...run });
    // A later write to an already terminal run must not count again.
    recordGenerationTransition({ phase: "succeeded" }, { phase: "succeeded", ...run });

    const metric = await collected("clash.generation.duration");
    expect(metric?.dataPoints).toHaveLength(1);
    const point = metric!.dataPoints[0]!;
    expect(point.attributes).toEqual({ "clash.generation.outcome": "succeeded" });
    expect(point.value).toMatchObject({ count: 1, sum: 3 });
  });
});

describe("recordOutboxDispatch", () => {
  it("counts each non-zero outcome per queue", async () => {
    recordOutboxDispatch("notification", { published: 2, failed: 0, stale: 1 });
    recordOutboxDispatch("checkpoint", { published: 0, failed: 1, stale: 0 });

    const metric = await collected("clash.outbox.dispatched");
    const values = Object.fromEntries(
      metric!.dataPoints.map((point) => [
        `${point.attributes["clash.outbox.queue"]}/${point.attributes["clash.outbox.outcome"]}`,
        point.value,
      ]),
    );
    expect(values).toEqual({
      "notification/published": 2,
      "notification/stale": 1,
      "checkpoint/failed": 1,
    });
  });
});

describe("observeOutboxBacklog", () => {
  it("reports pending outbox rows from the real migrated schema", async () => {
    const db = new PGlite();
    try {
      await migrateDatabase(db);
      const log = createPostgresReplicaLog(db, "p");
      await log.append({ id: "one", update: new Uint8Array([1]) });
      const expected = await db.query<{ kind: string; n: number }>(
        "SELECT kind, count(*)::int AS n FROM project_replica_outbox GROUP BY kind",
      );
      expect(expected.rows.length).toBeGreaterThan(0);

      observeOutboxBacklog(db);
      const metric = await collected("clash.outbox.backlog");
      expect(
        Object.fromEntries(
          metric!.dataPoints.map((point) => [
            point.attributes["clash.outbox.queue"],
            point.value,
          ]),
        ),
      ).toEqual(Object.fromEntries(expected.rows.map((row) => [row.kind, row.n])));
    } finally {
      await db.close();
    }
  });
});
