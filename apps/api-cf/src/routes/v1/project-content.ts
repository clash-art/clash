import { Hono } from "hono";
import { ProjectResourceDeliveryRequestSchema } from "@clash/shared-types/project-sync-content";
import {
  ContentTransferLimitError,
  assertContentTransferSize,
  readBoundedContent,
  type AssetDeliveryStore,
} from "@clash/asset-sdk/delivery";
import type { Env } from "../../config";
import { createCloudAssetDeliveryPort } from "../../services/cloud-asset-delivery";
import { createR2AssetDeliveryStore } from "../asset-capability";
import {
  contentHash,
  ProjectContentConflictError,
  createCloudProjectContentPorts,
  documentLocator,
  resourceLocator,
  projectContentReferences,
  type ProjectContentPorts,
} from "../../services/project-content";

export function createProjectContentRoutes(
  options: {
    ports?: (env: Env) => ProjectContentPorts;
    store?: AssetDeliveryStore;
    maxBytes?: number;
  } = {},
) {
  const routes = new Hono<{ Bindings: Env }>();
  const portsFor = options.ports ?? createCloudProjectContentPorts;
  routes.onError((error, c) =>
    error instanceof ContentTransferLimitError
      ? c.json(
          { error: error.message, code: error.code, maxBytes: error.maxBytes },
          413,
        )
      : c.json({ error: "Cloud content transport unavailable" }, 503),
  );
  routes.post("/:id/resources/:resourceId/delivery", async (c) => {
    const userId = c.req.header("x-user-id");
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const parsed = ProjectResourceDeliveryRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const projectId = c.req.param("id"),
      resourceId = c.req.param("resourceId");
    const ports = portsFor(c.env),
      input = parsed.data;
    const admission = await ports.authorize({
      projectId,
      userId,
      localReplicaId: input.localReplicaId,
    });
    if (!admission) return c.json({ error: "not_admitted" }, 403);
    const refs = await projectContentReferences(ports, projectId);
    const ref = refs.resources.find((value) => value.resourceId === resourceId);
    if (!ref) return c.json({ error: "resource_not_in_project" }, 404);
    if (
      input.operation === "upload" &&
      (input.resource.id !== resourceId || input.resource.kind !== ref.kind)
    )
      return c.json({ error: "resource_mismatch" }, 400);
    if (input.operation === "upload")
      assertContentTransferSize(input.resource.byteLength, options.maxBytes);
    let resource;
    try {
      resource = await ports.resource(
        admission.tenantId,
        resourceId,
        input.operation === "upload" ? input.resource : undefined,
      );
    } catch (error) {
      return error instanceof ProjectContentConflictError
        ? c.json({ error: "resource_facts_conflict" }, 409)
        : c.json({ error: "resource_registry_unavailable" }, 503);
    }
    if (!resource) return c.json({ error: "resource_not_replicated" }, 404);
    assertContentTransferSize(resource.byteLength, options.maxBytes);
    if (input.operation === "read") {
      const store =
        options.store ?? createR2AssetDeliveryStore(c.env.R2_BUCKET);
      const head = await store.head(
        await resourceLocator(admission.tenantId, resource),
      );
      if (!head || head.size !== resource.byteLength)
        return c.json({ error: "resource_bytes_not_replicated" }, 404);
    }
    const scope = {
      tenantId: admission.tenantId,
      projectId,
      localReplicaId: input.localReplicaId,
    };
    const delivery = createCloudAssetDeliveryPort(c.env, {
      origin: c.env.WORKER_PUBLIC_URL ?? new URL(c.req.url).origin,
      authorize: async () => !!(await ports.authorize({ ...scope, userId })),
    });
    const capability =
      input.operation === "upload"
        ? await delivery.issueUploadUrl({
            resourceId,
            scope,
            purpose: "host-staging",
            byteLength: resource.byteLength,
            digest: `sha256:${resource.digest.value}`,
            contentType: resource.contentType,
          })
        : await delivery.issueReadUrl({
            resourceId,
            scope,
            purpose: "download",
          });
    return c.json({ resource, capability });
  });
  routes.on(
    ["GET", "HEAD", "PUT"],
    "/:id/document-bodies/:digest",
    async (c) => {
      const userId = c.req.header("x-user-id"),
        localReplicaId = c.req.header("x-local-replica-id");
      if (!userId || !localReplicaId)
        return c.json({ error: "unauthorized" }, 401);
      const projectId = c.req.param("id"),
        ports = portsFor(c.env);
      const admission = await ports.authorize({
        projectId,
        localReplicaId,
        userId,
      });
      if (!admission) return c.json({ error: "not_admitted" }, 403);
      const digest = c.req.param("digest"),
        refs = await projectContentReferences(ports, projectId);
      const ref = refs.documents.find((value) => value.digest === digest);
      if (!ref) return c.json({ error: "document_not_in_project" }, 404);
      const store =
        options.store ?? createR2AssetDeliveryStore(c.env.R2_BUCKET);
      assertContentTransferSize(ref.byteLength, options.maxBytes);
      const key = await documentLocator(admission.tenantId, digest);
      if (c.req.method === "PUT") {
        const declaredLength = c.req.header("content-length");
        if (declaredLength !== undefined)
          assertContentTransferSize(Number(declaredLength), options.maxBytes);
        const bytes = await readBoundedContent(c.req.raw.body, options);
        if (
          bytes.byteLength !== ref.byteLength ||
          `sha256:${await contentHash(bytes)}` !== ref.digest
        )
          return c.json({ error: "document_integrity_mismatch" }, 400);
        if (!(await ports.authorize({ projectId, localReplicaId, userId })))
          return c.json({ error: "not_admitted" }, 403);
        if (
          !(await projectContentReferences(ports, projectId)).documents.some(
            (value) => value.digest === digest,
          )
        )
          return c.json({ error: "document_not_in_project" }, 404);
        await store.put(key, bytes, { contentType: ref.contentType });
        return c.body(null, 204);
      }
      if (c.req.method === "HEAD") {
        const head = await store.head(key);
        return head && head.size === ref.byteLength
          ? new Response(null, {
              headers: {
                "Content-Length": String(head.size),
                "Cache-Control": "private, no-store",
              },
            })
          : c.json({ error: "document_not_replicated" }, 404);
      }
      const value = await store.get(key);
      if (!value) return c.json({ error: "document_not_replicated" }, 404);
      assertContentTransferSize(value.size, options.maxBytes);
      const bytes = await readBoundedContent(value.body, options);
      if (bytes.byteLength !== ref.byteLength)
        return c.json({ error: "document_integrity_mismatch" }, 502);
      return new Response(bytes, {
        headers: {
          "Content-Type": ref.contentType,
          "Cache-Control": "private, no-store",
        },
      });
    },
  );
  return routes;
}
