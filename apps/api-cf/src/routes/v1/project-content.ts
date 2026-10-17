import {
  MultipartContentError,
  createUploadService,
  trustedHeaderIdentity,
  type ContentReferenceIndex,
} from "@clash/asset-sdk/upload-service";
import { serverLog } from "../../logger";
import { Hono } from "hono";
import { ProjectResourceDeliveryRequestSchema } from "@clash/shared-types/project-sync-content";
import {
  ContentTransferLimitError,
  PROJECT_CLOUD_CONTENT_PART_BYTES,
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
  projectContentResolverFor,
  type ProjectContentPorts,
} from "../../services/project-content";

const EMPTY_INDEX: ContentReferenceIndex = {
  async document() {
    return undefined;
  },
  async resource() {
    return undefined;
  },
};
const uploadLog = (
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) => (serverLog as any)[level]?.(event, fields);

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
      : error instanceof MultipartContentError
        ? c.json({ error: error.message }, error.status)
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
    const ref = await projectContentResolverFor(ports).resource(
      projectId,
      resourceId,
    );
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
  // Document bodies: the platform-agnostic upload service (issue #130). The
  // identity middleware in app.ts already validated and re-set x-user-id.
  routes.on(["GET", "HEAD", "PUT"], "/:id/document-bodies/:digest", (c) => {
    const ports = portsFor(c.env);
    return createUploadService({
      identity: trustedHeaderIdentity,
      admission: ports,
      index: ports.index ?? EMPTY_INDEX,
      room: {
        ...ports.room,
        ...(ports.room?.references || ports.snapshot
          ? { references: (id: string) => projectContentReferences(ports, id) }
          : {}),
      },
      store: options.store ?? createR2AssetDeliveryStore(c.env.R2_BUCKET),
      maxBytes: options.maxBytes,
      telemetry: { log: uploadLog },
      defer: (work) => {
        try {
          c.executionCtx.waitUntil(work);
        } catch {
          void work.catch(() => {});
        }
      },
    }).documentBody(c.req.raw, c.req.param("id"), c.req.param("digest"));
  });
  return routes;
}
