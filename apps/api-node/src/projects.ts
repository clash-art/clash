import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  createPostgresCloudProjectAdmissionStore,
  type PostgresTransactionPort,
} from "@clash/shared-runtime/project-cloud-admission-postgres";

const columns =
  'id,name,description,owner_id AS "ownerId",created_at AS "createdAt",updated_at AS "updatedAt",deleted_at AS "deletedAt"';
export function createProjectRoutes(
  db: PostgresTransactionPort,
  publicUrl: string,
) {
  const app = new Hono<{ Variables: { userId: string } }>();
  const admissions = createPostgresCloudProjectAdmissionStore(db);
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      typeof body?.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 512 ||
      (body.description !== undefined &&
        (typeof body.description !== "string" ||
          body.description.length > 10000))
    )
      return c.json(
        { error: "A project name is required (maximum 512 characters)" },
        400,
      );
    const id = randomUUID(),
      now = new Date().toISOString();
    await admissions.admit({
      userId: c.get("userId"),
      syncBaseUrl: publicUrl,
      request: {
        schemaVersion: 1,
        projectId: id,
        localReplicaId: `web:${id}`,
        resourceIds: [],
        metadata: {
          projectId: id,
          name: body.name.trim(),
          description: body.description?.trim() ?? null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      },
    });
    return c.json(
      {
        id,
        name: body.name.trim(),
        description: body.description?.trim() ?? null,
      },
      201,
    );
  });
  app.get("/:id", async (c) => {
    const result = await db.query(
      `SELECT ${columns} FROM project WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL`,
      [c.req.param("id"), c.get("userId")],
    );
    return result.rows[0]
      ? c.json({ ...result.rows[0], syncTransport: "streams" })
      : c.json({ error: "Project not found" }, 404);
  });
  app.patch("/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      typeof body?.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 512
    )
      return c.json(
        { error: "A project name is required (maximum 512 characters)" },
        400,
      );
    const result = await db.query(
      "UPDATE project SET name=$3,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL RETURNING id,name",
      [c.req.param("id"), c.get("userId"), body.name.trim()],
    );
    return result.rows[0]
      ? c.json({ ok: true, ...result.rows[0] })
      : c.json({ error: "Project not found" }, 404);
  });
  app.delete("/:id", async (c) => {
    const result = await db.query(
      "UPDATE project SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL RETURNING id",
      [c.req.param("id"), c.get("userId")],
    );
    return result.rows[0]
      ? c.json({ archived: true, recoverable: true, ...result.rows[0] })
      : c.json({ error: "Project not found" }, 404);
  });
  app.post("/:id/restore", async (c) => {
    const result = await db.query(
      "UPDATE project SET deleted_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_id=$2 AND deleted_at IS NOT NULL RETURNING id",
      [c.req.param("id"), c.get("userId")],
    );
    return result.rows[0]
      ? c.json({ restored: true, ...result.rows[0] })
      : c.json({ error: "Archived project not found" }, 404);
  });
  return app;
}
