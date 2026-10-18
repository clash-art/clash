import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, truncate, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectAssetHttpClient } from "@clash/asset-sdk";

import { managedLocalApiApps } from "./local-api-app.test-fixtures.js";

/**
 * Every SHA-256 the Host computes, as the number of bytes each hash instance
 * consumed, and every file opened through createReadStream. A full pass over
 * an Asset is one hash instance that consumed at least its byte length.
 */
const observed = vi.hoisted(() => ({
  hashedBytes: [] as number[],
  readStreams: [] as string[],
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const createHash = ((algorithm: string, options?: object) => {
    const hash = actual.createHash(algorithm, options as never);
    if (algorithm.toLowerCase() !== "sha256") return hash;
    const index = observed.hashedBytes.push(0) - 1;
    const update = hash.update.bind(hash) as (
      data: string | NodeJS.ArrayBufferView,
      encoding?: BufferEncoding,
    ) => typeof hash;
    hash.update = ((
      data: string | NodeJS.ArrayBufferView,
      encoding?: BufferEncoding,
    ) => {
      observed.hashedBytes[index]! +=
        typeof data === "string"
          ? Buffer.byteLength(data, encoding)
          : data.byteLength;
      return update(data, encoding);
    }) as typeof hash.update;
    return hash;
  }) as typeof actual.createHash;
  return { ...actual, createHash, default: { ...actual, createHash } };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const createReadStream = ((
    path: Parameters<typeof actual.createReadStream>[0],
    options?: Parameters<typeof actual.createReadStream>[1],
  ) => {
    observed.readStreams.push(String(path));
    return actual.createReadStream(path, options);
  }) as typeof actual.createReadStream;
  return {
    ...actual,
    createReadStream,
    default: { ...actual, createReadStream },
  };
});

const ORIGIN = "http://127.0.0.1:49152";
const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const ASSET_BYTES = 300 * 1024 + 11;

const temporaryDirectories: string[] = [];
const { createApp, close: closeApps } = managedLocalApiApps();

afterEach(async () => {
  await closeApps();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function resetObservations(): void {
  observed.hashedBytes.length = 0;
  observed.readStreams.length = 0;
}

function fullHashPasses(byteLength: number): number {
  return observed.hashedBytes.filter((bytes) => bytes >= byteLength).length;
}

function blobReads(digest: string): string[] {
  return observed.readStreams.filter((path) => path.includes(digest));
}

async function fixture() {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-read-hashing-"));
  temporaryDirectories.push(clashRoot);
  const options = {
    dataDir: join(clashRoot, "local-api"),
    clashRoot,
    userId: "local-user",
    projectAssetProjectionOrigin: () => ORIGIN,
    inspectAssetResource: async ({
      resource,
    }: {
      resource: { contentType?: string };
    }) => ({
      width: 1,
      height: 1,
      rotationDegrees: 0,
      contentType: resource.contentType ?? "image/png",
    }),
  };
  const app = createApp(options);
  const created = await app.request(`${ORIGIN}/api/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Hashing" }),
  });
  expect(created.status).toBe(201);
  const { id: projectId } = (await created.json()) as { id: string };
  const bytes = new Uint8Array(randomBytes(ASSET_BYTES));
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    app,
    clashRoot,
    projectId,
    bytes,
    digest,
    blobPath: join(clashRoot, "assets", "blobs", digest, "original.png"),
    stagingPath: join(clashRoot, "assets", "blobs", digest, "staging"),
    restart: async () => {
      await closeApps();
      return createApp(options);
    },
  };
}

async function importSingleShot(
  f: Awaited<ReturnType<typeof fixture>>,
  projectAssetId = "asset:frame",
) {
  const form = new FormData();
  form.set("file", new File([f.bytes], "frame.png", { type: "image/png" }));
  form.set("kind", "image");
  form.set("projectAssetId", projectAssetId);
  const response = await f.app.request(
    `${ORIGIN}/api/v1/projects/${f.projectId}/assets/import-file`,
    { method: "POST", body: form },
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return projectAssetId;
}

/** Every read surface a client uses for one Asset. */
async function readEverything(
  app: Awaited<ReturnType<typeof fixture>>["app"],
  projectId: string,
  assetId: string,
) {
  const asset = `${ORIGIN}/api/v1/projects/${projectId}/assets/${encodeURIComponent(assetId)}`;
  return {
    list: await app.request(`${ORIGIN}/api/v1/projects`),
    project: await app.request(`${ORIGIN}/api/v1/projects/${projectId}`),
    assets: await app.request(`${ORIGIN}/api/v1/projects/${projectId}/assets`),
    asset: await app.request(asset),
    media: await app.request(`${asset}/media`),
    localFile: await app.request(`${asset}/local-file`, {}, LOOPBACK),
  };
}

describe("local reads never re-hash immutable Asset bytes", () => {
  it("a single-shot import hashes the bytes once; list, project, Asset, media and local-file reads hash none", async () => {
    const f = await fixture();
    resetObservations();
    const assetId = await importSingleShot(f);
    expect(fullHashPasses(ASSET_BYTES)).toBe(1);
    expect(blobReads(f.digest)).toEqual([]);

    resetObservations();
    const reads = await readEverything(f.app, f.projectId, assetId);
    expect(reads.media.status).toBe(200);
    expect(new Uint8Array(await reads.media.arrayBuffer())).toEqual(f.bytes);
    expect(reads.localFile.status).toBe(200);
    expect(await reads.localFile.json()).toMatchObject({
      byteLength: ASSET_BYTES,
    });
    expect(reads.asset.status).toBe(200);
    expect(reads.list.status).toBe(200);
    expect(reads.project.status).toBe(200);
    expect(fullHashPasses(ASSET_BYTES)).toBe(0);
    expect(blobReads(f.digest)).toEqual([]);

    // A fresh Host process has no in-memory state and still reads by stat.
    const restarted = await f.restart();
    resetObservations();
    const afterRestart = await readEverything(restarted, f.projectId, assetId);
    expect(afterRestart.media.status).toBe(200);
    expect(afterRestart.list.status).toBe(200);
    expect(fullHashPasses(ASSET_BYTES)).toBe(0);
    expect(blobReads(f.digest)).toEqual([]);
  });

  it("a chunked import session hashes the bytes exactly once", async () => {
    const f = await fixture();
    const client = createProjectAssetHttpClient({
      endpoint: ORIGIN,
      fetch: (input, init) => Promise.resolve(f.app.request(String(input), init)),
    });
    resetObservations();
    const imported = await client.importFile({
      projectId: f.projectId,
      projectAssetId: "asset:chunked",
      kind: "image",
      file: new File([f.bytes], "frame.png", { type: "image/png" }),
      chunked: true,
    });
    expect(imported).toMatchObject({ id: "asset:chunked", status: "ready" });
    expect(fullHashPasses(ASSET_BYTES)).toBe(1);
    // The assembly pass is the only hash and the commit adopts the object by
    // rename: the assembled object is never read back.
    expect(
      observed.readStreams.filter((path) => path.includes("/objects/")),
    ).toEqual([]);
    expect(blobReads(f.digest)).toEqual([]);

    const media = await f.app.request(
      `${ORIGIN}/api/v1/projects/${f.projectId}/assets/asset%3Achunked/media`,
    );
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(f.bytes);
  });
});

describe("bytes a Host cannot serve fail with a coded error at every read surface", () => {
  async function expectCoded(
    f: Awaited<ReturnType<typeof fixture>>,
    assetId: string,
    code: string,
    status: number,
  ) {
    const reads = await readEverything(f.app, f.projectId, assetId);
    for (const response of [reads.media, reads.localFile]) {
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    }
    expect(reads.asset.status).toBe(200);
    expect(await reads.asset.json()).toMatchObject({
      id: assetId,
      status: "failed",
      errorCode: code,
    });
    const listed = (await reads.assets.json()) as {
      assets: Array<{ id: string; errorCode?: string }>;
    };
    expect(listed.assets).toContainEqual(
      expect.objectContaining({ id: assetId, errorCode: code }),
    );
    const project = (await reads.project.json()) as {
      assets: Array<{ id: string; errorCode?: string }>;
    };
    expect(project.assets).toContainEqual(
      expect.objectContaining({ id: assetId, errorCode: code }),
    );
    // The Dashboard card keeps the failed Asset, with its code, instead of
    // silently dropping it.
    const list = (await reads.list.json()) as {
      projects: Array<{
        id: string;
        assets: Array<{ id: string; errorCode?: string }>;
      }>;
    };
    expect(
      list.projects.find((candidate) => candidate.id === f.projectId)?.assets,
    ).toContainEqual(expect.objectContaining({ id: assetId, errorCode: code }));
  }

  it("a deleted blob is LOCAL_RESOURCE_MISSING (404)", async () => {
    const f = await fixture();
    const assetId = await importSingleShot(f);
    await unlink(f.blobPath);
    await unlink(f.stagingPath).catch(() => undefined);
    await expectCoded(f, assetId, "LOCAL_RESOURCE_MISSING", 404);
  });

  it.skipIf(process.getuid?.() === 0)(
    "a blob without read permission is LOCAL_RESOURCE_UNREADABLE (503) with its errno",
    async () => {
      const f = await fixture();
      const assetId = await importSingleShot(f);
      await chmod(f.blobPath, 0o000);
      try {
        await expectCoded(f, assetId, "LOCAL_RESOURCE_UNREADABLE", 503);
        const media = await f.app.request(
          `${ORIGIN}/api/v1/projects/${f.projectId}/assets/${encodeURIComponent(assetId)}/media`,
        );
        expect(await media.json()).toMatchObject({ errno: "EACCES" });
      } finally {
        await chmod(f.blobPath, 0o444);
      }
    },
  );

  it("a truncated blob is LOCAL_RESOURCE_SIZE_MISMATCH (503)", async () => {
    const f = await fixture();
    const assetId = await importSingleShot(f);
    await chmod(f.blobPath, 0o644);
    await truncate(f.blobPath, 7);
    await expectCoded(f, assetId, "LOCAL_RESOURCE_SIZE_MISMATCH", 503);
  });
});
