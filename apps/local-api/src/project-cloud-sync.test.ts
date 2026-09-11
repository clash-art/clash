import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    token: async () => undefined,
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
  async function addResource(id: string) {
    const bytes = new TextEncoder().encode(`bytes:${id}`);
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
  };
}

describe("production Project cloud coordinator adapter", () => {
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

it("a new Host retrieves cloud bytes after the source Host has stopped", async () => {
  const source = await fixture();
  const media = await source.addResource("offline-source");
  await source.service.schedule("project");
  expect((await source.admission())?.status).toBe("ready");
  await source.service.close();
  await source.rooms.close();
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
  await receiver.schedule("project");
  expect((await metadata.getProjectCloudAdmission("project", id))?.status).toBe(
    "ready",
  );
  const local = await resources.resolve(media.source.resource.id);
  expect(new Uint8Array(await readFile(local!.path))).toEqual(media.bytes);
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
