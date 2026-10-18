import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  openSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Console } from "node:console";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createBoundedJsonlLogSink,
  createDeduplicatedLogEmitter,
  installProcessStdioCapture,
} from "./observability.js";
import { createLogRecord } from "./logging.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    openSync: vi.fn(actual.openSync),
    writeSync: vi.fn(actual.writeSync),
  };
});

interface SinkRecord {
  event: string;
  sequence?: number;
  context?: Record<string, unknown>;
}

/** Read every JSONL segment a sink wrote, in rotation order. */
function readSinkRecords(directory: string): {
  records: SinkRecord[];
  bytes: number;
} {
  const segmentOf = (name: string) =>
    Number(name.replace(/\.jsonl$/, "").split("-").at(-1));
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    // Segment names embed an unpadded counter, so sort numerically.
    .sort((left, right) => segmentOf(left) - segmentOf(right));
  const records: SinkRecord[] = [];
  let bytes = 0;
  for (const file of files) {
    const text = readFileSync(join(directory, file), "utf8");
    bytes += Buffer.byteLength(text);
    for (const line of text.split("\n"))
      if (line) records.push(JSON.parse(line) as SinkRecord);
  }
  return { records, bytes };
}

describe("bounded observability", () => {
  it("does not rescan the directory for each record in an open segment", () => {
    const directory = mkdtempSync(join(tmpdir(), "clash-log-writes-"));
    try {
      const sink = createBoundedJsonlLogSink({
        directory,
        filePrefix: "test-host",
        maxBytes: 1024 * 1024,
        retention: { maxTotalBytes: 5 * 1024 * 1024, maxAgeDays: 7 },
      });
      sink.write({ event: "first" });
      const scans = vi.mocked(readdirSync).mock.calls.length;
      for (let i = 0; i < 30; i++) sink.write({ event: "next", sequence: i });
      expect(vi.mocked(readdirSync).mock.calls.length - scans).toBe(0);
      sink.close();
      const records = readFileSync(
        join(directory, readdirSync(directory)[0]),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({
        event: "next",
        sequence: 29,
        pid: process.pid,
        runId: records[0].runId,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("starts a new file after maxBytes and prunes oldest files over the byte bound", () => {
    const directory = mkdtempSync(join(tmpdir(), "clash-observability-"));

    try {
      let now = 1_000;
      const sink = createBoundedJsonlLogSink({
        directory,
        filePrefix: "test-host",
        maxBytes: 1,
        // Bound by total bytes: three rotated segments cannot all fit,
        // while the newest two do.
        retention: { maxTotalBytes: 150 },
        now: () => now++,
        pid: 42,
      });
      sink.write({ event: "first" });
      sink.write({ event: "second" });
      sink.write({ event: "third" });
      sink.close();

      const files = readdirSync(directory)
        .filter((file) => file.endsWith(".jsonl"))
        .sort();
      const retained = files.map((file) =>
        readFileSync(join(directory, file), "utf8"),
      );
      expect(retained.join("\n")).not.toContain("first");
      expect(retained.join("\n")).toContain("second");
      expect(retained.join("\n")).toContain("third");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("starts a new file when the day changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "clash-log-days-"));
    try {
      let now = new Date(2026, 0, 5, 23, 0, 0).getTime();
      const sink = createBoundedJsonlLogSink({
        directory,
        filePrefix: "test-host",
        maxBytes: 1024 * 1024,
        now: () => now,
        pid: 7,
      });
      sink.write({ event: "before-midnight" });
      now = new Date(2026, 0, 6, 1, 0, 0).getTime();
      sink.write({ event: "after-midnight" });
      sink.close();
      expect(
        readdirSync(directory).filter((file) => file.endsWith(".jsonl")),
      ).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never deletes without a retention bound and keeps the open file", () => {
    const directory = mkdtempSync(join(tmpdir(), "clash-log-keep-"));
    try {
      let now = 1_000;
      const sink = createBoundedJsonlLogSink({
        directory,
        filePrefix: "test-host",
        maxBytes: 1,
        // A caller that cannot read its retention config deletes nothing.
        now: () => now++,
        pid: 7,
      });
      sink.write({ event: "a" });
      sink.write({ event: "b" });
      sink.close();
      expect(
        readdirSync(directory).filter((file) => file.endsWith(".jsonl")),
      ).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("drops files older than maxAgeDays", async () => {
    const directory = mkdtempSync(join(tmpdir(), "clash-log-age-"));
    try {
      const sink = createBoundedJsonlLogSink({
        directory,
        filePrefix: "test-host",
        maxBytes: 1,
        retention: { maxAgeDays: 1 },
        pid: 7,
      });
      sink.write({ event: "old" });
      await sink.flush?.();
      const [oldFile] = readdirSync(directory).filter((file) =>
        file.endsWith(".jsonl"),
      );
      // The older segment's mtime predates the retention cutoff.
      const past = new Date(Date.now() - 2 * 86_400_000);
      utimesSync(join(directory, oldFile!), past, past);
      sink.write({ event: "newest" });
      sink.close();
      const retained = readdirSync(directory)
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => readFileSync(join(directory, file), "utf8"))
        .join("\n");
      expect(retained).not.toContain('"old"');
      expect(retained).toContain('"newest"');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("emits one copy of a repeated message and a bounded suppression summary", () => {
    const emitted: string[] = [];
    const summaries: Array<{ suppressedCount: number; distinctCount: number }> =
      [];
    const emitter = createDeduplicatedLogEmitter<string>({
      emit: (message) => emitted.push(message),
      emitSuppressed: (summary) => summaries.push(summary),
      keyOf: (message) => message,
      maxEventsPerWindow: 2,
      windowMs: 1_000,
      now: () => 0,
    });

    emitter.emit("same");
    emitter.emit("same");
    emitter.emit("different");
    emitter.emit("overflow");
    emitter.flush();

    expect(emitted).toEqual(["same", "different"]);
    expect(summaries).toEqual([{ suppressedCount: 2, distinctCount: 2 }]);
  });

  it("captures process stdio as structured records while preserving the original streams", () => {
    const stdout = { write: vi.fn((_chunk: unknown) => true) };
    const stderr = { write: vi.fn((_chunk: unknown) => true) };
    const records: Array<Record<string, unknown>> = [];
    const sink = {
      write: (record: Record<string, unknown>) => records.push(record),
      close: vi.fn(),
    };
    const capture = installProcessStdioCapture({
      component: "local-api",
      stdout,
      stderr,
      sink,
      now: () => 1_000,
      maxEventsPerWindow: 10,
      windowMs: 1_000,
    });

    stdout.write("ready\n");
    stderr.write(Buffer.from("failed\n"));
    capture.event("error", "process.crashed", { exitCode: 5 });
    capture.close();

    expect(stdout.write).toHaveBeenCalledWith("ready\n");
    expect(stderr.write).toHaveBeenCalledWith(Buffer.from("failed\n"));
    expect(records).toMatchObject([
      {
        timestamp: "1970-01-01T00:00:01.000Z",
        component: "local-api",
        level: "info",
        event: "process.stdout",
        context: { message: "ready" },
      },
      {
        timestamp: "1970-01-01T00:00:01.000Z",
        component: "local-api",
        level: "warn",
        event: "process.stderr",
        context: { message: "failed" },
      },
      {
        timestamp: "1970-01-01T00:00:01.000Z",
        component: "local-api",
        level: "error",
        event: "process.crashed",
        context: { exitCode: 5 },
      },
    ]);
    expect(sink.close).toHaveBeenCalledOnce();
  });

  it("frames chunked JSON and preserves console severity without double-encoding", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const targetConsole = new Console(stdout, stderr);
    const records: Array<Record<string, unknown>> = [];
    const capture = installProcessStdioCapture({
      component: "local-api",
      stdout,
      stderr,
      console: targetConsole,
      sink: { write: (record) => records.push(record), close() {} },
      maxEventsPerWindow: 2,
      windowMs: 1_000,
    });
    const record = createLogRecord({
      component: "local-api",
      module: "assets",
      level: "error",
      event: "asset.failed",
      context: { assetId: "a" },
    });
    const line = JSON.stringify(record);
    stdout.write(line.slice(0, 25));
    stdout.write(line.slice(25) + "\nready\n");
    targetConsole.warn("retry");
    targetConsole.error("failed after retries");
    stderr.write("partial final line");
    capture.close();
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "asset.failed",
        level: "error",
        context: { assetId: "a" },
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "process.console",
        level: "error",
        context: { message: "failed after retries" },
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "process.stderr",
        context: { message: "partial final line" },
      }),
    );
  });

  it("keeps distinct errors during an info flood and bounds suppression fingerprints", () => {
    const emitted: string[] = [];
    const summaries: unknown[] = [];
    const emitter = createDeduplicatedLogEmitter<string>({
      emit: (value) => emitted.push(value),
      emitSuppressed: (value) => summaries.push(value),
      keyOf: (value) => value,
      isCritical: (value) => value.startsWith("error"),
      maxEventsPerWindow: 2,
      windowMs: 1_000,
    });
    for (let i = 0; i < 100; i++) emitter.emit(`info-${i}`);
    emitter.emit("error-a");
    emitter.emit("error-a");
    emitter.emit("error-b");
    emitter.flush();
    expect(emitted).toContain("error-a");
    expect(emitted).toContain("error-b");
    expect(emitted.filter((value) => value === "error-a")).toHaveLength(1);
    expect(summaries).toContainEqual(
      expect.objectContaining({
        suppressedCount: 99,
        distinctCountCapped: true,
      }),
    );
  });

  it("stops growing a detached Host's startup fallback after readiness while retaining runtime records", async () => {
    const originalWrite = vi.fn((_chunk: unknown) => true);
    const stdout = { write: originalWrite };
    const records: Array<Record<string, unknown>> = [];
    const capture = installProcessStdioCapture({
      component: "local-api",
      stdout,
      stderr: { write: vi.fn(() => true) },
      sink: { write: (record) => records.push(record), close() {} },
      maxEventsPerWindow: 10,
      windowMs: 1_000,
    });
    stdout.write("starting\n");
    capture.stopStdioForwarding();
    stdout.write("runtime\n");
    await Promise.resolve();
    capture.close();
    expect(originalWrite).toHaveBeenCalledExactlyOnceWith("starting\n");
    expect(records).toContainEqual(
      expect.objectContaining({ context: { message: "runtime" } }),
    );
    expect(stdout.write).toBe(originalWrite);
  });

  it("persists asynchronously in order and never writes synchronously per record", async () => {
    const directory = mkdtempSync(join(tmpdir(), "clash-log-async-"));
    try {
      const sink = createBoundedJsonlLogSink({
        directory,
        filePrefix: "test-host",
        maxBytes: 1024 * 1024,
        pid: 9,
      });
      // Ignore unrelated sync fs calls made while creating the temporary path.
      vi.mocked(writeSync).mockClear();
      vi.mocked(openSync).mockClear();
      for (let i = 0; i < 500; i++) sink.write({ event: "record", sequence: i });
      // The write path is asynchronous: no sync open/write happened for any record.
      expect(vi.mocked(writeSync).mock.calls).toHaveLength(0);
      expect(vi.mocked(openSync).mock.calls).toHaveLength(0);
      await sink.flush?.();
      const records = readFileSync(
        join(directory, readdirSync(directory)[0]!),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { sequence: number });
      expect(records.map((record) => record.sequence)).toEqual(
        Array.from({ length: 500 }, (_, i) => i),
      );
      await sink.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("flushes queued records synchronously on the crash path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "clash-log-crash-"));
    try {
      const sink = createBoundedJsonlLogSink({
        directory,
        filePrefix: "test-host",
        maxBytes: 1024 * 1024,
      });
      sink.write({ event: "before.exit", sequence: 1 });
      sink.write({ event: "before.exit", sequence: 2 });
      sink.flushSync?.();
      const files = readdirSync(directory).filter((file) =>
        file.endsWith(".jsonl"),
      );
      const records = readFileSync(join(directory, files[0]!), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { sequence: number });
      expect(records.map((record) => record.sequence)).toEqual([1, 2]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("flushes capture records when the process exits without closing", () => {
    const directory = mkdtempSync(join(tmpdir(), "clash-log-exit-"));
    const fixture = fileURLToPath(
      new URL("./observability-crash.fixture.ts", import.meta.url),
    );
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    try {
      expect(() =>
        execFileSync(process.execPath, ["--import", "tsx", fixture, directory], {
          cwd: packageRoot,
          stdio: "pipe",
          timeout: 30_000,
        }),
      ).toThrow();
      const files = readdirSync(directory).filter((file) =>
        file.endsWith(".jsonl"),
      );
      expect(files).toHaveLength(1);
      const events = readFileSync(join(directory, files[0]!), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string });
      expect(events.map((record) => record.event)).toEqual(
        expect.arrayContaining(["before.crash", "process.stderr"]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("degrades on a write error, keeps a bounded tail, and recovers with a dropped count", async () => {
    const root = mkdtempSync(join(tmpdir(), "clash-log-recover-"));
    const blocked = join(root, "blocked");
    const directory = join(blocked, "logs");
    writeFileSync(blocked, "not a directory");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const sink = createBoundedJsonlLogSink({
        directory,
        filePrefix: "test-host",
        maxBytes: 1024 * 1024,
        retryBaseMs: 5,
      });
      sink.write({ event: "first.during.failure", sequence: 1 });
      await vi.waitFor(
        () => expect(sink.health?.()).toMatchObject({ status: "degraded" }),
        { timeout: 2_000 },
      );
      expect(sink.health?.()).toMatchObject({
        status: "degraded",
        code: "LOG_SINK_WRITE_FAILED",
      });
      // The sink reports once on the real stderr and keeps the record for retry.
      expect(stderr).toHaveBeenCalled();

      // Overflow the bounded 8 MiB retry tail while the disk is unavailable:
      // the oldest records are dropped and counted, the newest survives.
      const payload = "x".repeat(20_000);
      for (let i = 0; i < 2_500; i++)
        sink.write({ event: "backlog", sequence: i, text: payload });
      sink.write({ event: "kept.during.failure", sequence: 501 });
      expect(sink.health?.()).toMatchObject({
        status: "degraded",
        dropped: expect.any(Number),
      });
      expect((sink.health?.() as { dropped: number }).dropped).toBeGreaterThan(0);

      rmSync(blocked, { force: true });
      mkdirSync(blocked, { recursive: true });
      await vi.waitFor(
        () => expect(sink.health?.()).toMatchObject({ status: "healthy" }),
        { timeout: 5_000 },
      );
      await sink.close();
      const files = readdirSync(directory).filter((file) =>
        file.endsWith(".jsonl"),
      );
      const records = files
        .flatMap((file) =>
          readFileSync(join(directory, file), "utf8")
            .trim()
            .split("\n"),
        )
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; context: Record<string, unknown> });
      expect(records.map((record) => record.event)).toContain(
        "kept.during.failure",
      );
      expect(
        records.find((record) => record.event === "log.sink_recovered")
          ?.context,
      ).toMatchObject({ dropped: expect.any(Number) });
      expect(
        (records.find((record) => record.event === "log.sink_recovered")
          ?.context.dropped as number) ?? 0,
      ).toBeGreaterThan(0);
    } finally {
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps write() safe and the retry tail bounded through repeated failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "clash-log-repeat-fail-"));
    const blocked = join(root, "blocked");
    const directory = join(blocked, "logs");
    writeFileSync(blocked, "not a directory");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    // Compress only the sink's retry backoff; unrelated timers keep their delay.
    const realSetTimeout = globalThis.setTimeout;
    const fastTimers = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        realSetTimeout(
          callback,
          Math.min(delay ?? 0, 2),
          ...args,
        )) as typeof setTimeout);
    try {
      const sink = createBoundedJsonlLogSink({
        directory,
        filePrefix: "test-host",
        // One segment keeps the retained-record order unambiguous; rotation is
        // covered by the mid-batch test below.
        maxBytes: 1024 * 1024 * 1024,
        retryBaseMs: 1,
      });
      // Fill the bounded 8 MiB / 10k-record retry tail while every attempt fails.
      // Sanitizing caps each string field at 4k characters and a record at 24k.
      const chunks = Array.from({ length: 6 }, () => "x".repeat(4_000));
      const written: number[] = [];
      const write = (sequence: number) => {
        written.push(sequence);
        // A full queue used to shift an empty array here and throw out of write().
        sink.write({ event: "storm", sequence, chunks });
      };
      for (let i = 0; i < 400; i++) write(i);
      await vi.waitFor(
        () => expect(sink.health?.()).toMatchObject({ status: "degraded" }),
        { timeout: 2_000 },
      );
      const droppedWhileBlocked = (sink.health?.() as { dropped: number })
        .dropped;
      expect(droppedWhileBlocked).toBeGreaterThan(0);

      // Let a full queue survive repeated failed retries with no writes in
      // between: the old accounting added the whole batch back on every
      // failure, inflating pendingBytes, and a later write shifted an empty
      // queue and threw a TypeError.
      await vi.waitFor(
        () =>
          expect(
            (sink.health?.() as { attempts?: number }).attempts ?? 0,
          ).toBeGreaterThanOrEqual(20),
        { timeout: 5_000 },
      );
      expect(sink.health?.()).toMatchObject({
        status: "degraded",
        code: "LOG_SINK_WRITE_FAILED",
      });
      // The queue is still full during these writes, so the oldest records are
      // dropped and counted; none of them may throw. The count settles when the
      // in-flight failed batch is re-queued, so wait for it instead of sampling
      // in the middle of that await.
      let sequence = 400;
      for (let i = 0; i < 60; i++) write(sequence++);
      await vi.waitFor(
        () =>
          expect(
            (sink.health?.() as { dropped: number }).dropped,
          ).toBeGreaterThan(droppedWhileBlocked),
        { timeout: 2_000 },
      );
      expect(sink.health?.()).toMatchObject({
        status: "degraded",
        code: "LOG_SINK_WRITE_FAILED",
        dropped: expect.any(Number),
      });

      rmSync(blocked, { force: true });
      mkdirSync(blocked, { recursive: true });
      await vi.waitFor(
        () => expect(sink.health?.()).toMatchObject({ status: "healthy" }),
        { timeout: 10_000 },
      );
      await sink.close();

      const dropped = (sink.health?.() as { dropped: number }).dropped;
      const { records, bytes } = readSinkRecords(directory);
      const stormSequences = records
        .filter((record) => record.event === "storm")
        .map((record) => record.sequence!);
      // Every retained record is present exactly once, in enqueue order, and
      // only the oldest records were dropped.
      expect(new Set(stormSequences).size).toBe(stormSequences.length);
      expect(stormSequences).toEqual(
        written.slice(written.length - stormSequences.length),
      );
      expect(stormSequences.length + dropped).toBe(written.length);
      // The retry tail stayed inside its 8 MiB bound instead of accumulating
      // one batch per failed attempt.
      expect(stormSequences.length).toBeLessThanOrEqual(10_000);
      expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024 + 4_096);
    } finally {
      fastTimers.mockRestore();
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not duplicate written segments when a rotation fails mid-batch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "clash-log-mid-batch-"));
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const fixedNow = 1_000;
    const segmentPath = (segment: number) =>
      join(
        directory,
        `test-host-${String(fixedNow).padStart(16, "0")}-7-${segment}.jsonl`,
      );
    // A directory at segment 1's path makes opening it fail after segment 0
    // has already been appended to.
    mkdirSync(segmentPath(1));
    try {
      const sink = createBoundedJsonlLogSink({
        directory,
        filePrefix: "test-host",
        // Each record rotates, so one drain batch spans three segments.
        maxBytes: 1,
        now: () => fixedNow,
        pid: 7,
        retryBaseMs: 1,
      });
      sink.write({ event: "segment", sequence: 0 });
      sink.write({ event: "segment", sequence: 1 });
      sink.write({ event: "segment", sequence: 2 });
      await vi.waitFor(
        () => expect(sink.health?.()).toMatchObject({ status: "degraded" }),
        { timeout: 2_000 },
      );
      // Only the segment that actually reached the disk is visible; segments 1
      // and 2 are still queued and must not repeat segment 0 later.
      expect(
        readSinkRecords(directory).records.map((record) => record.sequence),
      ).toEqual([0]);

      rmSync(segmentPath(1), { recursive: true, force: true });
      await vi.waitFor(
        () => expect(sink.health?.()).toMatchObject({ status: "healthy" }),
        { timeout: 5_000 },
      );
      await sink.close();
      const sequences = readSinkRecords(directory)
        .records.filter((record) => record.event === "segment")
        .map((record) => record.sequence);
      expect(sequences).toEqual([0, 1, 2]);
    } finally {
      stderr.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("caps a unique-line storm and reports log.suppressed with a count", async () => {
    const stdout = { write: vi.fn((_chunk: unknown) => true) };
    const stderr = { write: vi.fn((_chunk: unknown) => true) };
    const records: Array<{
      event: string;
      level: string;
      context: Record<string, unknown>;
    }> = [];
    let clock = 0;
    const capture = installProcessStdioCapture({
      component: "local-api",
      stdout,
      stderr,
      sink: {
        write: (record) =>
          records.push(record as unknown as (typeof records)[number]),
        close() {},
      },
      maxEventsPerWindow: 200,
      windowMs: 1_000,
      maxRecordsPerSecond: 50,
      now: () => clock,
    });
    for (let i = 0; i < 10_000; i++) stderr.write(`unique failure ${i}\n`);
    // Ten thousand unique lines still cost one bounded batch of records.
    expect(records.length).toBeLessThanOrEqual(101);

    // The next event after the window flushes the counted summary.
    clock = 5_000;
    stderr.write("one more\n");
    await capture.close();
    const suppressed = records.find(
      (record) => record.event === "log.suppressed",
    );
    expect(suppressed?.level).toBe("info");
    expect(suppressed?.context.count).toBeGreaterThan(9_000);
    expect(suppressed?.context.count).toBe(
      suppressed?.context.suppressedCount,
    );
  });

  it("writes structured logger records directly instead of through console", async () => {
    const stdout = { write: vi.fn((_chunk: unknown) => true) };
    const stderr = { write: vi.fn((_chunk: unknown) => true) };
    const targetConsole = {
      debug: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const records: Array<Record<string, unknown>> = [];
    const capture = installProcessStdioCapture({
      component: "local-api",
      stdout,
      stderr,
      console: targetConsole,
      sink: { write: (record) => records.push(record), close() {} },
      maxEventsPerWindow: 100,
      windowMs: 1_000,
    });
    const { createStructuredLogger } = await import("./logging.js");
    createStructuredLogger({ component: "local-api", module: "test" }).info(
      "asset.loaded",
      { assetId: "a" },
    );
    await capture.close();
    // No console call and no console-formatted output; the one stream write is
    // the already-serialized startup mirror, not a round-trip to be parsed again.
    expect(targetConsole.info).not.toHaveBeenCalled();
    expect(stdout.write).toHaveBeenCalledTimes(1);
    expect(String(stdout.write.mock.calls[0]![0])).toContain(
      '"event":"asset.loaded"',
    );
    expect(records).toContainEqual(
      expect.objectContaining({ event: "asset.loaded", level: "info" }),
    );
  });

  it("never rate-limits Host lifecycle events during an external storm", () => {
    const stdout = { write: vi.fn(() => true) };
    const stderr = { write: vi.fn(() => true) };
    const records: Array<{ event: string }> = [];
    const capture = installProcessStdioCapture({
      component: "local-api",
      stdout,
      stderr,
      sink: { write: (record) => records.push(record as { event: string }), close() {} },
      maxEventsPerWindow: 200,
      windowMs: 1_000,
      maxRecordsPerSecond: 1,
      now: () => 0,
    });
    for (let i = 0; i < 500; i++) stderr.write(`storm ${i}\n`);
    capture.event("info", "server.stopping", { exitCode: 0 });
    capture.event("info", "server.stopped", { exitCode: 0 });
    expect(records.map((record) => record.event)).toEqual(
      expect.arrayContaining(["server.stopping", "server.stopped"]),
    );
  });

  it("keeps a multiline console Error in one diagnostic with its code and stack", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const targetConsole = new Console(stdout, stderr);
    const records: Array<Record<string, unknown>> = [];
    const capture = installProcessStdioCapture({
      component: "local-api",
      stdout,
      stderr,
      console: targetConsole,
      sink: { write: (record) => records.push(record), close() {} },
      maxEventsPerWindow: 10,
      windowMs: 1_000,
    });
    targetConsole.error(
      "request failed",
      Object.assign(new Error("offline"), { code: "ECONNRESET" }),
    );
    capture.close();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "error",
      context: {
        error: {
          code: "ECONNRESET",
          message: "offline",
          stack: expect.stringContaining("offline"),
        },
      },
    });
  });
});
