import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { LoroDoc } from "loro-crdt";
import {
  createProjectAsset,
  createProjectDocumentAsset,
  markDocumentAssetAuthority,
} from "@clash/shared-types";
import { createD1CloudProjectAdmissionStore } from "../services/cloud-project-admission";
import {
  contentHash,
  createCloudProjectContentPorts,
  createProjectContentResolver,
} from "../services/project-content";
import { createProjectContentRoutes } from "../routes/v1/project-content";
import { createAssetCapabilityRoutes } from "../routes/asset-capability";
import type { Env } from "../config";

describe("default cloud Project content adapters in workerd", () => {
  it("uses D1 admission, durable ProjectRoom references and immutable R2 bytes with tenant isolation", async () => {
    const bindings = {
      ...env,
      JWT_SECRET: "integration-only-content-secret",
    } as unknown as Env;
    const suffix = crypto.randomUUID(),
      projectId = `content-${suffix}`,
      localReplicaId = `machine-${suffix}`,
      userId = `owner-${suffix}`;
    const store = createD1CloudProjectAdmissionStore(bindings.DB);
    const now = new Date().toISOString();
    const admission = await store.admit({
      userId,
      syncBaseUrl: "https://cloud.test",
      request: {
        schemaVersion: 1,
        projectId,
        localReplicaId,
        resourceIds: [],
        metadata: {
          projectId,
          name: "Content",
          description: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      },
    });
    const bytes = new TextEncoder().encode("immutable cloud media"),
      body = new TextEncoder().encode('{"text":"document body"}');
    const resource = {
      id: `opaque-${suffix}`,
      kind: "image" as const,
      digest: { algorithm: "sha256" as const, value: await contentHash(bytes) },
      byteLength: bytes.length,
      contentType: "image/png",
    };
    const bodyRef = {
      digest: `sha256:${await contentHash(body)}`,
      byteLength: body.length,
      contentType: "application/json" as const,
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
    createProjectDocumentAsset(doc, {
      id: "revision",
      documentAssetId: "document",
      documentKind: "media.transcript",
      schemaVersion: 1,
      mutability: "versioned",
      body: bodyRef,
      producer: { kind: "actor", actor: { kind: "user", id: userId } },
      sourceRefs: [],
    });
    const room = bindings.ROOM.get(bindings.ROOM.idFromName(projectId));
    const persisted = await room.fetch(
      new Request(`http://internal/loro/${projectId}/updates`, {
        method: "POST",
        headers: { "x-internal-loro": "true", "x-loro-project-id": projectId },
        body: doc.export({ mode: "snapshot" }),
      }),
    );
    doc.free();
    expect(persisted.status).toBe(204);
    const app = new Hono<{ Bindings: Env }>();
    app.route("/api/v1/projects", createProjectContentRoutes());
    app.route(
      "/assets/capability",
      createAssetCapabilityRoutes({ resolve: createProjectContentResolver() }),
    );
    const headers = { "x-user-id": userId, "content-type": "application/json" };
    const issue = (operation: "upload" | "read", claimed = resource) =>
      app.request(
        `https://cloud.test/api/v1/projects/${projectId}/resources/${resource.id}/delivery`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operation,
            localReplicaId,
            ...(operation === "upload" ? { resource: claimed } : {}),
          }),
        },
        bindings,
      );
    const uploads = await Promise.all([issue("upload"), issue("upload")]);
    expect(uploads.map((response) => response.status)).toEqual([200, 200]);
    const { capability } = (await uploads[0].json()) as {
      capability: { url: string };
    };
    expect((await issue("read")).status).toBe(404);
    expect(
      (
        await issue("upload", {
          ...resource,
          digest: { algorithm: "sha256", value: "0".repeat(64) },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request(
          capability.url,
          { method: "PUT", body: bytes },
          bindings,
        )
      ).status,
    ).toBe(204);
    const { capability: download } = (await (await issue("read")).json()) as {
      capability: { url: string };
    };
    expect(
      new Uint8Array(
        await (await app.request(download.url, {}, bindings)).arrayBuffer(),
      ),
    ).toEqual(bytes);
    const documentPath = `https://cloud.test/api/v1/projects/${projectId}/document-bodies/${encodeURIComponent(bodyRef.digest)}`;
    const documentHeaders = {
      ...headers,
      "x-local-replica-id": localReplicaId,
    };
    expect(
      (
        await app.request(
          documentPath,
          { method: "PUT", headers: documentHeaders, body },
          bindings,
        )
      ).status,
    ).toBe(204);
    expect(
      new Uint8Array(
        await (
          await app.request(
            documentPath,
            { headers: documentHeaders },
            bindings,
          )
        ).arrayBuffer(),
      ),
    ).toEqual(body);
    const ports = createCloudProjectContentPorts(bindings);
    expect(await ports.resource("unrelated-tenant", resource.id)).toBeNull();
    await bindings.DB.prepare(
      "UPDATE project_cloud_admission SET status = 'local-only' WHERE project_id = ? AND local_replica_id = ?",
    )
      .bind(projectId, localReplicaId)
      .run();
    expect((await app.request(download.url, {}, bindings)).status).toBe(404);
    await store.admit({
      userId,
      syncBaseUrl: "https://cloud.test",
      request: {
        schemaVersion: 1,
        projectId,
        localReplicaId,
        resourceIds: [],
        metadata: {
          projectId,
          name: "Content",
          description: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      },
    });
    await bindings.DB.prepare("UPDATE project SET deleted_at = ? WHERE id = ?")
      .bind(1, projectId)
      .run();
    expect(
      await ports.authorize({
        projectId,
        localReplicaId,
        tenantId: admission.admission.tenantId,
      }),
    ).toBeNull();
  });
});
