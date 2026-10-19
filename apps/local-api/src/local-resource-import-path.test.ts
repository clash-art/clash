import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import type { LocalResourceStoreEvent } from "./local-resource-store.js";
import {
  createLocalResourceStore,
  LocalResourceImportSourceError,
  resourceIdForSha256,
} from "./local-resource-store.js";

/**
 * The default temp root is usually tmpfs/ext4, which cannot reflink. A CI job
 * with a loop-mounted XFS/Btrfs sets this so the clone branch is exercised.
 */
const rootBase = process.env.CLASH_TEST_COW_DIR?.trim() || tmpdir();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const clashRoot = await mkdtemp(join(rootBase, "clash-path-import-"));
  roots.push(clashRoot);
  return { clashRoot, dataDir: join(clashRoot, "local-api") };
}

async function cloneSupported(root: string): Promise<boolean> {
  const source = join(root, "probe-source");
  const target = join(root, "probe-target");
  await writeFile(source, "probe");
  try {
    await copyFile(source, target, constants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    return false;
  } finally {
    await rm(source, { force: true });
    await rm(target, { force: true });
  }
}

async function stagingNames(clashRoot: string): Promise<string[]> {
  const entries = await readdir(join(clashRoot, "assets", "blobs"), {
    recursive: true,
  }).catch(() => []);
  return entries.filter((entry) => entry.split(/[\\/]/).at(-1) === "staging");
}

it("stages a local path, hashes it once, and reports clone or copy fallback with cost", async () => {
  const { clashRoot, dataDir } = await fixture();
  const events: LocalResourceStoreEvent[] = [];
  const store = createLocalResourceStore({
    dataDir,
    clashRoot,
    onEvent: (event) => events.push(event),
  });
  const bytes = new Uint8Array(randomBytes(256 * 1024));
  const sourcePath = join(clashRoot, "source.bin");
  await writeFile(sourcePath, bytes);
  const source = await stat(sourcePath);
  const canClone = await cloneSupported(clashRoot);

  const staged = await store.stagePath({
    sourcePath,
    declaredByteLength: bytes.byteLength,
    sourceMtimeMs: source.mtimeMs,
    maxByteLength: bytes.byteLength,
  });

  const digest = createHash("sha256").update(bytes).digest("hex");
  expect(staged.digest).toBe(digest);
  expect(staged.byteLength).toBe(bytes.byteLength);
  expect(events).toHaveLength(1);
  const event = events[0]!;
  expect(event.event).toBe(
    canClone
      ? "project_asset_import.clone"
      : "project_asset_import.clone_fallback",
  );
  expect(event.fields).toMatchObject({
    code: canClone
      ? "PROJECT_ASSET_IMPORT_CLONE"
      : "PROJECT_ASSET_IMPORT_CLONE_FALLBACK",
    bytes: bytes.byteLength,
    ms: expect.any(Number),
    fs: expect.any(String),
    ...(canClone ? {} : { reason: expect.any(String) }),
  });

  const sealed = await store.seal({ receipt: staged.receipt, kind: "image" });
  expect(await readFile(sealed.path)).toEqual(Buffer.from(bytes));
  await store.releaseStaged(staged.resourceId);
  expect(await stagingNames(clashRoot)).toEqual([]);
});

it("keeps the imported Asset independent of a later source write", async () => {
  const { clashRoot, dataDir } = await fixture();
  const store = createLocalResourceStore({ dataDir, clashRoot });
  const original = new Uint8Array(randomBytes(64 * 1024));
  const sourcePath = join(clashRoot, "source.bin");
  await writeFile(sourcePath, original);
  const source = await stat(sourcePath);

  const staged = await store.stagePath({
    sourcePath,
    declaredByteLength: original.byteLength,
    sourceMtimeMs: source.mtimeMs,
    maxByteLength: original.byteLength,
  });
  const sealed = await store.seal({ receipt: staged.receipt, kind: "video" });

  // Same length, different bytes: a hardlink/reference would change the Asset.
  await writeFile(sourcePath, new Uint8Array(original.byteLength).fill(7));
  expect(await readFile(sealed.path)).toEqual(Buffer.from(original));
});

it("fails a vanished source with ASSET_IMPORT_SOURCE_UNREADABLE and no staged bytes", async () => {
  const { clashRoot, dataDir } = await fixture();
  const store = createLocalResourceStore({ dataDir, clashRoot });
  const missing = join(clashRoot, "vanished.bin");

  await expect(
    store.stagePath({
      sourcePath: missing,
      declaredByteLength: 4,
      maxByteLength: 1024,
    }),
  ).rejects.toMatchObject({
    code: "ASSET_IMPORT_SOURCE_UNREADABLE",
    errno: "ENOENT",
  });
  await expect(
    store.stagePath({
      sourcePath: missing,
      declaredByteLength: 4,
      maxByteLength: 1024,
    }),
  ).rejects.toBeInstanceOf(LocalResourceImportSourceError);
  expect(await stagingNames(clashRoot)).toEqual([]);
});

it("rejects a source that changed after the caller observed it, with no staged bytes", async () => {
  const { clashRoot, dataDir } = await fixture();
  const store = createLocalResourceStore({ dataDir, clashRoot });
  const bytes = new Uint8Array(randomBytes(1024));
  const sourcePath = join(clashRoot, "source.bin");
  await writeFile(sourcePath, bytes);

  await expect(
    store.stagePath({
      sourcePath,
      declaredByteLength: bytes.byteLength,
      sourceMtimeMs: 1,
      maxByteLength: bytes.byteLength,
    }),
  ).rejects.toMatchObject({ code: "ASSET_IMPORT_SOURCE_CHANGED" });
  expect(await stagingNames(clashRoot)).toEqual([]);
});

it("names the clone Resource by the streamed digest identity", async () => {
  const { clashRoot, dataDir } = await fixture();
  const store = createLocalResourceStore({ dataDir, clashRoot });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const sourcePath = join(clashRoot, "source.bin");
  await writeFile(sourcePath, bytes);
  const staged = await store.stagePath({
    sourcePath,
    declaredByteLength: bytes.byteLength,
    maxByteLength: bytes.byteLength,
  });
  expect(staged.resourceId).toBe(
    resourceIdForSha256(createHash("sha256").update(bytes).digest("hex")),
  );
});
