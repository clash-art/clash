import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  installCloudContentFile,
  uploadCloudContentFile,
  verifyCloudContentFile,
} from "./project-cloud-content";
import { PROJECT_CLOUD_CONTENT_PART_BYTES } from "@clash/asset-sdk/delivery";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cloud-content-"));
  roots.push(root);
  const value = new TextEncoder().encode(
    '{ "body" : "opaque revision bytes" }',
  );
  return {
    root,
    path: join(root, "body"),
    value,
    digest: `sha256:${createHash("sha256").update(value).digest("hex")}`,
    byteLength: value.length,
  };
}

it("installs verified opaque revision bytes atomically and repairs only with matching bytes", async () => {
  const input = await fixture();
  await writeFile(input.path, "damaged projection");
  await installCloudContentFile({
    ...input,
    body: new Response(input.value).body!,
  });
  expect(new Uint8Array(await readFile(input.path))).toEqual(input.value);
  expect(await verifyCloudContentFile(input)).toBe(true);
  expect(await readdir(input.root)).toEqual(["body"]);
});

it("rejects corrupt, truncated and oversized streams without exposing partial files", async () => {
  for (const failure of ["digest", "truncated", "overflow"] as const) {
    const input = await fixture();
    const value =
      failure === "digest"
        ? input.value.map((byte) => byte ^ 1)
        : failure === "truncated"
          ? input.value.subarray(1)
          : new Uint8Array(input.value.length + 1);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(value);
        if (failure !== "overflow") controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(installCloudContentFile({ ...input, body })).rejects.toThrow();
    expect(await readdir(input.root)).toEqual([]);
    if (failure === "overflow") expect(cancelled).toBe(true);
  }
});

it("verifies files before multipart upload and reads exact bounded portions", async () => {
  const input = await fixture();
  await writeFile(input.path, input.value);
  const received: Uint8Array[] = [];
  let completed = false;
  const fetcher: typeof fetch = async (target, init) => {
    const url = new URL(String(target));
    const action = url.searchParams.get("upload");
    if (action === "begin")
      return Response.json({
        uploadId: url.searchParams.get("uploadId"),
        partSize: PROJECT_CLOUD_CONTENT_PART_BYTES,
      });
    if (action === "part") received.push(init?.body as Uint8Array);
    if (action === "complete") completed = true;
    return new Response(null, { status: 204 });
  };
  await uploadCloudContentFile({
    ...input,
    url: "https://cloud.invalid/body",
    fetch: fetcher,
  });
  expect(Buffer.concat(received)).toEqual(Buffer.from(input.value));
  expect(completed).toBe(true);
  await writeFile(input.path, "wrong");
  await expect(
    uploadCloudContentFile({
      ...input,
      url: "https://cloud.invalid/body",
      fetch: async () => {
        throw new Error("must not reach network");
      },
    }),
  ).rejects.toThrow(/integrity/);
});
