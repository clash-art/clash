import { afterEach, describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import type { OtlpProtocol } from "@clash/shared-types";
import type { LogRecord } from "@clash/shared-runtime/logging";

import {
  createOtlpTraceExporter,
  type OtlpTraceExporterConfig,
} from "./exporters.js";
import { createHostTelemetry } from "./pipeline.js";
import { resolveTelemetryExport } from "./resolve.js";

function enabled(settings = {}) {
  const resolution = resolveTelemetryExport(
    { CLASH_ENABLE_TELEMETRY: "1" },
    settings,
  );
  if (!resolution.enabled) throw new Error("expected an enabled resolution");
  return resolution;
}

describe("createOtlpTraceExporter", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("builds the exporter for the resolved protocol with explicit options", () => {
    const seen: Array<[OtlpProtocol, OtlpTraceExporterConfig, string | undefined]> = [];
    const factory =
      (protocol: OtlpProtocol) =>
      (config: OtlpTraceExporterConfig): SpanExporter => {
        seen.push([protocol, config, process.env.OTEL_EXPORTER_OTLP_HEADERS]);
        return new InMemorySpanExporter();
      };
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=env-token";

    createOtlpTraceExporter(
      enabled({
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=settings-token",
      }),
      { "http/protobuf": factory("http/protobuf"), "http/json": factory("http/json") },
    );

    expect(seen).toEqual([
      [
        "http/json",
        {
          url: "http://localhost:4318/v1/traces",
          headers: { authorization: "settings-token" },
        },
        // The environment credential is hidden while the exporter is built…
        undefined,
      ],
    ]);
    // …and restored afterwards.
    expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toBe("authorization=env-token");
  });
});

describe("createHostTelemetry", () => {
  function setup() {
    const logs: LogRecord[] = [];
    const exported = new InMemorySpanExporter();
    const telemetry = createHostTelemetry({
      emitLog: (record) => logs.push(record),
      register: false,
      createExporter: () => exported,
    });
    return {
      logs,
      exported,
      telemetry,
      tracer: telemetry.provider.getTracer("clash.test"),
    };
  }

  it("always writes local span.end summaries and exports nothing by default", async () => {
    const { logs, exported, telemetry, tracer } = setup();
    const span = tracer.startSpan("invoke_agent", {
      attributes: { "clash.turn_id": "t1" },
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: "boom" });
    span.end();
    await telemetry.provider.forceFlush();

    expect(telemetry.exporting).toBe(false);
    expect(exported.getFinishedSpans()).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: "span.end",
      level: "error",
      component: "clash.test",
    });
    expect((logs[0]?.context as Record<string, unknown>).trace_id).toBe(
      span.spanContext().traceId,
    );
  });

  it("starts and stops OTLP export when the resolution changes", async () => {
    const { exported, telemetry, tracer } = setup();
    await telemetry.applyExport(enabled());
    expect(telemetry.exporting).toBe(true);
    tracer.startSpan("execute_tool").end();
    await telemetry.provider.forceFlush();
    expect(exported.getFinishedSpans().map((span) => span.name)).toEqual([
      "execute_tool",
    ]);

    await telemetry.applyExport(resolveTelemetryExport({}, {}));
    expect(telemetry.exporting).toBe(false);
    await telemetry.shutdown();
  });
});
