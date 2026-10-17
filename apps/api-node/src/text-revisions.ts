/**
 * Node adapter of the shared text-revisions module: Postgres rows
 * (`text_revisions`, migration 0014) and Markdown bodies on disk under
 * `<directory>/<projectId>/<contentHash>.md`. All semantics live in
 * `@clash/shared-runtime/cloud-project-host/text-revisions`.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  TextAppliedRevisionSchema,
  type TextAppliedRevision,
} from "@clash/shared-types";
import {
  indexTextRevision,
  listTextRevisionHistory,
  readTextRevisionContent,
  textRevisionContentHeaders,
  type TextRevisionPorts,
} from "@clash/shared-runtime/cloud-project-host/text-revisions";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";

// Project ids are server-issued; anything else never names a directory.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function createTextRevisionRoutes(options: {
  db: PostgresTransactionPort;
  directory: string;
}) {
  const app = new Hono<{ Variables: { userId: string } }>();
  const root = resolve(options.directory);
  const blobPath = (projectId: string, hash: string) => {
    if (!SAFE_ID.test(projectId)) throw new Error("Unsafe project id");
    return join(root, projectId, `${hash}.md`);
  };
  const ports = (userId: string): TextRevisionPorts => ({
    async canAccessProject(projectId) {
      if (!SAFE_ID.test(projectId)) return false;
      const owned = await options.db.query(
        "SELECT id FROM project WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",
        [projectId, userId],
      );
      return owned.rows.length > 0;
    },
    store: {
      async get(projectId, revisionId) {
        const result = await options.db.query(
          "SELECT revision FROM text_revisions WHERE project_id=$1 AND revision_id=$2",
          [projectId, revisionId],
        );
        const row = result.rows[0] as { revision: unknown } | undefined;
        return row ? TextAppliedRevisionSchema.parse(row.revision) : null;
      },
      async put(revision: TextAppliedRevision) {
        await options.db.query(
          `INSERT INTO text_revisions (project_id,revision_id,node_id,created_at,revision)
           VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (project_id,revision_id) DO NOTHING`,
          [
            revision.projectId,
            revision.revisionId,
            revision.nodeId,
            revision.createdAt,
            JSON.stringify(revision),
          ],
        );
      },
      async list({ projectId, nodeId, limit }) {
        const result = await options.db.query(
          `SELECT revision FROM text_revisions
            WHERE project_id=$1 AND ($2::text IS NULL OR node_id=$2)
            ORDER BY created_at DESC, revision_id DESC LIMIT $3`,
          [projectId, nodeId ?? null, limit],
        );
        return (result.rows as Array<{ revision: unknown }>).map((row) =>
          TextAppliedRevisionSchema.parse(row.revision),
        );
      },
    },
    blobs: {
      read: (projectId, hash) =>
        readFile(blobPath(projectId, hash), "utf8").catch(() => null),
      has: (projectId, hash) =>
        stat(blobPath(projectId, hash))
          .then((info) => info.isFile())
          .catch(() => false),
      async write(projectId, hash, content) {
        const target = blobPath(projectId, hash);
        await mkdir(join(root, projectId), { recursive: true });
        // Write-then-rename: a crash never leaves a truncated final body.
        const temporary = `${target}.${randomUUID()}.tmp`;
        await writeFile(temporary, content, "utf8");
        await rename(temporary, target);
      },
    },
  });

  app.post("/api/v1/text-revisions", async (c) => {
    const body = await c.req.json().catch(() => null);
    const result = await indexTextRevision(body, ports(c.get("userId")));
    return c.json(result.body, result.status);
  });
  app.get("/api/v1/projects/:projectId/text-revisions", async (c) => {
    const limit = Number(c.req.query("limit"));
    const result = await listTextRevisionHistory(
      {
        projectId: c.req.param("projectId"),
        nodeId: c.req.query("nodeId"),
        limit: Number.isFinite(limit) ? limit : undefined,
      },
      ports(c.get("userId")),
    );
    c.header("Cache-Control", "private, no-store");
    return c.json(result.body, result.status);
  });
  app.get(
    "/api/v1/projects/:projectId/text-revisions/:revisionId/content",
    async (c) => {
      const result = await readTextRevisionContent(
        {
          projectId: c.req.param("projectId"),
          revisionId: c.req.param("revisionId"),
        },
        ports(c.get("userId")),
      );
      if (result.status !== 200) return c.json(result.body, result.status);
      return new Response(result.content, {
        headers: textRevisionContentHeaders(result.contentHash),
      });
    },
  );
  return app;
}
