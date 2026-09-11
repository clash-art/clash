import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createLocalResourceStore,
  resourceIdForSha256,
} from "./local-resource-store.js";

async function fixture() {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-resource-store-"));
  const dataDir = join(clashRoot, "local-api");
  return {
    clashRoot,
    dataDir,
    store: createLocalResourceStore({ dataDir, clashRoot }),
  };
}

async function collectBytes(
  source: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function regularFilesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await regularFilesUnder(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("local Resource CAS", () => {
  it("stages an async byte stream within its declared bounds and resolves a path-free read stream", async () => {
    const { store } = await fixture();
    const first = new TextEncoder().encode("streamed ");
    const second = new TextEncoder().encode("resource bytes");
    const bytes = new Uint8Array(first.byteLength + second.byteLength);
    bytes.set(first);
    bytes.set(second, first.byteLength);
    const digest = digestOf(bytes);

    const staged = await store.stageStream({
      source: (async function* () {
        yield first;
        yield second;
      })(),
      declaredByteLength: bytes.byteLength,
      maxByteLength: bytes.byteLength,
      expectedDigest: digest,
    });
    const sealed = await store.seal({
      receipt: staged.receipt,
      kind: "video",
      contentType: "video/mp4",
    });
    const opened = await store.resolveStream(sealed.resource.id);

    expect(opened?.resource).toEqual(sealed.resource);
    expect(opened).not.toHaveProperty("path");
    expect(opened).not.toHaveProperty("storageKey");
    expect(opened!.stream).not.toHaveProperty("path");
    expect(await collectBytes(opened!.stream)).toEqual(new Uint8Array(bytes));
  });

  it("accepts a Node Readable and resolves its stream after a Host restart", async () => {
    const { clashRoot, dataDir, store } = await fixture();
    const chunks = [Buffer.from("restart-safe "), Buffer.from("stream")];
    const bytes = Buffer.concat(chunks);
    const digest = digestOf(bytes);

    const staged = await store.stageStream({
      source: Readable.from(chunks),
      declaredByteLength: bytes.byteLength,
      maxByteLength: bytes.byteLength + 8,
      expectedDigest: digest,
    });
    await store.seal({
      receipt: staged.receipt,
      kind: "audio",
      contentType: "audio/mpeg",
    });

    const restarted = createLocalResourceStore({ dataDir, clashRoot });
    const opened = await restarted.resolveStream(staged.resourceId);

    expect(opened?.resource.digest.value).toBe(digest);
    expect(await collectBytes(opened!.stream)).toEqual(new Uint8Array(bytes));
  });

  it("rejects a stream that exceeds its maximum without publishing partial staging state", async () => {
    const { clashRoot, store } = await fixture();
    const bytes = new TextEncoder().encode("too many bytes");
    const digest = digestOf(bytes);

    await expect(
      store.stageStream({
        source: (async function* () {
          yield bytes.subarray(0, 4);
          yield bytes.subarray(4);
        })(),
        maxByteLength: 5,
        expectedDigest: digest,
      }),
    ).rejects.toThrow(/maximum byte length/i);

    await expect(
      store.resolveStaged(resourceIdForSha256(digest)),
    ).resolves.toBeUndefined();
    expect(await regularFilesUnder(join(clashRoot, "assets", "blobs"))).toEqual(
      [],
    );
  });

  it("rejects a stream whose final length differs from its declaration", async () => {
    const { clashRoot, store } = await fixture();
    const bytes = new TextEncoder().encode("short");
    const digest = digestOf(bytes);

    await expect(
      store.stageStream({
        source: Readable.from([bytes]),
        declaredByteLength: bytes.byteLength + 1,
        maxByteLength: bytes.byteLength + 1,
        expectedDigest: digest,
      }),
    ).rejects.toThrow(/declared byte length/i);

    await expect(
      store.resolveStaged(resourceIdForSha256(digest)),
    ).resolves.toBeUndefined();
    expect(await regularFilesUnder(join(clashRoot, "assets", "blobs"))).toEqual(
      [],
    );
  });

  it("cleans up an interrupted source without registering or exposing partial bytes", async () => {
    const { clashRoot, store } = await fixture();
    const complete = new TextEncoder().encode("complete bytes never arrive");
    const digest = digestOf(complete);

    await expect(
      store.stageStream({
        source: (async function* () {
          yield complete.subarray(0, 8);
          throw new Error("upstream interrupted");
        })(),
        declaredByteLength: complete.byteLength,
        maxByteLength: complete.byteLength,
        expectedDigest: digest,
      }),
    ).rejects.toThrow("upstream interrupted");

    await expect(
      store.resolveStaged(resourceIdForSha256(digest)),
    ).resolves.toBeUndefined();
    expect(await regularFilesUnder(join(clashRoot, "assets", "blobs"))).toEqual(
      [],
    );
  });

  it("rejects an expected digest mismatch without publishing the stream", async () => {
    const { clashRoot, store } = await fixture();
    const bytes = new TextEncoder().encode("digest mismatch");
    const expectedDigest = "a".repeat(64);

    await expect(
      store.stageStream({
        source: Readable.from([bytes]),
        declaredByteLength: bytes.byteLength,
        maxByteLength: bytes.byteLength,
        expectedDigest,
      }),
    ).rejects.toThrow(/digest/i);

    await expect(
      store.resolveStaged(resourceIdForSha256(expectedDigest)),
    ).resolves.toBeUndefined();
    expect(await regularFilesUnder(join(clashRoot, "assets", "blobs"))).toEqual(
      [],
    );
  });

  it("converges concurrent stream writers on the same digest winner without leftover temporary files", async () => {
    const { clashRoot, store } = await fixture();
    const bytes = new TextEncoder().encode("one digest, concurrent writers");
    const digest = digestOf(bytes);
    const input = (source: AsyncIterable<Uint8Array>) => ({
      source,
      declaredByteLength: bytes.byteLength,
      maxByteLength: bytes.byteLength,
      expectedDigest: digest,
    });

    const [first, second] = await Promise.all([
      store.stageStream(
        input(
          (async function* () {
            yield bytes.subarray(0, 7);
            yield bytes.subarray(7);
          })(),
        ),
      ),
      store.stageStream(
        input(
          (async function* () {
            yield bytes;
          })(),
        ),
      ),
    ]);

    expect(second.receipt).toEqual(first.receipt);
    expect(second.path).toBe(first.path);
    expect(new Uint8Array(await readFile(first.path))).toEqual(bytes);
    expect(
      (await regularFilesUnder(join(clashRoot, "assets", "blobs"))).filter(
        (path) => path.includes("stream-staging") || path.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  it("keeps staged bytes outside authoritative Resource resolution until they are sealed", async () => {
    const { store } = await fixture();
    const bytes = new TextEncoder().encode("unverified upload bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");

    const staged = await store.stage({ bytes });

    expect(staged.receipt).toEqual({
      resourceId: `sha256:${digest}`,
      digest,
      byteLength: bytes.byteLength,
    });
    expect(staged).toMatchObject({
      resourceId: `sha256:${digest}`,
      digest,
      byteLength: bytes.byteLength,
    });
    expect(new Uint8Array(await readFile(staged.path))).toEqual(bytes);
    await expect(
      store.resolve(staged.receipt.resourceId),
    ).resolves.toBeUndefined();
  });

  it("recovers staged bytes after a Host restart without promoting them", async () => {
    const { clashRoot, dataDir, store } = await fixture();
    const bytes = new TextEncoder().encode("restart-safe staging bytes");
    const staged = await store.stage({ bytes });

    const restarted = createLocalResourceStore({ dataDir, clashRoot });

    await expect(
      restarted.resolveStaged(staged.receipt.resourceId),
    ).resolves.toEqual(staged);
    await expect(
      restarted.resolve(staged.receipt.resourceId),
    ).resolves.toBeUndefined();
  });

  it("lets rejected pre-seal media declarations retry with verified canonical facts", async () => {
    const { store } = await fixture();
    const bytes = new TextEncoder().encode(
      "bytes whose first declaration was wrong",
    );
    const digest = createHash("sha256").update(bytes).digest("hex");

    const stagedUnderRejectedDeclaration = await store.stage({
      bytes,
      originalName: "incorrect-video.mp4",
    });
    // The Host rejected the caller's video/video-mp4 declaration before seal.
    const retried = await store.stage({
      bytes,
      originalName: "verified-image.png",
    });

    expect(retried.receipt).toEqual(stagedUnderRejectedDeclaration.receipt);
    const sealed = await store.seal({
      receipt: retried.receipt,
      kind: "image",
      contentType: " Image/PNG ",
    });

    expect(sealed.resource).toEqual({
      id: `sha256:${digest}`,
      kind: "image",
      digest: { algorithm: "sha256", value: digest },
      byteLength: bytes.byteLength,
      contentType: "image/png",
    });
    await expect(store.resolve(sealed.resource.id)).resolves.toEqual(sealed);
  });

  it("replays the same canonical seal from its stable Resource id after restart", async () => {
    const { clashRoot, dataDir, store } = await fixture();
    const staged = await store.stage({
      bytes: new TextEncoder().encode("idempotent seal bytes"),
    });
    const first = await store.seal({
      receipt: staged.receipt,
      kind: "video",
      contentType: "video/mp4",
    });

    const restarted = createLocalResourceStore({ dataDir, clashRoot });
    const replayed = await restarted.seal({
      resourceId: staged.receipt.resourceId,
      kind: "video",
      contentType: " VIDEO/MP4 ",
    });

    expect(replayed).toEqual(first);
  });

  it("installs immutable bytes once and resolves their Host-private projection", async () => {
    const { clashRoot, store } = await fixture();
    const bytes = new TextEncoder().encode("immutable image bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");

    const first = await store.install({
      kind: "image",
      bytes,
      contentType: "image/png",
      originalName: "hero.png",
    });
    const second = await store.install({
      kind: "image",
      bytes,
      contentType: "image/png",
      originalName: "renamed.png",
    });

    expect(first.resource).toEqual({
      id: `sha256:${digest}`,
      kind: "image",
      digest: { algorithm: "sha256", value: digest },
      byteLength: bytes.byteLength,
      contentType: "image/png",
    });
    expect(second).toEqual(first);
    expect(first.createdAt).toEqual(expect.any(Number));
    expect(first.storageKey).toBe(`local-blobs/${digest}/original.png`);
    expect(first.path).toBe(
      join(clashRoot, "assets", "blobs", digest, "original.png"),
    );
    expect(new Uint8Array(await readFile(first.path))).toEqual(bytes);
    expect((await stat(first.path)).mode & 0o777).toBe(0o444);
    await expect(store.resolve(first.resource.id)).resolves.toEqual(first);
  });

  it("adopts a CLI-installed CAS blob only after verifying its digest and size", async () => {
    const { clashRoot, store } = await fixture();
    const bytes = new TextEncoder().encode("existing audio bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const directory = join(clashRoot, "assets", "blobs", digest);
    const path = join(directory, "original.mp3");
    await mkdir(directory, { recursive: true });
    await writeFile(path, bytes);

    const adopted = await store.adopt({
      kind: "audio",
      digest,
      byteLength: bytes.byteLength,
      contentType: "audio/mpeg",
      localBlobKey: `blobs/${digest}/original.mp3`,
    });

    expect(adopted.resource.id).toBe(resourceIdForSha256(digest));
    expect(adopted.storageKey).toBe(`local-blobs/${digest}/original.mp3`);
    await expect(store.resolve(adopted.resource.id)).resolves.toEqual(adopted);
  });

  it("rejects adoption when the claimed digest does not match the bytes", async () => {
    const { clashRoot, store } = await fixture();
    const claimedDigest = "a".repeat(64);
    const directory = join(clashRoot, "assets", "blobs", claimedDigest);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "original.mp4"), "different bytes");

    await expect(
      store.adopt({
        kind: "video",
        digest: claimedDigest,
        byteLength: 15,
        contentType: "video/mp4",
        localBlobKey: `blobs/${claimedDigest}/original.mp4`,
      }),
    ).rejects.toThrow(/digest/i);
    await expect(
      store.resolve(resourceIdForSha256(claimedDigest)),
    ).resolves.toBeUndefined();
  });

  it("fails closed when an indexed Resource loses its immutable bytes", async () => {
    const { store } = await fixture();
    const installed = await store.install({
      kind: "image",
      bytes: new TextEncoder().encode("will disappear"),
      contentType: "image/png",
      originalName: "lost.png",
    });
    await chmod(installed.path, 0o644);
    await writeFile(installed.path, new Uint8Array());

    await expect(store.resolve(installed.resource.id)).rejects.toThrow(
      /byte length|corrupt/i,
    );
  });

  it("fails closed when immutable bytes change without changing length", async () => {
    const { store } = await fixture();
    const installed = await store.install({
      kind: "image",
      bytes: new TextEncoder().encode("original"),
      contentType: "image/png",
      originalName: "corrupt.png",
    });
    await chmod(installed.path, 0o644);
    await writeFile(installed.path, new TextEncoder().encode("tampered"));

    await expect(store.resolve(installed.resource.id)).rejects.toThrow(
      /digest|corrupt/i,
    );
  });

  it("repairs an indexed CAS file when the same verified bytes are installed again", async () => {
    const { store } = await fixture();
    const bytes = new TextEncoder().encode("recoverable immutable bytes");
    const installed = await store.install({
      kind: "video",
      bytes,
      contentType: "video/mp4",
      originalName: "source.mp4",
    });
    await chmod(installed.path, 0o644);
    await writeFile(
      installed.path,
      new TextEncoder().encode("corrupted immutable bytes"),
    );

    await expect(store.resolve(installed.resource.id)).rejects.toThrow(
      /digest|byte length|corrupt/i,
    );

    const repaired = await store.install({
      kind: "video",
      bytes,
      contentType: "video/mp4",
      originalName: "renamed.mp4",
    });

    expect(repaired).toEqual(installed);
    expect(new Uint8Array(await readFile(repaired.path))).toEqual(bytes);
    expect((await stat(repaired.path)).mode & 0o777).toBe(0o444);
    await expect(store.resolve(repaired.resource.id)).resolves.toEqual(
      repaired,
    );
  });

  it("does not reinterpret one digest as a different media kind", async () => {
    const { store } = await fixture();
    const bytes = new TextEncoder().encode("same bytes");
    await store.install({
      kind: "image",
      bytes,
      contentType: "image/png",
      originalName: "same.png",
    });

    await expect(
      store.install({
        kind: "video",
        bytes,
        contentType: "video/mp4",
        originalName: "same.mp4",
      }),
    ).rejects.toThrow(/different immutable facts/i);
  });

  it("never reinterprets facts after a verified seal wins the Resource CAS", async () => {
    const { store } = await fixture();
    const bytes = new TextEncoder().encode("verified Resource winner");
    const legacy = await store.install({
      bytes,
      kind: "video",
      contentType: "video/mp4",
    });
    const verified = await store.seal({
      resourceId: legacy.resource.id,
      kind: "image",
      contentType: "image/png",
    });

    await expect(
      store.seal({
        resourceId: verified.resource.id,
        kind: "video",
        contentType: "video/mp4",
      }),
    ).rejects.toThrow(/different immutable facts/i);
    await expect(store.resolve(verified.resource.id)).resolves.toEqual(
      verified,
    );
  });
});

it("retains an opaque replicated Resource identity only after local facts verification", async () => {
  const { store } = await fixture();
  const staged = await store.stage({ bytes: new TextEncoder().encode("immutable-replica") });
  const source = await store.seal({ receipt: staged.receipt, kind: "image", contentType: "image/png" });
  const remote = { ...source.resource, id: "opaque-remote-resource" };
  const installed = await store.installReplica({ resource: remote, verifiedResourceId: source.resource.id });
  expect(installed.resource).toEqual(remote);
  expect(await readFile(installed.path)).toEqual(await readFile(source.path));
  await expect(store.installReplica({ resource: { ...remote, kind: "video" }, verifiedResourceId: source.resource.id })).rejects.toThrow(/facts/i);
});
