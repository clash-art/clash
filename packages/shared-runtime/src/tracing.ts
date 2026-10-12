import {
  createLogRecord,
  sanitizeLogValue,
  type LogRecord,
} from "./logging.js";

/**
 * Browser-safe helpers around the real OpenTelemetry SDK.
 *
 * Tracing is done through `@opentelemetry/api` + the official SDK
 * (`@opentelemetry/sdk-trace-node` in the local Host,
 * `@opentelemetry/sdk-trace-web` in the renderer). This module only owns the
 * pieces the SDK does not give us:
 *
 * - W3C traceparent formatting/parsing for manual propagation across the
 *   desktop IPC and Host HTTP boundaries.
 * - `spanSnapshotToLogRecord` — folds a finished ReadableSpan-shaped object
 *   into our `span.end` LogRecord so spans land in the same local JSONL
 *   diagnostics pipeline as everything else (`clash logs --event span.end`,
 *   `context.trace_id` correlation) even with no collector installed.
 * - The GenAI semantic-convention attribute names used when instrumenting
 *   agent sessions, kept as plain constants so front/back ends share them.
 *
 * OTLP export itself is the SDK's job (`@opentelemetry/exporter-*`); we never
 * re-implement the wire protocol.
 */

/** W3C traceparent: 00-<32-hex traceId>-<16-hex spanId>-<flags>. */
export interface TraceContextIds {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

export function formatTraceparent(context: TraceContextIds): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}

export function parseTraceparent(text: string): TraceContextIds | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(
    text.trim(),
  );
  if (!match) return undefined;
  if (match[1] === "0".repeat(32) || match[2] === "0".repeat(16)) {
    return undefined;
  }
  return {
    traceId: match[1],
    spanId: match[2],
    sampled: (Number.parseInt(match[3], 16) & 1) === 1,
  };
}

/** A fresh sampled root trace context (no parent). */
export function newTraceContext(): TraceContextIds {
  return {
    traceId: randomHex(16),
    spanId: randomHex(8),
    sampled: true,
  };
}

export function randomSpanId(): string {
  return randomHex(8);
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  let out = "";
  for (const byte of buffer) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** OpenTelemetry GenAI semantic-convention attribute names. */
export const GEN_AI = {
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  conversationId: "gen_ai.conversation.id",
  agentName: "gen_ai.agent.name",
  agentId: "gen_ai.agent.id",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  usageInputTokens: "gen_ai.usage.input_tokens",
  usageOutputTokens: "gen_ai.usage.output_tokens",
  responseFinishReasons: "gen_ai.response.finish_reasons",
  errorType: "error.type",
} as const;

export const GEN_AI_OPERATIONS = {
  createAgent: "create_agent",
  invokeAgent: "invoke_agent",
  chat: "chat",
  executeTool: "execute_tool",
} as const;

/**
 * Minimal structural view of a finished span. Compatible with the SDK's
 * `ReadableSpan` (spanContext(), kind, startTime, endTime, duration, status,
 * attributes, events) without this module depending on the SDK.
 */
export interface SpanSnapshot {
  name: string;
  /** OTel proto enum number, or our lowercase string form. */
  kind: number | string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationMs: number;
  attributes: Record<string, unknown>;
  events: Array<{
    name: string;
    timeUnixNano?: string;
    attributes?: Record<string, unknown>;
  }>;
  status: { code: number | string; message?: string };
}

const OTEL_STATUS_ERROR = "error";

function statusCodeToLevelAndText(code: number | string): {
  level: "info" | "error";
  text: string;
} {
  // proto enum: 0 unset, 1 ok, 2 error
  if (code === 2 || String(code).toLowerCase() === OTEL_STATUS_ERROR) {
    return { level: "error", text: "error" };
  }
  if (code === 1 || String(code).toLowerCase() === "ok") {
    return { level: "info", text: "ok" };
  }
  return { level: "info", text: "unset" };
}

/** Fold a finished span into the shared LogRecord envelope. */
export function spanSnapshotToLogRecord(
  span: SpanSnapshot,
  component: string,
): LogRecord {
  const status = statusCodeToLevelAndText(span.status.code);
  return createLogRecord({
    component,
    module: "tracing",
    level: status.level,
    event: "span.end",
    context: {
      name: span.name,
      kind: span.kind,
      trace_id: span.traceId,
      span_id: span.spanId,
      ...(span.parentSpanId ? { parent_span_id: span.parentSpanId } : {}),
      traceparent: formatTraceparent({
        traceId: span.traceId,
        spanId: span.spanId,
        sampled: true,
      }),
      duration_ms: span.durationMs,
      status: status.text,
      ...(span.status.message ? { status_message: span.status.message } : {}),
      attributes: sanitizeLogValue(span.attributes),
      ...(span.events.length > 0
        ? {
            events: span.events.map((event) => ({
              name: event.name,
              ...(event.attributes
                ? { attributes: sanitizeLogValue(event.attributes) }
                : {}),
            })),
          }
        : {}),
    },
  });
}
