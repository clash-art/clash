import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createLogRecord } from "@clash/shared-runtime/logging";
import { logsCommand, runLogs } from "./logs";

it("queries offline logs and returns machine-readable context and file locations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clash-cli-logs-"));
  try {
    await mkdir(join(directory, "local-api"));
    await writeFile(
      join(directory, "local-api", "local-api-fixture.jsonl"),
      JSON.stringify(
        createLogRecord({
          component: "local-api",
          module: "assets",
          event: "asset.failed",
          level: "error",
          context: {
            projectId: "p",
            assetId: "a",
            error: new Error("not found"),
          },
        }),
      ) + "\n",
    );
    const stdout = vi.fn();
    const result = await runLogs({
      directory,
      json: true,
      projectId: "p",
      stdout,
    });
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({
      matched: 1,
      records: [
        {
          event: "asset.failed",
          line: 1,
          context: { assetId: "a", error: { message: "not found" } },
        },
      ],
    });
    expect(result.files[0]).toBe(
      join(directory, "local-api", "local-api-fixture.jsonl"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects invalid query options before reading any logs", async () => {
  logsCommand.exitOverride().configureOutput({ writeErr() {} });
  await expect(
    logsCommand.parseAsync(["--since", "yesterday"], { from: "user" }),
  ).rejects.toThrow("Use a duration");
  await expect(
    logsCommand.parseAsync(["--limit", "NaN"], { from: "user" }),
  ).rejects.toThrow("Limit must");
});
