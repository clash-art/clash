import { storeMediaUpload, serveStoredMedia } from "./media-store.ts";
import { stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import {
  GlobalAssetEntrySchema,
  ResourceSchema,
  ResolvedAssetSchema,
} from "@clash/shared-types";
import type { GlobalAssetEntry, Resource } from "@clash/shared-types";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";

type Row = {
  entry: GlobalAssetEntry;
  resource: Resource;
  created_at: Date | string;
};
const fail = (status: 400 | 404 | 409, message: string): never => {
  throw new HTTPException(status, { message });
};
function identity(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    return fail(400, "Invalid asset or operation ID");
  return value;
}

export function createPersonalAssetRoutes(options: {
  db: PostgresTransactionPort;
  directory: string;
  publicUrl: string;
}) {
  const app = new Hono<{ Variables: { userId: string } }>();
  const directory = resolve(options.directory);
  const mediaPath = (resource: Resource) =>
    join(directory, ResourceSchema.parse(resource).digest.value);
  async function project(row: Row) {
    const entry = GlobalAssetEntrySchema.parse(row.entry);
    const resource = ResourceSchema.parse(row.resource);
    const available =
      entry.lifecycle.state === "active" &&
      (await stat(mediaPath(resource))
        .then((info) => info.isFile() && info.size === resource.byteLength)
        .catch(() => false));
    const url = `${options.publicUrl}/api/v1/libraries/personal/assets/${encodeURIComponent(entry.id)}/media`;
    return ResolvedAssetSchema.parse({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      metadata: entry.metadata,
      provenance: entry.provenance,
      lifecycle: entry.lifecycle,
      createdAt: new Date(row.created_at).getTime(),
      status: available ? "ready" : "unavailable",
      ...(available
        ? { url, ...(resource.kind === "image" ? { thumbnailUrl: url } : {}) }
        : {}),
    });
  }
  async function read(owner: string, id: string) {
    const result = await options.db.query<Row>(
      "SELECT entry,resource,created_at FROM personal_asset WHERE owner_id=$1 AND id=$2",
      [owner, id],
    );
    return result.rows[0] ?? fail(404, "Asset not found");
  }
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  // Multipart overhead is bounded too; bytes never enter a database row.
  app.use("/import-file", bodyLimit({ maxSize: 64 * 1024 * 1024 }));
  app.get("/", async (c) => {
    const result = await options.db.query<Row>(
      "SELECT entry,resource,created_at FROM personal_asset WHERE owner_id=$1 ORDER BY created_at DESC,id",
      [c.get("userId")],
    );
    return c.json({ assets: await Promise.all(result.rows.map(project)) });
  });
  app.post("/import-file", async (c) => {
    const form = await c.req.raw
      .formData()
      .catch(() => fail(400, "Invalid multipart upload"));
    const id = identity(form.get("globalAssetId"));
    const uploaded = await storeMediaUpload(directory, form);
    const resource = uploaded.resource;
    const entry = GlobalAssetEntrySchema.parse({
      id,
      kind: resource.kind,
      resourceId: resource.id,
      name: uploaded.name,
      metadata: uploaded.metadata,
      provenance: { kind: "import" },
      lifecycle: { state: "active" },
    });
    const owner = c.get("userId");
    await options.db.query(
      "INSERT INTO personal_asset(owner_id,id,entry,resource) VALUES($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT(owner_id,id) DO NOTHING",
      [owner, id, JSON.stringify(entry), JSON.stringify(resource)],
    );
    const persisted = await read(owner, id);
    if (
      persisted.resource.digest.value !== resource.digest.value ||
      persisted.resource.kind !== resource.kind ||
      persisted.resource.contentType !== resource.contentType
    )
      return fail(409, "Asset ID already identifies different immutable media");
    return c.json(await project(persisted), 201);
  });
  app.get("/:id", async (c) =>
    c.json(await project(await read(c.get("userId"), c.req.param("id")))),
  );
  for (const action of ["trash", "restore"] as const) {
    app.on(
      action === "trash" ? "DELETE" : "POST",
      action === "trash" ? "/:id" : "/:id/restore",
      async (c) => {
        const body = await c.req.json().catch(() => null);
        const operation = identity(body?.deleteOperationId);
        const owner = c.get("userId"),
          id = c.req.param("id");
        const row = await options.db.transaction(async (tx) => {
          const result = await tx.query<Row>(
            "SELECT entry,resource,created_at FROM personal_asset WHERE owner_id=$1 AND id=$2 FOR UPDATE",
            [owner, id],
          );
          const row = result.rows[0] ?? fail(404, "Asset not found");
          const entry = GlobalAssetEntrySchema.parse(row.entry);
          const seen =
            (
              await tx.query(
                "SELECT operation_id FROM personal_asset_deletion WHERE owner_id=$1 AND asset_id=$2 AND operation_id=$3",
                [owner, id, operation],
              )
            ).rows.length > 0;
          if (action === "trash") {
            if (
              entry.lifecycle.state === "trashed" &&
              entry.lifecycle.deleteOperationId === operation
            )
              return row;
            if (entry.lifecycle.state !== "active" || seen)
              return fail(
                409,
                "Deletion conflicts with the current asset state; reload the asset",
              );
            const now = Date.now();
            entry.lifecycle = {
              state: "trashed",
              deleteOperationId: operation,
              deletedAt: new Date(now).toISOString(),
              purgeAfter: new Date(now + 30 * 86400000).toISOString(),
            };
            await tx.query(
              "INSERT INTO personal_asset_deletion(owner_id,asset_id,operation_id) VALUES($1,$2,$3)",
              [owner, id, operation],
            );
          } else {
            if (entry.lifecycle.state === "active" && seen) return row;
            if (
              entry.lifecycle.state !== "trashed" ||
              entry.lifecycle.deleteOperationId !== operation
            )
              return fail(
                409,
                "Restore conflicts with the current deletion; reload the asset",
              );
            entry.lifecycle = { state: "active" };
          }
          await tx.query(
            "UPDATE personal_asset SET entry=$3::jsonb WHERE owner_id=$1 AND id=$2",
            [owner, id, JSON.stringify(entry)],
          );
          return { ...row, entry };
        });
        return c.json(await project(row));
      },
    );
  }
  app.get("/:id/media", async (c) => {
    const row = await read(c.get("userId"), c.req.param("id"));
    if (row.entry.lifecycle.state !== "active")
      return fail(404, "Asset not found");
    return serveStoredMedia(c, directory, row.resource);
  });
  app.onError((error, c) =>
    error instanceof HTTPException
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: "Asset storage unavailable" }, 503),
  );
  return app;
}
