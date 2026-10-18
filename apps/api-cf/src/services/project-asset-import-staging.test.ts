import { expect, it, vi } from "vitest";
import { PROJECT_ASSET_IMPORT_SESSION_TTL_MS } from "@clash/shared-runtime/cloud-project-host/project-asset-import-sessions";
import {
  listProjectAssetImportStaging,
  sweepProjectAssetImportStagingBucket,
} from "./project-asset-import-staging.js";

const PREFIX = "project-content-imports/";
const staged = (key: string, uploaded: Date) =>
  ({ key, uploaded }) as unknown as R2Object;

it("paginates R2 list results and maps each uploaded time", async () => {
  const first = new Date("2026-01-01T00:00:00.000Z");
  const second = new Date("2026-01-02T00:00:00.000Z");
  const list = vi.fn(async ({ cursor }: { cursor?: string }) =>
    cursor === "page-2"
      ? {
          objects: [staged("project-content-imports/b", second)],
          truncated: false,
        }
      : {
          objects: [staged("project-content-imports/a", first)],
          truncated: true,
          cursor: "page-2",
        },
  );
  const bucket = { list } as unknown as R2Bucket;

  const entries: Array<{ locator: string; createdAt: number }> = [];
  for await (const entry of listProjectAssetImportStaging(bucket))
    entries.push(entry);

  expect(entries).toEqual([
    { locator: "project-content-imports/a", createdAt: first.getTime() },
    { locator: "project-content-imports/b", createdAt: second.getTime() },
  ]);
  expect(list).toHaveBeenNthCalledWith(1, { prefix: PREFIX });
  expect(list).toHaveBeenNthCalledWith(2, {
    prefix: PREFIX,
    cursor: "page-2",
  });
});

it("deletes only staging older than the session cutoff", async () => {
  const now = Date.parse("2026-02-01T00:00:00.000Z");
  const list = vi.fn(async () => ({
    objects: [
      staged(
        "project-content-imports/old",
        new Date(now - 3 * PROJECT_ASSET_IMPORT_SESSION_TTL_MS),
      ),
      staged(
        "project-content-imports/young",
        new Date(now - PROJECT_ASSET_IMPORT_SESSION_TTL_MS),
      ),
    ],
    truncated: false,
  }));
  const remove = vi.fn(async () => {});
  const bucket = { list, delete: remove } as unknown as R2Bucket;

  const log = { info: vi.fn(), error: vi.fn() };
  await sweepProjectAssetImportStagingBucket(bucket, log, () => now);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith("project-content-imports/old");
  expect(log.info).toHaveBeenCalledWith("project_asset_import_staging.swept", {
    source: "objects",
    scanned: 2,
    deleted: 1,
    failed: 0,
  });
  expect(log.error).not.toHaveBeenCalled();
});

it("logs a coded failure when R2 listing itself fails instead of rejecting the cron", async () => {
  const bucket = {
    list: vi.fn(async () => {
      throw new Error("R2 unavailable");
    }),
  } as unknown as R2Bucket;
  const log = { info: vi.fn(), error: vi.fn() };
  await expect(
    sweepProjectAssetImportStagingBucket(bucket, log),
  ).resolves.toBeUndefined();
  expect(log.error).toHaveBeenCalledWith(
    "project_asset_import_staging.sweep_failed",
    {
      code: "PROJECT_ASSET_IMPORT_STAGING_SWEEP_FAILED",
      source: "objects",
      message: "R2 unavailable",
    },
  );
});
