import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { PROJECT_CLOUD_CONTENT_PART_BYTES } from "@clash/asset-sdk/delivery";
import { createR2AssetDeliveryStore } from "../routes/asset-capability";
import { contentHash } from "../services/project-content";

it("keeps multipart bytes private until full integrity verification and resumes idempotently", async () => {
  const store = createR2AssetDeliveryStore(env.R2_BUCKET);
  const bytes = new Uint8Array(PROJECT_CLOUD_CONTENT_PART_BYTES + 17).fill(71);
  const target = {
    identity: `project:replica:${crypto.randomUUID()}`,
    locator: `verified-test/${crypto.randomUUID()}`,
    digest: `sha256:${await contentHash(bytes)}`,
    byteLength: bytes.length,
    contentType: "application/octet-stream",
  };
  const session = { uploadId: crypto.randomUUID(), target };
  const upload = store.multipart!;
  await Promise.all([upload.begin(session), upload.begin(session)]);
  await upload.part(
    session,
    1,
    bytes.subarray(0, PROJECT_CLOUD_CONTENT_PART_BYTES),
  );
  expect(await store.head(target.locator)).toBeUndefined();
  await expect(upload.complete(session, async () => {})).rejects.toThrow();
  await upload.part(
    session,
    2,
    bytes.subarray(PROJECT_CLOUD_CONTENT_PART_BYTES),
  );
  await upload.part(
    session,
    2,
    bytes.subarray(PROJECT_CLOUD_CONTENT_PART_BYTES),
  );
  await expect(upload.part(session, 2, new Uint8Array(17))).rejects.toThrow();
  await expect(
    upload.complete(session, async () => {
      throw new Error("revoked");
    }),
  ).rejects.toThrow("revoked");
  expect(await store.head(target.locator)).toBeUndefined();
  await upload.complete(session, async () => {});
  await upload.complete(session, async () => {});
  const object = await store.get(target.locator);
  expect(
    `sha256:${await contentHash(new Uint8Array(await new Response(object!.body).arrayBuffer()))}`,
  ).toBe(target.digest);
  await expect(
    upload.begin({ ...session, target: { ...target, byteLength: 1 } }),
  ).rejects.toThrow();
});

it("streams the full product-limit Resource through authenticated HTTP multipart and R2 without a whole-object allocation", async () => {
  const { Hono } = await import("hono");
  const { createProjectContentRoutes } =
    await import("../routes/v1/project-content");
  const { createAssetCapabilityRoutes } =
    await import("../routes/asset-capability");
  const { createProjectContentResolver } =
    await import("../services/project-content");
  const { LoroDoc } = await import("loro-crdt");
  const { createProjectAsset } = await import("@clash/shared-types");
  const { PROJECT_CLOUD_CONTENT_MAX_BYTES } =
    await import("@clash/asset-sdk/delivery");
  const { createHash } = await import("node:crypto");
  const size = PROJECT_CLOUD_CONTENT_MAX_BYTES;
  const part = new Uint8Array(PROJECT_CLOUD_CONTENT_PART_BYTES).fill(37);
  const expected = createHash("sha256");
  for (let offset = 0; offset < size; offset += part.length)
    expected.update(part.subarray(0, Math.min(part.length, size - offset)));
  const resource = {
    id: crypto.randomUUID(),
    kind: "video" as const,
    byteLength: size,
    digest: { algorithm: "sha256" as const, value: expected.digest("hex") },
    contentType: "video/mp4",
  };
  const projectId = crypto.randomUUID(),
    tenantId = crypto.randomUUID(),
    localReplicaId = crypto.randomUUID();
  const doc = new LoroDoc();
  createProjectAsset(doc, {
    id: "media",
    kind: "video",
    source: { kind: "owned", resourceId: resource.id },
    lifecycle: { state: "active" },
    metadata: {},
  });
  const snapshot = doc.export({ mode: "snapshot" });
  doc.free();
  let admitted = true;
  const ports = {
    async authorize(input: {
      projectId: string;
      localReplicaId: string;
      tenantId?: string;
      userId?: string;
    }) {
      return admitted &&
        input.projectId === projectId &&
        input.localReplicaId === localReplicaId &&
        (!input.tenantId || input.tenantId === tenantId) &&
        (!input.userId || input.userId === "owner")
        ? { tenantId }
        : null;
    },
    async snapshot() {
      return snapshot;
    },
    async resource(tenant: string, id: string) {
      return tenant === tenantId && id === resource.id ? resource : null;
    },
  };
  const app = new Hono();
  app.route(
    "/api/v1/projects",
    createProjectContentRoutes({ ports: () => ports }),
  );
  app.route(
    "/assets/capability",
    createAssetCapabilityRoutes({
      resolve: createProjectContentResolver(() => ports),
    }),
  );
  const bindings = { ...env, JWT_SECRET: "multipart-integration-only-secret" };
  const issue = (operation: "upload" | "read", byteLength = size) =>
    app.request(
      `https://cloud.test/api/v1/projects/${projectId}/resources/${resource.id}/delivery`,
      {
        method: "POST",
        headers: { "x-user-id": "owner", "content-type": "application/json" },
        body: JSON.stringify({
          operation,
          localReplicaId,
          ...(operation === "upload"
            ? { resource: { ...resource, byteLength } }
            : {}),
        }),
      },
      bindings,
    );
  const tooBig = await issue("upload", size + 1);
  expect(tooBig.status).toBe(413);
  expect(await tooBig.json()).toMatchObject({ maxBytes: size });
  const issued = await issue("upload");
  expect(issued.status).toBe(200);
  const { capability } = (await issued.json()) as {
    capability: { url: string };
  };
  const uploadId = crypto.randomUUID();
  const request = (
    operation: string,
    body?: Uint8Array | ReadableStream<Uint8Array>,
    partNumber?: number,
  ) => {
    const url = new URL(capability.url);
    url.searchParams.set("upload", operation);
    url.searchParams.set("uploadId", uploadId);
    if (partNumber !== undefined)
      url.searchParams.set("partNumber", String(partNumber));
    return app.request(
      url.toString(),
      { method: "PUT", ...(body ? { body } : {}) },
      bindings,
    );
  };
  expect((await request("begin")).status).toBe(200);
  expect((await request("begin")).status).toBe(200);
  expect((await issue("read")).status).toBe(404);
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(part);
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  expect((await request("part", oversized, 1)).status).toBe(413);
  expect(
    (await request("part", part.subarray(0, part.length - 1), 1)).status,
  ).toBe(400);
  for (
    let offset = 0, number = 1;
    offset < size;
    offset += part.length, number += 1
  ) {
    const response = await request(
      "part",
      part.subarray(0, Math.min(part.length, size - offset)),
      number,
    );
    if (response.status !== 204) throw new Error(await response.text());
  }
  expect((await issue("read")).status).toBe(404);
  const completions = await Promise.all([
    request("complete"),
    request("complete"),
  ]);
  expect(completions.some((value) => value.status === 204)).toBe(true);
  expect(
    completions.every((value) => value.status === 204 || value.status === 409),
  ).toBe(true);
  expect((await request("complete")).status).toBe(204);
  const download = (await (await issue("read")).json()) as {
    capability: { url: string };
  };
  const response = await app.request(download.capability.url, {}, bindings);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBe(String(size));
  const received = createHash("sha256");
  let receivedLength = 0;
  await response.body!.pipeTo(
    new WritableStream<Uint8Array>({
      write(chunk) {
        receivedLength += chunk.length;
        received.update(chunk);
      },
    }),
  );
  expect(receivedLength).toBe(size);
  expect(received.digest("hex")).toBe(resource.digest.value);
  admitted = false;
  expect(
    (await app.request(download.capability.url, {}, bindings)).status,
  ).toBe(404);
}, 120_000);

it("replicates a Document beyond the former limit with the same authenticated chunk protocol", async () => {
  const { Hono } = await import("hono");
  const { LoroDoc } = await import("loro-crdt");
  const { createHash } = await import("node:crypto");
  const { createProjectDocumentAsset, markDocumentAssetAuthority } =
    await import("@clash/shared-types");
  const { createProjectContentRoutes } =
    await import("../routes/v1/project-content");
  const part = new Uint8Array(PROJECT_CLOUD_CONTENT_PART_BYTES).fill(65);
  const first = part.slice();
  first.set(new TextEncoder().encode('{"text":"'));
  const last = new TextEncoder().encode('"}\n');
  const chunkAt = (index: number) =>
    index === 0 ? first : index === 5 ? last : part;
  const hash = createHash("sha256");
  let byteLength = 0;
  for (let index = 0; index <= 5; index += 1) {
    hash.update(chunkAt(index));
    byteLength += chunkAt(index).length;
  }
  const digest = `sha256:${hash.digest("hex")}`,
    projectId = crypto.randomUUID(),
    tenantId = crypto.randomUUID();
  const doc = new LoroDoc();
  markDocumentAssetAuthority(doc);
  const created = createProjectDocumentAsset(doc, {
    id: "revision",
    documentAssetId: "document",
    documentKind: "media.transcript",
    schemaVersion: 1,
    mutability: "versioned",
    body: { digest, byteLength, contentType: "application/json" },
    producer: { kind: "actor", actor: { kind: "user", id: "owner" } },
    sourceRefs: [],
  });
  expect(created.ok).toBe(true);
  const snapshot = doc.export({ mode: "snapshot" });
  doc.free();
  const empty = new LoroDoc();
  const removed = empty.export({ mode: "snapshot" });
  empty.free();
  let referenced = true;
  const ports = {
    async authorize(input: {
      projectId: string;
      localReplicaId: string;
      userId?: string;
    }) {
      return input.projectId === projectId &&
        input.localReplicaId === "machine" &&
        input.userId === "owner"
        ? { tenantId }
        : null;
    },
    async snapshot() {
      return referenced ? snapshot : removed;
    },
    async resource() {
      return null;
    },
  };
  const app = new Hono();
  app.route(
    "/api/v1/projects",
    createProjectContentRoutes({ ports: () => ports }),
  );
  const url = `https://cloud.test/api/v1/projects/${projectId}/document-bodies/${encodeURIComponent(digest)}`;
  const headers = { "x-user-id": "owner", "x-local-replica-id": "machine" },
    uploadId = crypto.randomUUID();
  const request = (operation: string, body?: Uint8Array, number?: number) =>
    app.request(
      `${url}?upload=${operation}&uploadId=${uploadId}${number ? `&partNumber=${number}` : ""}`,
      { method: "PUT", headers, ...(body ? { body } : {}) },
      env,
    );
  const begun = await request("begin");
  if (begun.status !== 200) throw new Error(await begun.text());
  for (let index = 0; index <= 5; index += 1)
    expect((await request("part", chunkAt(index), index + 1)).status).toBe(204);
  expect((await app.request(url, { headers }, env)).status).toBe(404);
  referenced = false;
  expect((await request("complete")).status).toBe(404);
  referenced = true;
  expect((await request("complete")).status).toBe(204);
  const response = await app.request(url, { headers }, env);
  expect(response.status).toBe(200);
  const received = createHash("sha256");
  await response.body!.pipeTo(
    new WritableStream<Uint8Array>({
      write(chunk) {
        received.update(chunk);
      },
    }),
  );
  expect(`sha256:${received.digest("hex")}`).toBe(digest);
  expect(
    (
      await app.request(
        url,
        { headers: { ...headers, "x-local-replica-id": "other" } },
        env,
      )
    ).status,
  ).toBe(403);
});

it("rejects corrupt completion, isolates sessions, and reclaims aborted or expired staging", async () => {
  const { createR2ProjectMultipartStore, cleanupProjectContentUploads } =
    await import("../services/project-content-multipart");
  const bytes = new TextEncoder().encode("private immutable fixture");
  const target = {
    identity: crypto.randomUUID(),
    locator: `verified-test/${crypto.randomUUID()}`,
    digest: `sha256:${await contentHash(bytes)}`,
    byteLength: bytes.length,
  };
  const multipart = createR2ProjectMultipartStore(env.R2_BUCKET, () => 0);
  const session = { uploadId: crypto.randomUUID(), target };
  await multipart.begin(session);
  const results = await Promise.allSettled([
    multipart.part(session, 1, bytes),
    multipart.part(session, 1, bytes),
  ]);
  expect(results.some((value) => value.status === "fulfilled")).toBe(true);
  await multipart.part(session, 1, bytes);
  await expect(
    multipart.part(
      { ...session, target: { ...target, identity: "other-project" } },
      1,
      bytes,
    ),
  ).rejects.toMatchObject({ status: 410 });
  await multipart.abort(session);
  await expect(multipart.complete(session, async () => {})).rejects.toThrow();
  expect(await env.R2_BUCKET.head(target.locator)).toBeNull();
  const corrupt = {
    uploadId: crypto.randomUUID(),
    target: {
      ...target,
      locator: `${target.locator}-corrupt`,
      digest: `sha256:${"0".repeat(64)}`,
    },
  };
  await multipart.begin(corrupt);
  await multipart.part(corrupt, 1, bytes);
  await expect(
    multipart.complete(corrupt, async () => {}),
  ).rejects.toMatchObject({ status: 400 });
  expect(await env.R2_BUCKET.head(corrupt.target.locator)).toBeNull();
  const good = {
    uploadId: crypto.randomUUID(),
    target: { ...target, locator: `${target.locator}-good` },
  };
  await multipart.begin(good);
  await multipart.part(good, 1, bytes);
  await multipart.complete(good, async () => {});
  // Expire all finite sessions without pinning an implementation-owned TTL.
  for (let index = 0; index < 20; index += 1)
    await cleanupProjectContentUploads(env.R2_BUCKET, Number.MAX_SAFE_INTEGER);
  await expect(
    multipart.begin(session).then(() => multipart.part(session, 1, bytes)),
  ).resolves.toBeUndefined();
  // Cleanup only removes private upload state, never a verified canonical object.
  expect((await env.R2_BUCKET.head(good.target.locator))?.size).toBe(
    bytes.length,
  );
  await multipart.abort(session);
});

it("does not acknowledge abort while completion owns publication", async () => {
  const store = createR2AssetDeliveryStore(env.R2_BUCKET);
  const bytes = new TextEncoder().encode("verified before publish");
  const target = {
    identity: crypto.randomUUID(),
    locator: `verified-test/${crypto.randomUUID()}`,
    digest: `sha256:${await contentHash(bytes)}`,
    byteLength: bytes.length,
  };
  const session = { uploadId: crypto.randomUUID(), target };
  await store.multipart!.begin(session);
  await store.multipart!.part(session, 1, bytes);
  let announce!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finishing = store.multipart!.complete(session, async () => {
    announce();
    await resume;
  });
  await reached;
  await expect(store.multipart!.abort(session)).rejects.toMatchObject({
    status: 409,
  });
  expect(await store.head(target.locator)).toBeUndefined();
  release();
  await finishing;
  await store.multipart!.abort(session);
  expect((await store.head(target.locator))?.size).toBe(bytes.length);
});

it("recovers an uncertain canonical put without reopening an abortable session", async () => {
  const { createR2ProjectMultipartStore } =
    await import("../services/project-content-multipart");
  const bytes = new TextEncoder().encode("retry verified publication");
  const target = {
    identity: crypto.randomUUID(),
    locator: `verified-test/${crypto.randomUUID()}`,
    digest: `sha256:${await contentHash(bytes)}`,
    byteLength: bytes.length,
  };
  let fail = true;
  const bucket = new Proxy(env.R2_BUCKET, {
    get(original, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          if (args[0] === target.locator && fail) {
            fail = false;
            throw new Error("uncertain canonical put");
          }
          return original.put(...args);
        };
      const value = Reflect.get(original, property);
      return typeof value === "function" ? value.bind(original) : value;
    },
  });
  const multipart = createR2ProjectMultipartStore(bucket);
  const session = { uploadId: crypto.randomUUID(), target };
  await multipart.begin(session);
  await multipart.part(session, 1, bytes);
  await expect(multipart.complete(session, async () => {})).rejects.toThrow(
    "uncertain canonical put",
  );
  await expect(multipart.abort(session)).rejects.toMatchObject({ status: 409 });
  await multipart.complete(session, async () => {});
  expect((await bucket.head(target.locator))?.size).toBe(bytes.length);
});
