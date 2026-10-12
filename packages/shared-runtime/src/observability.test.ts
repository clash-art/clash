import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
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
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

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

  it("drops files older than maxAgeDays", () => {
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
