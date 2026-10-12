import { trace } from "@opentelemetry/api";
import { logs, SeverityNumber, type AnyValueMap } from "@opentelemetry/api-logs";
import {
  createLogRecord,
  type LogLevel,
  type LogRecord,
} from "@clash/shared-runtime/logging";

/**
 * Structured backend logger, shared by Node services and Cloudflare Workers.
 *
 * Every call produces the product-wide `LogRecord` envelope (same fields as
 * the local Host: component, module, level, event, context) and:
 *
 * 1. writes it as one JSON line to the console — Workers Logs extracts the
 *    JSON fields and attributes the line to the active span; Node services
 *    leave stdout collection to the platform;
 * 2. emits it to the OpenTelemetry Logs API — a no-op until a LoggerProvider
 *    is registered (Node: `startNodeTelemetry`), which then exports it with
 *    trace correlation per the standard `OTEL_LOGS_EXPORTER` settings.
 *
 * Trace and span ids of the active OTel span are added to the console line
 * so stdout-collected logs correlate with traces too.
 */

export type LogContext = Record<string, unknown>;

export interface ServerLogger {
  debug(event: string, context?: LogContext): void;
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, context?: LogContext): void;
  /** Same component, different module (e.g. `log.child("generation")`). */
  child(module: string): ServerLogger;
}

export interface ServerLoggerOptions {
  /** Service identity, e.g. `api-cf`, `api-node`, `render-server`. */
  component: string;
  module?: string;
  /** Console line writer; defaults to the console method for the level. */
  write?: (level: LogLevel, line: string) => void;
}

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

function consoleWrite(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "debug") console.debug(line);
  else console.log(line);
}

function activeTraceIds(): { trace_id: string; span_id: string } | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const { traceId, spanId } = span.spanContext();
  return trace.isSpanContextValid(span.spanContext())
    ? { trace_id: traceId, span_id: spanId }
    : undefined;
}

export function createServerLogger(options: ServerLoggerOptions): ServerLogger {
  const module = options.module ?? "app";
  const write = options.write ?? consoleWrite;

  const emit = (level: LogLevel, event: string, context: LogContext = {}) => {
    const ids = activeTraceIds();
    const record: LogRecord = createLogRecord({
      component: options.component,
      module,
      level,
      event,
      context: ids ? { ...context, ...ids } : context,
    });
    try {
      write(level, JSON.stringify(record));
    } catch {
      // Logging must never break the request path.
    }
    try {
      // Resolved per call: a logger taken before the SDK registers its
      // provider would stay a no-op forever. Providers cache loggers.
      logs.getLogger(options.component).emit({
        severityNumber: SEVERITY[level],
        severityText: level.toUpperCase(),
        body: record.event,
        eventName: record.event,
        attributes: {
          "clash.component": record.component,
          "clash.module": record.module,
          ...(record.context as AnyValueMap),
        },
      });
    } catch {
      // Same: the OTel bridge is best effort.
    }
  };

  return {
    debug: (event, context) => emit("debug", event, context),
    info: (event, context) => emit("info", event, context),
    warn: (event, context) => emit("warn", event, context),
    error: (event, context) => emit("error", event, context),
    child: (child) => createServerLogger({ ...options, module: child }),
  };
}
