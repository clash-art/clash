import {
  createStructuredLogger,
  type LogLevel,
} from "@clash/shared-runtime/logging";

const loggers = new Map<string, ReturnType<typeof createStructuredLogger>>();

/** Opt-in diagnostics via localStorage["clash.logLevel"], effective after reload. */
export function createLogger(module: string) {
  let logger = loggers.get(module);
  if (logger) return logger;
  let level: LogLevel = "info";
  try {
    const configured = globalThis.localStorage?.getItem("clash.logLevel");
    if (
      configured === "debug" ||
      configured === "info" ||
      configured === "warn" ||
      configured === "error"
    )
      level = configured;
  } catch {
    /* Storage may be unavailable; diagnostics still work. */
  }
  logger = createStructuredLogger({ component: "renderer", module, level });
  loggers.set(module, logger);
  return logger;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () =>
    loggers.forEach((logger) => logger.flush()),
  );
}

export const logger = createLogger("web");
