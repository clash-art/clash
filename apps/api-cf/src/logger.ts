import {
  createServerLogger,
  type ServerLogger,
} from "@clash/shared-telemetry/log";

/**
 * api-cf logging.
 *
 * Every line is the product-wide structured `LogRecord` (one JSON object per
 * console call), which Workers Logs indexes field by field and attributes to
 * the active trace span. Export is configured in wrangler `[observability]`.
 *
 * - `serverLog` is the structured API for new code:
 *   `serverLog.child("generation").info("generation.submitted", { task_id })`.
 * - `log` keeps the historical variadic call shape
 *   (`log.info("message", detail, error)`) so existing call sites emit
 *   structured records unchanged: the first string becomes the event, the
 *   remaining arguments land in `context.args` (Errors keep name, message
 *   and stack through the shared sanitizer), and the module is the calling
 *   file's name, as the previous tag was.
 */

export const serverLog: ServerLogger = createServerLogger({ component: "api-cf" });

const modules = new Map<string, ServerLogger>();

function moduleLogger(name: string): ServerLogger {
  let logger = modules.get(name);
  if (!logger) {
    logger = serverLog.child(name);
    modules.set(name, logger);
  }
  return logger;
}

const GENERIC_FILES = new Set(["index", "chunk", "bundle", "worker", "logger"]);

/** Name of the source file that called `log.*`, as the module tag. */
function callerModule(): string {
  const stack = new Error().stack;
  if (!stack) return "app";
  for (const line of stack.split("\n").slice(3)) {
    // Source (/src/foo/bar.ts) and bundled (foo/bar.js) paths.
    const match = line.match(/\/([\w-]+)\.(ts|js)/);
    if (match && !GENERIC_FILES.has(match[1]!)) return match[1]!;
  }
  return "app";
}

type Level = "debug" | "info" | "warn" | "error";
type LegacyLogFn = (message?: unknown, ...args: unknown[]) => void;

function legacy(level: Level): LegacyLogFn {
  return (message, ...args) => {
    const event = typeof message === "string" ? message : "log";
    const rest = typeof message === "string" ? args : [message, ...args];
    moduleLogger(callerModule())[level](
      event,
      rest.length > 0 ? { args: rest } : {},
    );
  };
}

export const log: Record<Level, LegacyLogFn> = {
  debug: legacy("debug"),
  info: legacy("info"),
  warn: legacy("warn"),
  error: legacy("error"),
};
