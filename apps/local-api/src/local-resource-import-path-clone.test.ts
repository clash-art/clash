import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { LocalResourceStoreEvent } from "./local-resource-store.js";
import { createLocalResourceStore } from "./local-resource-store.js";

const forceClone = vi.hoisted(() => ({ value: false }));
const forceExdev = vi.hoisted(() => ({ value: false }));

// The sandbox has no reflink-capable volume. This mock makes the platform's
// COPYFILE_FICLONE_FORCE call succeed so the clone branch itself is exercised;
// the real clone is covered by CLASH_TEST_COW_DIR on a loop-mounted XFS/Btrfs.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const copyFile = (async (
    ...args: Parameters<typeof actual.copyFile>
  ): Promise<void> => {
    if (args[2] === constants.COPYFILE_FICLONE_FORCE) {
      if (forceExdev.value) {
        const error = new Error(
          "EXDEV: cross-device link not permitted",
        ) as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      }
      if (forceClone.value) {
        await actual.copyFile(args[0], args[1]);
        return;
      }
    }
    await actual.copyFile(...args);
  }) as typeof actual.copyFile;
  return { ...actual, copyFile, default: { ...actual, copyFile } };
});

const roots: string[] = [];

afterEach(async () => {
  forceClone.value = false;
  forceExdev.value = false;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("reports a clone outcome, hashes the cloned file, and seals it", async () => {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-path-clone-"));
  roots.push(clashRoot);
  const dataDir = join(clashRoot, "local-api");
  const events: LocalResourceStoreEvent[] = [];
  const store = createLocalResourceStore({
    dataDir,
    clashRoot,
    onEvent: (event) => events.push(event),
  });
  const bytes = new Uint8Array(randomBytes(128 * 1024));
  const sourcePath = join(clashRoot, "source.bin");
  await writeFile(sourcePath, bytes);
  const source = await stat(sourcePath);
  forceClone.value = true;

  const staged = await store.stagePath({
    sourcePath,
    declaredByteLength: bytes.byteLength,
    sourceMtimeMs: source.mtimeMs,
    maxByteLength: bytes.byteLength,
  });

  expect(staged.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    level: "info",
    event: "project_asset_import.clone",
    fields: {
      code: "PROJECT_ASSET_IMPORT_CLONE",
      fs: expect.any(String),
      bytes: bytes.byteLength,
      ms: expect.any(Number),
    },
  });
  const sealed = await store.seal({ receipt: staged.receipt, kind: "image" });
  expect(await readFile(sealed.path)).toEqual(Buffer.from(bytes));
});

it("falls back to one streamed copy on a cross-volume EXDEV and reports it", async () => {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-path-exdev-"));
  roots.push(clashRoot);
  const dataDir = join(clashRoot, "local-api");
  const events: LocalResourceStoreEvent[] = [];
  const store = createLocalResourceStore({
    dataDir,
    clashRoot,
    onEvent: (event) => events.push(event),
  });
  const bytes = new Uint8Array(randomBytes(96 * 1024));
  const sourcePath = join(clashRoot, "source.bin");
  await writeFile(sourcePath, bytes);
  const source = await stat(sourcePath);
  forceExdev.value = true;

  const staged = await store.stagePath({
    sourcePath,
    declaredByteLength: bytes.byteLength,
    sourceMtimeMs: source.mtimeMs,
    maxByteLength: bytes.byteLength,
  });

  expect(staged.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(events).toEqual([
    {
      level: "info",
      event: "project_asset_import.clone_fallback",
      fields: {
        code: "PROJECT_ASSET_IMPORT_CLONE_FALLBACK",
        fs: expect.any(String),
        reason: "EXDEV",
        bytes: bytes.byteLength,
        ms: expect.any(Number),
      },
    },
  ]);
  const sealed = await store.seal({ receipt: staged.receipt, kind: "image" });
  expect(await readFile(sealed.path)).toEqual(Buffer.from(bytes));
});
