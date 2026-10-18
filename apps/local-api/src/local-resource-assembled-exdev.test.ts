import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalResourceStoreEvent } from "./local-resource-store.js";
import {
  createLocalResourceStore,
  resourceIdForSha256,
} from "./local-resource-store.js";

const forceExdev = vi.hoisted(() => ({ value: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename = (async (
    ...args: Parameters<typeof actual.rename>
  ): Promise<void> => {
    if (forceExdev.value && String(args[0]).endsWith("assembled-object.bin")) {
      const error = new Error(
        "EXDEV: cross-device link not permitted",
      ) as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    }
    await actual.rename(...args);
  }) as typeof actual.rename;
  return { ...actual, rename, default: { ...actual, rename } };
});

const roots: string[] = [];

afterEach(async () => {
  forceExdev.value = false;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("falls back to a streamed copy on EXDEV, reports bytes and ms, and seals the bytes", async () => {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-assemble-exdev-"));
  roots.push(clashRoot);
  const dataDir = join(clashRoot, "local-api");
  const events: LocalResourceStoreEvent[] = [];
  const store = createLocalResourceStore({
    dataDir,
    clashRoot,
    onEvent: (event) => events.push(event),
  });
  const bytes = new TextEncoder().encode("cross-filesystem assembled bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const sourcePath = join(clashRoot, "assembled-object.bin");
  await writeFile(sourcePath, bytes);

  forceExdev.value = true;
  const staged = await store.adoptAssembled({
    sourcePath,
    digest,
    byteLength: bytes.byteLength,
  });
  forceExdev.value = false;

  expect(events).toEqual([
    {
      level: "info",
      event: "project_asset_import.exdev_fallback",
      fields: {
        resourceId: resourceIdForSha256(digest),
        bytes: bytes.byteLength,
        ms: expect.any(Number),
        reason: "EXDEV",
      },
    },
  ]);
  // A copy leaves the session object for finalize to delete; the staged bytes
  // are complete and the inode is sealed without another hash.
  await expect(stat(sourcePath)).resolves.toMatchObject({ isFile: expect.any(Function) });
  const sealed = await store.seal({ receipt: staged.receipt, kind: "video" });
  expect(await readFile(sealed.path)).toEqual(Buffer.from(bytes));
});
