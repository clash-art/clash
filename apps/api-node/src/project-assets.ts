import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { Hono } from "hono";
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
  commitProjectAssetImport,
  observeProjectAsset,
  parseProjectAssetBatchIds,
  projectAssetReceiptMessage,
  projectProjectAsset,
  selectProjectAssets,
  projectAssetOperationUnavailable,
} from "@clash/shared-runtime/cloud-project-host/project-assets";
import type { PostgresQueryPort } from "@clash/shared-runtime/project-authorization-postgres";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { withProjectDocument } from "./project-document.ts";
import {
  storedMediaPath,
  readMediaUploadForm,
  storeMediaUpload,
  serveStoredMedia,
} from "./media-store.ts";
const fail = (status: 400 | 404 | 409, message: string): never => {
  throw new HTTPException(status, { message });
};
const RESOURCE_QUERY =
  "SELECT resource FROM project_resource WHERE project_id=$1 AND resource_id=$2";

/** Postgres + disk storage ports for the shared Project Asset logic. */
export function createProjectAssetRoutes(options: {
  db: PostgresTransactionPort;
  directory: string;
  publicUrl: string;
  receiptSecret: string;
}) {
  const app = new Hono<{ Variables: { userId: string } }>();
  const directory = resolve(options.directory);
  const readResource = async (
    projectId: string,
    resourceId: string,
    db: PostgresQueryPort = options.db,
  ) => {
    const result = await db.query<{ resource: Resource }>(RESOURCE_QUERY, [
      projectId,
      resourceId,
    ]);
    return result.rows[0]
      ? ResourceSchema.parse(result.rows[0].resource)
      : null;
  };
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
    bodyLimit({ maxSize: 64 * 1024 * 1024 }),
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
    const entry = await withProjectDocument(
      options.db,
      c.get("userId"),
      id,
      true,
      async (doc, tx) => {
        const imported = await commitProjectAssetImport(
          doc,
          {
            projectId: id,
            projectAssetId: assetId,
            resource: uploaded.resource,
            name: uploaded.name,
            metadata: uploaded.metadata,
            createdAt: Date.now(),
          },
          { readResource: (resourceId) => readResource(id, resourceId, tx) },
        );
        // A failure throws, rolling back the transaction and any doc edit.
        if (!imported.ok) return fail(409, String(imported.body.error));
        if (imported.created)
          await tx.query(
            "INSERT INTO project_resource(project_id,resource_id,resource) VALUES($1,$2,$3::jsonb)",
            [id, uploaded.resource.id, JSON.stringify(uploaded.resource)],
          );
        return imported.entry;
      },
    );
    return c.json(await project(id, entry), 201);
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
  // Trash and restore have no Postgres/disk port yet: say so (501), never 404.
  app.delete("/:projectId/assets/:assetId", (c) => {
    const { status, body } = projectAssetOperationUnavailable("trash");
    return c.json(body, status);
  });
  app.post("/:projectId/assets/:assetId/restore", (c) => {
    const { status, body } = projectAssetOperationUnavailable("restore");
    return c.json(body, status);
  });
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
