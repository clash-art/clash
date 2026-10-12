import { describe, expect, it } from "vitest";

import {
  formatTraceparent,
  GEN_AI,
  newTraceContext,
  parseTraceparent,
  randomSpanId,
  spanSnapshotToLogRecord,
  type SpanSnapshot,
} from "./tracing.js";

describe("traceparent", () => {
  it("formats and parses W3C traceparent", () => {
    const context = newTraceContext();
    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
    const parsed = parseTraceparent(formatTraceparent(context));
    expect(parsed).toEqual(context);
  });

  it("rejects malformed and all-zero headers", () => {
    expect(parseTraceparent("nonsense")).toBeUndefined();
    expect(
      parseTraceparent(`00-${"0".repeat(32)}-${"0".repeat(16)}-01`),
    ).toBeUndefined();
    expect(parseTraceparent("01-abc-def-01")).toBeUndefined();
  });

  it("generates distinct span ids", () => {
    expect(randomSpanId()).not.toBe(randomSpanId());
  });
});

describe("spanSnapshotToLogRecord", () => {
  const base: SpanSnapshot = {
    name: "invoke_agent",
    kind: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    parentSpanId: "c".repeat(16),
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: "1250000000",
    durationMs: 250,
    attributes: { [GEN_AI.operationName]: "invoke_agent" },
    events: [{ name: "acp.diagnostic", attributes: { status: "warn" } }],
    status: { code: 1 },
  };

  it("emits a span.end record with trace correlation fields", () => {
    const record = spanSnapshotToLogRecord(base, "acp");
    expect(record.schemaVersion).toBe(1);
    expect(record.event).toBe("span.end");
    expect(record.level).toBe("info");
    expect(record.context.trace_id).toBe(base.traceId);
    expect(record.context.parent_span_id).toBe(base.parentSpanId);
    expect(record.context.traceparent).toBe(
      `00-${base.traceId}-${base.spanId}-01`,
    );
    expect(record.context.duration_ms).toBe(250);
    expect(record.context.status).toBe("ok");
  });

  it("maps error status to error level, accepts string codes too", () => {
    const error = spanSnapshotToLogRecord(
      { ...base, status: { code: 2, message: "boom" } },
      "acp",
    );
    expect(error.level).toBe("error");
    expect(error.context.status).toBe("error");
    expect(error.context.status_message).toBe("boom");
    const strCode = spanSnapshotToLogRecord(
      { ...base, status: { code: "ERROR" } },
      "acp",
    );
    expect(strCode.level).toBe("error");
  });

  it("sanitizes span attributes and events", () => {
    const record = spanSnapshotToLogRecord(
      {
        ...base,
        attributes: { api_key: "clsh_secret", plain: "ok" },
      },
      "acp",
    );
    const text = JSON.stringify(record.context);
    expect(text).not.toContain("clsh_secret");
    expect(text).toContain('"plain":"ok"');
  });
});
