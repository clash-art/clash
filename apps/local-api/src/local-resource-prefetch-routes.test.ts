import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectAsset } from "@clash/shared-types";

import { managedLocalApiApps } from "./local-api-app.test-fixtures.js";
import { createLocalProjectAssetService } from "./local-project-assets.js";
import type { LocalResourceAvailability } from "./local-resource-prefetch.js";
import { createLocalResourceStore } from "./local-resource-store.js";

const ORIGIN = "http://127.0.0.1:49152";
const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

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

/**
 * A Host whose Project Asset bytes are not in its store yet, with the
 * prefetcher replaced by a recorder whose download state the test sets.
 */
async function fixture() {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-prefetch-routes-"));
  temporaryDirectories.push(clashRoot);
  let availability: LocalResourceAvailability | undefined;
  const prefetches: Array<{ projectId: string; visibleAssetIds?: string[] }> =
    [];
  const app = createApp({
    dataDir: join(clashRoot, "local-api"),
    clashRoot,
    userId: "local-user",
    projectAssetProjectionOrigin: () => ORIGIN,
    inspectAssetResource: async ({ resource }) => ({
      width: 1,
      height: 1,
      rotationDegrees: 0,
      contentType: resource.contentType ?? "image/png",
    }),
    resourcePrefetch: {
      availability: () => availability,
      prefetch: async (projectId, input) => {
        prefetches.push({
          projectId,
          ...(input.visibleAssetIds
            ? { visibleAssetIds: [...input.visibleAssetIds] }
            : {}),
        });
      },
    },
  });
  const created = await app.request(`${ORIGIN}/api/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Prefetch" }),
  });
  expect(created.status).toBe(201);
  const { id: projectId } = (await created.json()) as { id: string };
  const bytes = new Uint8Array(randomBytes(4096));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const form = new FormData();
  form.set("file", new File([bytes], "frame.png", { type: "image/png" }));
  form.set("kind", "image");
  form.set("projectAssetId", "asset:frame");
  const imported = await app.request(
    `${ORIGIN}/api/v1/projects/${projectId}/assets/import-file`,
    { method: "POST", body: form },
  );
  expect(imported.status, await imported.clone().text()).toBe(201);
  // The bytes are on their way from the cloud, not in this Host's store.
  await unlink(join(clashRoot, "assets", "blobs", digest, "original.png"));
  await unlink(
    join(clashRoot, "assets", "blobs", digest, "staging"),
  ).catch(() => undefined);
  const asset = `${ORIGIN}/api/v1/projects/${projectId}/assets/asset%3Aframe`;
  return {
    app,
    projectId,
    prefetches,
    setAvailability: (next: LocalResourceAvailability | undefined) => {
      availability = next;
    },
    reads: async () => ({
      asset: await app.request(asset),
      assets: await app.request(`${ORIGIN}/api/v1/projects/${projectId}/assets`),
      media: await app.request(`${asset}/media`),
      localFile: await app.request(`${asset}/local-file`, {}, LOOPBACK),
    }),
  };
}

describe("Host projection of background Resource downloads (#339)", () => {
  it("reports downloading with progress while the bytes are on their way, and every read surface still answers", async () => {
    const f = await fixture();
    f.setAvailability({ status: "downloading", progress: 0.25 });
    const reads = await f.reads();
    expect(reads.asset.status).toBe(200);
    expect(await reads.asset.json()).toMatchObject({
      id: "asset:frame",
      status: "downloading",
      progress: 0.25,
    });
    const listed = (await reads.assets.json()) as {
      assets: Array<Record<string, unknown>>;
    };
    expect(listed.assets).toContainEqual(
      expect.objectContaining({
        id: "asset:frame",
        status: "downloading",
        progress: 0.25,
      }),
    );
    for (const response of [reads.media, reads.localFile]) {
      expect(response.status).toBe(404);
      const body = (await response.json()) as { code: string; error: string };
      expect(body.code).toBe("LOCAL_RESOURCE_MISSING");
      expect(body.error).toContain("still downloading");
    }
    // A byte read that missed the store moves that Asset to the front.
    expect(f.prefetches).toContainEqual({
      projectId: f.projectId,
      visibleAssetIds: ["asset:frame"],
    });
  });

  it("reports a failed download with its code on the Asset and on the media and local-file routes", async () => {
    const f = await fixture();
    f.setAvailability({
      status: "failed",
      errorCode: "LOCAL_RESOURCE_DOWNLOAD_INTEGRITY",
      error: "LOCAL_RESOURCE_DOWNLOAD_INTEGRITY: Cloud content integrity mismatch",
    });
    const reads = await f.reads();
    expect(reads.asset.status).toBe(200);
    expect(await reads.asset.json()).toMatchObject({
      id: "asset:frame",
      status: "failed",
      errorCode: "LOCAL_RESOURCE_DOWNLOAD_INTEGRITY",
    });
    for (const response of [reads.media, reads.localFile]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "LOCAL_RESOURCE_DOWNLOAD_INTEGRITY",
        // One code prefix, not the prefetcher's and the Host's both.
        error:
          "LOCAL_RESOURCE_DOWNLOAD_INTEGRITY: Cloud content integrity mismatch",
      });
    }
  });

  it("accepts a visible-Asset hint and forwards it to the prefetcher", async () => {
    const f = await fixture();
    const accepted = await f.app.request(
      `${ORIGIN}/api/v1/projects/${f.projectId}/assets/prefetch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetIds: ["asset:frame", "asset:other"] }),
      },
    );
    expect(accepted.status).toBe(202);
    expect(f.prefetches).toContainEqual({
      projectId: f.projectId,
      visibleAssetIds: ["asset:frame", "asset:other"],
    });

    const rejected = await f.app.request(
      `${ORIGIN}/api/v1/projects/${f.projectId}/assets/prefetch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetIds: "asset:frame" }),
      },
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      code: "INVALID_PROJECT_ASSET_PREFETCH",
    });
  });
});

describe("a Project Asset whose Resource this Host has never registered", () => {
  async function unregisteredEntry() {
    const elsewhere = await mkdtemp(join(tmpdir(), "clash-other-host-"));
    temporaryDirectories.push(elsewhere);
    const installed = await createLocalResourceStore({
      dataDir: elsewhere,
    }).install({
      kind: "image",
      bytes: new Uint8Array(randomBytes(64)),
      contentType: "image/png",
    });
    const doc = new LoroDoc();
    try {
      const created = createProjectAsset(doc, {
        id: "asset:cloud",
        kind: "image",
        source: { kind: "owned", resourceId: installed.resource.id },
        lifecycle: { state: "active" },
        metadata: {},
      });
      if (!created.ok) throw new Error("fixture Asset was rejected");
      return created.entry;
    } finally {
      doc.free();
    }
  }

  async function service(
    availability?: LocalResourceAvailability,
  ) {
    const clashRoot = await mkdtemp(join(tmpdir(), "clash-receiver-host-"));
    temporaryDirectories.push(clashRoot);
    return createLocalProjectAssetService({
      dataDir: join(clashRoot, "local-api"),
      clashRoot,
      projectionOrigin: ORIGIN,
      resourceAvailability: () => availability,
    });
  }

  it("is unavailable with LOCAL_RESOURCE_MISSING when no download is known", async () => {
    const entry = await unregisteredEntry();
    const [resolved] = await (await service()).resolveCardEntries("project", [
      entry,
    ]);
    expect(resolved).toMatchObject({
      id: "asset:cloud",
      status: "unavailable",
      errorCode: "LOCAL_RESOURCE_MISSING",
    });
  });

  it("is downloading with progress while the prefetcher fetches it", async () => {
    const entry = await unregisteredEntry();
    const [resolved] = await (
      await service({ status: "downloading", progress: 0.5 })
    ).resolveCardEntries("project", [entry]);
    expect(resolved).toMatchObject({
      id: "asset:cloud",
      status: "downloading",
      progress: 0.5,
    });
  });
});
