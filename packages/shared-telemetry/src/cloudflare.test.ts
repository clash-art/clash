import { afterEach, describe, expect, it } from "vitest";
import { SpanStatusCode, trace } from "@opentelemetry/api";

import {
  installWorkersTracing,
  WorkersTracerProvider,
  type WorkersNativeSpan,
  type WorkersNativeTracing,
} from "./cloudflare";

/** Records what the native API received, standing in for workerd. */
function fakeNative() {
  const spans: Array<{ name: string; attributes: Record<string, unknown>; ended: boolean }> = [];
  const tracing: WorkersNativeTracing = {
    startActiveSpan(name, callback) {
      const entry = { name, attributes: {} as Record<string, unknown>, ended: false };
      spans.push(entry);
      const span: WorkersNativeSpan = {
        isTraced: true,
        setAttribute: (key, value) => {
          entry.attributes[key] = value;
        },
        end: () => {
          entry.ended = true;
        },
      };
      return callback(span);
    },
  };
  return { spans, tracing };
}

afterEach(() => {
  trace.disable();
});

describe("WorkersTracerProvider", () => {
  it("maps OTel spans, attributes and status onto native custom spans", async () => {
    const { spans, tracing } = fakeNative();
    const tracer = new WorkersTracerProvider(tracing).getTracer("clash.generation");
    const result = await tracer.startActiveSpan(
      "generation.run",
      { attributes: { "clash.provider": "fal", "clash.tags": ["a", "b"] } },
      async (span) => {
        span.setStatus({ code: SpanStatusCode.ERROR, message: "upstream 500" });
        span.end();
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(spans).toEqual([
      {
        name: "generation.run",
        ended: true,
        attributes: {
          "otel.scope.name": "clash.generation",
          "clash.provider": "fal",
          "clash.tags": '["a","b"]',
          "otel.status_code": "ERROR",
          "otel.status_description": "upstream 500",
        },
      },
    ]);
  });

  it("startSpan returns an open span that the caller ends", () => {
    const { spans, tracing } = fakeNative();
    const span = new WorkersTracerProvider(tracing).getTracer("t").startSpan("later");
    expect(spans[0]?.ended).toBe(false);
    span.end();
    expect(spans[0]?.ended).toBe(true);
    // No ids for manual propagation yet.
    expect(trace.isSpanContextValid(span.spanContext())).toBe(false);
  });

  it("installs only when the runtime provides native tracing", () => {
    expect(installWorkersTracing(undefined)).toBe(false);
    expect(installWorkersTracing({})).toBe(false);
    const { spans, tracing } = fakeNative();
    expect(installWorkersTracing(tracing)).toBe(true);
    trace.getTracer("shared").startActiveSpan("from.shared.code", (span) => span.end());
    expect(spans.map((span) => span.name)).toEqual(["from.shared.code"]);
  });
});
