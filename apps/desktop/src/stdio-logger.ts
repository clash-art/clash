import {
  createLogRecord,
  type LogRecord,
  type LogLevel,
} from "@clash/shared-runtime/logging";
import { format } from "node:util";
import {
  createBoundedJsonlLogSink,
  createDeduplicatedLogEmitter,
  type LogSuppressionSummary,
  type StructuredLogSink,
} from "@clash/shared-runtime/observability";

export { createDeduplicatedLogEmitter };
export type { LogSuppressionSummary };

type WritableLogStream = NodeJS.WritableStream & {
  write(chunk: string): boolean;
};

export interface DesktopLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  event(
    level: LogLevel,
    event: string,
    context?: Record<string, unknown>,
  ): void;
  record(record: LogRecord): void;
  close(): void;
}

export type DesktopFileLogSink = StructuredLogSink;

export function createDesktopFileLogSink(options: {
  directory: string;
  maxBytes: number;
  maxFiles: number;
  now?: () => number;
  pid?: number;
}): DesktopFileLogSink {
  return createBoundedJsonlLogSink({
    ...options,
    filePrefix: "desktop",
  });
}

const CLOSED_STDIO_ERROR_CODES = new Set([
  "EPIPE",
  "EIO",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

export function isClosedStdioError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && CLOSED_STDIO_ERROR_CODES.has(code);
}

export function createDesktopLogger(
  stdout: WritableLogStream = process.stdout,
  stderr: WritableLogStream = process.stderr,
  options: {
    fileSink?: DesktopFileLogSink;
    now?: () => number;
  } = {},
): DesktopLogger {
  let stdoutOpen = true;
  let stderrOpen = true;
  let fileSinkOpen = Boolean(options.fileSink);
  const now = options.now ?? Date.now;

  stdout.on("error", (error) => {
    if (isClosedStdioError(error)) {
      stdoutOpen = false;
      return;
    }
    throw error;
  });

  stderr.on("error", (error) => {
    if (isClosedStdioError(error)) {
      stderrOpen = false;
      return;
    }
    throw error;
  });

  function persist(record: Record<string, unknown>): void {
    if (fileSinkOpen && options.fileSink) {
      try {
        options.fileSink.write(record);
      } catch (error) {
        fileSinkOpen = false;
        writeStream(
          "stderr",
          JSON.stringify(
            createLogRecord({
              component: "desktop",
              module: "logging",
              level: "error",
              event: "logs.write_failed",
              context: { error },
            }),
          ),
        );
      }
    }
  }

  function writeStream(stream: "stdout" | "stderr", message: string): void {
    if (stream === "stdout" && !stdoutOpen) return;
    if (stream === "stderr" && !stderrOpen) return;

    try {
      const target = stream === "stdout" ? stdout : stderr;
      target.write(`${message}\n`);
    } catch (error) {
      if (isClosedStdioError(error)) {
        if (stream === "stdout") stdoutOpen = false;
        else stderrOpen = false;
        return;
      }
      throw error;
    }
  }

  function write(
    level: LogLevel,
    stream: "stdout" | "stderr",
    ...args: unknown[]
  ): void {
    const message = format(...args);
    persist(
      createLogRecord({
        timestamp: new Date(now()).toISOString(),
        component: "desktop",
        module: "main",
        level,
        event: "desktop.console",
        context: {
          message,
          ...(args.some((value) => value instanceof Error)
            ? { error: args.find((value) => value instanceof Error) }
            : {}),
        },
      }),
    );
    writeStream(stream, message);
  }

  return {
    info: (...args) => write("info", "stdout", ...args),
    warn: (...args) => write("warn", "stderr", ...args),
    error: (...args) => write("error", "stderr", ...args),
    event: (level, event, context = {}) => {
      const record = createLogRecord({
        timestamp: new Date(now()).toISOString(),
        component: "desktop",
        module: "main",
        level,
        event,
        context,
      });
      persist(record);
      writeStream(
        level === "warn" || level === "error" ? "stderr" : "stdout",
        JSON.stringify(record),
      );
    },
    record: (input) => {
      const record = createLogRecord(input);
      persist(record);
      writeStream(
        record.level === "warn" || record.level === "error"
          ? "stderr"
          : "stdout",
        JSON.stringify(record),
      );
    },
    close: () => {
      if (!fileSinkOpen || !options.fileSink) return;
      fileSinkOpen = false;
      options.fileSink.close();
    },
  };
}
