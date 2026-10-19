import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  mkdtemp,
  rm,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { LoroDoc } from "loro-crdt";
import {
  createProjectAsset,
  createProjectDocumentAsset,
  markDocumentAssetAuthority,
  type ProjectCloudAdmission,
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
// Captured before any fake-timer test: file/SQLite work still settles on the
// real event loop while the schedule under test is driven by fake timers.
const realSetTimeout = globalThis.setTimeout;
async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const attempts = Math.ceil(timeoutMs / 5);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error("Timed out waiting for condition");
}
async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
) {
  const attempts = Math.ceil(timeoutMs / 10);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
  }
  if (!(await predicate())) throw new Error("Timed out waiting for condition");
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  autoSchedule = true,
  overrides: {
    mutationDebounceMs?: number;
    mutationMaxWaitMs?: number;
    retryBackoffBaseMs?: number;
    retryBackoffMaxMs?: number;
  } = {},
) {
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
  let remoteDoc = new LoroDoc();
  const initialRemoteDoc = remoteDoc;
  cleanup.push(async () => initialRemoteDoc.free());
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
  let rejectAppend = false,
    rejectMetadata = false,
    appendCalls = 0,
    appendBytes = 0,
    appendTimes: number[] = [],
    appendSizes: number[] = [];
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
      if (rejectAppend) throw new Error("cloud link unavailable");
      appendCalls += 1;
      appendBytes += bytes.byteLength;
      appendTimes.push(Date.now());
      appendSizes.push(bytes.byteLength);
      remoteDoc.import(bytes);
    },
    async loadProjectMetadata() {
      return cloudMetadata;
    },
    async saveProjectMetadata(_id: string, value: ProjectMetadata) {
      if (rejectMetadata) throw new Error("metadata mirror unavailable");
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
    // The existing suite asserts on the end state of an explicit trigger, so
    // it disables the mutation quiet period; the #292 burst test sets its own.
    mutationDebounceMs: 0,
    ...overrides,
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
    rejectAppends: (value: boolean) => {
      rejectAppend = value;
    },
    rejectMetadata: (value: boolean) => {
      rejectMetadata = value;
    },
    appendStats: () => ({
      calls: appendCalls,
      bytes: appendBytes,
      times: [...appendTimes],
      sizes: [...appendSizes],
    }),
    /** Simulates a ProjectRoom reset/restored server-side to an empty doc. */
    resetRemoteDoc: () => {
      const fresh = new LoroDoc();
      cleanup.push(async () => fresh.free());
      remoteDoc = fresh;
    },
    currentRemoteDoc: () => remoteDoc,
    resetAppendStats: () => {
      appendCalls = 0;
      appendBytes = 0;
      appendTimes = [];
      appendSizes = [];
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
  it("refuses to upload a same-length altered large blob through multipart: LOCAL_RESOURCE_DIGEST_MISMATCH, nothing sent", async () => {
    const f = await fixture(false);
    const { source } = await f.addResource(
      "altered-large",
      new Uint8Array(PROJECT_CLOUD_CONTENT_PART_BYTES + 7),
    );
    // Local reads trust the digest computed at import, so this goes unnoticed
    // until the upload verifies the bytes it is about to send.
    await chmod(source.path, 0o644);
    await writeFile(
      source.path,
      new Uint8Array(PROJECT_CLOUD_CONTENT_PART_BYTES + 7).fill(1),
    );
    const originalFetch = f.options.fetch;
    const uploadActions: string[] = [];
    const service = createLocalProjectCloudSync({
      ...f.options,
      fetch: async (input, init) => {
        const action = new URL(String(input)).searchParams.get("upload");
        if (!action) return originalFetch(input, init);
        uploadActions.push(action);
        return new Response(null, { status: 500 });
      },
    });
    cleanup.push(() => service.close());
    await service.schedule("project");

    const admission = await f.admission();
    expect(admission?.status).toBe("failed");
    expect(admission?.lastError).toContain("LOCAL_RESOURCE_DIGEST_MISMATCH");
    expect(uploadActions).toEqual([]);
    expect(f.objects.size).toBe(0);
  });
  it("refuses to push a same-length altered small blob: LOCAL_RESOURCE_DIGEST_MISMATCH, nothing uploaded", async () => {
    const f = await fixture(false);
    const { source, bytes } = await f.addResource("altered-small");
    await chmod(source.path, 0o644);
    await writeFile(source.path, new Uint8Array(bytes.byteLength).fill(1));

    await f.service.schedule("project");

    const admission = await f.admission();
    expect(admission?.status).toBe("failed");
    expect(admission?.lastError).toContain("LOCAL_RESOURCE_DIGEST_MISMATCH");
    expect(f.putCount()).toBe(0);
    expect(f.objects.size).toBe(0);
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
  // The commit during upload is coalesced into a follow-up run; wait for it to
  // reach readiness instead of assuming the first run drains it.
  await waitForAsync(async () => (await f.admission())?.status === "ready");
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

async function schedulerFixture(
  projectIds: string[],
  maxConcurrent = 2,
  options: {
    status?: ProjectCloudAdmission["status"];
    retryMs?: number;
    retryJitterMs?: number;
    snapshotDelayMs?: number;
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), "cloud-scheduler-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const metadata = createLocalMetadataStore(dataDir);
  const replicaId = await getLocalReplicaId(dataDir);
  const now = new Date().toISOString();
  const localMetadata = new Map<string, ProjectMetadata>();
  const remoteMetadata = new Map<string, ProjectMetadata>();
  const remoteDocs = new Map<string, LoroDoc>();
  cleanup.push(async () => {
    for (const doc of remoteDocs.values()) doc.free();
  });
  const remoteDoc = (projectId: string) => {
    let doc = remoteDocs.get(projectId);
    if (!doc) {
      doc = new LoroDoc();
      remoteDocs.set(projectId, doc);
    }
    return doc;
  };
  for (const projectId of projectIds) {
    localMetadata.set(projectId, {
      projectId,
      name: projectId,
      description: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    await metadata.upsertProjectCloudAdmission({
      schemaVersion: 1,
      projectId,
      localReplicaId: replicaId,
      userId: "owner",
      tenantId: "tenant",
      syncBaseUrl: "https://cloud.test",
      status: options.status ?? "pending",
      capabilities: { canvas: true, projectMetadata: true, resources: true },
      admittedAt: null,
      updatedAt: now,
      lastError: null,
    });
  }
  const rooms = new LocalLoroRoomHub(
    dataDir,
    undefined,
    null,
    undefined,
    undefined,
  );
  cleanup.push(() => rooms.close());
  let active = 0;
  let maxActive = 0;
  let loads = 0;
  const loaded = new Set<string>();
  const remote = {
    async loadSnapshot(projectId: string) {
      loads += 1;
      loaded.add(projectId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const delay = options.snapshotDelayMs ?? 30;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        return remoteDocs.get(projectId)?.export({ mode: "snapshot" }) ?? null;
      } finally {
        active -= 1;
      }
    },
    async appendUpdate(projectId: string, bytes: Uint8Array) {
      remoteDoc(projectId).import(bytes);
    },
    async loadProjectMetadata(projectId: string) {
      return remoteMetadata.get(projectId) ?? null;
    },
    async saveProjectMetadata(projectId: string, value: ProjectMetadata) {
      remoteMetadata.set(projectId, value);
    },
  };
  let listAdmissionsCalls = 0;
  let fetchCalls = 0;
  let metadataWrites = 0;
  const service = createLocalProjectCloudSync({
    dataDir,
    rooms,
    remote: async () => remote,
    metadata: {
      list: async () => {
        throw new Error("full metadata load must not run for admission retry");
      },
      listAdmissions: async (id) => {
        listAdmissionsCalls += 1;
        return metadata.listProjectCloudAdmissions(id);
      },
      read: async (projectId) => localMetadata.get(projectId) ?? null,
      write: async (value) => {
        metadataWrites += 1;
        localMetadata.set(value.projectId, value);
      },
    },
    token: async () => "test-cloud-token",
    inspection: {
      finalize: async () => {
        throw new Error("Resource inspection is not used by this fixture");
      },
    },
    fetch: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    },
    maxConcurrent,
    retryMs: options.retryMs ?? 300_000,
    retryJitterMs: options.retryJitterMs ?? 0,
    retryBackoffBaseMs: 1_000,
    online: () => true,
  });
  cleanup.push(() => service.close());
  return {
    service,
    metadata,
    replicaId,
    rooms,
    localMetadata: (projectId: string) => localMetadata.get(projectId),
    remoteMetadata,
    remoteDoc,
    stats: () => ({
      maxActive,
      loads,
      listAdmissionsCalls,
      fetchCalls,
      metadataWrites,
      loaded: [...loaded],
    }),
  };
}

describe("Project cloud sync scheduling", () => {
  it("a local-only Host performs one scoped admission query and arms no timer", async () => {
    const f = await schedulerFixture([]);
    vi.useFakeTimers();
    try {
      await f.service.start();
      expect(f.stats()).toMatchObject({
        listAdmissionsCalls: 1,
        loads: 0,
        fetchCalls: 0,
      });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(f.stats()).toMatchObject({
        listAdmissionsCalls: 1,
        loads: 0,
        fetchCalls: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds concurrent Project syncs", async () => {
    const f = await schedulerFixture(["project-a", "project-b", "project-c"], 2);
    await Promise.all([
      f.service.schedule("project-a"),
      f.service.schedule("project-b"),
      f.service.schedule("project-c"),
    ]);
    expect(f.stats().maxActive).toBe(2);
    expect(f.stats().loads).toBe(3);
    for (const projectId of ["project-a", "project-b", "project-c"]) {
      expect(
        (await f.metadata.getProjectCloudAdmission(projectId, f.replicaId))
          ?.status,
      ).toBe("ready");
    }
  });

  it("re-pulls an admitted ready Project after the floor, including a remote metadata rename and snapshot change", async () => {
    const f = await schedulerFixture(["project"], 2, {
      status: "ready",
      snapshotDelayMs: 0,
    });
    const renamed = {
      ...f.localMetadata("project")!,
      name: "Renamed on another device",
      updatedAt: new Date(
        Date.parse(f.localMetadata("project")!.updatedAt) + 60_000,
      ).toISOString(),
    };
    f.remoteMetadata.set("project", renamed);
    f.remoteDoc("project").getMap("meta").set("remoteEdit", "from-device-b");
    vi.useFakeTimers();
    try {
      await f.service.start();
      expect(f.stats()).toMatchObject({
        listAdmissionsCalls: 1,
        loads: 0,
        metadataWrites: 0,
      });
      // A ready Project keeps the catch-up timer armed, but does not sync yet.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(300_000 - 1);
      expect(f.stats().loads).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await waitFor(() => f.stats().metadataWrites > 0);
      expect(f.stats().loads).toBe(1);
      expect(f.localMetadata("project")?.name).toBe(
        "Renamed on another device",
      );
      expect(
        await f.rooms.inspectProject("project", (doc) =>
          doc.getMap("meta").get("remoteEdit"),
        ),
      ).toBe("from-device-b");
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms the catch-up poll when admission schedules a Project that ends ready", async () => {
    const f = await schedulerFixture(["newly-admitted"], 2, {
      snapshotDelayMs: 0,
    });
    vi.useFakeTimers();
    try {
      await f.service.schedule("newly-admitted");
      expect(
        (await f.metadata.getProjectCloudAdmission(
          "newly-admitted",
          f.replicaId,
        ))?.status,
      ).toBe("ready");
      expect(f.stats().loads).toBe(1);
      await vi.advanceTimersByTimeAsync(300_000);
      await waitFor(() => f.stats().loads >= 2);
      expect(f.stats().loads).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds concurrent catch-up syncs when many admitted Projects are ready", async () => {
    const projectIds = [
      "ready-a",
      "ready-b",
      "ready-c",
      "ready-d",
      "ready-e",
      "ready-f",
    ];
    // Longer than one bounded wave, so the assertion measures the first
    // catch-up pass rather than a repeated poll of the same two Projects.
    const f = await schedulerFixture(projectIds, 2, {
      status: "ready",
      retryMs: 1_000,
    });
    await f.service.start();
    expect(f.stats().loads).toBe(0);
    await waitFor(() => f.stats().loads >= projectIds.length);
    expect(f.stats().maxActive).toBe(2);
    expect(f.stats().loaded.sort()).toEqual([...projectIds].sort());
  });
});


describe("durable cloud outbox (#292 / #299)", () => {
  it("coalesces a 60-edit burst into one delta upload, not 60 snapshots", async () => {
    // A quiet period makes the burst one upload window; without it the base
    // exports/uploads the whole document once per applied update.
    const f = await fixture(true, { mutationDebounceMs: 40 });
    const seed = randomBytes(150_000).toString("base64");
    await f.rooms.mutateProject("project", (doc) => {
      doc.getMap("nodes").set("seed", { type: "text", data: { label: seed } });
      return { value: undefined };
    });
    await f.service.schedule("project");
    expect((await f.admission())?.status).toBe("ready");
    const fullSnapshotBytes = f.remoteDoc.export({ mode: "snapshot" }).byteLength;
    expect(fullSnapshotBytes).toBeGreaterThan(100_000);
    f.resetAppendStats();
    for (let index = 0; index < 60; index += 1) {
      await f.rooms.mutateProject("project", (doc) => {
        doc.getMap("nodes").set(`edit-${index}`, {
          type: "text",
          data: { label: `edit ${index}` },
        });
        return { value: undefined };
      });
    }
    await waitForAsync(async () => (await f.admission())?.status === "ready");
    // Let a queued follow-up run settle before deciding how many uploads the
    // burst produced.
    await new Promise<void>((resolve) => realSetTimeout(resolve, 150));
    const stats = f.appendStats();
    expect(stats.calls).toBeGreaterThan(0);
    expect(stats.calls).toBeLessThanOrEqual(2);
    // A delta is proportional to the edits, not to the document: much smaller
    // than even one full snapshot, and tiny per edit.
    expect(stats.bytes).toBeLessThan(fullSnapshotBytes);
    expect(stats.bytes / 60).toBeLessThan(2_000);
    expect((await f.admission())?.status).toBe("ready");
  });

  it("re-sends the baseline when the remote no longer covers the sync cursor", async () => {
    // A delta the remote cannot apply would be parked as a pending import
    // behind a successful append: acknowledged, but never visible.
    const f = await fixture(true, { mutationDebounceMs: 40 });
    const seed = randomBytes(150_000).toString("base64");
    await f.rooms.mutateProject("project", (doc) => {
      doc.getMap("nodes").set("seed", { type: "text", data: { label: seed } });
      return { value: undefined };
    });
    await f.service.schedule("project");
    expect((await f.admission())?.status).toBe("ready");
    f.resetRemoteDoc();
    f.resetAppendStats();
    await f.rooms.mutateProject("project", (doc) => {
      doc.getMap("nodes").set("after-reset", {
        type: "text",
        data: { label: "after reset" },
      });
      return { value: undefined };
    });
    await waitForAsync(async () => f.appendStats().calls >= 1);
    await waitForAsync(async () => (await f.admission())?.status === "ready");
    // The upload is a full baseline, and the reset remote now holds both the
    // pre-reset seed and the new edit.
    expect(f.appendStats().bytes).toBeGreaterThan(100_000);
    const nodes = f.currentRemoteDoc().getMap("nodes");
    expect(nodes.get("seed")).toBeDefined();
    expect(nodes.get("after-reset")).toBeDefined();
  });

  it("flushes a continuous edit stream at the max wait and keeps later uploads as deltas", async () => {
    // A stream editing every 100 ms never leaves the 400 ms quiet period. The
    // 2 s max wait must flush the window anyway instead of postponing forever.
    const f = await fixture(true, { mutationDebounceMs: 400 });
    const seed = randomBytes(150_000).toString("base64");
    await f.rooms.mutateProject("project", (doc) => {
      doc.getMap("nodes").set("seed", { type: "text", data: { label: seed } });
      return { value: undefined };
    });
    await f.service.schedule("project");
    expect((await f.admission())?.status).toBe("ready");
    const fullSnapshotBytes = f.remoteDoc.export({ mode: "snapshot" }).byteLength;
    expect(fullSnapshotBytes).toBeGreaterThan(100_000);
    f.resetAppendStats();
    vi.useFakeTimers();
    try {
      const firstEditAt = Date.now();
      for (let index = 0; index < 60; index += 1) {
        await f.rooms.mutateProject("project", (doc) => {
          doc.getMap("nodes").set(`stream-${index}`, {
            type: "text",
            data: { label: `edit ${index}` },
          });
          return { value: undefined };
        });
        await vi.advanceTimersByTimeAsync(100);
        if (index === 19) {
          // Six seconds of edits start the first upload at the max wait, not
          // after the stream eventually goes quiet.
          await waitForAsync(async () => f.appendStats().calls >= 1);
        }
      }
      await vi.advanceTimersByTimeAsync(3_000);
      await waitForAsync(async () => f.appendStats().calls >= 2);
      await waitForAsync(
        async () => (await f.admission())?.status === "ready",
      );
      const stats = f.appendStats();
      expect(stats.calls).toBeGreaterThanOrEqual(2);
      expect(stats.times[0] - firstEditAt).toBeLessThanOrEqual(2_000 + 1);
      // The baseline cursor was acknowledged by the seed run, so every upload
      // is a delta proportional to the edits, not a whole snapshot.
      expect(stats.sizes[0]).toBeLessThan(fullSnapshotBytes);
      for (const bytes of stats.sizes.slice(1))
        expect(bytes).toBeLessThan(fullSnapshotBytes / 10);
      expect((await f.admission())?.status).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the quiet and max-wait timers on close", async () => {
    const f = await fixture(false, { mutationDebounceMs: 400 });
    vi.useFakeTimers();
    try {
      await f.service.invalidate("project");
      // The quiet timer, the max-wait timer, and the catch-up poll timer.
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);
      await f.service.close();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.appendStats().calls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces repeated mirror failures into one coded write and one backoff step", async () => {
    const f = await fixture(true, {
      mutationDebounceMs: 60_000,
      mutationMaxWaitMs: 60_000,
      retryBackoffBaseMs: 1_000,
      retryBackoffMaxMs: 4_000,
    });
    await f.service.schedule("project");
    expect((await f.admission())?.status).toBe("ready");
    f.resetAppendStats();
    // First failure of the episode is visible and arms a 1 s * (0.5 + 0) = 500 ms
    // retry. A second or later attempt would be >= 1 s.
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();
    try {
      const edit = (index: number) =>
        f.rooms.mutateProject("project", (doc) => {
          doc.getMap("nodes").set(`offline-${index}`, {
            type: "text",
            data: { label: `queued ${index}` },
          });
          return { value: undefined };
        });
      await edit(0);
      await f.service.reportMirrorFailure(
        "project",
        new Error("cloud link unavailable"),
      );
      const firstFailure = await f.admission();
      expect(firstFailure).toMatchObject({
        status: "failed",
        lastError: expect.stringMatching(/^PROJECT_CLOUD_MIRROR_FAILED: /),
      });
      const firstUpdatedAt = firstFailure?.updatedAt;
      for (let index = 1; index < 50; index += 1) {
        // Advance a little so a second CAS would necessarily change updatedAt,
        // but stay below the first backoff delay.
        await vi.advanceTimersByTimeAsync(5);
        await edit(index);
        await f.service.reportMirrorFailure(
          "project",
          new Error("cloud link unavailable"),
        );
      }
      const coalesced = await f.admission();
      expect(coalesced).toMatchObject({
        status: "failed",
        lastError: expect.stringMatching(/^PROJECT_CLOUD_MIRROR_FAILED: /),
      });
      // One admission write: only the first failure rewrote the row.
      expect(coalesced?.updatedAt).toBe(firstUpdatedAt);
      // 49 * 5 ms elapsed; the single recorded attempt retries at 500 ms.
      expect(f.appendStats().calls).toBe(0);
      await vi.advanceTimersByTimeAsync(254);
      expect(f.appendStats().calls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await waitForAsync(async () => f.appendStats().calls > 0);
      await waitForAsync(
        async () => (await f.admission())?.status === "ready",
      );
      expect((await f.admission())?.status).toBe("ready");
      expect((await f.admission())?.lastError).toBeNull();
      // The queued edits were replayed by the successful run.
      const remoteDoc = new LoroDoc();
      remoteDoc.import(f.remoteDoc.export({ mode: "snapshot" }));
      try {
        expect(remoteDoc.getMap("nodes").get("offline-0")).toMatchObject({
          data: { label: "queued 0" },
        });
        expect(remoteDoc.getMap("nodes").get("offline-49")).toMatchObject({
          data: { label: "queued 49" },
        });
      } finally {
        remoteDoc.free();
      }
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("persists a coded metadata failure and clears it after a successful retry", async () => {
    const f = await fixture(false);
    await f.service.schedule("project");
    expect((await f.admission())?.status).toBe("ready");
    f.rejectMetadata(true);
    Object.assign(f.localMetadata(), {
      name: "Renamed while offline",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    await f.service.schedule("project");
    expect((await f.admission())?.status).toBe("failed");
    expect((await f.admission())?.lastError).toMatch(
      /^PROJECT_METADATA_SYNC_FAILED: /,
    );
    f.rejectMetadata(false);
    await f.service.schedule("project");
    expect((await f.admission())?.status).toBe("ready");
    expect((await f.admission())?.lastError).toBeNull();
  });

  it("persists a coded link failure instead of logging it only", async () => {
    const f = await fixture(false);
    await f.service.schedule("project");
    await f.service.reportMirrorFailure(
      "project",
      new Error("cloud link unavailable"),
    );
    expect(await f.admission()).toMatchObject({
      status: "failed",
      lastError: expect.stringMatching(/^PROJECT_CLOUD_MIRROR_FAILED: /),
    });
    await f.service.schedule("project");
    expect((await f.admission())?.status).toBe("ready");
    expect((await f.admission())?.lastError).toBeNull();
  });

  it("replays an edit queued while the cloud was down after a Host restart", async () => {
    const f = await fixture(false);
    await f.service.schedule("project");
    expect((await f.admission())?.status).toBe("ready");
    f.rejectAppends(true);
    await f.rooms.mutateProject("project", (doc) => {
      doc.getMap("nodes").set("queued-while-down", {
        type: "text",
        data: { label: "survives restart" },
      });
      return { value: undefined };
    });
    Object.assign(f.localMetadata(), {
      name: "Renamed while offline",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    await f.service.invalidate("project");
    await waitForAsync(
      async () => (await f.admission())?.status === "failed",
    );
    expect((await f.admission())?.lastError).toMatch(
      /^PROJECT_CLOUD_MIRROR_FAILED: /,
    );
    await f.service.close();
    await f.rooms.close();
    f.rejectAppends(false);
    const rooms = new LocalLoroRoomHub(
      f.dataDir,
      undefined,
      null,
      undefined,
      undefined,
    );
    cleanup.push(() => rooms.close());
    const restarted = createLocalProjectCloudSync({ ...f.options, rooms });
    cleanup.push(() => restarted.close());
    await restarted.start();
    await restarted.schedule("project");
    expect((await f.admission())?.status).toBe("ready");
    // The metadata row is durable too; the coordinator replays it on the same
    // restart without waiting for another local edit.
    expect(f.cloudMetadata()?.name).toBe("Renamed while offline");
    const remoteDoc = new LoroDoc();
    remoteDoc.import(f.remoteDoc.export({ mode: "snapshot" }));
    try {
      expect(
        remoteDoc.getMap("nodes").get("queued-while-down"),
      ).toMatchObject({ data: { label: "survives restart" } });
    } finally {
      remoteDoc.free();
    }
  });
});

describe("Project cloud sync under idle eviction", () => {
  it("merges the remote snapshot when eviction races the network wait", async () => {
    const f = await fixture(false);
    await f.rooms.mutateProject("project", (doc) => {
      doc.getMap("nodes").set("local-only", { data: { status: "idle" } });
      return { value: undefined, save: true };
    });
    f.currentRemoteDoc()
      .getMap("nodes")
      .set("remote-only", { data: { status: "idle" } });
    const base = await f.options.remote();
    expect(base).toBeDefined();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = createLocalProjectCloudSync({
      ...f.options,
      remote: async () => ({
        ...base!,
        async loadSnapshot() {
          started();
          // Stand in for the network wait after sync has begun but before it
          // has a room to merge into.
          await gate;
          return f.currentRemoteDoc().export({ mode: "snapshot" });
        },
      }),
    });
    cleanup.push(() => service.close());

    const run = service.schedule("project");
    await startedPromise;
    await expect(
      f.rooms.evictIdleRooms({ idleTimeoutMs: 0 }),
    ).resolves.toEqual({ evicted: ["project"], failures: [] });
    release();
    await run;

    await expect(f.admission()).resolves.toMatchObject({
      status: "ready",
      lastError: null,
    });
    await expect(
      f.rooms.inspectProject("project", (doc) => ({
        remote: doc.getMap("nodes").get("remote-only"),
        local: doc.getMap("nodes").get("local-only"),
      })),
    ).resolves.toEqual({
      remote: { data: { status: "idle" } },
      local: { data: { status: "idle" } },
    });
  });
});
