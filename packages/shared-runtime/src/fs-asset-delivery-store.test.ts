import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFsAssetDeliveryStore } from "./fs-asset-delivery-store.js";
import { sweepFsProjectAssetImportStaging } from "./fs-import-staging-sweep.js";
import { PROJECT_ASSET_IMPORT_SESSION_TTL_MS } from "./cloud-project-host/project-asset-import-sessions.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("lists published objects with their file mtimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-fs-asset-store-"));
  roots.push(root);
  const store = createFsAssetDeliveryStore(root);
  const oldLocator = "project-content-imports/old-object";
  const youngLocator = "project-content-imports/nested/young-object";
  await store.put(oldLocator, new TextEncoder().encode("old"));
  await store.put(youngLocator, new TextEncoder().encode("young"));

  const oldTime = new Date("2026-01-01T00:00:00.000Z");
  const youngTime = new Date("2026-01-02T00:00:00.000Z");
  await utimes(join(root, "objects", oldLocator), oldTime, oldTime);
  await utimes(join(root, "objects", youngLocator), youngTime, youngTime);

  const entries: Array<{ locator: string; createdAt: number }> = [];
  for await (const entry of store.list()) entries.push(entry);

  expect(entries).toEqual(
    expect.arrayContaining([
      { locator: oldLocator, createdAt: oldTime.getTime() },
      { locator: youngLocator, createdAt: youngTime.getTime() },
    ]),
  );
});

it("sweeps an abandoned multipart upload (parts, never completed) and keeps a live one", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-fs-asset-store-"));
  roots.push(root);
  const store = createFsAssetDeliveryStore(root);
  const session = (uploadId: string, locator: string) => ({
    uploadId,
    target: { identity: `import:${locator}`, locator, byteLength: 4, digest: "" },
  });
  const abandoned = session("abandoned-upload-0001", "project-content-imports/abandoned");
  const live = session("live-upload-00000002", "project-content-imports/live");
  for (const s of [abandoned, live]) {
    await store.multipart!.begin(s as never);
    await store.multipart!.part(s as never, 1, new TextEncoder().encode("data"));
  }
  // Backdate every file of the abandoned session past the cutoff.
  const uploads: Array<{ locator: string; createdAt: number }> = [];
  for await (const entry of store.listUploads()) uploads.push(entry);
  expect(uploads).toHaveLength(2);
  const old = new Date(Date.now() - 3 * PROJECT_ASSET_IMPORT_SESSION_TTL_MS);
  const abandonedEntry = uploads.find((entry) => entry.locator.endsWith("/abandoned-upload-0001"))!;
  const dir = join(root, "staging", abandonedEntry.locator);
  for (const name of await readdir(dir)) await utimes(join(dir, name), old, old);
  await utimes(dir, old, old);

  const log = { info: vi.fn(), error: vi.fn() };
  await sweepFsProjectAssetImportStaging(store, log);

  const left: string[] = [];
  for await (const entry of store.listUploads()) left.push(entry.locator);
  expect(left).toHaveLength(1);
  expect(left[0]).toMatch(/\/live-upload-00000002$/);
  expect(log.info).toHaveBeenCalledWith("project_asset_import_staging.swept", {
    source: "uploads",
    scanned: 2,
    deleted: 1,
    failed: 0,
  });
  expect(log.error).not.toHaveBeenCalled();
});

it("refuses an upload locator outside the staging layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-fs-asset-store-"));
  roots.push(root);
  const store = createFsAssetDeliveryStore(root);
  await expect(store.deleteUpload("../objects")).rejects.toThrow("Invalid upload locator");
});
