import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { LoroDoc } from "loro-crdt";
import {
  createProjectAsset,
  createProjectDocumentAsset,
  markDocumentAssetAuthority,
  type Resource,
} from "@clash/shared-types";
import type { AssetDeliveryStore } from "@clash/asset-sdk/delivery";
import { createProjectContentRoutes } from "./project-content";
import { createAssetCapabilityRoutes } from "../asset-capability";
import {
  contentHash,
  createProjectContentResolver,
  type ProjectContentPorts,
} from "../../services/project-content";

async function fixture(
  options: { maxBytes?: number; bytes?: Uint8Array; body?: Uint8Array } = {},
) {
  const bytes = options.bytes ?? new TextEncoder().encode("immutable media"),
    body =
      options.body ??
      new TextEncoder().encode('{"text":"historical document"}');
  const resource: Resource = {
    id: "opaque-media",
    kind: "image",
    digest: { algorithm: "sha256", value: await contentHash(bytes) },
    byteLength: bytes.length,
    contentType: "image/png",
  };
  const doc = new LoroDoc();
  createProjectAsset(doc, {
    id: "asset",
    kind: "image",
    source: { kind: "owned", resourceId: resource.id },
    lifecycle: { state: "active" },
    metadata: {},
  });
  markDocumentAssetAuthority(doc);
  const bodyRef = {
    digest: `sha256:${await contentHash(body)}`,
    byteLength: body.length,
    contentType: "application/json" as const,
  };
  createProjectDocumentAsset(doc, {
    id: "revision",
    documentAssetId: "document",
    documentKind: "media.transcript",
    schemaVersion: 1,
    mutability: "versioned",
    body: bodyRef,
    producer: { kind: "actor", actor: { kind: "user", id: "owner" } },
    sourceRefs: [],
  });
  const snapshot = doc.export({ mode: "snapshot" });
  doc.free();
  const objects = new Map<string, Uint8Array>(),
    registry = new Map<string, Resource>();
  let admitted = true;
  const ports: ProjectContentPorts = {
    async authorize(input) {
      return admitted &&
        input.projectId === "project" &&
        input.localReplicaId === "machine" &&
        (!input.userId || input.userId === "owner") &&
        (!input.tenantId || input.tenantId === "tenant")
        ? { tenantId: "tenant" }
        : null;
    },
    async snapshot() {
      return snapshot;
    },
    async resource(tenant, id, claim) {
      const key = `${tenant}/${id}`;
      if (claim) {
        const previous = registry.get(key);
        if (previous && previous.digest.value !== claim.digest.value)
          throw new Error("Conflicting immutable facts");
        registry.set(key, claim);
      }
      return registry.get(key) ?? null;
    },
  };
  const store: AssetDeliveryStore = {
    head(key) {
      const value = objects.get(key);
      return value && { size: value.length };
    },
    get(key, range) {
      const value = objects.get(key);
      if (!value) return undefined;
      const bytes = range
        ? value.slice(range.offset, range.offset + range.length)
        : value;
      return { body: new Response(bytes).body!, size: value.length };
    },
    put(key, value) {
      objects.set(key, value.slice());
    },
  };
  const app = new Hono();
  app.route(
    "/api/v1/projects",
    createProjectContentRoutes({
      ports: () => ports,
      store,
      maxBytes: options.maxBytes,
    }),
  );
  app.route(
    "/assets/capability",
    createAssetCapabilityRoutes({
      resolve: createProjectContentResolver(() => ports),
      store,
      maxBytes: options.maxBytes,
    }),
  );
  const env = { ENVIRONMENT: "production", JWT_SECRET: "test-only-secret" };
  const request = (path: string, init?: RequestInit) =>
    app.request(path, init, env);
  const issue = (
    operation: "read" | "upload",
    project = "project",
    id = resource.id,
    localReplicaId = "machine",
  ) =>
    request(`/api/v1/projects/${project}/resources/${id}/delivery`, {
      method: "POST",
      headers: { "x-user-id": "owner", "content-type": "application/json" },
      body: JSON.stringify({
        operation,
        localReplicaId,
        ...(operation === "upload" ? { resource } : {}),
      }),
    });
  return {
    bytes,
    body,
    bodyRef,
    resource,
    objects,
    request,
    issue,
    revoke: () => {
      admitted = false;
    },
  };
}

describe("Project content transport", () => {
  it("round trips immutable media and Document bytes and safely retries interrupted/corrupt uploads", async () => {
    const f = await fixture();
    const upload = (await (await f.issue("upload")).json()) as {
      capability: { url: string };
    };
    expect(
      (await f.request(upload.capability.url, { method: "PUT", body: "wrong" }))
        .status,
    ).toBe(400);
    expect(f.objects.size).toBe(0);
    expect(
      (
        await f.request(upload.capability.url, {
          method: "PUT",
          body: new Uint8Array(f.bytes.length),
        })
      ).status,
    ).toBe(400);
    expect(
      (await f.request(upload.capability.url, { method: "PUT", body: f.bytes }))
        .status,
    ).toBe(204);
    expect(
      (await f.request(upload.capability.url, { method: "PUT", body: f.bytes }))
        .status,
    ).toBe(204);
    const read = (await (await f.issue("read")).json()) as {
      capability: { url: string };
    };
    expect(
      new Uint8Array(
        await (await f.request(read.capability.url)).arrayBuffer(),
      ),
    ).toEqual(f.bytes);
    const path = `/api/v1/projects/project/document-bodies/${encodeURIComponent(f.bodyRef.digest)}`;
    const headers = { "x-user-id": "owner", "x-local-replica-id": "machine" };
    expect(
      (await f.request(path, { method: "PUT", headers, body: "broken" }))
        .status,
    ).toBe(400);
    expect(
      (await f.request(path, { method: "PUT", headers, body: f.body })).status,
    ).toBe(204);
    expect(
      new Uint8Array(await (await f.request(path, { headers })).arrayBuffer()),
    ).toEqual(f.body);
  });
  it("rejects foreign Project, replica, and arbitrary resource identities and revokes issued capabilities", async () => {
    const f = await fixture();
    expect((await f.issue("upload", "other-project")).status).toBe(403);
    expect(
      (await f.issue("upload", "project", f.resource.id, "other-machine"))
        .status,
    ).toBe(403);
    expect((await f.issue("upload", "project", "private/key")).status).toBe(
      404,
    );
    const { capability } = (await (await f.issue("upload")).json()) as {
      capability: { url: string };
    };
    f.revoke();
    expect(
      (await f.request(capability.url, { method: "PUT", body: f.bytes }))
        .status,
    ).toBe(404);
    expect(f.objects.size).toBe(0);
  });
  it("rechecks revocation after consuming an upload stream", async () => {
    const f = await fixture();
    const { capability } = (await (await f.issue("upload")).json()) as {
      capability: { url: string };
    };
    const stream = new ReadableStream({
      pull(controller) {
        f.revoke();
        controller.enqueue(f.bytes);
        controller.close();
      },
    });
    const result = await f.request(capability.url, {
      method: "PUT",
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect([403, 404]).toContain(result.status);
    expect(f.objects.size).toBe(0);
  });
});

it("enforces the whole-object limit at issuance and while receiving media/Document chunks", async () => {
  const maxBytes = 8;
  const f = await fixture({
    maxBytes,
    bytes: new Uint8Array(maxBytes),
    body: new Uint8Array(maxBytes),
  });
  const endpoint = `/api/v1/projects/project/resources/${f.resource.id}/delivery`;
  const oversized = await f.request(endpoint, {
    method: "POST",
    headers: { "x-user-id": "owner", "content-type": "application/json" },
    body: JSON.stringify({
      operation: "upload",
      localReplicaId: "machine",
      resource: { ...f.resource, byteLength: maxBytes + 1 },
    }),
  });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({
    code: "CLOUD_CONTENT_TOO_LARGE",
    maxBytes,
  });
  const { capability } = (await (await f.issue("upload")).json()) as {
    capability: { url: string };
  };
  expect(
    (await f.request(capability.url, { method: "PUT", body: f.bytes })).status,
  ).toBe(204);
  const chunks = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(maxBytes));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
  const media = await f.request(capability.url, {
    method: "PUT",
    body: chunks(),
    duplex: "half",
  } as RequestInit);
  expect(media.status).toBe(413);
  expect(await media.json()).toMatchObject({
    code: "CLOUD_CONTENT_TOO_LARGE",
    maxBytes,
  });
  const documentPath = `/api/v1/projects/project/document-bodies/${encodeURIComponent(f.bodyRef.digest)}`;
  const headers = { "x-user-id": "owner", "x-local-replica-id": "machine" };
  expect(
    (await f.request(documentPath, { method: "PUT", headers, body: f.body }))
      .status,
  ).toBe(204);
  const document = await f.request(documentPath, {
    method: "PUT",
    headers,
    body: chunks(),
    duplex: "half",
  } as RequestInit);
  expect(document.status).toBe(413);
  expect(await document.json()).toMatchObject({
    code: "CLOUD_CONTENT_TOO_LARGE",
    maxBytes,
  });
});
