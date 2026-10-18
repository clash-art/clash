import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MultipartAssemblyError } from "@clash/asset-sdk/upload-service";
import {
  PROJECT_CLOUD_CONTENT_PART_BYTES,
  type AssetDeliveryStore,
} from "@clash/asset-sdk/delivery";
import { createFsAssetDeliveryStore } from "./fs-asset-delivery-store.js";

/** Reads the store performs while assembling, to prove no part is buffered. */
const observed = vi.hoisted(() => ({ readFilePaths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = ((
    path: Parameters<typeof actual.readFile>[0],
    options?: Parameters<typeof actual.readFile>[1],
  ) => {
    observed.readFilePaths.push(String(path));
    return actual.readFile(path, options as never);
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

type Session = Parameters<
  NonNullable<AssetDeliveryStore["multipart"]>["begin"]
>[0];

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const session = (
  uploadId: string,
  locator: string,
  byteLength: number,
): Session =>
  ({
    uploadId,
    target: {
      identity: `import:${locator}`,
      locator,
      byteLength,
      digest: "",
    },
  }) as never;

async function uploadParts(
  store: ReturnType<typeof createFsAssetDeliveryStore>,
  target: Session,
  byteLength: number,
): Promise<{ digest: string; size: number }> {
  await store.multipart!.begin(target);
  const hash = createHash("sha256");
  const partBytes = Buffer.alloc(PROJECT_CLOUD_CONTENT_PART_BYTES, 0x5a);
  let remaining = byteLength;
  let partNumber = 0;
  while (remaining > 0) {
    partNumber += 1;
    const length = Math.min(PROJECT_CLOUD_CONTENT_PART_BYTES, remaining);
    const chunk = partBytes.subarray(0, length);
    hash.update(chunk);
    await store.multipart!.part(target, partNumber, chunk);
    remaining -= length;
  }
  return { digest: hash.digest("hex"), size: byteLength };
}

it("assembles a 64 MiB + 1 object by streaming, hashing once and persisting the digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-fs-asset-streaming-"));
  roots.push(root);
  const store = createFsAssetDeliveryStore(root);
  const locator = "project-content-imports/streamed";
  const byteLength = 64 * 1024 * 1024 + 1;
  const target = session("streaming-upload-0001", locator, byteLength);
  const expected = await uploadParts(store, target, byteLength);

  const realConcat = Buffer.concat;
  const largeConcatTotals: number[] = [];
  const concat = vi
    .spyOn(Buffer, "concat")
    .mockImplementation(((
      list: readonly Uint8Array[],
      totalLength?: number,
    ) => {
      const total =
        totalLength ?? list.reduce((sum, value) => sum + value.byteLength, 0);
      if (total >= PROJECT_CLOUD_CONTENT_PART_BYTES)
        largeConcatTotals.push(total);
      return realConcat(list as Uint8Array[], totalLength);
    }) as typeof Buffer.concat);
  observed.readFilePaths.length = 0;
  await store.multipart!.complete(target, async () => undefined);

  // One bounded read chunk at a time: no whole-part readFile, no Buffer.concat
  // of a part or the whole object.
  expect(largeConcatTotals).toEqual([]);
  concat.mockRestore();
  expect(
    observed.readFilePaths.filter((path) => /\/part-\d+$/.test(path)),
  ).toEqual([]);

  const objectPath = join(root, "objects", locator);
  expect((await stat(objectPath)).size).toBe(byteLength);
  await expect(store.assembled(locator)).resolves.toEqual({
    path: objectPath,
    digest: expected.digest,
    size: byteLength,
  });

  // The digest survives a Host restart (sidecar), so finalize still adopts the
  // object instead of hashing it a second time.
  const restarted = createFsAssetDeliveryStore(root);
  await expect(restarted.assembled(locator)).resolves.toMatchObject({
    path: objectPath,
    digest: expected.digest,
    size: byteLength,
  });
  expect(await readdir(join(root, "objects", "project-content-imports"))).toEqual(
    expect.arrayContaining([`streamed`, `streamed.sha256`]),
  );
});

it("fails a broken part with a coded assembly error and removes the partial object", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-fs-asset-streaming-"));
  roots.push(root);
  const store = createFsAssetDeliveryStore(root);
  const locator = "project-content-imports/broken";
  const target = session("broken-upload-000001", locator, 8);
  await store.multipart!.begin(target);
  await store.multipart!.part(target, 1, new TextEncoder().encode("12345678"));

  const uploads: Array<{ locator: string }> = [];
  for await (const entry of store.listUploads()) uploads.push(entry);
  const dir = join(root, "staging", uploads[0]!.locator);
  // A part that is no longer a readable file fails mid-assembly.
  await rm(join(dir, "part-1"), { force: true });
  await mkdir(join(dir, "part-1"));

  await expect(
    store.multipart!.complete(target, async () => undefined),
  ).rejects.toBeInstanceOf(MultipartAssemblyError);
  expect(await readdir(dir)).not.toContain("assembled");
  await expect(store.assembled(locator)).resolves.toBeUndefined();
  await expect(stat(join(root, "objects", locator))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("reports a missing part as a coded assembly failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-fs-asset-streaming-"));
  roots.push(root);
  const store = createFsAssetDeliveryStore(root);
  const locator = "project-content-imports/missing-part";
  const target = session("missing-upload-00001", locator, 8);
  await store.multipart!.begin(target);
  await store.multipart!.part(target, 1, new TextEncoder().encode("12345678"));

  const uploads: Array<{ locator: string }> = [];
  for await (const entry of store.listUploads()) uploads.push(entry);
  await rm(join(root, "staging", uploads[0]!.locator, "part-1"), {
    force: true,
  });

  await expect(
    store.multipart!.complete(target, async () => undefined),
  ).rejects.toMatchObject({
    status: 409,
    code: "PROJECT_ASSET_IMPORT_ASSEMBLY_FAILED",
    cause: expect.objectContaining({ code: "ENOENT" }),
  });
  await expect(store.assembled(locator)).resolves.toBeUndefined();
});
