import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { resolveProjectAsset } from "@clash/asset-sdk";
import {
  createProjectAsset,
  agentReadReceiptToken,
  projectAssetMutationReadTokenFromDoc,
  listActionAssetReferences,
  markProjectAssetAuthority,
  listProjectAssets,
  readProjectAsset,
  ResourceSchema,
  type ProjectAssetEntry,
  type Resource,
} from "@clash/shared-types";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { withProjectDocument } from "./project-document.ts";
import {
  storedMediaPath,
  storeMediaUpload,
  serveStoredMedia,
} from "./media-store.ts";
const fail = (status: 400 | 404 | 409, message: string): never => {
  throw new HTTPException(status, { message });
};
export function createProjectAssetRoutes(options: {
  db: PostgresTransactionPort;
  directory: string;
  publicUrl: string;
  receiptSecret: string;
}) {
  const app = new Hono<{ Variables: { userId: string } }>();
  const directory = resolve(options.directory);
  const readResource = async (projectId: string, resourceId: string) => {
    const result = await options.db.query<{ resource: Resource }>(
      "SELECT resource FROM project_resource WHERE project_id=$1 AND resource_id=$2",
      [projectId, resourceId],
    );
    return result.rows[0]
      ? ResourceSchema.parse(result.rows[0].resource)
      : null;
  };
  const project = async (projectId: string, entry: ProjectAssetEntry) =>
    resolveProjectAsset(
      {
        registry: {
          async resolve() {
            const resource = await readResource(
              projectId,
              entry.source.resourceId,
            );
            if (
              !resource ||
              !(await stat(storedMediaPath(directory, resource))
                .then(
                  (info) => info.isFile() && info.size === resource.byteLength,
                )
                .catch(() => false))
            )
              return {
                status: "unavailable",
                error: "Media is not available on this server.",
              };
            return { status: "ready", resource };
          },
        },
        projection: {
          async resolve() {
            const url = `${options.publicUrl}/api/v1/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(entry.id)}/media`;
            return {
              status: "ready",
              url,
              ...(entry.kind === "image" ? { thumbnailUrl: url } : {}),
            };
          },
        },
      },
      { projectId, entry },
    );
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
      (doc) => listProjectAssets(doc, { projectId: id }),
    );
    return c.json({
      assets: await Promise.all(entries.map((entry) => project(id, entry))),
    });
  });
  app.post("/:projectId/assets/batch", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !Array.isArray(body?.ids) ||
      body.ids.length > 1000 ||
      body.ids.some((id: unknown) => typeof id !== "string" || !id.trim())
    )
      return fail(400, "Invalid asset IDs");
    const ids = new Set<string>(body.ids),
      id = c.req.param("projectId");
    const entries = await withProjectDocument(
      options.db,
      c.get("userId"),
      id,
      false,
      (doc) =>
        listProjectAssets(doc, { projectId: id }).filter((entry) =>
          ids.has(entry.id),
        ),
    );
    return c.json({
      assets: await Promise.all(entries.map((entry) => project(id, entry))),
    });
  });
  app.post("/:projectId/assets/import-file", async (c) => {
    const id = c.req.param("projectId");
    const form = await c.req.raw
      .formData()
      .catch(() => fail(400, "Invalid multipart upload"));
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
        const existing = readProjectAsset(doc, assetId, { projectId: id });
        if (existing) {
          const result = await tx.query<{ resource: Resource }>(
            "SELECT resource FROM project_resource WHERE project_id=$1 AND resource_id=$2",
            [id, existing.source.resourceId],
          );
          const stored = result.rows[0]?.resource;
          if (
            !stored ||
            stored.digest.value !== uploaded.resource.digest.value ||
            stored.kind !== uploaded.resource.kind ||
            stored.contentType !== uploaded.resource.contentType
          )
            return fail(
              409,
              "Asset ID already identifies different immutable media",
            );
          return existing;
        }
        const created = createProjectAsset(doc, {
          id: assetId,
          kind: uploaded.resource.kind,
          source: { kind: "owned", resourceId: uploaded.resource.id },
          createdAt: Date.now(),
          name: uploaded.name,
          metadata: uploaded.metadata,
          provenance: { kind: "import" },
          lifecycle: { state: "active" },
        });
        if (!created.ok) return fail(409, created.error.message);
        const marked = markProjectAssetAuthority(doc);
        if (!marked.ok) return fail(409, marked.error.message);
        await tx.query(
          "INSERT INTO project_resource(project_id,resource_id,resource) VALUES($1,$2,$3::jsonb)",
          [id, uploaded.resource.id, JSON.stringify(uploaded.resource)],
        );
        return created.entry;
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
          (doc) => {
            const entry = readProjectAsset(doc, assetId, { projectId: id });
            if (!entry) return fail(404, "Asset not found");
            return {
              entry,
              references: listActionAssetReferences(doc, assetId),
              version: projectAssetMutationReadTokenFromDoc(doc, id, assetId),
            };
          },
        );
        if (!observed.version) return fail(404, "Asset not found");
        const receipt = createHmac("sha256", options.receiptSecret)
          .update(
            JSON.stringify(["project-asset", owner, id, observed.version]),
          )
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
