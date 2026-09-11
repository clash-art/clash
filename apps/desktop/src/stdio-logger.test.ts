import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDesktopLogger } from "./stdio-logger";

function fakeStream(write: (chunk: string) => boolean = () => true) {
  const emitter = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
  };
  emitter.write = vi.fn(write);
  return emitter as NodeJS.WritableStream & { write: ReturnType<typeof vi.fn> };
}

function epipe(): Error & { code: string } {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
}

function eio(): Error & { code: string } {
  return Object.assign(new Error("write EIO"), { code: "EIO" });
}

describe("desktop stdio logger", () => {
  it("formats successful stdout writes", () => {
    const stdout = fakeStream();
    const logger = createDesktopLogger(stdout, fakeStream());

    logger.info("hello %s", "desktop");

    expect(stdout.write).toHaveBeenCalledWith("hello desktop\n");
  });

  it("mirrors stdio messages into structured records", () => {
    const records: Array<Record<string, unknown>> = [];
    const sink = {
      write: (record: Record<string, unknown>) => records.push(record),
      close: vi.fn(),
    };
    const factory = createDesktopLogger as unknown as (
      stdout: NodeJS.WritableStream,
      stderr: NodeJS.WritableStream,
      options: {
        fileSink: typeof sink;
        now: () => number;
      },
    ) => ReturnType<typeof createDesktopLogger> & { close(): void };
    const logger = factory(fakeStream(), fakeStream(), {
      fileSink: sink,
      now: () => 1_000,
    });

    logger.info("hello %s", "desktop");
    logger.warn("careful");
    logger.close();

    expect(records).toMatchObject([
      {
        timestamp: "1970-01-01T00:00:01.000Z",
        level: "info",
        component: "desktop",
        event: "desktop.console",
        context: { message: "hello desktop" },
      },
      {
        timestamp: "1970-01-01T00:00:01.000Z",
        level: "warn",
        component: "desktop",
        event: "desktop.console",
        context: { message: "careful" },
      },
    ]);
    expect(sink.close).toHaveBeenCalledOnce();
  });

  it("writes named events with queryable context fields", () => {
    const records: Array<Record<string, unknown>> = [];
    const sink = {
      write: (record: Record<string, unknown>) => records.push(record),
      close: vi.fn(),
    };
    const factory = createDesktopLogger as unknown as (
      stdout: NodeJS.WritableStream,
      stderr: NodeJS.WritableStream,
      options: { fileSink: typeof sink; now: () => number },
    ) => ReturnType<typeof createDesktopLogger> & {
      event(
        level: "info" | "warn" | "error",
        event: string,
        context: Record<string, unknown>,
      ): void;
    };
    const logger = factory(fakeStream(), fakeStream(), {
      fileSink: sink,
      now: () => 2_000,
    });

    expect((logger as { event?: unknown }).event).toBeTypeOf("function");
    logger.event("error", "renderer.crashed", {
      windowId: 7,
      exitCode: 5,
    });

    expect(records).toMatchObject([
      {
        timestamp: "1970-01-01T00:00:02.000Z",
        level: "error",
        event: "renderer.crashed",
        context: { windowId: 7, exitCode: 5 },
      },
    ]);
  });

  it("drops future stdout logs after a synchronous EPIPE", () => {
    const stdout = fakeStream(() => {
      throw epipe();
    });
    const logger = createDesktopLogger(stdout, fakeStream());

    expect(() => logger.info("first")).not.toThrow();
    expect(() => logger.info("second")).not.toThrow();

    expect(stdout.write).toHaveBeenCalledTimes(1);
  });

  it("drops future stderr logs after an asynchronous EPIPE", () => {
    const stderr = fakeStream();
    const logger = createDesktopLogger(fakeStream(), stderr);

    stderr.emit("error", epipe());
    expect(() => logger.error("after close")).not.toThrow();

    expect(stderr.write).not.toHaveBeenCalled();
  });

  it("treats an asynchronous macOS PTY EIO as a closed stderr stream", () => {
    const stderr = fakeStream();
    const logger = createDesktopLogger(fakeStream(), stderr);

    expect(() => stderr.emit("error", eio())).not.toThrow();
    expect(() => logger.error("after PTY close")).not.toThrow();

    expect(stderr.write).not.toHaveBeenCalled();
  });

  it("rotates structured JSONL logs and removes files beyond retention", async () => {
    const module = (await import("./stdio-logger")) as unknown as {
      createDesktopFileLogSink?: (options: {
        directory: string;
        maxBytes: number;
        maxFiles: number;
        now: () => number;
        pid: number;
      }) => {
        write(record: Record<string, unknown>): void;
        close(): void;
      };
    };
    const directory = mkdtempSync(join(tmpdir(), "clash-desktop-logs-"));

    try {
      expect(module.createDesktopFileLogSink).toBeTypeOf("function");
      let now = 1_000;
      const sink = module.createDesktopFileLogSink?.({
        directory,
        maxBytes: 1,
        maxFiles: 2,
        now: () => now++,
        pid: 42,
      });
      sink?.write({ event: "first" });
      sink?.write({ event: "second" });
      sink?.write({ event: "third" });
      sink?.close();

      const files = readdirSync(directory)
        .filter((file) => file.endsWith(".jsonl"))
        .sort();
      expect(files).toHaveLength(2);
      const retained = files.flatMap((file) =>
        readFileSync(join(directory, file), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string }),
      );
      expect(retained.map((record) => record.event)).toEqual([
        "second",
        "third",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("summarizes repeated and burst logs instead of emitting every record", async () => {
    const module = (await import("./stdio-logger")) as unknown as {
      createDeduplicatedLogEmitter?: <T>(options: {
        emit: (value: T) => void;
        emitSuppressed: (summary: {
          suppressedCount: number;
          distinctCount: number;
        }) => void;
        keyOf: (value: T) => string;
        maxEventsPerWindow: number;
        windowMs: number;
        now: () => number;
      }) => {
        emit(value: T): void;
        flush(): void;
      };
    };
    const delivered: string[] = [];
    const summaries: Array<{
      suppressedCount: number;
      distinctCount: number;
    }> = [];

    expect(module.createDeduplicatedLogEmitter).toBeTypeOf("function");
    const observer = module.createDeduplicatedLogEmitter?.<string>({
      emit: (value) => delivered.push(value),
      emitSuppressed: (summary) => summaries.push(summary),
      keyOf: (value) => value,
      maxEventsPerWindow: 2,
      windowMs: 1_000,
      now: () => 0,
    });
    observer?.emit("same");
    observer?.emit("same");
    observer?.emit("other");
    observer?.emit("overflow");
    observer?.flush();

    expect(delivered).toEqual(["same", "other"]);
    expect(summaries).toEqual([{ suppressedCount: 2, distinctCount: 2 }]);
  });
});
