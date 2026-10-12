import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { parseTraceparent } from "@clash/shared-runtime/tracing";

import { withActionTrace } from "./uiTrace";

const exporter = new InMemorySpanExporter();

beforeEach(() => {
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }),
  );
});

afterEach(() => {
  trace.disable();
  exporter.reset();
});

const attributes = { "clash.prompt.chars": 5, "clash.prompt.queued": false };

describe("withActionTrace", () => {
  it("hands out the action span's traceparent and ends the span", () => {
    const traceparent = withActionTrace("prompt.send", attributes, (action) => action.traceparent);
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("ui.prompt.send");
    expect(span?.attributes).toMatchObject({ "clash.ui.action": "prompt.send", ...attributes });
    expect(parseTraceparent(traceparent ?? "")).toMatchObject({
      traceId: span?.spanContext().traceId,
      spanId: span?.spanContext().spanId,
    });
  });

  it("marks thrown and rejected actions as failed and rethrows", async () => {
    expect(() =>
      withActionTrace("prompt.send", attributes, () => {
        throw new TypeError("boom");
      }),
    ).toThrow("boom");
    await expect(
      withActionTrace("prompt.send", attributes, () => Promise.reject(new RangeError("late"))),
    ).rejects.toThrow("late");
    await Promise.resolve();
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.status.code)).toEqual([
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
    ]);
    expect(spans.map((span) => span.attributes["exception.type"])).toEqual([
      "TypeError",
      "RangeError",
    ]);
  });

  it("produces no traceparent when no SDK is installed", () => {
    trace.disable();
    expect(withActionTrace("prompt.send", attributes, (action) => action.traceparent)).toBeUndefined();
  });
});
