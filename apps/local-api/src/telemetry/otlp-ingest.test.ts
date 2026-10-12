import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import type { LogRecord } from "@clash/shared-runtime/logging";

import { managedLocalApiApps } from "../local-api-app.test-fixtures.js";
import { decodeOtlpJsonTraces } from "./otlp-ingest.js";
import { createHostTelemetry } from "./pipeline.js";
import { resolveTelemetryExport } from "./resolve.js";

/** Record real spans with the SDK, as the GUI renderer would. */
function recordClientSpans(): ReadableSpan[] {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "clash-web" }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("clash.web", "1.0.0");
  const parent = tracer.startSpan("ui.action", {
    kind: SpanKind.CLIENT,
    attributes: {
      "clash.ui.action": "prompt.send",
      "clash.count": 3,
      "clash.ratio": 0.5,
      "clash.flag": true,
      "clash.tags": ["a", "b"],
    },
  });
  parent.addEvent("ui.step", { step: 1 });
  const child = tracer.startSpan(
    "ui.render",
    {},
    trace.setSpan(context.active(), parent),
  );
  child.setStatus({ code: SpanStatusCode.ERROR, message: "render failed" });
  child.end();
  parent.end();
  return exporter.getFinishedSpans();
}

/** Encode with the official OTLP/HTTP JSON serializer. */
function encode(spans: ReadableSpan[]): unknown {
  return JSON.parse(
    new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans)),
  );
}

function comparable(span: ReadableSpan) {
  return {
    name: span.name,
    kind: span.kind,
    context: span.spanContext(),
    parentSpanId: span.parentSpanContext?.spanId,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    status: span.status,
    attributes: span.attributes,
    events: span.events.map(({ name, time, attributes }) => ({
      name,
      time,
      attributes,
    })),
    scope: span.instrumentationScope.name,
    resource: span.resource.attributes["service.name"],
  };
}

describe("decodeOtlpJsonTraces", () => {
  it("round-trips spans encoded by the official OTLP JSON serializer", () => {
    const original = recordClientSpans();
    const decoded = decodeOtlpJsonTraces(encode(original));
    if (!decoded.ok) throw new Error(decoded.error);
    expect(decoded.rejected).toBe(0);
    const byName = (spans: ReadableSpan[]) =>
      [...spans].sort((a, b) => a.name.localeCompare(b.name)).map(comparable);
    expect(byName(decoded.spans)).toEqual(byName(original));
  });

  it("rejects malformed spans individually and malformed requests whole", () => {
    const body = encode(recordClientSpans()) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>;
    };
    body.resourceSpans[0]!.scopeSpans[0]!.spans.push(
      { name: "no ids" },
      { traceId: "zz", spanId: "zz", name: "bad ids" },
    );
    const decoded = decodeOtlpJsonTraces(body);
    expect(decoded.ok && decoded.rejected).toBe(2);
    expect(decoded.ok && decoded.spans).toHaveLength(2);

    expect(decodeOtlpJsonTraces({ spans: [] }).ok).toBe(false);
    expect(decodeOtlpJsonTraces("nope").ok).toBe(false);
  });

  it("rejects spans beyond the per-request limit", () => {
    const decoded = decodeOtlpJsonTraces(encode(recordClientSpans()), {
      maxSpans: 1,
      maxAttributes: 128,
      maxEvents: 128,
      maxLinks: 128,
    });
    expect(decoded.ok && decoded.spans).toHaveLength(1);
    expect(decoded.ok && decoded.rejected).toBe(1);
  });
});

describe("HostTelemetry.ingest", () => {
  it("summarises client spans locally and exports them only when enabled", async () => {
    const logs: LogRecord[] = [];
    const exported = new InMemorySpanExporter();
    const telemetry = createHostTelemetry({
      emitLog: (record) => logs.push(record),
      register: false,
      createExporter: () => exported,
    });
    const decoded = decodeOtlpJsonTraces(encode(recordClientSpans()));
    if (!decoded.ok) throw new Error(decoded.error);

    telemetry.ingest(decoded.spans);
    expect(logs.map((record) => record.event)).toEqual(["span.end", "span.end"]);
    expect(logs.every((record) => record.component === "clash.web")).toBe(true);
    expect(exported.getFinishedSpans()).toHaveLength(0);

    await telemetry.applyExport(
      resolveTelemetryExport({ CLASH_ENABLE_TELEMETRY: "1" }, {}),
    );
    telemetry.ingest(decoded.spans);
    await telemetry.provider.forceFlush();
    expect(exported.getFinishedSpans().map((span) => span.name).sort()).toEqual(
      ["ui.action", "ui.render"],
    );
    await telemetry.shutdown();
  });
});

describe("POST /api/v1/local/otlp/v1/traces", () => {
  it("feeds client spans into the Host pipeline with OTLP responses", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-otlp-ingest-"));
    const apps = managedLocalApiApps();
    const ingested: ReadableSpan[] = [];
    try {
      const app = apps.createApp({
        dataDir,
        userId: "local-user",
        hostTelemetry: {
          exporting: false,
          async applyExport() {},
          ingest: (spans) => ingested.push(...spans),
          async shutdown() {},
        },
      });
      const post = (body: string, contentType = "application/json") =>
        app.request("/api/v1/local/otlp/v1/traces", {
          method: "POST",
          headers: { "content-type": contentType },
          body,
        });

      const ok = await post(JSON.stringify(encode(recordClientSpans())));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({});
      expect(ingested.map((span) => span.name).sort()).toEqual([
        "ui.action",
        "ui.render",
      ]);

      const partial = encode(recordClientSpans()) as {
        resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>;
      };
      partial.resourceSpans[0]!.scopeSpans[0]!.spans.push({ name: "bad" });
      const partialResponse = await post(JSON.stringify(partial));
      expect(await partialResponse.json()).toMatchObject({
        partialSuccess: { rejectedSpans: 1 },
      });

      expect((await post("{", "application/json")).status).toBe(400);
      expect((await post("", "application/x-protobuf")).status).toBe(415);
    } finally {
      await apps.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
