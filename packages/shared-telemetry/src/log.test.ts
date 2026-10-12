import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { parseLogRecord, type LogLevel } from "@clash/shared-runtime/logging";

import { createServerLogger } from "./log";

// The Node SDK registers this context manager; without one there is no
// active span to read.
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterAll(() => {
  context.disable();
});

afterEach(() => {
  logs.disable();
});

function capture() {
  const lines: Array<[LogLevel, string]> = [];
  return { lines, write: (level: LogLevel, line: string) => lines.push([level, line]) };
}

describe("createServerLogger", () => {
  it("writes the shared LogRecord envelope as one JSON line", () => {
    const { lines, write } = capture();
    const log = createServerLogger({ component: "api-node", write });
    log.child("outbox").warn("outbox.retry", { attempt: 2 });
    expect(lines).toHaveLength(1);
    const [level, line] = lines[0]!;
    expect(level).toBe("warn");
    expect(parseLogRecord(line)).toMatchObject({
      component: "api-node",
      module: "outbox",
      level: "warn",
      event: "outbox.retry",
      context: { attempt: 2 },
    });
  });

  it("adds the active span's ids to the line", () => {
    const { lines, write } = capture();
    const tracer = new BasicTracerProvider().getTracer("test");
    const span = tracer.startSpan("work");
    context.with(trace.setSpan(context.active(), span), () => {
      createServerLogger({ component: "c", write }).info("inside");
    });
    span.end();
    const record = parseLogRecord(lines[0]![1]);
    expect(record?.context).toMatchObject({
      trace_id: span.spanContext().traceId,
      span_id: span.spanContext().spanId,
    });
  });

  it("emits to the OpenTelemetry Logs API when a provider is registered", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter })],
    });
    logs.setGlobalLoggerProvider(provider);
    const { write } = capture();
    createServerLogger({ component: "render-server", write }).error("render.failed", {
      task_id: "t1",
    });
    await provider.forceFlush();
    const [record] = exporter.getFinishedLogRecords();
    expect(record?.body).toBe("render.failed");
    expect(record?.severityText).toBe("ERROR");
    expect(record?.attributes).toMatchObject({
      "clash.component": "render-server",
      task_id: "t1",
    });
  });
});
