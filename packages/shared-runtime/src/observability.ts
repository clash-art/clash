import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  createLogRecord,
  parseLogRecord,
  sanitizeLogValue,
  type LogLevel,
  type LogRecord,
} from "./logging.js";

export type StructuredLogLevel = LogLevel;

export interface StructuredLogSink {
  write(record: Record<string, unknown>): void;
  close(): void;
}

export function createBoundedJsonlLogSink(options: {
  directory: string;
  filePrefix: string;
  maxBytes: number;
  maxFiles: number;
  now?: () => number;
  pid?: number;
}): StructuredLogSink {
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const maxBytes = Math.max(1, options.maxBytes);
  const maxFiles = Math.max(1, options.maxFiles);
  const filePrefix =
    options.filePrefix.replace(/[^a-zA-Z0-9._-]/g, "-") || "clash";
  let segment = 0;
  let currentBytes = 0;
  const runId = `${options.filePrefix}-${pid}-${now()}`;

  mkdirSync(options.directory, { recursive: true, mode: 0o700 });

  const nextPath = () =>
    join(
      options.directory,
      `${filePrefix}-${String(now()).padStart(16, "0")}-${pid}-${segment++}.jsonl`,
    );
  let currentPath = nextPath();

  const prune = () => {
    const files = readdirSync(options.directory)
      .filter(
        (file) => file.startsWith(`${filePrefix}-`) && file.endsWith(".jsonl"),
      )
      .flatMap((file) => {
        try {
          return [
            {
              file,
              modifiedAt: statSync(join(options.directory, file)).mtimeMs,
            },
          ];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      })
      .sort(
        (left, right) =>
          left.modifiedAt - right.modifiedAt ||
          left.file.localeCompare(right.file),
      );
    for (const entry of files.slice(0, Math.max(0, files.length - maxFiles))) {
      rmSync(join(options.directory, entry.file), { force: true });
    }
  };

  prune();

  return {
    write(record) {
      const line = `${JSON.stringify({ ...(sanitizeLogValue(record) as Record<string, unknown>), pid, runId })}\n`;
      const bytes = Buffer.byteLength(line);
      if (currentBytes > 0 && currentBytes + bytes > maxBytes) {
        currentPath = nextPath();
        currentBytes = 0;
      }
      const newFile = currentBytes === 0;
      appendFileSync(currentPath, line, { encoding: "utf8", mode: 0o600 });
      currentBytes += bytes;
      // Directory scans belong to rotation, never to the per-record hot path.
      if (newFile) prune();
    },
    close() {},
  };
}

export interface LogSuppressionSummary {
  suppressedCount: number;
  distinctCount: number;
  distinctCountCapped?: true;
}

export function createDeduplicatedLogEmitter<T>(options: {
  emit: (value: T) => void;
  emitSuppressed: (summary: LogSuppressionSummary) => void;
  keyOf: (value: T) => string;
  isCritical?: (value: T) => boolean;
  maxEventsPerWindow: number;
  windowMs: number;
  now?: () => number;
}): { emit(value: T): void; flush(): void } {
  const now = options.now ?? Date.now;
  const maxEventsPerWindow = Math.max(1, options.maxEventsPerWindow);
  const windowMs = Math.max(1, options.windowMs);
  let windowStartedAt = now();
  let emittedCount = 0;
  let suppressedCount = 0;
  let distinctCountCapped = false;
  const emittedKeys = new Set<string>();
  const suppressedKeys = new Set<string>();

  const reset = () => {
    windowStartedAt = now();
    emittedCount = 0;
    suppressedCount = 0;
    distinctCountCapped = false;
    emittedKeys.clear();
    suppressedKeys.clear();
  };

  const flush = () => {
    if (suppressedCount > 0) {
      options.emitSuppressed({
        suppressedCount,
        distinctCount: suppressedKeys.size,
        ...(distinctCountCapped ? { distinctCountCapped: true as const } : {}),
      });
    }
    reset();
  };

  return {
    emit(value) {
      if (now() - windowStartedAt >= windowMs) flush();
      const key = options.keyOf(value);
      if (
        emittedKeys.has(key) ||
        (emittedCount >= maxEventsPerWindow && !options.isCritical?.(value))
      ) {
        suppressedCount += 1;
        if (suppressedKeys.size < maxEventsPerWindow) suppressedKeys.add(key);
        else if (!suppressedKeys.has(key)) distinctCountCapped = true;
        return;
      }
      if (emittedKeys.size >= Math.max(32, maxEventsPerWindow * 2))
        emittedKeys.delete(emittedKeys.values().next().value!);
      emittedKeys.add(key);
      emittedCount += 1;
      options.emit(value);
    },
    flush,
  };
}

type CapturableLogStream = Pick<NodeJS.WriteStream, "write">;

export interface ProcessStdioCapture {
  event(
    level: StructuredLogLevel,
    event: string,
    context?: Record<string, unknown>,
  ): void;
  /** Detached Host has reached readiness; its startup fallback no longer mirrors runtime logs. */
  stopStdioForwarding(): void;
  close(): void;
}

export function installProcessStdioCapture(options: {
  component: string;
  stdout?: CapturableLogStream;
  stderr?: CapturableLogStream;
  console?: Pick<Console, "debug" | "info" | "log" | "warn" | "error">;
  sink: StructuredLogSink;
  maxEventsPerWindow: number;
  windowMs: number;
  now?: () => number;
}): ProcessStdioCapture {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const targetConsole =
    options.console ?? (options.stdout || options.stderr ? undefined : console);
  const now = options.now ?? Date.now;
  const originalStdoutWrite = stdout.write;
  const originalStderrWrite = stderr.write;
  let open = true;
  let sinkOpen = true;
  let consoleCapture: { level: LogLevel; message: string } | undefined;
  let forwardStdio = true;
  const makeRecord = (
    level: LogLevel,
    event: string,
    context: Record<string, unknown>,
  ) =>
    createLogRecord({
      component: options.component,
      module: "process",
      level,
      event,
      context,
      timestamp: new Date(now()).toISOString(),
    });
  const persist = (record: Record<string, unknown>) => {
    if (!sinkOpen) return;
    try {
      options.sink.write(record);
    } catch (error) {
      sinkOpen = false;
      // One fallback on the original stream, never a recursive log attempt.
      try {
        Reflect.apply(originalStderrWrite, stderr, [
          JSON.stringify(makeRecord("error", "logs.write_failed", { error })) +
            "\n",
        ]);
      } catch {
        /* closed parent stream */
      }
    }
  };
  const emitter = createDeduplicatedLogEmitter<LogRecord>({
    emit: persist,
    emitSuppressed: (summary) =>
      persist(makeRecord("info", "logs.suppressed", { ...summary })),
    keyOf: ({ level, module, event, context }) =>
      JSON.stringify([level, module, event, context]),
    isCritical: ({ level }) => level === "warn" || level === "error",
    maxEventsPerWindow: options.maxEventsPerWindow,
    windowMs: options.windowMs,
    now,
  });
  const flushers: Array<() => void> = [];
  const wrap = (
    stream: CapturableLogStream,
    originalWrite: CapturableLogStream["write"],
    source: "stdout" | "stderr",
  ): CapturableLogStream["write"] => {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const emitLine = (line: string) => {
      const message = line.replace(/\r$/, "");
      if (!message) return;
      const parsed = parseLogRecord(message);
      emitter.emit(
        parsed ??
          makeRecord(
            source === "stderr" ? "warn" : "info",
            `process.${source}`,
            { message },
          ),
      );
    };
    flushers.push(() => {
      pending += decoder.end();
      emitLine(pending);
      pending = "";
    });
    return function capturedWrite(chunk, ...args) {
      if (open) {
        try {
          const text =
            typeof chunk === "string"
              ? chunk
              : decoder.write(Buffer.from(chunk));
          if (consoleCapture) {
            // Console has an explicit call boundary: keep multiline errors together
            // and reuse its formatted output instead of inspecting arguments twice.
            if (pending) {
              emitLine(pending);
              pending = "";
            }
            if (consoleCapture.message.length < 128_000)
              consoleCapture.message += text.slice(
                0,
                128_000 - consoleCapture.message.length,
              );
          } else {
            pending += text;
            let newline: number;
            while ((newline = pending.indexOf("\n")) !== -1) {
              emitLine(pending.slice(0, newline));
              pending = pending.slice(newline + 1);
            }
            if (pending.length > 128_000) {
              emitLine(pending);
              pending = "";
            }
          }
        } catch {
          /* Capturing must preserve stream semantics even for invalid chunks. */
        }
      }
      if (forwardStdio)
        return Reflect.apply(originalWrite, stream, [chunk, ...args]);
      const callback = args.at(-1);
      if (typeof callback === "function") queueMicrotask(() => callback());
      return true;
    } as CapturableLogStream["write"];
  };
  stdout.write = wrap(stdout, originalStdoutWrite, "stdout");
  stderr.write = wrap(stderr, originalStderrWrite, "stderr");
  const restoreConsole: Array<() => void> = [];
  if (targetConsole) {
    for (const method of ["debug", "info", "log", "warn", "error"] as const) {
      const original = targetConsole[method];
      const wrapped = (...args: unknown[]) => {
        const previous = consoleCapture;
        const capture = {
          level: (method === "log" ? "info" : method) as LogLevel,
          message: "",
        };
        consoleCapture = capture;
        try {
          Reflect.apply(original, targetConsole, args);
        } finally {
          consoleCapture = previous;
          if (open && capture.message) {
            const message = capture.message.replace(/[\r\n]+$/, "");
            const error = args.find((value) => value instanceof Error);
            emitter.emit(
              parseLogRecord(message) ??
                makeRecord(capture.level, "process.console", {
                  message,
                  ...(error ? { error } : {}),
                }),
            );
          }
        }
      };
      targetConsole[method] = wrapped;
      restoreConsole.push(() => {
        if (targetConsole[method] === wrapped) targetConsole[method] = original;
      });
    }
  }
  return {
    stopStdioForwarding() {
      forwardStdio = false;
    },
    event(level, event, context = {}) {
      if (open) emitter.emit(makeRecord(level, event, context));
    },
    close() {
      if (!open) return;
      flushers.forEach((flush) => flush());
      emitter.flush();
      open = false;
      stdout.write = originalStdoutWrite;
      stderr.write = originalStderrWrite;
      restoreConsole.forEach((restore) => restore());
      try {
        options.sink.close();
      } catch {
        /* failed sink already reported */
      }
      sinkOpen = false;
    },
  };
}
