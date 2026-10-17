/**
 * Cloudflare adapter of the shared text-revisions module: D1 rows
 * (`text_revisions`, apps/web/drizzle/0029) and Markdown bodies in R2 under
 * `text-revisions/<projectId>/<contentHash>.md`. All semantics live in
 * `@clash/shared-runtime/cloud-project-host/text-revisions`.
 */
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
import type { Env } from "../../config";
import { createD1ProjectAuthorizationStore } from "../../loro/auth";

const blobKey = (projectId: string, hash: string) =>
  `text-revisions/${encodeURIComponent(projectId)}/${hash}.md`;

const parseRow = (row: { revision_json: string } | null) =>
  row ? TextAppliedRevisionSchema.parse(JSON.parse(row.revision_json)) : null;

function d1Ports(env: Env, userId: string): TextRevisionPorts {
  return {
    async canAccessProject(projectId) {
      const project =
        await createD1ProjectAuthorizationStore(env).readProject(projectId);
      return !!project && project.ownerId === userId && project.deletedAt === null;
    },
    store: {
      get: async (projectId, revisionId) =>
        parseRow(
          await env.DB.prepare(
            "SELECT revision_json FROM text_revisions WHERE project_id = ? AND revision_id = ?",
          )
            .bind(projectId, revisionId)
            .first<{ revision_json: string }>(),
        ),
      async put(revision: TextAppliedRevision) {
        await env.DB.prepare(
          `INSERT INTO text_revisions (project_id, revision_id, node_id, created_at, revision_json)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (project_id, revision_id) DO NOTHING`,
        )
          .bind(
            revision.projectId,
            revision.revisionId,
            revision.nodeId,
            revision.createdAt,
            JSON.stringify(revision),
          )
          .run();
      },
      async list({ projectId, nodeId, limit }) {
        const statement = nodeId
          ? env.DB.prepare(
              `SELECT revision_json FROM text_revisions WHERE project_id = ? AND node_id = ?
               ORDER BY created_at DESC, revision_id DESC LIMIT ?`,
            ).bind(projectId, nodeId, limit)
          : env.DB.prepare(
              `SELECT revision_json FROM text_revisions WHERE project_id = ?
               ORDER BY created_at DESC, revision_id DESC LIMIT ?`,
            ).bind(projectId, limit);
        const { results } = await statement.all<{ revision_json: string }>();
        return results.map((row) => parseRow(row)!);
      },
    },
    blobs: {
      async read(projectId, hash) {
        const object = await env.R2_BUCKET.get(blobKey(projectId, hash));
        return object ? object.text() : null;
      },
      has: async (projectId, hash) =>
        (await env.R2_BUCKET.head(blobKey(projectId, hash))) !== null,
      async write(projectId, hash, content) {
        // R2 puts are atomic: a reader sees the whole body or none.
        await env.R2_BUCKET.put(blobKey(projectId, hash), content, {
          httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        });
      },
    },
  };
}

export function createTextRevisionRoutes() {
  const app = new Hono<{ Bindings: Env }>();
  const user = (c: any) => c.req.header("x-user-id")?.trim() as string | undefined;
  app.post("/text-revisions", async (c) => {
    const userId = user(c);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const result = await indexTextRevision(body, d1Ports(c.env, userId));
    return c.json(result.body, result.status);
  });
  app.get("/projects/:projectId/text-revisions", async (c) => {
    const userId = user(c);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const limit = Number(c.req.query("limit"));
    const result = await listTextRevisionHistory(
      {
        projectId: c.req.param("projectId"),
        nodeId: c.req.query("nodeId"),
        limit: Number.isFinite(limit) ? limit : undefined,
      },
      d1Ports(c.env, userId),
    );
    c.header("Cache-Control", "private, no-store");
    return c.json(result.body, result.status);
  });
  app.get("/projects/:projectId/text-revisions/:revisionId/content", async (c) => {
    const userId = user(c);
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const result = await readTextRevisionContent(
      {
        projectId: c.req.param("projectId"),
        revisionId: c.req.param("revisionId"),
      },
      d1Ports(c.env, userId),
    );
    if (result.status !== 200) return c.json(result.body, result.status);
    return new Response(result.content, {
      headers: textRevisionContentHeaders(result.contentHash),
    });
  });
  return app;
}
