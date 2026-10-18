import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import {
  mkdir,
  open,
  readdir,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  createLogRecord,
  getStructuredLogRecordWriter,
  isSanitizedLogRecord,
  parseLogRecord,
  sanitizeLogValue,
  setStructuredLogRecordWriter,
  type LogLevel,
  type LogRecord,
} from "./logging.js";

export type StructuredLogLevel = LogLevel;

/** Coded health of a process log sink. */
export type LogSinkStatusCode = "LOG_SINK_WRITE_FAILED";

export interface LogSinkHealth {
  status: "healthy" | "degraded";
  /** Present while degraded; the stable code a caller can branch on. */
  code?: LogSinkStatusCode;
  /** Records dropped because the bounded retry tail overflowed. */
  dropped?: number;
  /** Consecutive failed write attempts in the current degraded episode. */
  attempts?: number;
  /** Delay before the next reopen attempt. */
  retryDelayMs?: number;
  message?: string;
}

export interface StructuredLogSink {
  write(record: Record<string, unknown>): void;
  /**
   * Persist queued records. Sinks that write asynchronously return a promise
   * when a write was in flight; awaiting it guarantees ordering and durability.
   */
  close(): void | Promise<void>;
  /** Wait for queued records to reach the filesystem (tests/diagnostics). */
  flush?(): Promise<void>;
  /** Synchronous crash-path flush; never awaits an in-flight write. */
  flushSync?(): void;
  health?(): LogSinkHealth;
}

/** Deletion bounds for one JSONL log directory. */
export interface LogRetention {
  /** Delete oldest segments while retained bytes exceed this total. */
  maxTotalBytes?: number;
  /** Delete segments whose modification time is older than this many days. */
  maxAgeDays?: number;
}

/** Product-wide default log retention for local JSONL segments. */
export const DEFAULT_JSONL_LOG_RETENTION: LogRetention = {
  maxTotalBytes: 25 * 1024 * 1024,
  maxAgeDays: 7,
};

/**
 * Rotating JSONL sink. A new file starts on creation, when the day changes,
 * or when the open file would exceed `maxBytes`; file names embed timestamp,
 * pid and segment so runs never collide.
 *
 * Deletion is opt-in: each bound in `retention` applies only when supplied
 * (a caller that cannot read its retention config deletes nothing), and the
 * file currently being written is never deleted. Segments are appended
 * verbatim — no compression.
 */
export function createBoundedJsonlLogSink(options: {
  directory: string;
  filePrefix: string;
  /** Start a new file rather than let the open one grow past this size. */
  maxBytes: number;
  /** Deletion bounds; omitted bounds never delete (and neither does absent retention). */
  retention?: LogRetention;
  /** Record component used by sink-generated records (failure/recovery). */
  component?: string;
  /** First retry delay after a write error; doubles up to 5 s. */
  retryBaseMs?: number;
  now?: () => number;
  pid?: number;
}): StructuredLogSink {
  interface Entry {
    line: string;
    bytes: number;
    /** Segment this record belongs to; queued records keep rotation order. */
    path: string;
  }

  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const maxBytes = Math.max(1, options.maxBytes);
  const retention = options.retention;
  const component = options.component ?? "log-sink";
  const filePrefix =
    options.filePrefix.replace(/[^a-zA-Z0-9._-]/g, "-") || "clash";
  const runId = `${options.filePrefix}-${pid}-${now()}`;
  /** Bounded tail retained while the disk is unavailable. */
  const maxPendingRecords = 10_000;
  const maxPendingBytes = 8 * 1024 * 1024;
  const retryBaseMs = Math.max(1, options.retryBaseMs ?? 100);
  const retryMaxMs = 5_000;

  let segment = 0;
  /** Bytes assigned to the current segment, queued or already written. */
  let currentBytes = 0;
  let currentDay = new Date(now()).toDateString();
  let currentPath = nextPath();
  let pending: Entry[] = [];
  let pendingBytes = 0;
  let dropped = 0;
  let handle: FileHandle | undefined;
  let handlePath: string | undefined;
  let inflight: Promise<void> | undefined;
  let drainQueued = false;
  let retryTimer: NodeJS.Timeout | undefined;
  let retryDelayMs = retryBaseMs;
  let maintenance: Promise<void> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let degraded:
    | {
        code: LogSinkStatusCode;
        attempts: number;
        message: string;
        since: number;
      }
    | undefined;

  function nextPath() {
    return join(
      options.directory,
      `${filePrefix}-${String(now()).padStart(16, "0")}-${pid}-${segment++}.jsonl`,
    );
  }

  const serialize = (record: Record<string, unknown>) =>
    `${JSON.stringify({
      ...((isSanitizedLogRecord(record)
        ? record
        : sanitizeLogValue(record)) as Record<string, unknown>),
      pid,
      runId,
    })}\n`;

  const lineOf = (record: Record<string, unknown>) => {
    const line = serialize(record);
    return { line, bytes: Buffer.byteLength(line) };
  };

  function isActivePath(path: string) {
    if (path === currentPath) return true;
    return pending.some((entry) => entry.path === path);
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function scheduleRetry() {
    if (retryTimer || closed) return;
    const delay = retryDelayMs;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void drain();
    }, delay);
    retryTimer.unref?.();
    retryDelayMs = Math.min(retryDelayMs * 2, retryMaxMs);
  }

  function scheduleDrain() {
    if (drainQueued || closed || retryTimer) return;
    drainQueued = true;
    setImmediate(() => {
      drainQueued = false;
      void drain();
    });
  }

  async function releaseHandle() {
    const openHandle = handle;
    handle = undefined;
    handlePath = undefined;
    if (!openHandle) return;
    try {
      await openHandle.close();
    } catch {
      /* already closed; the fd is gone with it */
    }
  }

  /**
   * Drop the oldest records while the retry tail overflows. The queue can be
   * emptied by a previous drop, so the loop must stop at an empty queue instead
   * of shifting `undefined` (which used to throw out of `write()`).
   */
  function trimPending() {
    while (
      pending.length > 0 &&
      (pending.length > maxPendingRecords || pendingBytes > maxPendingBytes)
    ) {
      const removed = pending.shift()!;
      pendingBytes -= removed.bytes;
      dropped += 1;
    }
  }

  function enqueueFrom(entry: Entry) {
    pending.push(entry);
    pendingBytes += entry.bytes;
    trimPending();
  }

  /**
   * Put the unwritten remainder back at the head so queue order is preserved,
   * then re-apply the bound: records that do not fit are dropped and counted.
   */
  function requeueFront(entries: Entry[]) {
    if (entries.length === 0) return;
    pending = [...entries, ...pending];
    for (const entry of entries) pendingBytes += entry.bytes;
    trimPending();
  }

  function fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const first = !degraded;
    degraded = {
      code: "LOG_SINK_WRITE_FAILED",
      attempts: (degraded?.attempts ?? 0) + 1,
      message,
      since: degraded?.since ?? now(),
    };
    // Retry the bounded tail with backoff; only overflow is lost, and it is counted.
    scheduleRetry();
    if (first) {
      // One fallback line on the real stderr; never a recursive log attempt.
      try {
        process.stderr.write(
          `${JSON.stringify(
            createLogRecord({
              component,
              module: "jsonl",
              level: "error",
              event: "logs.write_failed",
              context: {
                code: "LOG_SINK_WRITE_FAILED",
                message,
                path: currentPath,
              },
            }),
          )}\n`,
        );
      } catch {
        /* closed parent stream */
      }
    }
  }

  function recover() {
    const attempts = degraded?.attempts ?? 0;
    const since = degraded?.since ?? now();
    degraded = undefined;
    retryDelayMs = retryBaseMs;
    const line = lineOf(
      createLogRecord({
        component,
        module: "jsonl",
        level: "info",
        event: "log.sink_recovered",
        context: {
          code: "LOG_SINK_WRITE_FAILED",
          dropped,
          attempts,
          degradedMs: Math.max(0, now() - since),
          path: currentPath,
        },
      }),
    );
    enqueueFrom({ ...line, path: currentPath });
    if (currentBytes === 0) currentBytes = line.bytes;
    else currentBytes += line.bytes;
  }

  async function drain(): Promise<void> {
    if (inflight) return inflight;
    if (closed) return;
    inflight = (async () => {
      while (pending.length > 0 && !closed) {
        const batch = pending.splice(0);
        const bytes = batch.reduce((sum, entry) => sum + entry.bytes, 0);
        // The spliced batch has left the queue, so its bytes leave the count
        // too. Only what is put back after a failure is counted again.
        pendingBytes -= bytes;
        let index = 0;
        try {
          await mkdir(options.directory, { recursive: true, mode: 0o700 });
          while (index < batch.length) {
            const path = batch[index]!.path;
            let end = index + 1;
            while (end < batch.length && batch[end]!.path === path) end += 1;
            if (handlePath !== path) {
              await releaseHandle();
              handle = await open(path, "a", 0o600);
              handlePath = path;
              // Directory scans belong to rotation, never to the per-record hot path.
              void prune();
            }
            const text = batch
              .slice(index, end)
              .map((entry) => entry.line)
              .join("");
            await handle!.write(text, undefined, "utf8");
            index = end;
          }
          retryDelayMs = retryBaseMs;
          if (degraded) recover();
        } catch (error) {
          // Segments before `index` are already appended; re-queuing them would
          // duplicate records once the sink recovers.
          requeueFront(batch.slice(index));
          await releaseHandle();
          fail(error);
          return;
        }
      }
    })().finally(() => {
      inflight = undefined;
      if (pending.length > 0 && !closed && !retryTimer) scheduleDrain();
    });
    return inflight;
  }

  /** Synchronous flush of the bounded tail (shutdown and crash paths). */
  function flushPendingSync() {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    let index = 0;
    try {
      mkdirSync(options.directory, { recursive: true, mode: 0o700 });
      while (index < batch.length) {
        const path = batch[index]!.path;
        let end = index + 1;
        while (end < batch.length && batch[end]!.path === path) end += 1;
        const text = batch
          .slice(index, end)
          .map((entry) => entry.line)
          .join("");
        if (handle && handlePath === path) {
          writeSync(handle.fd, text);
        } else {
          const fd = openSync(path, "a", 0o600);
          try {
            writeSync(fd, text);
          } finally {
            closeSync(fd);
          }
        }
        index = end;
      }
    } catch (error) {
      dropped += batch.length - index;
      if (!degraded) {
        degraded = {
          code: "LOG_SINK_WRITE_FAILED",
          attempts: 1,
          message: error instanceof Error ? error.message : String(error),
          since: now(),
        };
      }
    }
  }

  function closeFdSync() {
    const openHandle = handle;
    handle = undefined;
    handlePath = undefined;
    // Never close a FileHandle's fd behind its back: the handle would later
    // try to close the same (possibly reused) descriptor during GC.
    if (openHandle) void openHandle.close().catch(() => undefined);
  }

  function pruneSync() {
    if (!retention?.maxTotalBytes && !retention?.maxAgeDays) return;
    try {
      const maxTotalBytes =
        retention?.maxTotalBytes !== undefined
          ? Math.max(0, retention.maxTotalBytes)
          : undefined;
      const cutoff =
        retention?.maxAgeDays !== undefined
          ? now() - Math.max(0, retention.maxAgeDays) * 86_400_000
          : undefined;
      let files = readdirSync(options.directory)
        .filter(
          (file) =>
            file.startsWith(`${filePrefix}-`) && file.endsWith(".jsonl"),
        )
        .flatMap((file) => {
          try {
            const info = statSync(join(options.directory, file));
            return [{ file, modifiedAt: info.mtimeMs, size: info.size }];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          }
        });
      const remove = (file: string) => {
        // The open segment and segments with queued records are always kept.
        if (isActivePath(join(options.directory, file))) return;
        try {
          rmSync(join(options.directory, file), { force: true });
        } catch {
          return;
        }
        files = files.filter((entry) => entry.file !== file);
      };
      if (cutoff !== undefined)
        for (const entry of [...files])
          if (entry.modifiedAt < cutoff) remove(entry.file);
      if (maxTotalBytes !== undefined) {
        files.sort(
          (left, right) =>
            left.modifiedAt - right.modifiedAt ||
            left.file.localeCompare(right.file),
        );
        let total = files.reduce((sum, entry) => sum + entry.size, 0);
        for (const entry of [...files]) {
          if (total <= maxTotalBytes) break;
          const before = files.length;
          remove(entry.file);
          if (files.length < before) total -= entry.size;
        }
      }
    } catch {
      /* Retention is best effort; deletion failures must not affect product work. */
    }
  }

  /** Off-hot-path pruning: one async scan per new segment, coalesced. */
  async function prune(): Promise<void> {
    if (!retention?.maxTotalBytes && !retention?.maxAgeDays) return;
    if (maintenance) return maintenance;
    maintenance = (async () => {
      try {
        const names = await readdir(options.directory);
        const files: Array<{ file: string; modifiedAt: number; size: number }> =
          [];
        for (const file of names) {
          if (!file.startsWith(`${filePrefix}-`) || !file.endsWith(".jsonl"))
            continue;
          try {
            const info = await stat(join(options.directory, file));
            files.push({ file, modifiedAt: info.mtimeMs, size: info.size });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        const maxTotalBytes =
          retention?.maxTotalBytes !== undefined
            ? Math.max(0, retention.maxTotalBytes)
            : undefined;
        const cutoff =
          retention?.maxAgeDays !== undefined
            ? now() - Math.max(0, retention.maxAgeDays) * 86_400_000
            : undefined;
        let retained = files;
        const remove = async (file: string) => {
          if (isActivePath(join(options.directory, file))) return false;
          await rm(join(options.directory, file), { force: true });
          retained = retained.filter((entry) => entry.file !== file);
          return true;
        };
        if (cutoff !== undefined)
          for (const entry of [...retained])
            if (entry.modifiedAt < cutoff) await remove(entry.file);
        if (maxTotalBytes !== undefined) {
          retained.sort(
            (left, right) =>
              left.modifiedAt - right.modifiedAt ||
              left.file.localeCompare(right.file),
          );
          let total = retained.reduce((sum, entry) => sum + entry.size, 0);
          for (const entry of [...retained]) {
            if (total <= maxTotalBytes) break;
            if (await remove(entry.file)) total -= entry.size;
          }
        }
      } catch {
        /* Retention is best effort; deletion failures must not affect product work. */
      }
    })().finally(() => {
      maintenance = undefined;
    });
    return maintenance;
  }

  return {
    write(record) {
      if (closed) return;
      const entry = lineOf(record);
      const day = new Date(now()).toDateString();
      if (
        currentBytes > 0 &&
        (currentBytes + entry.bytes > maxBytes || day !== currentDay)
      ) {
        currentPath = nextPath();
        currentBytes = 0;
        currentDay = day;
      }
      currentBytes += entry.bytes;
      enqueueFrom({ ...entry, path: currentPath });
      scheduleDrain();
    },
    async flush() {
      while (inflight) await inflight;
      if (pending.length > 0 && !closed && !retryTimer) await drain();
    },
    flushSync() {
      flushPendingSync();
    },
    async close() {
      if (closing) return closing;
      closed = true;
      clearRetry();
      // No write in flight: flush synchronously so callers that read the file
      // immediately after close() observe every record.
      if (!inflight) {
        flushPendingSync();
        pruneSync();
        closeFdSync();
        closing = Promise.resolve();
        return closing;
      }
      closing = inflight
        .catch(() => {
          /* already recorded as degraded */
        })
        .then(() => {
          flushPendingSync();
          pruneSync();
          closeFdSync();
        });
      return closing;
    },
    health() {
      if (degraded) {
        return {
          status: "degraded",
          code: degraded.code,
          dropped,
          attempts: degraded.attempts,
          retryDelayMs,
          message: degraded.message,
        };
      }
      return { status: "healthy", ...(dropped > 0 ? { dropped } : {}) };
    },
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
  /** Process-wide admission cap; excess records are counted in one summary. */
  maxEventsPerSecond?: number;
  /**
   * Reserved admission rate for warnings/errors, so an info flood cannot
   * starve the records that explain a failure. Defaults to 20% of the rate.
   */
  maxCriticalPerSecond?: number;
  /** Emit the pending summary when a quiet window ends (default true). */
  scheduleSummary?: boolean;
  now?: () => number;
}): { emit(value: T, priority?: boolean): boolean; flush(): void } {
  const now = options.now ?? Date.now;
  const maxEventsPerWindow = Math.max(1, options.maxEventsPerWindow);
  const windowMs = Math.max(1, options.windowMs);
  const rate = options.maxEventsPerSecond
    ? Math.max(1, options.maxEventsPerSecond)
    : undefined;
  const criticalRate = rate
    ? Math.max(1, options.maxCriticalPerSecond ?? Math.ceil(rate / 5))
    : undefined;
  const bucketSize = rate ? rate * 2 : 0;
  const criticalBucketSize = criticalRate ? criticalRate * 2 : 0;
  let tokens = bucketSize;
  let bucketUpdatedAt = now();
  let criticalTokens = criticalBucketSize;
  let criticalBucketUpdatedAt = now();
  let windowStartedAt = now();
  let emittedCount = 0;
  let suppressedCount = 0;
  let distinctCountCapped = false;
  let summaryTimer: NodeJS.Timeout | undefined;
  const emittedKeys = new Set<string>();
  const suppressedKeys = new Set<string>();

  const clearSummaryTimer = () => {
    if (summaryTimer) clearTimeout(summaryTimer);
    summaryTimer = undefined;
  };

  const reset = () => {
    windowStartedAt = now();
    emittedCount = 0;
    suppressedCount = 0;
    distinctCountCapped = false;
    emittedKeys.clear();
    suppressedKeys.clear();
  };

  const flush = () => {
    clearSummaryTimer();
    if (suppressedCount > 0) {
      options.emitSuppressed({
        suppressedCount,
        distinctCount: suppressedKeys.size,
        ...(distinctCountCapped ? { distinctCountCapped: true as const } : {}),
      });
    }
    reset();
  };

  /** A quiet interval still reports what it dropped; no timer while idle. */
  const scheduleSummary = () => {
    if (summaryTimer || options.scheduleSummary === false) return;
    const remaining = Math.max(0, windowMs - (now() - windowStartedAt));
    summaryTimer = setTimeout(() => {
      summaryTimer = undefined;
      flush();
    }, remaining);
    summaryTimer.unref?.();
  };

  const takeToken = (critical: boolean) => {
    if (!rate || (critical && !criticalRate)) return true;
    const at = now();
    if (critical) {
      criticalTokens = Math.min(
        criticalBucketSize,
        criticalTokens + ((at - criticalBucketUpdatedAt) / 1_000) * criticalRate!,
      );
      criticalBucketUpdatedAt = at;
      if (criticalTokens < 1) return false;
      criticalTokens -= 1;
      return true;
    }
    tokens = Math.min(
      bucketSize,
      tokens + ((at - bucketUpdatedAt) / 1_000) * rate,
    );
    bucketUpdatedAt = at;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  return {
    emit(value, priority = false) {
      if (now() - windowStartedAt >= windowMs) flush();
      const key = options.keyOf(value);
      const critical = options.isCritical?.(value) ?? false;
      if (
        (!priority && !takeToken(critical)) ||
        emittedKeys.has(key) ||
        (!priority &&
          emittedCount >= maxEventsPerWindow &&
          !critical)
      ) {
        suppressedCount += 1;
        if (suppressedKeys.size < maxEventsPerWindow) suppressedKeys.add(key);
        else if (!suppressedKeys.has(key)) distinctCountCapped = true;
        scheduleSummary();
        return false;
      }
      if (emittedKeys.size >= Math.max(32, maxEventsPerWindow * 2))
        emittedKeys.delete(emittedKeys.values().next().value!);
      emittedKeys.add(key);
      emittedCount += 1;
      options.emit(value);
      return true;
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
  /** Flush pending framing and the sink; await for an ordered normal shutdown. */
  close(): Promise<void>;
}

export function installProcessStdioCapture(options: {
  component: string;
  stdout?: CapturableLogStream;
  stderr?: CapturableLogStream;
  console?: Pick<Console, "debug" | "info" | "log" | "warn" | "error">;
  sink: StructuredLogSink;
  maxEventsPerWindow: number;
  windowMs: number;
  /** Process-wide admission cap; excess lines are counted, not serialized. */
  maxRecordsPerSecond?: number;
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
      persist(
        makeRecord("info", "log.suppressed", {
          count: summary.suppressedCount,
          suppressedCount: summary.suppressedCount,
          distinctCount: summary.distinctCount,
          ...(summary.distinctCountCapped
            ? { distinctCountCapped: true }
            : {}),
        }),
      ),
    keyOf: ({ level, module, event, context }) =>
      JSON.stringify([level, module, event, context]),
    isCritical: ({ level }) => level === "warn" || level === "error",
    maxEventsPerWindow: options.maxEventsPerWindow,
    windowMs: options.windowMs,
    maxEventsPerSecond: options.maxRecordsPerSecond ?? 50,
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
  /**
   * Structured records bypass the console round-trip: the Host's own logger
   * hands the record object to the sink directly. Startup still mirrors the
   * JSON line to the real stream until the detached Host reaches readiness.
   */
  const writeStructuredRecord = (record: LogRecord) => {
    if (!open) return;
    const emitted = emitter.emit(record);
    if (!emitted || !forwardStdio) return;
    const toStderr = record.level === "warn" || record.level === "error";
    try {
      Reflect.apply(toStderr ? originalStderrWrite : originalStdoutWrite, toStderr ? stderr : stdout, [
        `${JSON.stringify(record)}\n`,
      ]);
    } catch {
      /* closed parent stream */
    }
  };
  setStructuredLogRecordWriter(writeStructuredRecord);

  /** Crash path: flush framing and the sink synchronously, then release. */
  const onProcessExit = () => {
    try {
      flushers.forEach((flush) => flush());
      emitter.flush();
      options.sink.flushSync?.();
      void options.sink.close();
    } catch {
      /* exit handlers must never throw */
    }
  };
  process.once("exit", onProcessExit);

  return {
    stopStdioForwarding() {
      forwardStdio = false;
    },
    event(level, event, context = {}) {
      // Host-owned lifecycle records are low volume; never lose them to the
      // external-line rate cap (plugin/console storms).
      if (open) emitter.emit(makeRecord(level, event, context), true);
    },
    async close() {
      if (!open) return;
      open = false;
      process.off("exit", onProcessExit);
      flushers.forEach((flush) => flush());
      emitter.flush();
      if (getStructuredLogRecordWriter() === writeStructuredRecord)
        setStructuredLogRecordWriter(undefined);
      stdout.write = originalStdoutWrite;
      stderr.write = originalStderrWrite;
      restoreConsole.forEach((restore) => restore());
      try {
        await options.sink.close();
      } catch {
        /* failed sink already reported */
      }
      sinkOpen = false;
    },
  };
}
