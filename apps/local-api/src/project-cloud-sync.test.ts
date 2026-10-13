import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { LoroDoc } from "loro-crdt";
import {
  createProjectAsset,
  createProjectDocumentAsset,
  markDocumentAssetAuthority,
  type ProjectMetadata,
  type Resource,
} from "@clash/shared-types";
import { storeMetadataBody } from "@clash/shared-runtime";
import type { AssetDeliveryStore } from "@clash/asset-sdk/delivery";
import { PROJECT_CLOUD_CONTENT_PART_BYTES } from "@clash/asset-sdk/delivery";
import { createLocalProjectCloudSync } from "./project-cloud-sync";
import { createLocalMetadataStore } from "./local-metadata-store";
import { createLocalResourceStore } from "./local-resource-store";
import { getLocalReplicaId } from "./local-replica-identity";
import { LocalLoroRoomHub } from "./sync";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(autoSchedule = true) {
  // Cross-runtime integration: load the Worker adapters at runtime so their
  // ambient Cloudflare types do not contaminate the Node compiler's globals.
  const { createProjectContentRoutes } = await import(
    new URL("../../api-cf/src/routes/v1/project-content.ts", import.meta.url)
      .href
  );
  const { createAssetCapabilityRoutes } = await import(
    new URL("../../api-cf/src/routes/asset-capability.ts", import.meta.url).href
  );
  const { createProjectContentResolver } = await import(
    new URL("../../api-cf/src/services/project-content.ts", import.meta.url)
      .href
  );
  const dataDir = await mkdtemp(join(tmpdir(), "project-cloud-sync-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const metadataStore = createLocalMetadataStore(dataDir),
    replicaId = await getLocalReplicaId(dataDir);
  const resourceStore = createLocalResourceStore({ dataDir });
  const remoteDoc = new LoroDoc();
  cleanup.push(async () => remoteDoc.free());
  let cloudMetadata: ProjectMetadata | null = null;
  const metadata: ProjectMetadata = {
    projectId: "project",
    name: "Project",
    description: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
  };
  await metadataStore.upsertProjectCloudAdmission({
    schemaVersion: 1,
    projectId: "project",
    localReplicaId: replicaId,
    userId: "owner",
    tenantId: "tenant",
    syncBaseUrl: "https://cloud.test",
    status: "pending",
    capabilities: { canvas: true, projectMetadata: true, resources: true },
    admittedAt: null,
    updatedAt: metadata.updatedAt,
    lastError: null,
  });
  const admittedReplicas = new Set([replicaId]);
  const objects = new Map<string, Uint8Array>(),
    registry = new Map<string, Resource>();
  let putCount = 0;
  let rejectUpload = false,
    beforePut: (() => Promise<void>) | undefined;
  const ports = {
    async authorize(input: { projectId: string; localReplicaId: string }) {
      const admission = await metadataStore.getProjectCloudAdmission(
        "project",
        replicaId,
      );
      return input.projectId === "project" &&
        admittedReplicas.has(input.localReplicaId) &&
        admission?.status !== "local-only"
        ? { tenantId: "tenant" }
        : null;
    },
    async snapshot() {
      return remoteDoc.export({ mode: "snapshot" });
    },
    async resource(tenant: string, id: string, claim?: Resource) {
      if (claim) registry.set(`${tenant}/${id}`, claim);
      return registry.get(`${tenant}/${id}`) ?? null;
    },
  };
  const byteStore: AssetDeliveryStore = {
    head(key) {
      const value = objects.get(key);
      return value && { size: value.length };
    },
    get(key) {
      const value = objects.get(key);
      return (
        value && {
          size: value.length,
          body: new Response(new Uint8Array(value)).body!,
        }
      );
    },
    async put(key, bytes) {
      putCount++;
      if (rejectUpload) throw new Error("interrupted upload");
      await beforePut?.();
      objects.set(key, bytes.slice());
    },
  };
  const cloud = new Hono();
  cloud.use("*", async (c, next) => {
    c.req.raw.headers.set("x-user-id", "owner");
    await next();
  });
  cloud.route(
    "/api/v1/projects",
    createProjectContentRoutes({ ports: () => ports, store: byteStore }),
  );
  cloud.route(
    "/assets/capability",
    createAssetCapabilityRoutes({
      resolve: createProjectContentResolver(() => ports),
      store: byteStore,
    }),
  );
  const fetcher: typeof fetch = async (input, init) =>
    cloud.request(
      new Request(input, init),
      {},
      { JWT_SECRET: "test-secret", ENVIRONMENT: "production" },
    );
  let service: ReturnType<typeof createLocalProjectCloudSync>;
  const rooms = new LocalLoroRoomHub(
    dataDir,
    undefined,
    null,
    undefined,
    (projectId) =>
      autoSchedule ? service?.invalidate(projectId) : Promise.resolve(),
  );
  cleanup.push(() => rooms.close());
  const remote = {
    async loadSnapshot() {
      // The hosted snapshot route refuses a soft-deleted Project.
      if (cloudMetadata?.deletedAt)
        throw new Error("Remote Loro snapshot load failed with HTTP 401");
      return remoteDoc.export({ mode: "snapshot" });
    },
    async appendUpdate(_id: string, bytes: Uint8Array) {
      remoteDoc.import(bytes);
    },
    async loadProjectMetadata() {
      return cloudMetadata;
    },
    async saveProjectMetadata(_id: string, value: ProjectMetadata) {
      cloudMetadata = value;
    },
  };
  const options = {
    dataDir,
    rooms,
    remote: async () => remote,
    metadata: {
      list: async () => ["project"],
      read: async () => metadata,
      write: async (value: ProjectMetadata) => {
        Object.assign(metadata, value);
      },
    },
    token: async () => "test-cloud-token",
    inspection: {
      finalize: async (input: {
        resourceId: string;
        kind: "image" | "video" | "audio" | "model";
        contentType?: string;
      }) => ({ source: await resourceStore.seal(input), facts: {} as any }),
    },
    fetch: fetcher,
  };
  service = createLocalProjectCloudSync(options);
  cleanup.push(() => service.close());
  async function addResource(
    id: string,
    bytes = new TextEncoder().encode(`bytes:${id}`),
  ) {
    const source = await resourceStore.install({
      kind: "image",
      bytes,
      contentType: "image/png",
    });
    await rooms.mutateProject("project", (doc) => ({
      value: createProjectAsset(doc, {
        id,
        kind: "image",
        source: { kind: "owned", resourceId: source.resource.id },
        lifecycle: { state: "active" },
        metadata: {},
      }),
    }));
    return { source, bytes };
  }
  return {
    dataDir,
    replicaId,
    metadataStore,
    remoteDoc,
    objects,
    rooms,
    options,
    service,
    addResource,
    rejectUploads: (value: boolean) => {
      rejectUpload = value;
    },
    beforePut: (callback: () => Promise<void>) => {
      beforePut = callback;
    },
    allowReplica: (id: string) => {
      admittedReplicas.add(id);
    },
    putCount: () => putCount,
    admission: () =>
      metadataStore.getProjectCloudAdmission("project", replicaId),
    localMetadata: () => metadata,
    cloudMetadata: () => cloudMetadata,
    setCloudMetadata: (value: ProjectMetadata) => {
      cloudMetadata = value;
    },
  };
}

describe("production Project cloud coordinator adapter", () => {
  it("uploads a large local Resource through bounded multipart requests before readiness", async () => {
    const f = await fixture(false);
    const { source, bytes } = await f.addResource(
      "large",
      new Uint8Array(PROJECT_CLOUD_CONTENT_PART_BYTES + 7),
    );
    const { resourceLocator } = await import(
      new URL("../../api-cf/src/services/project-content.ts", import.meta.url)
        .href
    );
    const key = await resourceLocator("tenant", source.resource);
    const originalFetch = f.options.fetch;
    const parts: Uint8Array[] = [];
    let complete = false;
    const service = createLocalProjectCloudSync({
      ...f.options,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const action = url.searchParams.get("upload");
        if (!action) return originalFetch(input, init);
        if (action === "begin")
          return Response.json({
            uploadId: url.searchParams.get("uploadId"),
            partSize: PROJECT_CLOUD_CONTENT_PART_BYTES,
          });
        if (action === "part") {
          expect((await f.admission())?.status).toBe("syncing");
          const part = init?.body as Uint8Array;
          expect(part.byteLength).toBeLessThanOrEqual(
            PROJECT_CLOUD_CONTENT_PART_BYTES,
          );
          parts.push(part);
        } else if (action === "complete") {
          f.objects.set(key, new Uint8Array(Buffer.concat(parts)));
          complete = true;
        } else throw new Error(`Unexpected upload action ${action}`);
        return new Response(null, { status: 204 });
      },
    });
    cleanup.push(() => service.close());
    await service.schedule("project");
    expect(complete).toBe(true);
    expect((await f.admission())?.status).toBe("ready");
    expect(createHash("sha256").update(f.objects.get(key)!).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });
  it("resumes an interrupted multipart upload after Host restart without resending accepted parts", async () => {
    const f = await fixture(false);
    const { source, bytes } = await f.addResource(
      "resumed",
      new Uint8Array(2 * PROJECT_CLOUD_CONTENT_PART_BYTES + 7).map(
        (_, index) => index % 251,
      ),
    );
    const { resourceLocator } = await import(
      new URL("../../api-cf/src/services/project-content.ts", import.meta.url)
        .href
    );
    const key = await resourceLocator("tenant", source.resource);
    const originalFetch = f.options.fetch;
    // Cloud staging outlives the Host process: parts stay held per upload ID.
    const sessions = new Map<string, Map<number, Uint8Array>>();
    const sent: { uploadId: string; partNumber: number }[] = [];
    let killAtPart = 2;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const action = url.searchParams.get("upload");
      if (!action) return originalFetch(input, init);
      const uploadId = url.searchParams.get("uploadId")!;
      if (action === "begin") {
        if (!sessions.has(uploadId)) sessions.set(uploadId, new Map());
        return Response.json({
          uploadId,
          partSize: PROJECT_CLOUD_CONTENT_PART_BYTES,
          parts: [...sessions.get(uploadId)!].map(([partNumber, part]) => ({
            partNumber,
            sha256: createHash("sha256").update(part).digest("hex"),
          })),
        });
      }
      const session = sessions.get(uploadId);
      if (!session) return new Response(null, { status: 410 });
      if (action === "part") {
        const partNumber = Number(url.searchParams.get("partNumber"));
        if (partNumber === killAtPart) throw new TypeError("fetch failed");
        session.set(partNumber, init?.body as Uint8Array);
        sent.push({ uploadId, partNumber });
      } else if (action === "complete") {
        f.objects.set(
          key,
          new Uint8Array(
            Buffer.concat(
              [...session].sort(([a], [b]) => a - b).map(([, part]) => part),
            ),
          ),
        );
      } else if (action === "abort") sessions.delete(uploadId);
      return new Response(null, { status: 204 });
    };
    const killed = createLocalProjectCloudSync({
      ...f.options,
      fetch: fetcher,
    });
    await killed.schedule("project");
    await killed.close();
    expect((await f.admission())?.status).toBe("failed");
    expect(sent.map((part) => part.partNumber)).toEqual([1]);
    const uploadId = sent[0]!.uploadId;

    killAtPart = 0;
    sent.length = 0;
    const restarted = createLocalProjectCloudSync({
      ...f.options,
      fetch: fetcher,
    });
    cleanup.push(() => restarted.close());
    await restarted.schedule("project");
    expect((await f.admission())?.status).toBe("ready");
    expect(sent).toEqual([
      { uploadId, partNumber: 2 },
      { uploadId, partNumber: 3 },
    ]);
    expect(createHash("sha256").update(f.objects.get(key)!).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });
  it("reaches ready only after acknowledged Loro, metadata, media and Document bytes, and retries after restart", async () => {
    const f = await fixture();
    f.rejectUploads(true);
    const { bytes } = await f.addResource("first");
    const stored = await storeMetadataBody({
      dataDir: f.dataDir,
      body: { text: "document" },
    });
    const bodyBytes = await readFile(stored.path);
    await f.rooms.mutateProject("project", (doc) => {
      markDocumentAssetAuthority(doc);
      createProjectDocumentAsset(doc, {
        id: "revision",
        documentAssetId: "document",
        documentKind: "media.transcript",
        schemaVersion: 1,
        mutability: "versioned",
        body: {
          digest: stored.contentHash,
          byteLength: bodyBytes.length,
          contentType: "application/json",
        },
        producer: { kind: "actor", actor: { kind: "user", id: "owner" } },
        sourceRefs: [],
      });
      return { value: undefined };
    });
    await f.service.schedule("project");
    expect((await f.admission())?.status).toBe("failed");
    expect([...f.objects.values()]).not.toContainEqual(bytes);
    await f.service.close();
    f.rejectUploads(false);
    const restarted = createLocalProjectCloudSync(f.options);
    cleanup.push(() => restarted.close());
    await restarted.start();
    await restarted.schedule("project");
    expect((await f.admission())?.status).toBe("ready");
    expect([...f.objects.values()]).toContainEqual(bytes);
    expect([...f.objects.values()]).toContainEqual(new Uint8Array(bodyBytes));
    const uploadedBefore = f.putCount();
    await restarted.schedule("project");
    expect(f.putCount()).toBe(uploadedBefore);
    const newResource = await f.addResource("second");
    await restarted.invalidate("project");
    await restarted.schedule("project");
    expect((await f.admission())?.status).toBe("ready");
    expect([...f.objects.values()]).toContainEqual(newResource.bytes);
    expect(f.putCount() - uploadedBefore).toBe(1);
  });
  it("cannot publish ready over admission revoked during content persistence", async () => {
    const f = await fixture();
    await f.addResource("media");
    f.beforePut(async () => {
      const admission = await f.admission();
      await f.metadataStore.upsertProjectCloudAdmission({
        ...admission!,
        status: "local-only",
      });
    });
    await f.service.schedule("project");
    expect((await f.admission())?.status).toBe("local-only");
  });
});

it("waits for the remote Loro acknowledgement before bytes or ready", async () => {
  const f = await fixture(false);
  await f.addResource("waiting");
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const remote = await f.options.remote();
  const original = remote.appendUpdate;
  remote.appendUpdate = async (...args) => {
    entered();
    await blocked;
    await original(...args);
  };
  const running = f.service.schedule("project");
  await started;
  expect((await f.admission())?.status).toBe("syncing");
  expect(f.objects.size).toBe(0);
  release();
  await running;
  expect((await f.admission())?.status).toBe("ready");
});

it("shutdown interrupts a hanging content request without waiting for the network budget", async () => {
  const f = await fixture(false);
  await f.addResource("hanging");
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = createLocalProjectCloudSync({
    ...f.options,
    fetch: async (_input, init) => {
      entered();
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(init!.signal!.reason),
          { once: true },
        );
      });
    },
  });
  const running = pending.schedule("project");
  await started;
  await Promise.race([
    pending.close(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("shutdown hung")), 1_000),
    ),
  ]);
  await running;
  expect((await f.admission())?.status).not.toBe("ready");
});

async function receiverFor(source: Awaited<ReturnType<typeof fixture>>) {
  const dataDir = await mkdtemp(join(tmpdir(), "cloud-receiver-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const id = await getLocalReplicaId(dataDir),
    metadata = createLocalMetadataStore(dataDir),
    resources = createLocalResourceStore({ dataDir });
  await metadata.upsertProjectCloudAdmission({
    ...(await source.admission())!,
    localReplicaId: id,
    status: "pending",
  });
  source.allowReplica(id);
  let receiver: ReturnType<typeof createLocalProjectCloudSync>;
  const rooms = new LocalLoroRoomHub(
    dataDir,
    undefined,
    null,
    undefined,
    (projectId) => receiver.invalidate(projectId),
  );
  cleanup.push(() => rooms.close());
  receiver = createLocalProjectCloudSync({
    ...source.options,
    dataDir,
    rooms,
    inspection: {
      finalize: async (input) => ({
        source: await resources.seal(input),
        facts: {} as any,
      }),
    },
  });
  cleanup.push(() => receiver.close());
  return {
    dataDir,
    resources,
    receiver,
    admission: () => metadata.getProjectCloudAdmission("project", id),
  };
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

it("a new Host retrieves cloud bytes after the source Host has stopped", async () => {
  const source = await fixture();
  const media = await source.addResource("offline-source");
  await source.service.schedule("project");
  expect((await source.admission())?.status).toBe("ready");
  await source.service.close();
  await source.rooms.close();
  const { resources, receiver, admission } = await receiverFor(source);
  await receiver.schedule("project");
  expect((await admission())?.status).toBe("ready");
  const local = await resources.resolve(media.source.resource.id);
  expect(new Uint8Array(await readFile(local!.path))).toEqual(media.bytes);
  // #95: the downloaded bytes are kept once, not as staging + sealed copies.
  expect(await filesUnder(dirname(local!.path))).toEqual([local!.path]);
  expect(
    await resources.resolveStaged(
      `sha256:${media.source.resource.digest.value}`,
    ),
  ).toBeUndefined();
});

it("a download that fails verification leaves no bytes behind and a retry stores one copy", async () => {
  const source = await fixture();
  const media = await source.addResource("corrupt-in-cloud");
  await source.service.schedule("project");
  expect((await source.admission())?.status).toBe("ready");
  await source.service.close();
  await source.rooms.close();
  const intact = new Map(source.objects);
  for (const [key, bytes] of intact) {
    const corrupt = bytes.slice();
    corrupt[0] ^= 0xff;
    source.objects.set(key, corrupt);
  }
  const { resources, receiver, admission } = await receiverFor(source);
  await receiver.schedule("project");
  expect((await admission())?.status).toBe("failed");
  expect(
    await resources.resolve(media.source.resource.id).catch(() => undefined),
  ).toBeUndefined();

  for (const [key, bytes] of intact) source.objects.set(key, bytes);
  await receiver.schedule("project");
  expect((await admission())?.status).toBe("ready");
  const local = await resources.resolve(media.source.resource.id);
  expect(new Uint8Array(await readFile(local!.path))).toEqual(media.bytes);
  // Only the sealed copy exists anywhere in the blob store: the failed
  // attempt left no partial file and the retry left no staging file.
  expect(await filesUnder(dirname(dirname(local!.path)))).toEqual([
    local!.path,
  ]);
});

it("a Resource committed during upload invalidates completion until its own bytes arrive", async () => {
  const f = await fixture();
  f.rejectUploads(true);
  await f.addResource("first-inflight");
  await f.service.schedule("project");
  f.rejectUploads(false);
  let release!: () => void,
    entered!: () => void,
    puts = 0;
  const secondStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let later: Awaited<ReturnType<typeof f.addResource>>;
  f.beforePut(async () => {
    if (++puts === 1) later = await f.addResource("added-during-upload");
    else {
      entered();
      await blocked;
    }
  });
  const running = f.service.schedule("project");
  await secondStarted;
  expect((await f.admission())?.status).not.toBe("ready");
  expect([...f.objects.values()]).not.toContainEqual(later!.bytes);
  release();
  await running;
  expect((await f.admission())?.status).toBe("ready");
  expect([...f.objects.values()]).toContainEqual(later!.bytes);
});

it("the cloud byte cap fails readiness without restricting local Resource publication or reads", async () => {
  const f = await fixture(false);
  const media = await f.addResource("local-bigger-than-cloud-cap");
  const maxBytes = media.bytes.length - 1;
  const limited = createLocalProjectCloudSync({ ...f.options, maxBytes });
  cleanup.push(() => limited.close());
  await limited.schedule("project");
  expect(await f.admission()).toMatchObject({
    status: "failed",
    lastError: expect.stringContaining(`maxBytes=${maxBytes}`),
  });
  expect(f.objects.size).toBe(0);
  const local = await createLocalResourceStore({ dataDir: f.dataDir }).resolve(
    media.source.resource.id,
  );
  expect(new Uint8Array(await readFile(local!.path))).toEqual(media.bytes);
});

it("rejects an oversized declared Document before trying to open a missing local body", async () => {
  const f = await fixture(false),
    maxBytes = 8;
  await f.rooms.mutateProject("project", (doc) => {
    markDocumentAssetAuthority(doc);
    const result = createProjectDocumentAsset(doc, {
      id: "revision",
      documentAssetId: "document",
      documentKind: "media.transcript",
      schemaVersion: 1,
      mutability: "versioned",
      body: {
        digest: `sha256:${"a".repeat(64)}`,
        byteLength: maxBytes + 1,
        contentType: "application/json",
      },
      producer: { kind: "actor", actor: { kind: "user", id: "owner" } },
      sourceRefs: [],
    });
    expect(result.ok).toBe(true);
    return { value: undefined };
  });
  const limited = createLocalProjectCloudSync({ ...f.options, maxBytes });
  cleanup.push(() => limited.close());
  await limited.schedule("project");
  expect(await f.admission()).toMatchObject({
    status: "failed",
    lastError: expect.stringContaining(`maxBytes=${maxBytes}`),
  });
  expect(f.objects.size).toBe(0);
});

it("reports the remote transfer cap when the cloud deployment uses a smaller limit", async () => {
  const f = await fixture(false);
  await f.addResource("remote-limited");
  const remoteMaxBytes = 8;
  const service = createLocalProjectCloudSync({
    ...f.options,
    fetch: async () =>
      new Response(
        JSON.stringify({
          code: "CLOUD_CONTENT_TOO_LARGE",
          maxBytes: remoteMaxBytes,
        }),
        { status: 413 },
      ),
  });
  cleanup.push(() => service.close());
  await service.schedule("project");
  expect(await f.admission()).toMatchObject({
    status: "failed",
    lastError: expect.stringContaining(`maxBytes=${remoteMaxBytes}`),
  });
});

// Issue #83: delete and restore must round-trip through the metadata mirror.
describe("Project tombstone replication", () => {
  it("pulls a delete made on another Host instead of failing on the snapshot", async () => {
    const f = await fixture(false);
    const tombstone = {
      ...f.localMetadata(),
      updatedAt: "2026-09-02T00:00:00.000Z",
      deletedAt: "2026-09-02T00:00:00.000Z",
    };
    f.setCloudMetadata(tombstone);
    await f.service.schedule("project");
    expect(f.localMetadata()).toEqual(tombstone);
    expect((await f.admission())?.lastError).not.toMatch(/HTTP 401/);
  });

  it("pushes a local restore over the cloud tombstone and resumes sync", async () => {
    const f = await fixture(false);
    f.setCloudMetadata({
      ...f.localMetadata(),
      updatedAt: "2026-09-02T00:00:00.000Z",
      deletedAt: "2026-09-02T00:00:00.000Z",
    });
    const restored = {
      ...f.localMetadata(),
      updatedAt: "2026-09-03T00:00:00.000Z",
    };
    Object.assign(f.localMetadata(), restored);
    await f.service.schedule("project");
    expect(f.cloudMetadata()).toEqual(restored);
    expect((await f.admission())?.status).toBe("ready");
  });

  it("pulls a restore made on another Host into a locally deleted Project", async () => {
    const f = await fixture(false);
    Object.assign(f.localMetadata(), {
      updatedAt: "2026-09-02T00:00:00.000Z",
      deletedAt: "2026-09-02T00:00:00.000Z",
    });
    const restored = {
      ...f.localMetadata(),
      updatedAt: "2026-09-03T00:00:00.000Z",
      deletedAt: null,
    };
    f.setCloudMetadata(restored);
    await f.service.schedule("project");
    expect(f.localMetadata()).toEqual(restored);
    expect((await f.admission())?.status).toBe("ready");
  });
});
