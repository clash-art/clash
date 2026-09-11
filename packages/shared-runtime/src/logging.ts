/** Browser-safe diagnostic contract. File ownership stays with the desktop/Host. */
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogRecord extends Record<string, unknown> {
  schemaVersion: 1;
  timestamp: string;
  component: string;
  module: string;
  level: LogLevel;
  event: string;
  context: Record<string, unknown>;
}
export type LogContext =
  Record<string, unknown> | (() => Record<string, unknown>);
const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const privateKey =
  /^(?:authorization|cookie|set-cookie|password|secret|.*token|api[_-]?key|credential|prompt|messages|bodyText|runtime|payload|content)$/i;

function cleanText(value: string): string {
  return value
    .slice(0, 4_000)
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"')]+/g, (text) => {
      try {
        const url = new URL(text);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[Invalid URL]";
      }
    })
    .replace(/\bBearer\s+\S+|\bclsh_[a-zA-Z0-9]+/gi, "[REDACTED]");
}

/** Bounded traversal; no toJSON/getters, raw prompts or delivery credentials. */
export function sanitizeLogValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let remaining = 24_000;
  let visited = 0;
  const visit = (input: unknown, depth: number): unknown => {
    if (++visited > 256 || remaining <= 0 || depth > 8) return "[Truncated]";
    if (typeof input === "string") {
      const text = cleanText(input).slice(0, remaining);
      remaining -= text.length;
      return text;
    }
    if (
      input === null ||
      typeof input === "number" ||
      typeof input === "boolean"
    )
      return input;
    if (typeof input === "bigint") return String(input);
    if (typeof input !== "object") return String(input);
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input))
      return input.slice(0, 50).map((entry) => visit(entry, depth + 1));
    const output: Record<string, unknown> = {};
    const keys =
      input instanceof Error
        ? [
            ...new Set([
              "name",
              "message",
              "code",
              "status",
              "stack",
              "cause",
              ...Object.keys(input),
            ]),
          ]
        : Object.keys(input);
    for (const key of keys.slice(0, 50)) {
      if (key === "__proto__" || key === "constructor") continue;
      if (privateKey.test(key)) {
        output[key] = "[REDACTED]";
        continue;
      }
      try {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        // V8 materializes Error.stack with a native getter.
        if (descriptor?.get && !(input instanceof Error && key === "stack")) {
          output[key] = "[Getter]";
          continue;
        }
        const field = (input as Record<string, unknown>)[key];
        if (field !== undefined) output[key] = visit(field, depth + 1);
      } catch {
        output[key] = "[Unreadable]";
      }
    }
    return output;
  };
  try {
    return visit(value, 0);
  } catch {
    return "[Unreadable]";
  }
}

export function createLogRecord(
  input: Pick<LogRecord, "component" | "module" | "level" | "event"> & {
    timestamp?: string;
    context?: Record<string, unknown>;
  },
): LogRecord {
  return {
    schemaVersion: 1,
    timestamp: input.timestamp ?? new Date().toISOString(),
    component: cleanText(input.component),
    module: cleanText(input.module),
    level: input.level,
    event: cleanText(input.event),
    context: sanitizeLogValue(input.context ?? {}) as Record<string, unknown>,
  };
}

/** Accept only our versioned envelope; third-party console JSON stays a message. */
export function parseLogRecord(text: string): LogRecord | undefined {
  if (!text.startsWith("{") || text.length > 128_000) return undefined;
  try {
    const value = JSON.parse(text);
    if (
      value.schemaVersion !== 1 ||
      typeof value.timestamp !== "string" ||
      !Number.isFinite(Date.parse(value.timestamp)) ||
      typeof value.component !== "string" ||
      typeof value.module !== "string" ||
      !Object.hasOwn(levels, value.level) ||
      typeof value.event !== "string" ||
      !value.context ||
      typeof value.context !== "object" ||
      Array.isArray(value.context)
    )
      return undefined;
    return createLogRecord(value);
  } catch {
    return undefined;
  }
}

export function createStructuredLogger(options: {
  component: string;
  module: string;
  level?: LogLevel;
  write?: (record: LogRecord) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const write =
    options.write ??
    ((record: LogRecord) => console[record.level](JSON.stringify(record)));
  const seen = new Set<string>();
  let startedAt = now();
  let suppressedCount = 0;
  let events: Record<string, number> = {};
  const record = (
    level: LogLevel,
    event: string,
    context: Record<string, unknown>,
  ) =>
    createLogRecord({
      component: options.component,
      module: options.module,
      level,
      event,
      context,
      timestamp: new Date(now()).toISOString(),
    });
  const flush = () => {
    if (suppressedCount) {
      try {
        write(record("info", "logs.suppressed", { suppressedCount, events }));
      } catch {
        /* Diagnostics must not affect product work. */
      }
    }
    seen.clear();
    events = {};
    suppressedCount = 0;
    startedAt = now();
  };
  const log = (level: LogLevel, event: string, context: LogContext = {}) => {
    if (levels[level] < levels[options.level ?? "info"]) return;
    try {
      if (now() - startedAt >= 10_000) flush();
      const value = record(
        level,
        event,
        typeof context === "function" ? context() : context,
      );
      // Stacks differ at call sites but do not distinguish repeated instances of the same failure.
      const key = JSON.stringify(
        [level, event, value.context],
        (name, field) => (name === "stack" ? undefined : field),
      );
      if (seen.has(key)) {
        suppressedCount++;
        const eventKey =
          Object.hasOwn(events, event) || Object.keys(events).length < 64
            ? event
            : "other";
        events[eventKey] = (events[eventKey] ?? 0) + 1;
        return;
      }
      // Only duplicate messages are suppressed. New errors always survive an info flood.
      if (seen.size >= 256) seen.delete(seen.values().next().value!);
      seen.add(key);
      write(value);
    } catch {
      /* Logging is best effort, including lazy context and unavailable consoles. */
    }
  };
  return {
    debug: (event: string, context?: LogContext) =>
      log("debug", event, context),
    info: (event: string, context?: LogContext) => log("info", event, context),
    warn: (event: string, context?: LogContext) => log("warn", event, context),
    error: (event: string, context?: LogContext) =>
      log("error", event, context),
    flush,
  };
}
