import { describe, expect, it, vi } from "vitest";
import {
  contentHash,
  createInMemoryAssetDeliveryStore,
  createInMemoryContentReferenceIndex,
  createUploadService,
  documentLocator,
  trustedHeaderIdentity,
  type ContentPublishedEvent,
} from "./upload-service.js";
import { PROJECT_CLOUD_CONTENT_PART_BYTES } from "./content-transfer.js";

const PART = PROJECT_CLOUD_CONTENT_PART_BYTES;

async function fixture(size = PART * 2 + 123) {
  const body = new Uint8Array(size);
  for (let i = 0; i < size; i++) body[i] = (i * 31) & 0xff;
  const digest = `sha256:${await contentHash(body)}`;
  const index = createInMemoryContentReferenceIndex();
  const store = createInMemoryAssetDeliveryStore();
  const published: ContentPublishedEvent[] = [];
  let admitted = true;
  const roomReferences = vi.fn(async () => ({
    resources: [],
    documents: [{ digest, byteLength: size, contentType: "application/json" }],
  }));
  const background: Promise<unknown>[] = [];
  const service = createUploadService({
    identity: trustedHeaderIdentity,
    admission: {
      async authorize(input) {
        return admitted &&
          input.projectId === "p1" &&
          input.localReplicaId === "r1" &&
          (!input.userId || input.userId === "u1")
          ? { tenantId: "t1" }
          : null;
      },
    },
    index,
    store,
    room: {
      references: roomReferences,
      async notifyPublished(event) {
        published.push(event);
      },
    },
    defer: (work) => background.push(work),
  });
  const url = (q = "") =>
    `https://upload.test/api/v1/projects/p1/document-bodies/${encodeURIComponent(digest)}${q}`;
  const headers = { "x-user-id": "u1", "x-local-replica-id": "r1" };
  const req = (q: string, init: RequestInit = {}) =>
    service.handle(
      new Request(url(q), { method: "PUT", ...init, headers: { ...headers, ...(init.headers as object) } }),
    ) as Promise<Response>;
  return {
    body, digest, size, index, store, service, published, roomReferences, background, req, url, headers,
    revoke: () => (admitted = false),
  };
}

describe("upload service (in-memory adapters)", () => {
  it("ignores non-upload routes", async () => {
    const f = await fixture(10);
    expect(await f.service.handle(new Request("https://x/api/v1/projects/p1/other"))).toBeUndefined();
  });

  it("requires identity and replica", async () => {
    const f = await fixture(10);
    const r = await f.service.handle(new Request(f.url(), { method: "PUT" }));
    expect(r!.status).toBe(401);
  });

  it("multipart upload with resume: index hit never asks the room; digest verified; one notify", async () => {
    const f = await fixture();
    await f.index.replace("p1", {
      resources: [],
      documents: [{ digest: f.digest, byteLength: f.size, contentType: "application/json" }],
    });
    const id = "session-0123456789abcdef";
    expect((await f.req(`?upload=begin&uploadId=${id}`)).status).toBe(200);
    const part = (n: number) =>
      f.body.slice((n - 1) * PART, Math.min(n * PART, f.size));
    expect((await f.req(`?upload=part&uploadId=${id}&partNumber=1`, { body: part(1) })).status).toBe(204);
    // Interrupted sender re-begins and learns which parts are held.
    const resumed = await (await f.req(`?upload=begin&uploadId=${id}`)).json();
    expect(resumed.parts.map((p: { partNumber: number }) => p.partNumber)).toEqual([1]);
    expect(resumed.parts[0].sha256).toBe(await contentHash(part(1)));
    for (const n of [2, 3])
      expect((await f.req(`?upload=part&uploadId=${id}&partNumber=${n}`, { body: part(n) })).status).toBe(204);
    expect((await f.req(`?upload=complete&uploadId=${id}`)).status).toBe(204);
    await Promise.all(f.background);
    expect(f.roomReferences).not.toHaveBeenCalled();
    expect(f.published).toEqual([
      { type: "content.published", projectId: "p1", kind: "document", digest: f.digest, byteLength: f.size },
    ]);
    const got = await f.service.handle(new Request(f.url(), { headers: f.headers }));
    expect(`sha256:${await contentHash(new Uint8Array(await got!.arrayBuffer()))}`).toBe(f.digest);
    expect(f.store.objects.has(await documentLocator("t1", f.digest))).toBe(true);
  });

  it("index miss falls back to the room once per lookup", async () => {
    const f = await fixture(10);
    const r = await f.req("", { body: f.body });
    expect(r.status).toBe(204);
    expect(f.roomReferences).toHaveBeenCalled();
  });

  it("corrupted part: complete 400 digest mismatch, never published", async () => {
    const f = await fixture(PART + 5);
    await f.index.replace("p1", { resources: [], documents: [{ digest: f.digest, byteLength: f.size, contentType: "application/json" }] });
    const id = "session-corrupt-000000";
    await f.req(`?upload=begin&uploadId=${id}`);
    const bad = f.body.slice(0, PART);
    bad[7] ^= 1;
    await f.req(`?upload=part&uploadId=${id}&partNumber=1`, { body: bad });
    await f.req(`?upload=part&uploadId=${id}&partNumber=2`, { body: f.body.slice(PART) });
    expect((await f.req(`?upload=complete&uploadId=${id}`)).status).toBe(400);
    expect((await f.service.handle(new Request(f.url(), { headers: f.headers })))!.status).toBe(404);
    expect(f.published).toEqual([]);
  });

  it("abort is idempotent and an aborted session cannot resume", async () => {
    const f = await fixture(10);
    const id = "session-abort-00000000";
    await f.req(`?upload=begin&uploadId=${id}`);
    expect((await f.req(`?upload=abort&uploadId=${id}`)).status).toBe(204);
    expect((await f.req(`?upload=abort&uploadId=${id}`)).status).toBe(204);
    expect((await f.req(`?upload=begin&uploadId=${id}`)).status).toBe(410);
  });

  it("revalidates admission before publish (revoked mid-upload → 403)", async () => {
    const f = await fixture(10);
    const id = "session-revoke-0000000";
    await f.req(`?upload=begin&uploadId=${id}`);
    await f.req(`?upload=part&uploadId=${id}&partNumber=1`, { body: f.body });
    f.revoke();
    expect((await f.req(`?upload=complete&uploadId=${id}`)).status).toBe(403);
  });

  it("unreferenced digest → 404; out-of-range part → 400; oversized → 413", async () => {
    const f = await fixture(10);
    f.roomReferences.mockResolvedValue({ resources: [], documents: [] });
    expect((await f.req("", { body: f.body })).status).toBe(404);
    f.roomReferences.mockResolvedValue({ resources: [], documents: [{ digest: f.digest, byteLength: 10, contentType: "application/json" }] });
    const id = "session-range-00000000";
    await f.req(`?upload=begin&uploadId=${id}`);
    expect((await f.req(`?upload=part&uploadId=${id}&partNumber=9`, { body: f.body })).status).toBe(400);
    expect((await f.req(`?upload=part&uploadId=${id}&partNumber=1`, { body: new Uint8Array(PART + 1), headers: { "content-length": String(PART + 1) } })).status).toBe(413);
  });

  it("logs failures with the #121 severity taxonomy", async () => {
    const log = vi.fn();
    const f = await fixture(10);
    const svc = createUploadService({
      identity: trustedHeaderIdentity,
      admission: { authorize: async () => null },
      index: f.index,
      store: f.store,
      telemetry: { log },
    });
    const r = await svc.handle(new Request(f.url(), { method: "PUT", headers: f.headers, body: f.body }));
    expect(r!.status).toBe(403);
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      "upload.document_body",
      expect.objectContaining({ status: 403, severity: expect.any(String) }),
    );
  });
});
