import { describe, expect, it, vi } from "vitest";
import {
  createStructuredLogger,
  parseLogRecord,
  sanitizeLogValue,
} from "./logging.js";

describe("shared diagnostic records", () => {
  it("does not evaluate disabled debug context; errors retain identity, code and cause", () => {
    const write = vi.fn();
    const context = vi.fn();
    const logger = createStructuredLogger({
      component: "renderer",
      module: "sync",
      write,
    });
    logger.debug("sync.connecting", context);
    expect(context).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    const error = Object.assign(
      new Error("projection failed", { cause: new Error("connection closed") }),
      { code: "ECONNRESET" },
    );
    logger.error("asset.resolve_failed", {
      projectId: "project-a",
      assetId: "asset-b",
      error,
    });
    const record = parseLogRecord(JSON.stringify(write.mock.calls[0][0]));
    expect(record).toMatchObject({
      component: "renderer",
      module: "sync",
      level: "error",
      event: "asset.resolve_failed",
      context: {
        projectId: "project-a",
        assetId: "asset-b",
        error: {
          name: "Error",
          message: "projection failed",
          code: "ECONNRESET",
          stack: expect.stringContaining("projection failed"),
          cause: { message: "connection closed" },
        },
      },
    });
  });

  it("redacts credentials and payloads and safely serializes cyclic or hostile context", () => {
    const value: Record<string, unknown> = {
      projectId: "p",
      token: "secret",
      prompt: "private draft",
      url: "https://user:pass@host.test/assets/a?token=secret#secret",
      error: new Error("GET https://host.test/a?signature=secret failed"),
      count: 9n,
    };
    value.self = value;
    Object.defineProperty(value, "hostile", {
      enumerable: true,
      get() {
        throw new Error("getter");
      },
    });
    const serialized = JSON.stringify(sanitizeLogValue(value));
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("private draft");
    expect(JSON.parse(serialized)).toMatchObject({
      projectId: "p",
      count: "9",
      url: "https://host.test/assets/a",
      self: "[Circular]",
    });
  });

  it("summarizes repeated warnings without losing distinct failures or logging every retry", () => {
    const records: unknown[] = [];
    let now = 0;
    const logger = createStructuredLogger({
      component: "renderer",
      module: "assets",
      write: (record) => records.push(record),
      now: () => now,
    });
    for (let i = 0; i < 30; i++)
      logger.warn("asset.resolve_failed", {
        assetId: "a",
        error: new Error("offline"),
      });
    logger.error("asset.resolve_failed", {
      assetId: "b",
      error: new Error("denied"),
    });
    expect(records).toHaveLength(2);
    now = 11_000;
    logger.info("asset.ready", { assetId: "a" });
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "logs.suppressed",
        context: expect.objectContaining({
          suppressedCount: 29,
          events: { "asset.resolve_failed": 29 },
        }),
      }),
    );
  });

  it("does not let diagnostic failures change application behavior", () => {
    const logger = createStructuredLogger({
      component: "renderer",
      module: "test",
      write() {
        throw new Error("closed");
      },
    });
    expect(() =>
      logger.error("failed", () => {
        throw new Error("context");
      }),
    ).not.toThrow();
    expect(() =>
      logger.error("failed", { error: new Error("original") }),
    ).not.toThrow();
  });
});
