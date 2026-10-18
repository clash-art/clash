import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemorySpanExporter,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startLocalApiServer } from "./server.js";
import { createHostTelemetry } from "./telemetry/pipeline.js";
import { resolveTelemetryExport } from "./telemetry/resolve.js";

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

function enabled() {
  const resolution = resolveTelemetryExport(
    { CLASH_ENABLE_TELEMETRY: "1" },
    {},
  );
  if (!resolution.enabled) throw new Error("expected an enabled resolution");
  return resolution;
}

async function startServer(
  dataDir: string,
  hostTelemetry: ReturnType<typeof createHostTelemetry>,
) {
  process.env.CLASH_ENABLE_TELEMETRY = "1";
  return startLocalApiServer({
    dataDir,
    port: 0,
    remotePersistence: null,
    agentRuntime: "disabled",
    hostTelemetry,
    discovery: { enabled: false },
  });
}

function close(server: Awaited<ReturnType<typeof startLocalApiServer>>) {
  return new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

function logRecords(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map(
    (call) =>
      JSON.parse(String(call[0])) as {
        event?: string;
        context?: Record<string, unknown>;
      },
  );
}

describe("Host telemetry shutdown", () => {
  it("flushes spans ended just before the server closes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-telemetry-flush-"));
    const inner = new InMemorySpanExporter();
    // InMemorySpanExporter.shutdown() clears its spans, so keep the recorded
    // export across the provider shutdown this test is asserting.
    const exported: SpanExporter = {
      export: (spans, callback) => inner.export(spans, callback),
      shutdown: async () => {},
    };
    const telemetry = createHostTelemetry({
      emitLog: () => {},
      register: false,
      createExporter: () => exported,
    });
    const server = await startServer(dataDir, telemetry);
    try {
      await telemetry.applyExport(enabled());
      expect(telemetry.exporting).toBe(true);
      telemetry.provider
        .getTracer("shutdown.test")
        .startSpan("last.turn")
        .end();
      expect(telemetry.pendingSpans).toBe(1);

      await close(server);

      expect(inner.getFinishedSpans().map((span) => span.name)).toContain(
        "last.turn",
      );
    } finally {
      await telemetry.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("bounds shutdown with an unreachable collector and logs the loss", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-telemetry-timeout-"));
    let releaseExport: (() => void) | undefined;
    const hangingExporter: SpanExporter = {
      export(_spans, callback) {
        releaseExport = () => callback({ code: 0 });
      },
      shutdown: async () => {},
    };
    const telemetry = createHostTelemetry({
      emitLog: () => {},
      register: false,
      createExporter: () => hangingExporter,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = await startServer(dataDir, telemetry);
    try {
      await telemetry.applyExport(enabled());
      telemetry.provider
        .getTracer("shutdown.test")
        .startSpan("queued.turn")
        .end();

      const startedAt = Date.now();
      await close(server);
      const elapsedMs = Date.now() - startedAt;

      expect(
        elapsedMs,
        "close is bounded by the telemetry deadline",
      ).toBeLessThan(5_000);
      expect(elapsedMs).toBeGreaterThanOrEqual(2_900);
      expect(releaseExport).toBeTypeOf("function");
      expect(logRecords(warn)).toContainEqual(
        expect.objectContaining({
          event: "host.telemetry_flush_failed",
          context: expect.objectContaining({
            code: "TELEMETRY_FLUSH_FAILED",
            pendingSpans: 1,
            reason: "timeout",
          }),
        }),
      );
    } finally {
      releaseExport?.();
      await telemetry.shutdown();
      warn.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
