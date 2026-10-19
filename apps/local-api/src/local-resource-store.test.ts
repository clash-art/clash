import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { PROJECT_ASSET_IMPORT_MAX_BYTES } from "@clash/asset-sdk";

import {
  createLocalResourceStore,
  LocalResourceStreamLimitError,
  resourceIdForSha256,
  stageLocalResourceInput,
  sweepLocalResourceStaging,
} from "./local-resource-store.js";

const nodeRequire = createRequire(import.meta.url);

function ageStagingRow(
  dataDir: string,
  resourceId: string,
  createdAt: number,
): void {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const database = new DatabaseSync(join(dataDir, "local.sqlite"));
  try {
    database
      .prepare(
        "UPDATE local_resource_staging SET created_at = ? WHERE resource_id = ?",
      )
      .run(createdAt, resourceId);
  } finally {
    database.close();
  }
}

function stagingRowCount(dataDir: string): number {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { get(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const database = new DatabaseSync(join(dataDir, "local.sqlite"));
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM local_resource_staging")
      .get() as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

function setSealedStorageKey(
  dataDir: string,
  resourceId: string,
  storageKey: string,
): void {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const database = new DatabaseSync(join(dataDir, "local.sqlite"));
  try {
    database
      .prepare(
        "UPDATE local_resources SET storage_key = ? WHERE resource_id = ?",
      )
      .run(storageKey, resourceId);
  } finally {
    database.close();
  }
}

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

  it("releases a staging receipt and its file only once the bytes are sealed", async () => {
    const { store, clashRoot } = await fixture();
    const bytes = new TextEncoder().encode("downloaded replica bytes");
    const staged = await store.stage({ bytes });

    await store.releaseStaged(staged.resourceId);
    expect((await store.resolveStaged(staged.resourceId))?.path).toBe(
      staged.path,
    );

    const sealed = await store.seal({
      receipt: staged.receipt,
      kind: "image",
      contentType: "image/png",
    });
    await store.releaseStaged(staged.resourceId);
    await store.releaseStaged(staged.resourceId);

    expect(await store.resolveStaged(staged.resourceId)).toBeUndefined();
    expect(await regularFilesUnder(join(clashRoot, "assets", "blobs"))).toEqual(
      [sealed.path],
    );
    expect(
      new Uint8Array(
        await readFile((await store.resolve(sealed.resource.id))!.path),
      ),
    ).toEqual(bytes);

    // A later flow that stages the same bytes gets a fresh, sealable receipt.
    const restaged = await store.stage({ bytes });
    expect(restaged.receipt).toEqual(staged.receipt);
    expect(
      (
        await store.seal({
          receipt: restaged.receipt,
          kind: "image",
          contentType: "image/png",
        })
      ).path,
    ).toBe(sealed.path);
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

  it("reports a truncated immutable file as LOCAL_RESOURCE_SIZE_MISMATCH", async () => {
    const { store } = await fixture();
    const installed = await store.install({
      kind: "image",
      bytes: new TextEncoder().encode("will disappear"),
      contentType: "image/png",
      originalName: "lost.png",
    });
    await chmod(installed.path, 0o644);
    await writeFile(installed.path, new Uint8Array());

    await expect(store.resolve(installed.resource.id)).rejects.toMatchObject({
      name: "LocalResourceError",
      code: "LOCAL_RESOURCE_SIZE_MISMATCH",
      resourceId: installed.resource.id,
    });
    await expect(
      store.resolveStream(installed.resource.id),
    ).rejects.toMatchObject({ code: "LOCAL_RESOURCE_SIZE_MISMATCH" });
  });

  it("reports a deleted immutable file as LOCAL_RESOURCE_MISSING", async () => {
    const { store } = await fixture();
    const installed = await store.install({
      kind: "image",
      bytes: new TextEncoder().encode("deleted outside the Host"),
      contentType: "image/png",
    });
    // The sealed file and its staging file share one inode; remove both names.
    const staged = (await store.resolveStaged(installed.resource.id))!;
    await unlink(installed.path);
    await unlink(staged.path);

    await expect(store.resolve(installed.resource.id)).rejects.toMatchObject({
      code: "LOCAL_RESOURCE_MISSING",
      errno: "ENOENT",
    });
    await expect(
      store.resolveStaged(installed.resource.id),
    ).rejects.toMatchObject({ code: "LOCAL_RESOURCE_MISSING" });
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports an immutable file without read permission as LOCAL_RESOURCE_UNREADABLE",
    async () => {
      const { store } = await fixture();
      const installed = await store.install({
        kind: "image",
        bytes: new TextEncoder().encode("permission removed"),
        contentType: "image/png",
      });
      await chmod(installed.path, 0o000);
      try {
        await expect(
          store.resolve(installed.resource.id),
        ).rejects.toMatchObject({
          code: "LOCAL_RESOURCE_UNREADABLE",
          errno: "EACCES",
        });
      } finally {
        await chmod(installed.path, 0o444);
      }
    },
  );

  it("resolves by stat only: a same-length rewrite is not re-hashed on read", async () => {
    const { store } = await fixture();
    const installed = await store.install({
      kind: "image",
      bytes: new TextEncoder().encode("original"),
      contentType: "image/png",
      originalName: "settled.png",
    });
    await chmod(installed.path, 0o644);
    await writeFile(installed.path, new TextEncoder().encode("tampered"));

    // Reads trust the digest computed at import; only a cloud upload
    // re-checks the bytes (see project-cloud-sync.test.ts).
    await expect(store.resolve(installed.resource.id)).resolves.toEqual(
      installed,
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

    await expect(store.resolve(installed.resource.id)).rejects.toMatchObject({
      code: "LOCAL_RESOURCE_SIZE_MISMATCH",
    });

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
  const staged = await store.stage({
    bytes: new TextEncoder().encode("immutable-replica"),
  });
  const source = await store.seal({
    receipt: staged.receipt,
    kind: "image",
    contentType: "image/png",
  });
  const remote = { ...source.resource, id: "opaque-remote-resource" };
  const installed = await store.installReplica({
    resource: remote,
    verifiedResourceId: source.resource.id,
  });
  expect(installed.resource).toEqual(remote);
  expect(await readFile(installed.path)).toEqual(await readFile(source.path));
  await expect(
    store.installReplica({
      resource: { ...remote, kind: "video" },
      verifiedResourceId: source.resource.id,
    }),
  ).rejects.toThrow(/facts/i);
});

it("adopts an assembled file by renaming its inode into staging, without copying or hashing it again", async () => {
  const { clashRoot, store } = await fixture();
  const bytes = new TextEncoder().encode("assembled resource bytes");
  const digest = digestOf(bytes);
  const sourcePath = join(clashRoot, "assembled-object.bin");
  await writeFile(sourcePath, bytes);

  const staged = await store.adoptAssembled({
    sourcePath,
    digest,
    byteLength: bytes.byteLength,
  });

  expect(staged).toMatchObject({
    resourceId: resourceIdForSha256(digest),
    digest,
    byteLength: bytes.byteLength,
  });
  // A rename moves the inode; only a fallback copy would leave the source.
  await expect(stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  const sealed = await store.seal({ receipt: staged.receipt, kind: "video" });
  expect(await readFile(sealed.path)).toEqual(Buffer.from(bytes));
});

it("discards staged bytes without touching a sealed Resource", async () => {
  const { store } = await fixture();
  const bytes = new TextEncoder().encode("staged then discarded");
  const staged = await store.stage({ bytes });
  const sealed = await store.seal({ receipt: staged.receipt, kind: "image" });

  await store.discardStaged(staged.resourceId);

  await expect(store.resolveStaged(staged.resourceId)).resolves.toBeUndefined();
  await expect(stat(staged.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(sealed.path)).toEqual(Buffer.from(bytes));
});

describe("local Resource staging sweep", () => {
  it("removes an old unreferenced receipt and file but keeps a recent staging file", async () => {
    const { clashRoot, dataDir, store } = await fixture();
    const now = Date.now();
    const old = new Date(now - 2 * 60 * 60 * 1000);
    const orphanBytes = new TextEncoder().encode("orphaned staging bytes");
    const orphan = await store.stage({ bytes: orphanBytes });
    ageStagingRow(dataDir, orphan.resourceId, old.getTime());
    await utimes(orphan.path, old, old);

    const liveBytes = new TextEncoder().encode("recent staging bytes");
    const live = await store.stage({ bytes: liveBytes });
    // A receipt can be old while a concurrent retry just replaced its file.
    ageStagingRow(dataDir, live.resourceId, old.getTime());

    const result = await sweepLocalResourceStaging({
      dataDir,
      clashRoot,
      olderThanMs: 60 * 60 * 1000,
      now,
    });

    expect(result.failed).toEqual([]);
    expect(result.removed).toEqual([
      {
        resourceId: orphan.resourceId,
        storageKey: orphan.storageKey,
        reason: "unreferenced",
      },
    ]);
    await expect(
      store.resolveStaged(orphan.resourceId),
    ).resolves.toBeUndefined();
    await expect(stat(orphan.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.resolveStaged(live.resourceId))?.path).toBe(live.path);
    expect(stagingRowCount(dataDir)).toBe(1);

    await store.discardStaged(live.resourceId);
  });

  it("releases the old staging name after sealing and never removes the sealed original", async () => {
    const { clashRoot, dataDir, store } = await fixture();
    const now = Date.now();
    const old = new Date(now - 2 * 60 * 60 * 1000);
    const bytes = new TextEncoder().encode("sealed Resource bytes");
    const staged = await store.stage({ bytes });
    const sealed = await store.seal({
      receipt: staged.receipt,
      kind: "image",
      contentType: "image/png",
    });
    ageStagingRow(dataDir, staged.resourceId, old.getTime());
    await utimes(staged.path, old, old);

    const result = await sweepLocalResourceStaging({
      dataDir,
      clashRoot,
      olderThanMs: 60 * 60 * 1000,
      now,
    });

    expect(result.failed).toEqual([]);
    expect(result.removed).toContainEqual({
      resourceId: staged.resourceId,
      storageKey: staged.storageKey,
      reason: "sealed",
    });
    await expect(
      store.resolveStaged(staged.resourceId),
    ).resolves.toBeUndefined();
    await expect(stat(staged.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sealed.path)).toEqual(Buffer.from(bytes));
    expect((await stat(sealed.path)).nlink).toBe(1);
  });

  it("removes an old orphan staging file with no receipt and leaves a sealed original alone", async () => {
    const { clashRoot, dataDir, store } = await fixture();
    const now = Date.now();
    const old = new Date(now - 2 * 60 * 60 * 1000);
    const bytes = new TextEncoder().encode("sealed original bytes");
    const staged = await store.stage({ bytes });
    const sealed = await store.seal({ receipt: staged.receipt, kind: "image" });
    await store.discardStaged(staged.resourceId);

    // Crash shape: the staging directory entry survives while its row is gone.
    const orphanPath = join(
      clashRoot,
      "assets",
      "blobs",
      digestOf(bytes),
      "staging",
    );
    await writeFile(orphanPath, bytes, { mode: 0o444 });
    await utimes(orphanPath, old, old);

    const result = await sweepLocalResourceStaging({
      dataDir,
      clashRoot,
      olderThanMs: 60 * 60 * 1000,
      now,
    });

    expect(result.failed).toEqual([]);
    expect(result.removed).toContainEqual({
      storageKey: `local-blobs/${digestOf(bytes)}/staging`,
      reason: "orphan_file",
    });
    await expect(stat(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sealed.path)).toEqual(Buffer.from(bytes));
    expect((await stat(sealed.path)).nlink).toBe(1);
  });

  it("refuses to unlink a receipt whose staging path is the sealed Resource's storage", async () => {
    const { clashRoot, dataDir, store } = await fixture();
    const now = Date.now();
    const old = new Date(now - 2 * 60 * 60 * 1000);
    const bytes = new TextEncoder().encode("staging is the sealed original");
    const staged = await store.stage({ bytes });
    await store.seal({ receipt: staged.receipt, kind: "image" });
    // Corrupt/legacy shape: the sealed row points at the staging name itself.
    setSealedStorageKey(dataDir, staged.resourceId, staged.storageKey);
    ageStagingRow(dataDir, staged.resourceId, old.getTime());
    await utimes(staged.path, old, old);

    const result = await sweepLocalResourceStaging({
      dataDir,
      clashRoot,
      olderThanMs: 60 * 60 * 1000,
      now,
    });

    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.message).toMatch(/staging storage key/i);
    expect(stagingRowCount(dataDir)).toBe(1);
    expect(await readFile(staged.path)).toEqual(Buffer.from(bytes));
  });

  it("refuses to unlink an orphan staging file that is the sealed Resource's storage", async () => {
    const { clashRoot, dataDir, store } = await fixture();
    const now = Date.now();
    const old = new Date(now - 2 * 60 * 60 * 1000);
    const bytes = new TextEncoder().encode("staging is the only sealed copy");
    const staged = await store.stage({ bytes });
    await store.seal({ receipt: staged.receipt, kind: "image" });
    // Corrupt/legacy shape with no receipt: only the sealed row names the file.
    setSealedStorageKey(dataDir, staged.resourceId, staged.storageKey);
    await store.discardStaged(staged.resourceId);
    // The discard removed the bytes; put the sealed copy back at that name.
    await writeFile(staged.path, bytes, { mode: 0o444 });
    await utimes(staged.path, old, old);

    const result = await sweepLocalResourceStaging({
      dataDir,
      clashRoot,
      olderThanMs: 60 * 60 * 1000,
      now,
    });

    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.message).toMatch(/staging storage key/i);
    expect(await readFile(staged.path)).toEqual(Buffer.from(bytes));
  });
});

it("rejects an over-cap declared import before consuming its source", async () => {
  const { clashRoot, store } = await fixture();
  let read = false;

  expect(() =>
    stageLocalResourceInput(store, {
      source: (async function* () {
        read = true;
        yield new Uint8Array(1);
      })(),
      declaredByteLength: PROJECT_ASSET_IMPORT_MAX_BYTES + 1,
    }),
  ).toThrow(/maximum byte length/);

  expect(read).toBe(false);
  expect(await regularFilesUnder(join(clashRoot, "assets", "blobs"))).toEqual(
    [],
  );
});

it("rejects over-cap caller-held bytes without staging anything", async () => {
  const { clashRoot, dataDir, store } = await fixture();
  const bytes = new Uint8Array(PROJECT_ASSET_IMPORT_MAX_BYTES + 1);

  let error: unknown;
  try {
    stageLocalResourceInput(store, { bytes });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(LocalResourceStreamLimitError);
  expect(error).toMatchObject({
    code: "CLOUD_CONTENT_TOO_LARGE",
    maxBytes: PROJECT_ASSET_IMPORT_MAX_BYTES,
  });
  expect(await regularFilesUnder(join(clashRoot, "assets", "blobs"))).toEqual(
    [],
  );
  // The guard throws before the store opens its database or writes a receipt.
  expect(await regularFilesUnder(dataDir)).toEqual([]);
});

it("keeps staging bytes when the sealed original is missing", async () => {
  const { clashRoot, dataDir, store } = await fixture();
  const now = Date.now();
  const old = new Date(now - 2 * 60 * 60 * 1000);
  const bytes = new TextEncoder().encode("only staging copy remains");
  const staged = await store.stage({ bytes });
  const sealed = await store.seal({ receipt: staged.receipt, kind: "image" });
  await unlink(sealed.path);
  ageStagingRow(dataDir, staged.resourceId, old.getTime());
  await utimes(staged.path, old, old);

  const result = await sweepLocalResourceStaging({
    dataDir,
    clashRoot,
    olderThanMs: 60 * 60 * 1000,
    now,
  });

  expect(result.removed).toEqual([]);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0]?.message).toMatch(/sealed Resource/i);
  expect((await store.resolveStaged(staged.resourceId))?.path).toBe(
    staged.path,
  );
  expect(await readFile(staged.path)).toEqual(Buffer.from(bytes));
});
