import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createLogRecord } from "./logging.js";
import { readLocalLogs } from "./log-reader.js";

describe("local diagnostic queries", () => {
  it("merges rotations chronologically, filters identities and retains summary counts beyond the result limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-log-query-"));
    try {
      await mkdir(join(directory, "desktop"));
      await mkdir(join(directory, "local-api"));
      const record = (component: string, assetId: string, time: number) =>
        JSON.stringify({
          ...createLogRecord({
            timestamp: new Date(time).toISOString(),
            component,
            module: "assets",
            level: "error",
            event: "asset.failed",
            context: { projectId: "p", assetId, error: new Error("offline") },
          }),
          pid: 42,
          runId: "host-run",
        });
      await writeFile(
        join(directory, "desktop", "desktop-old.jsonl"),
        record("renderer", "a", 1_000) + "\n{broken\n",
      );
      await writeFile(
        join(directory, "local-api", "local-api-new.jsonl"),
        [
          record("local-api", "a", 3_000),
          record("local-api", "other", 4_000),
          record("local-api", "a", 2_000),
        ].join("\n"),
      );
      const result = await readLocalLogs({
        directory,
        projectId: "p",
        assetId: "a",
        limit: 1,
      });
      expect(result.matched).toBe(3);
      expect(result.invalidLines).toBe(1);
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({
        component: "local-api",
        timestamp: new Date(3_000).toISOString(),
        runId: "host-run",
        pid: 42,
        line: 1,
        file: join(directory, "local-api", "local-api-new.jsonl"),
      });
      const recent = await readLocalLogs({
        directory,
        component: "renderer",
        since: 2_000,
      });
      expect(recent.records).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads existing renderer envelopes and masks URL credentials without rewriting the file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-log-legacy-"));
    try {
      await mkdir(join(directory, "desktop"));
      const path = join(directory, "desktop", "desktop-legacy.jsonl");
      await writeFile(
        path,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          event: "renderer.console",
          context: {
            windowId: 1,
            message: "Failed https://host.test/asset?token=secret",
          },
        }) + "\n",
      );
      const result = await readLocalLogs({
        directory,
        component: "renderer",
        level: "warn",
      });
      expect(result.records[0]).toMatchObject({
        legacy: true,
        component: "renderer",
        context: { windowId: 1, message: "Failed https://host.test/asset" },
      });
      expect(JSON.stringify(result)).not.toContain("secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports an empty directory without starting a Host", async () => {
    const result = await readLocalLogs({
      directory: join(tmpdir(), "clash-no-log-profile-absent"),
    });
    expect(result.records).toEqual([]);
    expect(result.files).toEqual([]);
  });
});
