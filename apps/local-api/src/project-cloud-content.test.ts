import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { utimes } from "node:fs/promises";
import {
  installCloudContentFile,
  sweepAbandonedPartials,
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
  const offline = {
    url: "https://cloud.invalid/body",
    fetch: async () => {
      throw new Error("must not reach network");
    },
  };
  await writeFile(input.path, "wrong");
  await expect(
    uploadCloudContentFile({ ...input, ...offline }),
  ).rejects.toMatchObject({ code: "LOCAL_RESOURCE_SIZE_MISMATCH" });
  // Same length, different bytes: only this upload-time hash can tell.
  await writeFile(
    input.path,
    input.value.map((byte) => byte ^ 1),
  );
  await expect(
    uploadCloudContentFile({ ...input, ...offline }),
  ).rejects.toMatchObject({ code: "LOCAL_RESOURCE_DIGEST_MISMATCH" });
});

it("removes partials orphaned by a killed Host but keeps fresh in-flight ones", async () => {
  const { root, path } = await fixture();
  const stale = `${path}.11111111-1111-1111-1111-111111111111.partial`;
  const fresh = `${path}.22222222-2222-2222-2222-222222222222.partial`;
  const other = join(root, "other.33333333.partial");
  await writeFile(stale, "x");
  await writeFile(fresh, "y");
  await writeFile(other, "z");
  const old = new Date(Date.now() - 60 * 60_000);
  await utimes(stale, old, old);
  await utimes(other, old, old);
  expect(await sweepAbandonedPartials(path)).toBe(1);
  expect((await readdir(root)).sort()).toEqual(
    ["body.22222222-2222-2222-2222-222222222222.partial", "other.33333333.partial"].sort(),
  );
});
