import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serve } from "@hono/node-server";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActionAssetBinding,
  listActionAssetBindings,
  listActionAssetReferences,
  listProjectAssets,
  projectAssetAuthorityVersion,
  readProjectAsset,
  type Asset,
} from "@clash/shared-types";

import { managedLocalApiApps } from "./local-api-app.test-fixtures.js";
import {
  createLocalAssetInspectionService,
  type LocalAssetInspector,
} from "./local-asset-inspections.js";
import type { LocalAssetRepresentationService } from "./local-asset-representations.js";
import { createLocalMetadataStore } from "./local-metadata-store.js";
import { LocalMediaProcessTimeoutError } from "./local-media-process.js";
import {
  createLocalAssetRepresentationService,
  type LocalAssetRepresentationRecipeRunner,
} from "./local-asset-representations.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import { createLocalResourceStore } from "./local-resource-store.js";
import {
  createLocalProjectAssetService,
  publishLocalProjectAssetWithBindings,
  type LocalProjectAssetReplica,
} from "./local-project-assets.js";
import { FileReplicaStore } from "./loro/file-replica-store.js";
import { LocalLoroRoomHub } from "./sync.js";

const temporaryDirectories: string[] = [];
const { createApp: createLocalApiApp, close: closeApps } =
  managedLocalApiApps();
const PROJECT_ASSET_RECEIPT_RE =
  /^project-asset-v1:[a-f0-9]{16}:receipt:[A-Za-z0-9._~-]+$/;
const nodeRequire = createRequire(import.meta.url);

const inspectFixtureAsset: LocalAssetInspector = async ({ resource }) =>
  resource.kind === "image"
    ? {
        width: 1,
        height: 1,
        rotationDegrees: 0,
        contentType: resource.contentType ?? "image/png",
      }
    : resource.kind === "video"
      ? {
          width: 1,
          height: 1,
          rotationDegrees: 0,
          durationMs: 2_000,
          frameRate: 24,
          videoCodec: "h264",
          hasAudio: false,
          contentType: resource.contentType ?? "video/mp4",
        }
      : {
          durationMs: 2_000,
          hasAudio: true,
          audioCodec: "mp3",
          sampleRate: 48_000,
          channelCount: 2,
          channelLayout: "stereo",
          contentType: resource.contentType ?? "audio/mpeg",
        };

function projectTrashRequest(
  deleteOperationId: string,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: "DELETE",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ deleteOperationId }),
  };
}

/**
 * Most route tests use placeholder bytes, so a real ffmpeg/sharp derivation
 * would fail on them. Tests that exercise representations install their own
 * service and valid recipes.
 */
const noRepresentations: LocalAssetRepresentationService = {
  schedule() {},
  scheduleBackground() {},
  async ensure() {
    return [];
  },
  async read() {
    return undefined;
  },
  async failure() {
    return undefined;
  },
  async openThumbnail() {
    return undefined;
  },
  async openProxy() {
    return undefined;
  },
  async start() {},
  async close() {},
};

async function fixture() {
  const clashRoot = await mkdtemp(
    join(tmpdir(), "clash-project-asset-routes-"),
  );
  temporaryDirectories.push(clashRoot);
  const dataDir = join(clashRoot, "local-api");
  const service = createLocalProjectAssetService({
    dataDir,
    clashRoot,
    projectionOrigin: "http://seed.invalid",
    assetInspection: createLocalAssetInspectionService({
      dataDir,
      clashRoot,
      inspectResource: inspectFixtureAsset,
    }),
  });
  const asset = await service.installOwned({
    projectId: "project-a",
    projectAssetId: "result:one",
    kind: "audio",
    bytes: new TextEncoder().encode("0123456789"),
    contentType: "audio/mpeg",
    name: "result.unusual",
    metadata: { durationMs: 2_000 },
    provenance: { kind: "generation", actionRunId: "run-1" },
  });
  const appOptions = {
    dataDir,
    clashRoot,
    userId: "local-user",
    projectAssetProjectionOrigin: () => "http://127.0.0.1:49152",
    inspectAssetResource: inspectFixtureAsset,
    assetRepresentations: noRepresentations,
  };
  return {
    app: createLocalApiApp(appOptions),
    asset,
    service,
    clashRoot,
    dataDir,
  };
}

function legacyProjectAsset(input: {
  id: string;
  storageKey: string;
  digest: string;
  bytes: number;
}): Asset {
  return {
    id: input.id,
    userId: "local-user",
    kind: "image",
    srcR2Key: input.storageKey,
    coverR2Key: null,
    metadata: {
      bytes: input.bytes,
      contentType: "image/png",
      contentHash: input.digest,
      originalName: "legacy.png",
    },
    sourceModel: null,
    sourcePrompt: null,
    sourceTaskId: null,
    sources: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function replaceLegacyProjectAssets(input: {
  store: ReturnType<typeof createLocalMetadataStore>;
  projectId: string;
  asset: Asset;
  digest: string;
  bytes: Uint8Array;
  dataDir: string;
}): Promise<void> {
  const state = await input.store.load();
  state.assets = [input.asset];
  state.assetRefs = [
    {
      assetId: input.asset.id,
      projectId: input.projectId,
      importedAt: 1,
    },
  ];
  state.assetNodeRefs = [];
  state.libraryAssetRefs = [];
  await input.store.save(state, { replaceLegacyAssetMigrationInput: true });
  const path = join(input.dataDir, "assets", input.asset.srcR2Key);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, input.bytes);
}

function ageDeletedProjectForPurge(dataDir: string, projectId: string): void {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const database = new DatabaseSync(join(dataDir, "local.sqlite"));
  const agedDeletedAt = new Date(
    Date.now() - 8 * 24 * 60 * 60 * 1000,
  ).toISOString();
  try {
    database
      .prepare("UPDATE project SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(agedDeletedAt, agedDeletedAt, projectId);
  } finally {
    database.close();
  }
}

function editBindingCollisionReplica(input: {
  doc: LoroDoc;
  actionId: "image-editor" | "video-clipper";
  sourceAssetId: string;
}): {
  replica: LocalProjectAssetReplica;
  arm(): void;
  actionRunId(): string | null;
} {
  let armed = false;
  let collisionRunId: string | null = null;
  return {
    replica: {
      inspect: async (_id, read) => read(input.doc),
      mutate: async (_id, mutation) => {
        if (armed && collisionRunId === null) {
          const probe = input.doc.fork();
          await mutation(probe);
          const editOutput = listProjectAssets(probe).find(
            (entry) =>
              entry.provenance?.kind === "edit" &&
              !readProjectAsset(input.doc, entry.id),
          );
          const actionRunId = editOutput?.provenance?.actionRunId;
          if (actionRunId) {
            collisionRunId = actionRunId;
            const collision = createActionAssetBinding(input.doc, {
              id: `action-asset:${actionRunId}:output`,
              owner: {
                kind: "run",
                actionId: input.actionId,
                actionRevisionId: "collision-revision",
                actionRunId,
              },
              direction: "output",
              slot: "already-claimed",
              projectAssetId: input.sourceAssetId,
              role: "primary",
            });
            expect(collision).toMatchObject({ ok: true });
          }
        }
        return (await mutation(input.doc)).value;
      },
    },
    arm() {
      armed = true;
    },
    actionRunId() {
      return collisionRunId;
    },
  };
}

afterEach(async () => {
  await closeApps();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Project-scoped ResolvedAsset routes", () => {
  it("commits HTTP Asset lifecycle writes through the open Project room", async () => {
    const clashRoot = await mkdtemp(
      join(tmpdir(), "clash-project-asset-live-room-"),
    );
    temporaryDirectories.push(clashRoot);
    const dataDir = join(clashRoot, "local-api");
    const projectId = "live-project";
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    const room = await hub.room(projectId);
    const peer = new LoroDoc();
    room.addPeer((update) => peer.import(update));

    const replica: LocalProjectAssetReplica = {
      inspect: (id, read) => hub.inspectProject(id, read),
      mutate: (id, mutation) => hub.mutateProject(id, mutation),
    };
    const app = createLocalApiApp({
      dataDir,
      clashRoot,
      userId: "local-user",
      projectAssetProjectionOrigin: "http://127.0.0.1:49152",
      projectAssetReplica: replica,
      inspectAssetResource: async ({ resource }) => ({
        width: 1,
        height: 1,
        rotationDegrees: 0,
        contentType: resource.contentType ?? "image/png",
      }),
    });

    const bytes = new TextEncoder().encode("live room image");
    const collectionUrl = `http://127.0.0.1:49152/api/v1/projects/${projectId}/assets`;
    const assetUrl = `${collectionUrl}/live%3Aasset`;

    const form = new FormData();
    form.set("file", new File([bytes], "live.png", { type: "image/png" }));
    form.set("kind", "image");
    form.set("projectAssetId", "live:asset");

    const imported = await app.request(`${collectionUrl}/import-file`, {
      method: "POST",
      body: form,
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    expect(readProjectAsset(peer, "live:asset")?.lifecycle).toEqual({
      state: "active",
    });

    const trashed = await app.request(
      assetUrl,
      projectTrashRequest("delete:live-room"),
    );
    expect(trashed.status, await trashed.clone().text()).toBe(200);
    expect(readProjectAsset(peer, "live:asset")?.lifecycle.state).toBe(
      "trashed",
    );

    const restored = await app.request(`${assetUrl}/restore`, {
      method: "POST",
    });
    expect(restored.status).toBe(200);
    expect(readProjectAsset(peer, "live:asset")?.lifecycle).toEqual({
      state: "active",
    });
  });

  it("lists and reads the same storage-free ResolvedAsset shape at the configured Host origin", async () => {
    const { app, asset } = await fixture();
    const baseUrl = "http://127.0.0.1:49152/api/v1/projects/project-a/assets";
    const mediaUrl = `${baseUrl}/${encodeURIComponent(asset.id)}/media`;
    const expected = {
      id: "result:one",
      kind: "audio",
      name: "result.unusual",
      metadata: {
        durationMs: 2_000,
        hasAudio: true,
        audioCodec: "mp3",
        sampleRate: 48_000,
        channelCount: 2,
        channelLayout: "stereo",
        bytes: 10,
        contentType: "audio/mpeg",
        originalName: "result.unusual",
      },
      provenance: { kind: "generation", actionRunId: "run-1" },
      lifecycle: { state: "active" },
      status: "ready",
      url: mediaUrl,
    };

    const listed = await app.request(
      "http://localhost:49152/api/v1/projects/project-a/assets",
    );
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody).toMatchObject({ assets: [expected] });
    expect(listedBody.assets[0].createdAt).toEqual(expect.any(Number));

    const read = await app.request(
      `${baseUrl}/${encodeURIComponent(asset.id)}`,
    );
    expect(read.status).toBe(200);
    expect(read.headers.get("x-clash-read-receipt")).toMatch(
      PROJECT_ASSET_RECEIPT_RE,
    );
    expect(await read.json()).toEqual(listedBody.assets[0]);
  });

  it("serves the immutable projection with Resource validators and byte ranges", async () => {
    const { app, asset } = await fixture();
    const mediaUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}/media`;

    const full = await app.request(mediaUrl);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("audio/mpeg");
    expect(full.headers.get("content-length")).toBe("10");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    const etag = full.headers.get("etag");
    const lastModified = full.headers.get("last-modified");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(lastModified).not.toBeNull();
    await expect(full.text()).resolves.toBe("0123456789");

    const partial = await app.request(mediaUrl, {
      headers: { range: "bytes=2-5" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-type")).toBe("audio/mpeg");
    expect(partial.headers.get("content-length")).toBe("4");
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(partial.headers.get("etag")).toBe(etag);
    await expect(partial.text()).resolves.toBe("2345");

    const notModified = await app.request(mediaUrl, {
      headers: { "if-none-match": etag! },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.body).toBeNull();
    expect(notModified.headers.get("etag")).toBe(etag);

    const staleRange = await app.request(mediaUrl, {
      headers: { range: "bytes=2-5", "if-range": '"stale-etag"' },
    });
    expect(staleRange.status).toBe(200);
    expect(staleRange.headers.get("content-range")).toBeNull();
    await expect(staleRange.text()).resolves.toBe("0123456789");

    const matchingRange = await app.request(mediaUrl, {
      headers: { range: "bytes=2-5", "if-range": etag! },
    });
    expect(matchingRange.status).toBe(206);
    await expect(matchingRange.text()).resolves.toBe("2345");

    const multiRange = await app.request(mediaUrl, {
      headers: { range: "bytes=0-1,4-5" },
    });
    expect(multiRange.status).toBe(200);
    expect(multiRange.headers.get("content-range")).toBeNull();
    await expect(multiRange.text()).resolves.toBe("0123456789");

    const unsatisfiable = await app.request(mediaUrl, {
      headers: { range: "bytes=99-100" },
    });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10");
  });

  /** Stands in for the Node socket `@hono/node-server` passes as `c.env`. */
  const socketPeer = (remoteAddress: string | undefined) => ({
    incoming: { socket: { remoteAddress } },
  });

  it("exposes the read-only store file of a Project Asset to same-machine clients", async () => {
    const { app, asset } = await fixture();
    const baseUrl = "http://127.0.0.1:49152/api/v1/projects/project-a/assets";

    const response = await app.request(
      `${baseUrl}/${encodeURIComponent(asset.id)}/local-file`,
      {},
      socketPeer("127.0.0.1"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      path: string;
      byteLength: number;
    };
    expect(body.byteLength).toBe(10);
    await expect(readFile(body.path, "utf8")).resolves.toBe("0123456789");
    // Read-only for everyone: a linked working-tree file cannot rewrite it.
    expect((await stat(body.path)).mode & 0o222).toBe(0);

    const missing = await app.request(
      `${baseUrl}/missing-asset/local-file`,
      {},
      socketPeer("127.0.0.1"),
    );
    expect(missing.status).toBe(404);
  });

  it.each(["127.0.0.1", "127.4.5.6", "::1", "::ffff:127.0.0.1"])(
    "answers the store file to the loopback socket peer %s",
    async (remoteAddress) => {
      const { app, asset } = await fixture();
      const response = await app.request(
        `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}/local-file`,
        {},
        socketPeer(remoteAddress),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { path: string };
      await expect(readFile(body.path, "utf8")).resolves.toBe("0123456789");
    },
  );

  it.each([
    ["a LAN peer", socketPeer("192.168.1.5"), {}],
    ["an IPv4-mapped non-loopback peer", socketPeer("::ffff:10.0.0.1"), {}],
    ["a socket without a peer address", socketPeer(undefined), {}],
    ["a request with no socket", undefined, {}],
    [
      "a non-loopback peer claiming loopback in headers",
      socketPeer("192.168.1.5"),
      {
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
        forwarded: "for=127.0.0.1",
        host: "127.0.0.1:49152",
      },
    ],
  ])(
    "refuses the store file to %s without revealing the path",
    async (_label, env, headers) => {
      const { app, asset, dataDir, clashRoot } = await fixture();
      const baseUrl = "http://127.0.0.1:49152/api/v1/projects/project-a/assets";

      const response = await app.request(
        `${baseUrl}/${encodeURIComponent(asset.id)}/local-file`,
        { headers },
        env,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      const text = await response.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(typeof body.error).toBe("string");
      expect(body).not.toHaveProperty("path");
      expect(body).not.toHaveProperty("byteLength");
      expect(text).not.toContain(dataDir);
      expect(text).not.toContain(clashRoot);

      // Existence is not disclosed either: a missing Asset answers the same.
      const missing = await app.request(
        `${baseUrl}/missing-asset/local-file`,
        { headers },
        env,
      );
      expect(missing.status).toBe(403);
    },
  );

  it("reads the peer address from the real Node socket behind the Host server", async () => {
    const { app, asset } = await fixture();
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    try {
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}/local-file`,
        { headers: { "x-forwarded-for": "192.168.1.5" } },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { path: string };
      await expect(readFile(body.path, "utf8")).resolves.toBe("0123456789");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("projects a video proxy for preview playback and keeps /media on the original", async () => {
    const { service, clashRoot, dataDir } = await fixture();
    await service.installOwned({
      projectId: "project-a",
      projectAssetId: "clip:one",
      kind: "video",
      bytes: new TextEncoder().encode("original-video"),
      contentType: "video/mp4",
      name: "clip.mp4",
      metadata: { durationMs: 2_000 },
      provenance: { kind: "generation", actionRunId: "run-clip" },
    });
    const proxyPath = join(clashRoot, "proxy.mp4");
    await writeFile(proxyPath, "proxy-bytes");
    let proxyReady = false;
    const proxy = {
      role: "proxy" as const,
      recipe: "video-proxy/v1:test",
      resourceId: "resource-proxy",
    };
    const representations: LocalAssetRepresentationService = {
      schedule() {},
      scheduleBackground() {},
      async ensure() {
        return [];
      },
      async read(_sourceResourceId, role) {
        return role === "proxy" && proxyReady ? proxy : undefined;
      },
      async openThumbnail() {
        return undefined;
      },
      async openProxy() {
        return proxyReady
          ? {
              resource: {
                id: proxy.resourceId,
                kind: "video" as const,
                digest: { algorithm: "sha256" as const, value: "b".repeat(64) },
                byteLength: 11,
                contentType: "video/mp4",
              },
              path: proxyPath,
              createdAt: 1,
              storageKey: "derived/resource-proxy.mp4",
            }
          : undefined;
      },
      async start() {},
      async close() {},
    };
    const app = createLocalApiApp({
      dataDir,
      clashRoot,
      userId: "local-user",
      projectAssetProjectionOrigin: () => "http://127.0.0.1:49152",
      inspectAssetResource: inspectFixtureAsset,
      assetRepresentations: representations,
    });
    const assetUrl =
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/clip%3Aone";

    const pending = (await (await app.request(assetUrl)).json()) as {
      url: string;
      proxyUrl?: string;
    };
    expect(pending.url).toBe(`${assetUrl}/media`);
    expect(pending.proxyUrl).toBeUndefined();
    expect((await app.request(`${assetUrl}/proxy`)).status).toBe(404);

    proxyReady = true;
    const ready = (await (await app.request(assetUrl)).json()) as {
      url: string;
      proxyUrl?: string;
    };
    expect(ready.url).toBe(`${assetUrl}/media`);
    expect(ready.proxyUrl).toBe(`${assetUrl}/proxy`);

    const played = await app.request(ready.proxyUrl!, {
      headers: { range: "bytes=0-4" },
    });
    expect(played.status).toBe(206);
    expect(played.headers.get("content-type")).toBe("video/mp4");
    expect(played.headers.get("content-range")).toBe("bytes 0-4/11");
    await expect(played.text()).resolves.toBe("proxy");
    await expect((await app.request(ready.url)).text()).resolves.toBe(
      "original-video",
    );
  });

  it("carries a coded representation failure instead of a missing video poster URL", async () => {
    const { service, clashRoot, dataDir } = await fixture();
    await service.installOwned({
      projectId: "project-a",
      projectAssetId: "clip:interrupted",
      kind: "video",
      bytes: new TextEncoder().encode("original-video"),
      contentType: "video/mp4",
      name: "clip.mp4",
      metadata: { durationMs: 2_000 },
      provenance: { kind: "generation", actionRunId: "run-clip" },
    });
    const thumbnail = {
      role: "thumbnail" as const,
      recipe: "video-poster/v1:test",
      resourceId: "resource-poster",
    };
    const representations: LocalAssetRepresentationService = {
      schedule() {},
      scheduleBackground() {},
      async ensure() {
        return [];
      },
      async read(_sourceResourceId, role) {
        return role === "thumbnail" ? thumbnail : undefined;
      },
      async failure(_sourceResourceId, role) {
        return role === "proxy"
          ? {
              role: "proxy",
              code: "REPRESENTATION_INTERRUPTED",
              message: "The Host stopped while deriving this representation.",
              retryAt: 1_790_000_000_000,
              attempts: 2,
            }
          : undefined;
      },
      async openThumbnail() {
        return undefined;
      },
      async openProxy() {
        return undefined;
      },
      async start() {},
      async close() {},
    };
    const app = createLocalApiApp({
      dataDir,
      clashRoot,
      userId: "local-user",
      projectAssetProjectionOrigin: () => "http://127.0.0.1:49152",
      inspectAssetResource: inspectFixtureAsset,
      assetRepresentations: representations,
    });

    const response = await app.request(
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/clip%3Ainterrupted",
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      thumbnailUrl?: string;
      proxyUrl?: string;
      representationFailure?: unknown;
    };
    expect(body.thumbnailUrl).toBe(
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/clip%3Ainterrupted/thumbnail",
    );
    expect(body.proxyUrl).toBeUndefined();
    expect(body.representationFailure).toEqual({
      role: "proxy",
      code: "REPRESENTATION_INTERRUPTED",
      message: "The Host stopped while deriving this representation.",
      retryAt: 1_790_000_000_000,
      attempts: 2,
    });
  });

  const inspectLargeVideo: LocalAssetInspector = async ({ resource }) => ({
    width: 1_920,
    height: 1_080,
    rotationDegrees: 0,
    durationMs: 2_000,
    frameRate: 24,
    videoCodec: "h264",
    hasAudio: false,
    contentType: resource.contentType ?? "video/mp4",
  });

  function derivedRecipeRunner(
    resources: ReturnType<typeof createLocalResourceStore>,
    ran: string[],
  ): LocalAssetRepresentationRecipeRunner {
    return async ({ recipe }) => {
      ran.push(recipe.id);
      const staged = await resources.stage({
        bytes: new TextEncoder().encode(`derived ${recipe.id}`),
      });
      return recipe.role === "proxy"
        ? {
            kind: "resource",
            role: "proxy",
            stagedResourceId: staged.resourceId,
            resourceKind: "video",
            contentType: "video/mp4",
          }
        : {
            kind: "resource",
            role: "thumbnail",
            stagedResourceId: staged.resourceId,
            resourceKind: "image",
            contentType: "image/webp",
          };
    };
  }

  it("advertises a missing poster route for a replica-arrived video and backfills its proxy", async () => {
    const { clashRoot, dataDir } = await fixture();
    const resources = createLocalResourceStore({ dataDir, clashRoot });
    const publication = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://seed.invalid",
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: inspectLargeVideo,
      }),
    });
    // Cloud sync/workspace import writes the Project Asset fact straight into
    // the local replica; nothing calls installOwnedResult, so no derivation is
    // scheduled at publication time.
    const source = await resources.install({
      kind: "video",
      contentType: "video/mp4",
      bytes: new TextEncoder().encode("replica-video"),
    });
    const entry = await publication.prepareStagedOwnedEntry({
      projectAssetId: "clip:replica",
      kind: "video",
      resourceId: source.resource.id,
      metadata: { durationMs: 2_000 },
    });
    const replicas = new FileReplicaStore(join(dataDir, "projects"));
    await replicas.updateSnapshotAtomic("project-a", (doc) => {
      const result = publishLocalProjectAssetWithBindings(doc, entry, []);
      return { value: result.entry, save: result.changed };
    });
    const ran: string[] = [];
    const representations = createLocalAssetRepresentationService({
      dataDir,
      clashRoot,
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: inspectLargeVideo,
      }),
      ffmpegPath: () => "/test/bin/ffmpeg",
      recipeRunner: derivedRecipeRunner(resources, ran),
    });
    const app = createLocalApiApp({
      dataDir,
      clashRoot,
      userId: "local-user",
      projectAssetProjectionOrigin: () => "http://127.0.0.1:49152",
      inspectAssetResource: inspectLargeVideo,
      assetRepresentations: representations,
    });
    const assetUrl =
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/clip%3Areplica";
    try {
      const pending = await app.request(assetUrl);
      expect(pending.status, await pending.clone().text()).toBe(200);
      const body = (await pending.json()) as {
        thumbnailUrl?: string;
        proxyUrl?: string;
        representationFailure?: unknown;
      };
      expect(body.thumbnailUrl).toBe(`${assetUrl}/thumbnail`);
      expect(body.proxyUrl).toBeUndefined();
      expect(body.representationFailure).toBeUndefined();

      // The advertised route derives the poster on demand.
      const poster = await app.request(body.thumbnailUrl!);
      expect(poster.status, await poster.clone().text()).toBe(200);
      await expect(poster.text()).resolves.toBe("derived video-poster");

      // The background backstop publishes the proxy without a proxy request.
      await vi.waitFor(
        async () => {
          const read = await app.request(assetUrl);
          expect(read.status).toBe(200);
          const current = (await read.json()) as { proxyUrl?: string };
          expect(current.proxyUrl).toBe(`${assetUrl}/proxy`);
        },
        { timeout: 5_000 },
      );
      const proxy = await app.request(`${assetUrl}/proxy`);
      expect(proxy.status, await proxy.clone().text()).toBe(200);
      await expect(proxy.text()).resolves.toBe("derived video-proxy");
      expect(ran).toEqual(
        expect.arrayContaining(["video-poster", "video-proxy"]),
      );
    } finally {
      await representations.close();
    }
  });

  it("returns the Asset list without waiting for missing-video backstops and runs one background derivation at a time", async () => {
    const { clashRoot, dataDir } = await fixture();
    const resources = createLocalResourceStore({ dataDir, clashRoot });
    const publication = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://seed.invalid",
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: inspectLargeVideo,
      }),
    });
    const assetCount = 4;
    for (let index = 0; index < assetCount; index += 1) {
      const source = await resources.install({
        kind: "video",
        contentType: "video/mp4",
        bytes: new TextEncoder().encode(`list-video-${index}`),
      });
      await publication.publishStagedOwnedWithBindings({
        projectId: "project-list",
        projectAssetId: `clip:list-${index}`,
        kind: "video",
        resourceId: source.resource.id,
        metadata: { durationMs: 2_000 },
        bindings: [],
      });
    }
    const gates: Array<() => void> = [];
    const ran: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const recipeRunner: LocalAssetRepresentationRecipeRunner = async ({
      recipe,
    }) => {
      ran.push(recipe.id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active -= 1;
      const staged = await resources.stage({
        bytes: new TextEncoder().encode(`derived ${recipe.id}`),
      });
      return recipe.role === "proxy"
        ? {
            kind: "resource",
            role: "proxy",
            stagedResourceId: staged.resourceId,
            resourceKind: "video",
            contentType: "video/mp4",
          }
        : {
            kind: "resource",
            role: "thumbnail",
            stagedResourceId: staged.resourceId,
            resourceKind: "image",
            contentType: "image/webp",
          };
    };
    const representations = createLocalAssetRepresentationService({
      dataDir,
      clashRoot,
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: inspectLargeVideo,
      }),
      ffmpegPath: () => "/test/bin/ffmpeg",
      recipeRunner,
    });
    const app = createLocalApiApp({
      dataDir,
      clashRoot,
      userId: "local-user",
      projectAssetProjectionOrigin: () => "http://127.0.0.1:49152",
      inspectAssetResource: inspectLargeVideo,
      assetRepresentations: representations,
    });
    try {
      // The list must return even though the first background derivation is
      // still blocked on its gate.
      const listed = await app.request(
        "http://127.0.0.1:49152/api/v1/projects/project-list/assets",
      );
      expect(listed.status, await listed.clone().text()).toBe(200);
      const body = (await listed.json()) as {
        assets: Array<{ thumbnailUrl?: string; proxyUrl?: string }>;
      };
      expect(body.assets).toHaveLength(assetCount);
      for (const asset of body.assets) {
        expect(asset.thumbnailUrl).toMatch(/\/thumbnail$/u);
        expect(asset.proxyUrl).toBeUndefined();
      }
      await vi.waitFor(() => expect(gates).toHaveLength(1), {
        timeout: 5_000,
      });
      expect(maximumActive).toBe(1);

      // Drain poster then proxy for each source, one background derivation at
      // a time; the queue never overlaps background agents.
      for (let index = 0; index < assetCount * 2; index += 1) {
        await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0), {
          timeout: 5_000,
        });
        gates.shift()?.();
      }
      await vi.waitFor(() => expect(ran).toHaveLength(assetCount * 2), {
        timeout: 5_000,
      });
      expect(maximumActive).toBe(1);
    } finally {
      for (const release of gates.splice(0)) release();
      await representations.close();
    }
  });

  it("batch reads only requested Asset entries from the selected Project", async () => {
    const { app, asset } = await fixture();
    const baseUrl = "http://127.0.0.1:49152/api/v1/projects/project-a/assets";

    const response = await app.request(`${baseUrl}/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["missing", asset.id, asset.id] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      assets: [
        expect.objectContaining({
          id: "result:one",
          kind: "audio",
          status: "ready",
          url: `${baseUrl}/${encodeURIComponent(asset.id)}/media`,
        }),
      ],
    });
  });

  it("fails a hung inspection with a coded timeout and leaves no staged bytes", async () => {
    const clashRoot = await mkdtemp(
      join(tmpdir(), "clash-project-asset-probe-timeout-"),
    );
    temporaryDirectories.push(clashRoot);
    const dataDir = join(clashRoot, "local-api");
    const app = createLocalApiApp({
      dataDir,
      clashRoot,
      userId: "local-user",
      projectAssetProjectionOrigin: () => "http://127.0.0.1:49152",
      inspectAssetResource: async () => {
        throw new LocalMediaProcessTimeoutError(
          "ASSET_INSPECTION_TIMEOUT",
          "inspect import.mp4",
          100,
        );
      },
    });
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([1, 2, 3])], "hang.mp4", {
        type: "video/mp4",
      }),
    );
    form.set("kind", "video");
    form.set("projectAssetId", "import:hang");

    const response = await app.request(
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file",
      { method: "POST", body: form },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "ASSET_INSPECTION_TIMEOUT",
    });

    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        prepare(sql: string): { get(): unknown };
        close(): void;
      };
    };
    const database = new DatabaseSync(join(dataDir, "local.sqlite"));
    try {
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM local_resource_staging")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM local_resources").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("imports multipart bytes idempotently under an explicit Project Asset id and rejects conflicting bytes", async () => {
    const { app } = await fixture();
    const url =
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file";
    const request = (value: string) => {
      const form = new FormData();
      form.set("file", new File([value], "hero.png", { type: "image/png" }));
      form.set("kind", "image");
      form.set("projectAssetId", "imported:multipart");
      return app.request(url, { method: "POST", body: form });
    };

    const first = await request("multipart image");
    const second = await request("multipart image");
    expect(first.status).toBe(201);
    // The same bytes under the same id are an explicit replay, not a new Asset.
    expect(second.status).toBe(200);
    const expected = {
      id: "imported:multipart",
      kind: "image",
      name: "hero.png",
      metadata: {
        width: 1,
        height: 1,
        bytes: 15,
        contentType: "image/png",
        rotationDegrees: 0,
        originalName: "hero.png",
      },
      provenance: { kind: "import" },
      lifecycle: { state: "active" },
      status: "ready",
      url: "http://127.0.0.1:49152/api/v1/projects/project-a/assets/imported%3Amultipart/media",
      thumbnailUrl:
        "http://127.0.0.1:49152/api/v1/projects/project-a/assets/imported%3Amultipart/media",
    };
    const imported = await first.json();
    expect(imported).toMatchObject(expected);
    expect(imported.createdAt).toEqual(expect.any(Number));
    await expect(second.json()).resolves.toEqual(imported);
    expect(JSON.stringify(imported)).not.toMatch(
      /storageKey|localBlobKey|signedUrl|\/Users\//,
    );

    const conflicting = await request("different immutable bytes");
    expect(conflicting.status, await conflicting.clone().text()).toBe(409);
    await expect(conflicting.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_ID_COLLISION",
    });
  });

  it("names the existing Asset instead of importing the same bytes under a second id when asked to reject duplicates", async () => {
    const { app } = await fixture();
    const base = "http://127.0.0.1:49152/api/v1/projects/project-a/assets";
    const request = (
      projectAssetId: string,
      extra: Record<string, string> = {},
    ) => {
      const form = new FormData();
      form.set(
        "file",
        new File(["one image"], "hero.png", { type: "image/png" }),
      );
      form.set("kind", "image");
      form.set("projectAssetId", projectAssetId);
      for (const [key, value] of Object.entries(extra)) form.set(key, value);
      return app.request(`${base}/import-file`, { method: "POST", body: form });
    };

    // The observed mistake: a first import under a minted id, then the same
    // file again under the id the task actually asked for.
    expect((await request("asset:minted")).status).toBe(201);
    const duplicate = await request("preassigned", {
      duplicateContent: "reject",
    });
    expect(duplicate.status, await duplicate.clone().text()).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_DUPLICATE_CONTENT",
      projectAssetId: "preassigned",
      existingProjectAssetIds: ["asset:minted"],
    });
    const afterRejection = (await (await app.request(base)).json()) as {
      assets: Array<{ id: string }>;
    };
    expect(afterRejection.assets.map(({ id }) => id)).not.toContain(
      "preassigned",
    );

    // Replaying the id that already owns the bytes is not a duplicate: it
    // returns the existing Asset as an explicit replay.
    const replay = await request("asset:minted", {
      duplicateContent: "reject",
    });
    expect(replay.status).toBe(200);
    // A second Asset over the same bytes stays possible when it is asked for.
    expect((await request("copy", { duplicateContent: "allow" })).status).toBe(
      201,
    );
    expect((await request("default-copy")).status).toBe(201);

    const invalid = await request("other", { duplicateContent: "maybe" });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      code: "INVALID_PROJECT_ASSET_IMPORT",
    });
  });

  it("answers a re-import of a trashed Asset with restore instead of an id collision", async () => {
    const { app } = await fixture();
    const base = "http://127.0.0.1:49152/api/v1/projects/project-a/assets";
    const request = () => {
      const form = new FormData();
      form.set(
        "file",
        new File(["trashed image"], "hero.png", { type: "image/png" }),
      );
      form.set("kind", "image");
      form.set("projectAssetId", "imported:trashed");
      return app.request(`${base}/import-file`, { method: "POST", body: form });
    };
    expect((await request()).status).toBe(201);
    const trashed = await app.request(
      `${base}/${encodeURIComponent("imported:trashed")}`,
      projectTrashRequest("delete:reimport"),
    );
    expect(trashed.status, await trashed.clone().text()).toBe(200);

    const reimport = await request();
    expect(reimport.status).toBe(409);
    await expect(reimport.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_TRASHED",
      projectAssetId: "imported:trashed",
    });
  });

  it("publishes edit outputs as ResolvedAsset and records Action input/output bindings", async () => {
    const { app, dataDir } = await fixture();
    const importForm = new FormData();
    importForm.set(
      "file",
      new File(["source image"], "source.png", { type: "image/png" }),
    );
    importForm.set("kind", "image");
    importForm.set("projectAssetId", "source:image");
    const imported = await app.request(
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file",
      { method: "POST", body: importForm },
    );
    expect(imported.status).toBe(201);

    const invocation = {
      actionId: "image-editor",
      projectId: "project-a",
      source: { assetId: "source:image", kind: "image" },
      params: { rotation: 90 },
      surface: "asset-preview",
      mode: "implicit",
    };
    const editForm = new FormData();
    editForm.set(
      "file",
      new File(["edited image"], "edited.png", { type: "image/png" }),
    );
    editForm.set("projectId", "project-a");
    editForm.set("sourceAssetId", "source:image");
    editForm.set("editKind", "image-editor");
    editForm.set("outputKind", "image");
    editForm.set("editParams", JSON.stringify(invocation.params));
    editForm.set("origin", "asset-preview");
    editForm.set("invocation", JSON.stringify(invocation));
    editForm.set("actionRunId", "edit:route-replay-1");

    const first = await app.request("/api/v1/edits", {
      method: "POST",
      body: editForm,
    });
    const replay = await app.request("/api/v1/edits", {
      method: "POST",
      body: editForm,
    });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(replay.status, await replay.clone().text()).toBe(200);
    const output = (await first.json()) as { id: string };
    await expect(replay.json()).resolves.toEqual(output);
    expect(output).toMatchObject({
      id: expect.stringMatching(/^asset:edit:/),
      kind: "image",
      name: "edited.png",
      provenance: {
        kind: "edit",
        actionRunId: "edit:route-replay-1",
        model: "implicit:image-editor",
      },
      status: "ready",
      url: expect.stringContaining("/api/v1/projects/project-a/assets/"),
    });
    expect(JSON.stringify(output)).not.toMatch(
      /srcR2Key|storageKey|signedUrl|coverR2Key/,
    );

    const doc = await new FileReplicaStore(join(dataDir, "projects")).recover(
      "project-a",
    );
    expect(listActionAssetReferences(doc, "source:image")).toMatchObject([
      {
        direction: "input",
        slot: "source",
        projectAssetId: "source:image",
        role: "source",
      },
    ]);
    expect(listActionAssetReferences(doc, output.id)).toMatchObject([
      {
        direction: "output",
        slot: "output",
        projectAssetId: output.id,
        role: "primary",
      },
    ]);
    expect(
      listProjectAssets(doc).filter(
        (entry) => entry.provenance?.actionRunId === "edit:route-replay-1",
      ),
    ).toHaveLength(1);
    expect(
      listActionAssetBindings(doc).filter(
        (binding) =>
          binding.owner.kind === "run" &&
          binding.owner.actionRunId === "edit:route-replay-1",
      ),
    ).toHaveLength(2);
  });

  it("rejects reuse of an edit actionRunId for different immutable output bytes", async () => {
    const { app, dataDir } = await fixture();
    const sourceForm = new FormData();
    sourceForm.set(
      "file",
      new File(["source image"], "source.png", { type: "image/png" }),
    );
    sourceForm.set("kind", "image");
    sourceForm.set("projectAssetId", "source:image");
    const imported = await app.request(
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file",
      { method: "POST", body: sourceForm },
    );
    expect(imported.status, await imported.clone().text()).toBe(201);

    const invocation = {
      actionId: "image-editor",
      projectId: "project-a",
      source: { assetId: "source:image", kind: "image" },
      params: { rotation: 90 },
      surface: "asset-preview",
      mode: "implicit",
    };
    const request = (bytes: string) => {
      const form = new FormData();
      form.set("file", new File([bytes], "edited.png", { type: "image/png" }));
      form.set("projectId", "project-a");
      form.set("sourceAssetId", "source:image");
      form.set("editKind", "image-editor");
      form.set("outputKind", "image");
      form.set("editParams", JSON.stringify(invocation.params));
      form.set("origin", "asset-preview");
      form.set("invocation", JSON.stringify(invocation));
      form.set("actionRunId", "edit:bytes-conflict-1");
      return app.request("/api/v1/edits", { method: "POST", body: form });
    };

    const first = await request("first edited image");
    const conflict = await request("different edited image");

    expect(first.status, await first.clone().text()).toBe(200);
    expect(conflict.status, await conflict.clone().text()).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_ID_COLLISION",
    });
    const doc = await new FileReplicaStore(join(dataDir, "projects")).recover(
      "project-a",
    );
    expect(
      listProjectAssets(doc).filter(
        (entry) => entry.provenance?.actionRunId === "edit:bytes-conflict-1",
      ),
    ).toHaveLength(1);
    expect(
      listActionAssetBindings(doc).filter(
        (binding) =>
          binding.owner.kind === "run" &&
          binding.owner.actionRunId === "edit:bytes-conflict-1",
      ),
    ).toHaveLength(2);
  });

  it("rejects reuse of an edit actionRunId for a different frozen invocation", async () => {
    const { app, dataDir } = await fixture();
    const sourceForm = new FormData();
    sourceForm.set(
      "file",
      new File(["source image"], "source.png", { type: "image/png" }),
    );
    sourceForm.set("kind", "image");
    sourceForm.set("projectAssetId", "source:image");
    const imported = await app.request(
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file",
      { method: "POST", body: sourceForm },
    );
    expect(imported.status, await imported.clone().text()).toBe(201);

    const request = (rotation: 90 | 180) => {
      const invocation = {
        actionId: "image-editor",
        projectId: "project-a",
        source: { assetId: "source:image", kind: "image" },
        params: { rotation },
        surface: "asset-preview",
        mode: "implicit",
      };
      const form = new FormData();
      form.set(
        "file",
        new File(["same edited bytes"], "edited.png", {
          type: "image/png",
        }),
      );
      form.set("projectId", "project-a");
      form.set("sourceAssetId", "source:image");
      form.set("editKind", "image-editor");
      form.set("outputKind", "image");
      form.set("editParams", JSON.stringify(invocation.params));
      form.set("origin", "asset-preview");
      form.set("invocation", JSON.stringify(invocation));
      form.set("actionRunId", "edit:invocation-conflict-1");
      return app.request("/api/v1/edits", { method: "POST", body: form });
    };

    const first = await request(90);
    const conflict = await request(180);

    expect(first.status, await first.clone().text()).toBe(200);
    expect(conflict.status, await conflict.clone().text()).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "ACTION_ASSET_BINDING_ID_COLLISION",
    });
    const doc = await new FileReplicaStore(join(dataDir, "projects")).recover(
      "project-a",
    );
    expect(
      listProjectAssets(doc).filter(
        (entry) =>
          entry.provenance?.actionRunId === "edit:invocation-conflict-1",
      ),
    ).toHaveLength(1);
    expect(
      listActionAssetBindings(doc).filter(
        (binding) =>
          binding.owner.kind === "run" &&
          binding.owner.actionRunId === "edit:invocation-conflict-1",
      ),
    ).toHaveLength(2);
  });

  it("converges repeated video-crop computation onto one output and one binding set", async () => {
    const { app, clashRoot, dataDir } = await fixture();
    const sourceForm = new FormData();
    sourceForm.set(
      "file",
      new File(["source video"], "source.mp4", { type: "video/mp4" }),
    );
    sourceForm.set("kind", "video");
    sourceForm.set("projectAssetId", "source:video");
    const imported = await app.request(
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file",
      { method: "POST", body: sourceForm },
    );
    expect(imported.status, await imported.clone().text()).toBe(201);

    const fakeFfmpeg = join(clashRoot, "fake-replay-ffmpeg");
    await writeFile(
      fakeFfmpeg,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        'const input = args[args.indexOf("-i") + 1];',
        "const output = args[args.length - 1];",
        'const start = args[args.indexOf("-ss") + 1];',
        'const duration = args[args.indexOf("-t") + 1];',
        "fs.writeFileSync(output, Buffer.concat([fs.readFileSync(input), Buffer.from(` crop:${start}:${duration}`)]));",
      ].join("\n"),
    );
    await chmod(fakeFfmpeg, 0o755);
    const priorFfmpegPath = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = fakeFfmpeg;
    const params = { mode: "crop" as const, startSec: 0, endSec: 1 };
    const body = {
      actionRunId: "edit:crop-replay-1",
      projectId: "project-a",
      sourceAssetId: "source:video",
      params,
      origin: "asset-preview",
      invocation: {
        actionId: "video-clipper",
        projectId: "project-a",
        source: { assetId: "source:video", kind: "video" },
        params,
        surface: "asset-preview",
        mode: "implicit",
      },
    };
    const request = () =>
      app.request("/api/v1/edits/video-crop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    let first: Response;
    let replay: Response;
    let conflict: Response;
    try {
      first = await request();
      replay = await request();
      conflict = await app.request("/api/v1/edits/video-crop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...body,
          params: { mode: "crop", startSec: 0, endSec: 1.5 },
          invocation: {
            ...body.invocation,
            params: { mode: "crop", startSec: 0, endSec: 1.5 },
          },
        }),
      });
    } finally {
      if (priorFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = priorFfmpegPath;
    }

    expect(first.status, await first.clone().text()).toBe(200);
    expect(replay.status, await replay.clone().text()).toBe(200);
    const output = (await first.json()) as { id: string };
    await expect(replay.json()).resolves.toEqual(output);
    expect(conflict.status, await conflict.clone().text()).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "PROJECT_ASSET_ID_COLLISION",
    });
    const doc = await new FileReplicaStore(join(dataDir, "projects")).recover(
      "project-a",
    );
    expect(
      listProjectAssets(doc).filter(
        (entry) => entry.provenance?.actionRunId === "edit:crop-replay-1",
      ),
    ).toHaveLength(1);
    expect(
      listActionAssetBindings(doc).filter(
        (binding) =>
          binding.owner.kind === "run" &&
          binding.owner.actionRunId === "edit:crop-replay-1",
      ),
    ).toHaveLength(2);
  });

  it("edits an admitted linked source by publishing a new owned entry without changing the source", async () => {
    const { app, dataDir } = await fixture();
    const globalAssetId = "global:linked-edit-source";
    const globalForm = new FormData();
    globalForm.set(
      "file",
      new File(["linked source image"], "linked-source.png", {
        type: "image/png",
      }),
    );
    globalForm.set("kind", "image");
    globalForm.set("globalAssetId", globalAssetId);
    const imported = await app.request(
      "http://127.0.0.1:49152/api/v1/libraries/personal/assets/import-file",
      { method: "POST", body: globalForm },
    );
    expect(imported.status, await imported.clone().text()).toBe(201);

    const admittedResponse = await app.request(
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/admit",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ globalAssetId }),
      },
    );
    expect(admittedResponse.status, await admittedResponse.clone().text()).toBe(
      201,
    );
    const admitted = (await admittedResponse.json()) as { id: string };
    const replicas = new FileReplicaStore(join(dataDir, "projects"));
    const sourceBefore = readProjectAsset(
      await replicas.recover("project-a"),
      admitted.id,
    );
    expect(sourceBefore).toMatchObject({
      id: admitted.id,
      source: {
        kind: "linked",
        origin: {
          scope: "global",
          libraryId: "personal",
          entryId: globalAssetId,
        },
      },
      lifecycle: { state: "active" },
    });

    const invocation = {
      actionId: "image-editor",
      projectId: "project-a",
      source: { assetId: admitted.id, kind: "image" },
      params: { rotation: 90 },
      surface: "asset-preview",
      mode: "implicit",
    };
    const editForm = new FormData();
    editForm.set(
      "file",
      new File(["edited linked image"], "edited-linked.png", {
        type: "image/png",
      }),
    );
    editForm.set("projectId", "project-a");
    editForm.set("sourceAssetId", admitted.id);
    editForm.set("editKind", "image-editor");
    editForm.set("outputKind", "image");
    editForm.set("editParams", JSON.stringify(invocation.params));
    editForm.set("origin", "asset-preview");
    editForm.set("invocation", JSON.stringify(invocation));
    editForm.set("actionRunId", "edit:linked-source-1");

    const editedResponse = await app.request("/api/v1/edits", {
      method: "POST",
      body: editForm,
    });
    expect(editedResponse.status, await editedResponse.clone().text()).toBe(
      200,
    );
    const edited = (await editedResponse.json()) as { id: string };
    expect(edited.id).not.toBe(admitted.id);

    const after = await replicas.recover("project-a");
    expect(readProjectAsset(after, admitted.id)).toEqual(sourceBefore);
    expect(readProjectAsset(after, edited.id)).toMatchObject({
      id: edited.id,
      source: { kind: "owned" },
      lifecycle: { state: "active" },
      provenance: { kind: "edit" },
    });
  });

  it("keeps only staged bytes when an edit output binding identity collides", async () => {
    const clashRoot = await mkdtemp(
      join(tmpdir(), "clash-project-asset-edit-collision-"),
    );
    temporaryDirectories.push(clashRoot);
    const dataDir = join(clashRoot, "local-api");
    const projectId = "edit-collision-project";
    const doc = new LoroDoc();
    const collision = editBindingCollisionReplica({
      doc,
      actionId: "image-editor",
      sourceAssetId: "source:image",
    });
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      replica: collision.replica,
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: inspectFixtureAsset,
      }),
    });
    await service.installOwned({
      projectId,
      projectAssetId: "source:image",
      kind: "image",
      bytes: new TextEncoder().encode("source image"),
      contentType: "image/png",
      name: "source.png",
      metadata: {},
    });
    collision.arm();
    const app = createLocalApiApp({
      dataDir,
      clashRoot,
      userId: "local-user",
      projectAssetProjectionOrigin: "http://127.0.0.1:49152",
      projectAssetReplica: collision.replica,
      inspectAssetResource: inspectFixtureAsset,
    });
    const invocation = {
      actionId: "image-editor",
      projectId,
      source: { assetId: "source:image", kind: "image" },
      params: { rotation: 90 },
      surface: "asset-preview",
      mode: "implicit",
    };
    const editForm = new FormData();
    editForm.set(
      "file",
      new File(["edited image"], "edited.png", { type: "image/png" }),
    );
    editForm.set("projectId", projectId);
    editForm.set("sourceAssetId", "source:image");
    editForm.set("editKind", "image-editor");
    editForm.set("outputKind", "image");
    editForm.set("editParams", JSON.stringify(invocation.params));
    editForm.set("origin", "asset-preview");
    editForm.set("invocation", JSON.stringify(invocation));
    editForm.set("actionRunId", "edit:binding-collision-1");

    const response = await app.request("/api/v1/edits", {
      method: "POST",
      body: editForm,
    });

    expect(response.status, await response.clone().text()).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "ACTION_ASSET_BINDING_ID_COLLISION",
    });
    const collisionRunId = collision.actionRunId();
    expect(collisionRunId).toMatch(/^edit:/);
    expect(
      listProjectAssets(doc).filter(
        (entry) => entry.provenance?.actionRunId === collisionRunId,
      ),
    ).toEqual([]);
    expect(
      listActionAssetBindings(doc).filter(
        (binding) =>
          binding.owner.kind === "run" &&
          binding.owner.actionRunId === collisionRunId,
      ),
    ).toEqual([
      expect.objectContaining({
        id: `action-asset:${collisionRunId}:output`,
        slot: "already-claimed",
        projectAssetId: "source:image",
      }),
    ]);
    const digest = createHash("sha256")
      .update(new TextEncoder().encode("edited image"))
      .digest("hex");
    await expect(
      service.resolveStagedOwned(`sha256:${digest}`),
    ).resolves.toMatchObject({ resourceId: `sha256:${digest}` });
  });

  it("publishes no video-crop Project facts when its output binding identity collides", async () => {
    const clashRoot = await mkdtemp(
      join(tmpdir(), "clash-project-asset-crop-collision-"),
    );
    temporaryDirectories.push(clashRoot);
    const dataDir = join(clashRoot, "local-api");
    const projectId = "crop-collision-project";
    const doc = new LoroDoc();
    const collision = editBindingCollisionReplica({
      doc,
      actionId: "video-clipper",
      sourceAssetId: "source:video",
    });
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      replica: collision.replica,
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: inspectFixtureAsset,
      }),
    });
    await service.installOwned({
      projectId,
      projectAssetId: "source:video",
      kind: "video",
      bytes: new TextEncoder().encode("source video"),
      contentType: "video/mp4",
      name: "source.mp4",
      metadata: { durationMs: 2_000 },
    });
    collision.arm();
    const fakeFfmpeg = join(clashRoot, "fake-ffmpeg");
    await writeFile(
      fakeFfmpeg,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        'const input = args[args.indexOf("-i") + 1];',
        "const output = args[args.length - 1];",
        'fs.writeFileSync(output, Buffer.concat([fs.readFileSync(input), Buffer.from(" cropped")]));',
      ].join("\n"),
    );
    await chmod(fakeFfmpeg, 0o755);
    const priorFfmpegPath = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = fakeFfmpeg;
    const app = createLocalApiApp({
      dataDir,
      clashRoot,
      userId: "local-user",
      projectAssetProjectionOrigin: "http://127.0.0.1:49152",
      projectAssetReplica: collision.replica,
      inspectAssetResource: inspectFixtureAsset,
    });
    const params = { mode: "crop", startSec: 0, endSec: 1 };
    const invocation = {
      actionId: "video-clipper",
      projectId,
      source: { assetId: "source:video", kind: "video" },
      params,
      surface: "asset-preview",
      mode: "implicit",
    };
    let response: Response;
    try {
      response = await app.request("/api/v1/edits/video-crop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionRunId: "edit:crop-binding-collision-1",
          projectId,
          sourceAssetId: "source:video",
          params,
          origin: "asset-preview",
          invocation,
        }),
      });
    } finally {
      if (priorFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = priorFfmpegPath;
    }

    expect(response.status, await response.clone().text()).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "ACTION_ASSET_BINDING_ID_COLLISION",
    });
    const collisionRunId = collision.actionRunId();
    expect(collisionRunId).toMatch(/^edit:/);
    expect(
      listProjectAssets(doc).filter(
        (entry) => entry.provenance?.actionRunId === collisionRunId,
      ),
    ).toEqual([]);
    expect(
      listActionAssetBindings(doc).filter(
        (binding) =>
          binding.owner.kind === "run" &&
          binding.owner.actionRunId === collisionRunId,
      ),
    ).toEqual([
      expect.objectContaining({
        id: `action-asset:${collisionRunId}:output`,
        slot: "already-claimed",
        projectAssetId: "source:video",
      }),
    ]);
    const digest = createHash("sha256")
      .update(new TextEncoder().encode("source video cropped"))
      .digest("hex");
    await expect(
      service.resolveStagedOwned(`sha256:${digest}`),
    ).resolves.toMatchObject({ resourceId: `sha256:${digest}` });
  });

  it("enqueues Director generation through the shared durable Provider journal", async () => {
    const clashRoot = await mkdtemp(
      join(tmpdir(), "clash-director-project-asset-"),
    );
    temporaryDirectories.push(clashRoot);
    const dataDir = join(clashRoot, "local-api");
    let wakes = 0;
    const binding = {
      pluginId: "clash.fal",
      version: "0.1.0",
      exportId: "fal-execute",
      schemaHash: `sha256:${"a".repeat(64)}`,
    } as const;
    const app = createLocalApiApp({
      dataDir,
      userId: "local-user",
      resolvePluginBinding: async () => binding,
      processProjectWork: async () => {
        wakes += 1;
      },
      projectAssetProjectionOrigin: "http://127.0.0.1:49152",
    });
    const createdProject = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Generated Director models" }),
    });
    const { id: projectId } = (await createdProject.json()) as { id: string };
    await app.request("/api/v1/model-providers", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers: [
          {
            id: "fal-director",
            providerId: "fal",
            upstreamId: "fal",
            enabled: true,
            priority: 1,
            credentials: { apiKey: "fal-director-secret" },
          },
        ],
      }),
    });

    const response = await app.request("/api/v1/director-model-generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actionRunId: "director:request-1",
        projectId,
        prompt: "A chestnut horse",
        quality: "low-poly",
      }),
    });
    expect(response.status, await response.clone().text()).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "queued",
      actionRunId: "director:request-1",
      requestId: "director:request-1",
      statusUrl: expect.stringContaining("director%3Arequest-1"),
    });
    const journal = createSqliteDurableRunJournal(dataDir);
    const run = await journal.load({
      actionRunId: "director:request-1",
      outputSlot: "media",
    });
    expect(run).toMatchObject({
      phase: "queued",
      owner: { realm: "local", id: "local-api" },
      executorInput: {
        binding,
        accountId: "fal-director",
        kind: "model",
        projectId,
        delivery: {
          kind: "project-asset",
          actionId: "director:model-generation",
          name: "generated-model.glb",
          prompt: "A chestnut horse",
        },
      },
    });
    expect(JSON.stringify(run?.executorInput)).not.toMatch(
      /apiKey|fal-director-secret|credentials/,
    );

    const status = await app.request(
      `/api/v1/director-model-generations/director%3Arequest-1?projectId=${encodeURIComponent(projectId)}`,
    );
    expect(status.status).toBe(202);
    expect(wakes).toBeGreaterThanOrEqual(1);

    const conflict = await app.request("/api/v1/director-model-generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actionRunId: "director:request-1",
        projectId,
        prompt: "A different model",
      }),
    });
    expect(conflict.status).toBe(409);
  });

  it("rejects a multipart import without a stable Project Asset id before publishing an Asset", async () => {
    const { app } = await fixture();
    const url =
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file";
    const form = new FormData();
    form.set(
      "file",
      new File(["same immutable bytes"], "same.png", {
        type: "image/png",
      }),
    );
    form.set("kind", "image");

    const response = await app.request(url, { method: "POST", body: form });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Project Asset import requires file, kind, and projectAssetId",
      code: "INVALID_PROJECT_ASSET_IMPORT",
    });
    const listed = await app.request(url.replace("/import-file", ""));
    await expect(listed.json()).resolves.toEqual({
      assets: [expect.objectContaining({ id: "result:one" })],
    });
  });

  it("rejects empty, mismatched, and invalidly identified multipart imports", async () => {
    const { app } = await fixture();
    const url =
      "http://127.0.0.1:49152/api/v1/projects/project-a/assets/import-file";
    const requests: FormData[] = [];

    const empty = new FormData();
    empty.set("file", new File([], "empty.png", { type: "image/png" }));
    empty.set("kind", "image");
    requests.push(empty);

    const mismatched = new FormData();
    mismatched.set(
      "file",
      new File(["not a video"], "still.png", { type: "image/png" }),
    );
    mismatched.set("kind", "video");
    requests.push(mismatched);

    const invalidId = new FormData();
    invalidId.set(
      "file",
      new File(["image"], "still.png", { type: "image/png" }),
    );
    invalidId.set("kind", "image");
    invalidId.set("projectAssetId", " ");
    requests.push(invalidId);

    for (const form of requests) {
      const response = await app.request(url, { method: "POST", body: form });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "INVALID_PROJECT_ASSET_IMPORT",
      });
    }
  });

  it("lists Action references and rejects logical deletion while the Asset is in use", async () => {
    const { app, asset, dataDir } = await fixture();
    const replicas = new FileReplicaStore(join(dataDir, "projects"));
    await replicas.updateSnapshotAtomic("project-a", (doc) => {
      const result = createActionAssetBinding(doc, {
        id: "binding:timeline:primary",
        owner: {
          kind: "revision",
          actionId: "timeline:main",
          actionRevisionId: "timeline-revision:1",
        },
        direction: "input",
        slot: "track:video:0",
        projectAssetId: asset.id,
        role: "primary",
      });
      if (!result.ok) throw new Error(result.error.code);
      return { value: undefined };
    });

    const baseUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}`;
    const references = await app.request(`${baseUrl}/references`);
    expect(references.status).toBe(200);
    expect(references.headers.get("x-clash-read-receipt")).toMatch(
      PROJECT_ASSET_RECEIPT_RE,
    );
    const expectedReference = {
      id: "binding:timeline:primary",
      owner: {
        kind: "revision",
        actionId: "timeline:main",
        actionRevisionId: "timeline-revision:1",
      },
      direction: "input",
      slot: "track:video:0",
      projectAssetId: "result:one",
      role: "primary",
    };
    await expect(references.json()).resolves.toEqual({
      projectAssetId: "result:one",
      references: [expectedReference],
    });

    const removed = await app.request(
      baseUrl,
      projectTrashRequest("delete:referenced-asset"),
    );
    expect(removed.status, await removed.clone().text()).toBe(409);
    await expect(removed.json()).resolves.toEqual({
      error: "Project Asset result:one is still referenced.",
      code: "ASSET_IN_USE",
      projectAssetId: "result:one",
      references: [expectedReference],
    });
    expect(
      readProjectAsset(await replicas.recover("project-a"), asset.id)
        ?.lifecycle,
    ).toEqual({ state: "active" });
  });

  it("logically trashes and restores an unreferenced Asset without deleting its bytes", async () => {
    const { app, asset, dataDir, service } = await fixture();
    const baseUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}`;
    const resourcePath = (await service.openProjection("project-a", asset.id))
      .path;

    const removed = await app.request(
      baseUrl,
      projectTrashRequest("delete:logical-trash"),
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({
      id: "result:one",
      kind: "audio",
      name: "result.unusual",
      metadata: {
        durationMs: 2_000,
        bytes: 10,
        contentType: "audio/mpeg",
        originalName: "result.unusual",
      },
      provenance: { kind: "generation", actionRunId: "run-1" },
      lifecycle: {
        state: "trashed",
        deleteOperationId: expect.any(String),
        deletedAt: expect.any(String),
        purgeAfter: expect.any(String),
      },
      status: "unavailable",
    });
    expect(await readFile(resourcePath, "utf8")).toBe("0123456789");
    const trashed = readProjectAsset(
      await new FileReplicaStore(join(dataDir, "projects")).recover(
        "project-a",
      ),
      asset.id,
    );
    expect(trashed?.lifecycle).toMatchObject({
      state: "trashed",
      deleteOperationId: expect.any(String),
      deletedAt: expect.any(String),
      purgeAfter: expect.any(String),
    });

    const restored = await app.request(`${baseUrl}/restore`, {
      method: "POST",
    });
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      id: "result:one",
      lifecycle: { state: "active" },
      status: "ready",
      url: `${baseUrl}/media`,
    });
    expect(
      readProjectAsset(
        await new FileReplicaStore(join(dataDir, "projects")).recover(
          "project-a",
        ),
        asset.id,
      )?.lifecycle,
    ).toEqual({ state: "active" });
    expect(await readFile(resourcePath, "utf8")).toBe("0123456789");
  });

  it("requires a stable delete operation id from the Project Asset producer", async () => {
    const { app, asset } = await fixture();
    const baseUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}`;

    const response = await app.request(baseUrl, { method: "DELETE" });

    expect(response.status, await response.clone().text()).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "deleteOperationId is required",
      code: "INVALID_PROJECT_ASSET_TRASH",
    });
  });

  it("returns the committed delete for an at-least-once retry but CAS-rejects another operation", async () => {
    const { app, asset } = await fixture();
    const baseUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}`;
    const read = await app.request(baseUrl);
    const activeReceipt = read.headers.get("x-clash-read-receipt")!;
    const remove = (deleteOperationId: string) =>
      app.request(baseUrl, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-clash-client-type": "agent",
          "x-clash-if-match": activeReceipt,
        },
        body: JSON.stringify({ deleteOperationId }),
      });

    const first = await remove("delete:at-least-once");
    const retried = await remove("delete:at-least-once");

    expect(first.status, await first.clone().text()).toBe(200);
    expect(retried.status, await retried.clone().text()).toBe(200);
    const firstResult = await first.json();
    await expect(retried.json()).resolves.toEqual(firstResult);

    const competing = await remove("delete:competing-operation");
    expect(competing.status, await competing.clone().text()).toBe(409);
    await expect(competing.json()).resolves.toMatchObject({
      code: "STALE_READ",
    });
  });

  it("requires and rotates a Host receipt for agent delete and restore", async () => {
    const { app, asset } = await fixture();
    const baseUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(asset.id)}`;

    const missing = await app.request(
      baseUrl,
      projectTrashRequest("delete:missing-read", {
        "x-clash-client-type": "agent",
      }),
    );
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toMatchObject({
      code: "READ_REQUIRED",
    });

    const read = await app.request(baseUrl);
    const activeReceipt = read.headers.get("x-clash-read-receipt");
    expect(activeReceipt).toMatch(PROJECT_ASSET_RECEIPT_RE);
    expect(JSON.stringify(await read.json())).not.toContain("readToken");

    const removed = await app.request(
      baseUrl,
      projectTrashRequest("delete:agent-receipt", {
        "x-clash-client-type": "agent",
        "x-clash-if-match": activeReceipt!,
      }),
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    const trashedReceipt = removed.headers.get("x-clash-read-receipt");
    expect(trashedReceipt).toMatch(PROJECT_ASSET_RECEIPT_RE);
    expect(trashedReceipt).not.toBe(activeReceipt);
    expect(JSON.stringify(await removed.json())).not.toContain("readToken");

    const restored = await app.request(`${baseUrl}/restore`, {
      method: "POST",
      headers: {
        "x-clash-client-type": "agent",
        "x-clash-if-match": trashedReceipt!,
      },
    });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(restored.headers.get("x-clash-read-receipt")).toMatch(
      PROJECT_ASSET_RECEIPT_RE,
    );
    expect(JSON.stringify(await restored.json())).not.toContain("readToken");
  });

  it("rejects tampered and stale Project Asset receipts inside the mutation", async () => {
    const tamperedFixture = await fixture();
    const tamperedUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(tamperedFixture.asset.id)}`;
    const initialRead = await tamperedFixture.app.request(tamperedUrl);
    const receipt = initialRead.headers.get("x-clash-read-receipt")!;
    const tampered = `${receipt.slice(0, -1)}${receipt.endsWith("A") ? "B" : "A"}`;
    const rejectedTampered = await tamperedFixture.app.request(
      tamperedUrl,
      projectTrashRequest("delete:tampered-receipt", {
        "x-clash-client-type": "agent",
        "x-clash-if-match": tampered,
      }),
    );
    expect(rejectedTampered.status).toBe(409);
    await expect(rejectedTampered.json()).resolves.toMatchObject({
      code: "INVALID_READ_PROOF",
    });

    const staleFixture = await fixture();
    const staleUrl = `http://127.0.0.1:49152/api/v1/projects/project-a/assets/${encodeURIComponent(staleFixture.asset.id)}`;
    const staleRead = await staleFixture.app.request(staleUrl);
    const staleReceipt = staleRead.headers.get("x-clash-read-receipt")!;
    const replicas = new FileReplicaStore(
      join(staleFixture.dataDir, "projects"),
    );
    await replicas.updateSnapshotAtomic("project-a", (doc) => {
      const result = createActionAssetBinding(doc, {
        id: "binding:concurrent-input",
        owner: { kind: "draft", actionId: "action:concurrent" },
        direction: "input",
        slot: "image:0",
        projectAssetId: staleFixture.asset.id,
        role: "reference",
      });
      if (!result.ok) throw new Error(result.error.code);
      return { value: undefined };
    });

    const rejectedStale = await staleFixture.app.request(
      staleUrl,
      projectTrashRequest("delete:stale-receipt", {
        "x-clash-client-type": "agent",
        "x-clash-if-match": staleReceipt,
      }),
    );
    expect(rejectedStale.status).toBe(409);
    await expect(rejectedStale.json()).resolves.toMatchObject({
      code: "STALE_READ",
    });
    expect(
      readProjectAsset(
        await replicas.recover("project-a"),
        staleFixture.asset.id,
      )?.lifecycle.state,
    ).toBe("active");
  });

  it("does not resolve a Project Asset through another Project", async () => {
    const { app, asset } = await fixture();
    const otherProjectUrl = `http://127.0.0.1:49152/api/v1/projects/project-b/assets/${encodeURIComponent(asset.id)}`;

    const read = await app.request(otherProjectUrl);
    expect(read.status).toBe(404);
    await expect(read.json()).resolves.toEqual({
      error: "Project Asset not found",
      code: "PROJECT_ASSET_NOT_FOUND",
    });

    const media = await app.request(`${otherProjectUrl}/media`);
    expect(media.status).toBe(404);
    await expect(media.json()).resolves.toEqual({
      error: "Project Asset not found",
      code: "PROJECT_ASSET_NOT_FOUND",
    });
  });

  it("materializes and serves a same-id Project replica re-imported after purge", async () => {
    const clashRoot = await mkdtemp(
      join(tmpdir(), "clash-project-asset-reimport-"),
    );
    temporaryDirectories.push(clashRoot);
    const dataDir = join(clashRoot, "local-api");
    const projectId = "reimported-project";
    const metadata = createLocalMetadataStore(dataDir);
    const oldBytes = new TextEncoder().encode("old replica image");
    const oldDigest = createHash("sha256").update(oldBytes).digest("hex");
    await replaceLegacyProjectAssets({
      store: metadata,
      projectId,
      dataDir,
      digest: oldDigest,
      bytes: oldBytes,
      asset: legacyProjectAsset({
        id: "asset:old-replica",
        storageKey: "generated/old-replica.png",
        digest: oldDigest,
        bytes: oldBytes.byteLength,
      }),
    });

    const app = createLocalApiApp({
      dataDir,
      clashRoot,
      userId: "local-user",
      projectAssetProjectionOrigin: "http://127.0.0.1:49152",
      inspectAssetResource: inspectFixtureAsset,
    });
    const initialize = () =>
      app.request(`/api/v1/projects/${projectId}/initialize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Re-imported Project" }),
      });
    expect((await initialize()).status).toBe(201);

    const oldMediaUrl = `http://127.0.0.1:49152/api/v1/projects/${projectId}/assets/${encodeURIComponent("asset:old-replica")}/media`;
    const oldMedia = await app.request(oldMediaUrl);
    expect(oldMedia.status).toBe(200);
    expect(await oldMedia.text()).toBe("old replica image");

    expect(
      (
        await app.request(`/api/v1/projects/${projectId}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    ageDeletedProjectForPurge(dataDir, projectId);
    const purged = await app.request(`/api/v1/projects/${projectId}/purge`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "purge" }),
    });
    expect(purged.status).toBe(200);
    expect(await purged.json()).toMatchObject({
      purged: true,
      replicaDeleted: true,
    });

    const newBytes = new TextEncoder().encode("new replica image");
    const newDigest = createHash("sha256").update(newBytes).digest("hex");
    await replaceLegacyProjectAssets({
      store: metadata,
      projectId,
      dataDir,
      digest: newDigest,
      bytes: newBytes,
      asset: legacyProjectAsset({
        id: "asset:new-replica",
        storageKey: "generated/new-replica.png",
        digest: newDigest,
        bytes: newBytes.byteLength,
      }),
    });
    const importedDoc = new LoroDoc();
    importedDoc.getMap("workspace-import").set("revision", "second");
    const replicas = new FileReplicaStore(join(dataDir, "projects"));
    await expect(
      replicas.installSnapshotIfAbsent(
        projectId,
        importedDoc.export({ mode: "snapshot" }),
      ),
    ).resolves.toEqual({ installed: true });
    expect((await initialize()).status).toBe(201);

    const newMediaUrl = `http://127.0.0.1:49152/api/v1/projects/${projectId}/assets/${encodeURIComponent("asset:new-replica")}/media`;
    const newMedia = await app.request(newMediaUrl);
    expect(newMedia.status).toBe(200);
    expect(await newMedia.text()).toBe("new replica image");

    const materialized = await replicas.recover(projectId);
    expect(projectAssetAuthorityVersion(materialized)).toBe(1);
    expect(listProjectAssets(materialized)).toEqual([
      expect.objectContaining({
        id: "asset:new-replica",
        source: { kind: "owned", resourceId: `sha256:${newDigest}` },
      }),
    ]);
  });
});
