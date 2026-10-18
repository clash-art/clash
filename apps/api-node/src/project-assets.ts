import { createHmac, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { Hono } from "hono";
import type { LoroDoc } from "loro-crdt";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import {
  agentReadReceiptToken,
  readProjectAsset,
  ResourceSchema,
  type ProjectAssetEntry,
  type Resource,
} from "@clash/shared-types";
import {
  INVALID_PROJECT_ASSET_TRASH,
  PROJECT_ASSET_PURGE_DELAY_MS,
  applyProjectAssetLifecycle,
  commitProjectAssetImport,
  parseProjectAssetDeleteOperationId,
  type ProjectAssetLifecycleCommand,
  type ProjectAssetLifecycleResult,
  observeProjectAsset,
  parseProjectAssetBatchIds,
  projectAssetReceiptMessage,
  projectProjectAsset,
  selectProjectAssets,
  type ProjectAssetImportCommand,
  type ProjectAssetImportResult,
} from "@clash/shared-runtime/cloud-project-host/project-assets";
import {
  createHmacProjectAssetImportSessionTokens,
  createProjectAssetImportSession,
  finalizeProjectAssetImportSession,
  handleProjectAssetImportSessionContent,
  PROJECT_ASSET_IMPORT_STAGING_CLEANUP_FAILED,
  type ProjectAssetImportSessionPorts,
} from "@clash/shared-runtime/cloud-project-host/project-asset-import-sessions";
import { createFsAssetDeliveryStore } from "@clash/shared-runtime/fs-asset-delivery-store";
import { apiNodeLog } from "./log.ts";
import {
  PROJECT_ASSET_IMPORT_MAX_BYTES,
  sanitizeAssetImportMetadataHints,
  type AssetImportMetadataHints,
} from "@clash/asset-sdk";
import type { PostgresQueryPort } from "@clash/shared-runtime/project-authorization-postgres";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { withProjectDocument } from "./project-document.ts";
import {
  storedMediaPath,
  readMediaUploadForm,
  storeMediaBytes,
  storeMediaUpload,
  serveStoredMedia,
} from "./media-store.ts";
const fail = (status: 400 | 404 | 409, message: string): never => {
  throw new HTTPException(status, { message });
};
const RESOURCE_QUERY =
  "SELECT resource FROM project_resource WHERE project_id=$1 AND resource_id=$2";
const importStagingLog = apiNodeLog.child("project-asset-import-staging");

/** The Resource admitted to this Project under `resourceId`, or null. */
export async function readProjectResource(
  db: PostgresQueryPort,
  projectId: string,
  resourceId: string,
): Promise<Resource | null> {
  const result = await db.query<{ resource: Resource }>(RESOURCE_QUERY, [
    projectId,
    resourceId,
  ]);
  return result.rows[0] ? ResourceSchema.parse(result.rows[0].resource) : null;
}

/**
 * Publish stored bytes as a Project Asset inside the caller's Project
 * transaction: the shared import commit on `doc` plus the Resource row, so
 * both land with the same log append or not at all.
 */
export async function admitProjectMedia(
  doc: LoroDoc,
  tx: PostgresQueryPort,
  command: ProjectAssetImportCommand,
): Promise<ProjectAssetImportResult> {
  const { projectId, resource } = command;
  const imported = await commitProjectAssetImport(doc, command, {
    readResource: (resourceId) => readProjectResource(tx, projectId, resourceId),
  });
  if (imported.ok && imported.created)
    await tx.query(
      "INSERT INTO project_resource(project_id,resource_id,resource) VALUES($1,$2,$3::jsonb)",
      [projectId, resource.id, JSON.stringify(resource)],
    );
  return imported;
}

/** Postgres + disk storage ports for the shared Project Asset logic. */
export function createProjectAssetRoutes(options: {
  db: PostgresTransactionPort;
  directory: string;
  publicUrl: string;
  receiptSecret: string;
}) {
  const app = new Hono<{ Variables: { userId: string } }>();
  const directory = resolve(options.directory);
  const readResource = (projectId: string, resourceId: string) =>
    readProjectResource(options.db, projectId, resourceId);
  const projection = {
    readResource: (projectId: string, resourceId: string) =>
      readResource(projectId, resourceId),
    available: (_projectId: string, resource: Resource) =>
      stat(storedMediaPath(directory, resource))
        .then((info) => info.isFile() && info.size === resource.byteLength)
        .catch(() => false),
    mediaUrl: ({
      projectId,
      entry,
    }: {
      projectId: string;
      entry: ProjectAssetEntry;
    }) =>
      `${options.publicUrl}/api/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(entry.id)}/media`,
  };
  const project = (projectId: string, entry: ProjectAssetEntry) =>
    projectProjectAsset(projection, { projectId, entry });

  /** The one import commit path: single-shot and session finalize both use it. */
  const commitImportedMedia = async (input: {
    owner: string;
    projectId: string;
    projectAssetId: string;
    uploaded: Awaited<ReturnType<typeof storeMediaBytes>>;
    duplicateContent?: "allow" | "reject";
    metadataHints?: AssetImportMetadataHints;
  }) => {
    const { owner, projectId: id, projectAssetId, uploaded } = input;
    const metadata = {
      ...uploaded.metadata,
      ...sanitizeAssetImportMetadataHints(input.metadataHints),
    };
    const entry = await withProjectDocument(
      options.db,
      owner,
      id,
      true,
      async (doc, tx) => {
        const imported = await admitProjectMedia(doc, tx, {
          projectId: id,
          projectAssetId,
          resource: uploaded.resource,
          name: uploaded.name,
          metadata,
          createdAt: Date.now(),
          ...(input.duplicateContent
            ? { duplicateContent: input.duplicateContent }
            : {}),
        });
        // A failure throws, rolling back the transaction and any doc edit.
        if (!imported.ok) return fail(409, String(imported.body.error));
        return imported.entry;
      },
    );
    return project(id, entry);
  };

  const importStaging = createFsAssetDeliveryStore(
    join(directory, "import-sessions"),
  );
  const importSessionPorts = (
    projectId: string,
  ): ProjectAssetImportSessionPorts => ({
    clock: { now: () => Date.now() },
    newId: randomUUID,
    tokens: createHmacProjectAssetImportSessionTokens({
      secret: options.receiptSecret,
      now: () => Date.now(),
    }),
    access: {
      async canAccessProject({ projectId: id, ownerId }) {
        const owned = await options.db.query(
          "SELECT id FROM project WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",
          [id, ownerId],
        );
        return owned.rows.length > 0;
      },
    },
    staging: {
      store: importStaging,
      delete: (locator) => importStaging.delete(locator),
      onCleanupFailure(locator, error) {
        importStagingLog.error("project_asset_import_staging.cleanup_failed", {
          code: PROJECT_ASSET_IMPORT_STAGING_CLEANUP_FAILED,
          locator,
          error,
        });
      },
    },
    uploadUrl: (sessionId) =>
      `${options.publicUrl.replace(/\/+$/u, "")}/api/v1/projects/${encodeURIComponent(projectId)}/assets/import-sessions/${encodeURIComponent(sessionId)}/content`,
    async commit(input) {
      const bytes = new Uint8Array(
        await new Response(await input.openSource()).arrayBuffer(),
      );
      const uploaded = await storeMediaBytes(directory, {
        kind: input.kind,
        name: input.fileName,
        type: input.contentType ?? "",
        bytes,
      });
      return commitImportedMedia({
        owner: input.ownerId,
        projectId: input.projectId,
        projectAssetId: input.projectAssetId,
        uploaded,
        ...(input.duplicateContent
          ? { duplicateContent: input.duplicateContent }
          : {}),
        ...(input.metadataHints
          ? { metadataHints: input.metadataHints }
          : {}),
      });
    },
    async resolveCommitted({ projectId: id, ownerId, projectAssetId }) {
      const entry = await withProjectDocument(
        options.db,
        ownerId,
        id,
        false,
        (doc) => readProjectAsset(doc, projectAssetId, { projectId: id }),
      );
      return entry ? project(id, entry) : null;
    },
  });
  app.use("/:projectId/assets/*", async (c, next) => {
    const owned = await options.db.query(
      "SELECT id FROM project WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",
      [c.req.param("projectId"), c.get("userId")],
    );
    if (!owned.rows.length) return fail(404, "Project not found");
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  app.use(
    "/:projectId/assets/import-file",
    // A single request may carry any supported size here (no Worker body
    // limit). Chunked sessions remain available for clients that opt in.
    bodyLimit({ maxSize: PROJECT_ASSET_IMPORT_MAX_BYTES }),
  );
  app.get("/:projectId/assets", async (c) => {
    const id = c.req.param("projectId");
    const entries = await withProjectDocument(
      options.db,
      c.get("userId"),
      id,
      false,
      (doc) => selectProjectAssets(doc, id),
    );
    return c.json({
      assets: await Promise.all(entries.map((entry) => project(id, entry))),
    });
  });
  app.post("/:projectId/assets/batch", async (c) => {
    const ids = parseProjectAssetBatchIds(
      await c.req.json().catch(() => null),
    );
    if (!ids) return fail(400, "Invalid asset IDs");
    const id = c.req.param("projectId");
    const entries = await withProjectDocument(
      options.db,
      c.get("userId"),
      id,
      false,
      (doc) => selectProjectAssets(doc, id, ids),
    );
    return c.json({
      assets: await Promise.all(entries.map((entry) => project(id, entry))),
    });
  });
  app.post("/:projectId/assets/import-file", async (c) => {
    const id = c.req.param("projectId");
    const form = await readMediaUploadForm(c.req.raw);
    const assetId = form.get("projectAssetId");
    if (typeof assetId !== "string" || !assetId.trim() || assetId.length > 512)
      return fail(400, "Invalid Asset ID");
    const uploaded = await storeMediaUpload(directory, form);
    return c.json(
      await commitImportedMedia({
        owner: c.get("userId"),
        projectId: id,
        projectAssetId: assetId,
        uploaded,
      }),
      201,
    );
  });
  for (const references of [false, true])
    app.get(
      `/:projectId/assets/:assetId${references ? "/references" : ""}`,
      async (c) => {
        const id = c.req.param("projectId"),
          assetId = c.req.param("assetId"),
          owner = c.get("userId");
        const observed = await withProjectDocument(
          options.db,
          owner,
          id,
          false,
          (doc) => observeProjectAsset(doc, id, assetId),
        );
        if (!observed) return fail(404, "Asset not found");
        const receipt = createHmac("sha256", options.receiptSecret)
          .update(projectAssetReceiptMessage(owner, id, observed.version))
          .digest("base64url");
        c.header(
          "x-clash-read-receipt",
          agentReadReceiptToken({ readToken: observed.version, receipt }),
        );
        return c.json(
          references
            ? { projectAssetId: assetId, references: observed.references }
            : await project(id, observed.entry),
        );
      },
    );
  // Trash and restore are soft deletes of the Project document (shared
  // lifecycle logic); stored media and Resource rows are untouched.
  const receiptFor = (owner: string, id: string, version: string) =>
    createHmac("sha256", options.receiptSecret)
      .update(projectAssetReceiptMessage(owner, id, version))
      .digest("base64url");
  const writeObservation = (header: (name: string) => string | undefined) => {
    const actorClientType = header("x-clash-client-type")?.trim();
    const expectedReadToken = header("x-clash-if-match")?.trim();
    return {
      ...(actorClientType ? { actorClientType } : {}),
      ...(expectedReadToken ? { expectedReadToken } : {}),
    };
  };
  const lifecycle = async (
    c: any,
    command: ProjectAssetLifecycleCommand,
  ): Promise<Response> => {
    const owner = c.get("userId") as string;
    const id = command.projectId;
    type Outcome =
      | Extract<ProjectAssetLifecycleResult, { ok: false }>
      | (Extract<ProjectAssetLifecycleResult, { ok: true }> & {
          version: string | undefined;
        });
    const outcome = await withProjectDocument<Outcome>(
      options.db,
      owner,
      id,
      (result) => result.ok && result.mutated,
      (doc): Outcome => {
        const result = applyProjectAssetLifecycle(doc, command, {
          verifyReceipt: (version, receipt) =>
            receipt === receiptFor(owner, id, version),
        });
        if (!result.ok) return result;
        const observed = observeProjectAsset(doc, id, command.projectAssetId);
        return { ...result, version: observed?.version };
      },
    );
    if (!outcome.ok) return c.json(outcome.body, outcome.status);
    if (outcome.version)
      c.header(
        "x-clash-read-receipt",
        agentReadReceiptToken({
          readToken: outcome.version,
          receipt: receiptFor(owner, id, outcome.version),
        }),
      );
    return c.json(await project(id, outcome.entry));
  };
  app.delete("/:projectId/assets/:assetId", async (c) => {
    const deleteOperationId = parseProjectAssetDeleteOperationId(
      await c.req.json().catch(() => null),
    );
    if (!deleteOperationId)
      return c.json(
        INVALID_PROJECT_ASSET_TRASH.body,
        INVALID_PROJECT_ASSET_TRASH.status,
      );
    const now = Date.now();
    return lifecycle(c, {
      action: "trash",
      projectId: c.req.param("projectId"),
      projectAssetId: c.req.param("assetId"),
      deleteOperationId,
      deletedAt: new Date(now).toISOString(),
      purgeAfter: new Date(now + PROJECT_ASSET_PURGE_DELAY_MS).toISOString(),
      observation: writeObservation((name) => c.req.header(name)),
    });
  });
  app.post("/:projectId/assets/:assetId/restore", (c) =>
    lifecycle(c, {
      action: "restore",
      projectId: c.req.param("projectId"),
      projectAssetId: c.req.param("assetId"),
      observation: writeObservation((name) => c.req.header(name)),
    }),
  );
  // Chunked import: the same Asset SDK protocol the Cloudflare adapter serves,
  // over the shared filesystem staging store and the single-shot commit above.
  app.post("/:projectId/assets/import-sessions", async (c) => {
    const result = await createProjectAssetImportSession(
      {
        projectId: c.req.param("projectId"),
        ownerId: c.get("userId"),
        body: await c.req.json().catch(() => null),
      },
      importSessionPorts(c.req.param("projectId")),
    );
    return c.json(result.body, result.status);
  });
  app.post(
    "/:projectId/assets/import-sessions/:sessionId/finalize",
    async (c) => {
      const result = await finalizeProjectAssetImportSession(
        {
          projectId: c.req.param("projectId"),
          sessionId: c.req.param("sessionId"),
          ownerId: c.get("userId"),
        },
        importSessionPorts(c.req.param("projectId")),
      );
      return c.json(result.body, result.status);
    },
  );
  app.put(
    "/:projectId/assets/import-sessions/:sessionId/content",
    async (c) =>
      handleProjectAssetImportSessionContent(
        c.req.raw,
        {
          projectId: c.req.param("projectId"),
          sessionId: c.req.param("sessionId"),
          ownerId: c.get("userId"),
        },
        importSessionPorts(c.req.param("projectId")),
      ),
  );
  app.get("/:projectId/assets/:assetId/media", async (c) => {
    const id = c.req.param("projectId");
    const entry = await withProjectDocument(
      options.db,
      c.get("userId"),
      id,
      false,
      (doc) => readProjectAsset(doc, c.req.param("assetId"), { projectId: id }),
    );
    if (!entry || entry.lifecycle.state !== "active")
      return fail(404, "Asset not found");
    const resource = await readResource(id, entry.source.resourceId);
    if (!resource) return fail(404, "Media unavailable");
    return serveStoredMedia(c, directory, resource);
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException)
      return c.json({ error: error.message }, error.status);
    if (error.message === "Project not found")
      return c.json({ error: error.message }, 404);
    return c.json({ error: "Project asset storage unavailable" }, 503);
  });
  return app;
}
