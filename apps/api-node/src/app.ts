import { createProjectAssetRoutes } from "./project-assets.ts";
import {
  createTimelineHostRoutes,
  type TimelineHostOptions,
} from "./timeline-host.ts";
import { createProjectRoutes } from "./projects.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createPersonalAssetRoutes } from "./personal-assets.ts";
import type { NodeAuth } from "./auth.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ProjectCloudAdmissionRequestSchema } from "@clash/shared-types";
import { authenticateApiToken } from "@clash/shared-runtime/project-authorization";
import { createPostgresProjectAuthorizationStore } from "@clash/shared-runtime/project-authorization-postgres";
import {
  createPostgresCloudProjectAdmissionStore,
  type PostgresTransactionPort,
} from "@clash/shared-runtime/project-cloud-admission-postgres";

export function createNodeCloudApp(options: {
  db: PostgresTransactionPort;
  syncBaseUrl: string;
  auth?: NodeAuth;
  assetDirectory?: string;
  timeline?: TimelineHostOptions;
}) {
  const app = new Hono<{ Variables: { userId: string } }>();
  const authority = createPostgresProjectAuthorizationStore(options.db);
  const admissions = createPostgresCloudProjectAdmissionStore(options.db);
  const syncBaseUrl = new URL(options.syncBaseUrl).href.replace(/\/+$/u, "");
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) => {
    try {
      await options.db.query("SELECT id FROM api_token LIMIT 0");
      await options.db.query(
        "SELECT project_id FROM project_cloud_admission LIMIT 0",
      );
      return c.json({ status: "ok" });
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
  });
  app.get("/api/better-auth/options", (c) =>
    c.json({ password: !!options.auth, emailOtp: false, google: false }),
  );
  if (options.auth) {
    const auth = options.auth;
    app.use("/api/better-auth/*", bodyLimit({ maxSize: 65536 }));
    app.all("/api/better-auth/*", (c) => auth.handler(c.req.raw));
    app.use("/api/settings/*", async (c, next) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return c.json({ error: "Unauthorized" }, 401);
      if (
        !["GET", "HEAD"].includes(c.req.method) &&
        c.req.header("origin") !== new URL(syncBaseUrl).origin
      )
        return c.json({ error: "Forbidden origin" }, 403);
      c.set("userId", session.user.id);
      return next();
    });
    app.use("/api/settings/*", bodyLimit({ maxSize: 65536 }));
    app.get("/api/settings/tokens", async (c) => {
      const result = await options.db.query(
        'SELECT id,name,token_prefix AS "tokenPrefix",last_used_at AS "lastUsedAt",created_at AS "createdAt" FROM api_token WHERE user_id=$1 ORDER BY created_at,id',
        [c.get("userId")],
      );
      return c.json(result.rows);
    });
    app.post("/api/settings/tokens", async (c) => {
      const body = await c.req.json().catch(() => null);
      if (
        typeof body?.name !== "string" ||
        !body.name.trim() ||
        body.name.length > 128
      )
        return c.json(
          { error: "A token name is required (maximum 128 characters)" },
          400,
        );
      const token = "clsh_" + randomBytes(20).toString("hex");
      const result = await options.db.query(
        'INSERT INTO api_token(id,user_id,name,token_hash,token_prefix) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,token_prefix AS "tokenPrefix",last_used_at AS "lastUsedAt",created_at AS "createdAt"',
        [
          randomUUID(),
          c.get("userId"),
          body.name.trim(),
          createHash("sha256").update(token).digest("hex"),
          token.slice(0, 13),
        ],
      );
      c.header("Cache-Control", "no-store");
      return c.json({ token, info: result.rows[0] }, 201);
    });
    app.delete("/api/settings/tokens/:id", async (c) => {
      const result = await options.db.query(
        "DELETE FROM api_token WHERE id=$1 AND user_id=$2 RETURNING id",
        [c.req.param("id"), c.get("userId")],
      );
      return result.rows.length
        ? c.body(null, 204)
        : c.json({ error: "Token not found" }, 404);
    });
  }
  app.use("/api/*", async (c, next) => {
    try {
      const session =
        !c.req.header("authorization") && options.auth
          ? await options.auth.api.getSession({ headers: c.req.raw.headers })
          : null;
      if (session) {
        if (
          !["GET", "HEAD"].includes(c.req.method) &&
          c.req.header("origin") !== new URL(syncBaseUrl).origin
        )
          return c.json({ error: "Forbidden origin" }, 403);
        c.set("userId", session.user.id);
      } else {
        const identity = await authenticateApiToken(c.req.raw, authority);
        c.set("userId", identity.userId);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Unauthorized")
        return c.json({ error: "Unauthorized" }, 401);
      return c.json({ error: "Authentication unavailable" }, 503);
    }
    return next();
  });
  app.use("/api/*", async (c, next) => {
    if (
      c.req.path === "/api/v1/libraries/personal/assets/import-file" ||
      /^\/api\/v1\/projects\/[^/]+\/assets\/import-file$/.test(c.req.path)
    )
      return next();
    return bodyLimit({ maxSize: 8 * 1024 * 1024 })(c, next);
  });
  app.route(
    "/api/v1/libraries/personal/assets",
    createPersonalAssetRoutes({
      db: options.db,
      directory: options.assetDirectory ?? "data/assets",
      publicUrl: syncBaseUrl,
    }),
  );
  app.route(
    "/api/v1/projects",
    createProjectAssetRoutes({
      db: options.db,
      directory: options.assetDirectory ?? "data/assets",
      publicUrl: syncBaseUrl,
      receiptSecret:
        options.timeline?.receiptSecret ?? randomBytes(32).toString("hex"),
    }),
  );
  app.get("/api/v1/projects", async (c) => {
    const archived = c.req.query("archived") ?? "active";
    if (!["active", "only", "include"].includes(archived))
      return c.json({ error: "Invalid archived filter" }, 400);
    const result = await options.db.query(
      `SELECT id,name,description,owner_id AS "ownerId",created_at AS "createdAt",updated_at AS "updatedAt",deleted_at AS "deletedAt" FROM project WHERE owner_id=$1 AND ($2='include' OR ($2='only' AND deleted_at IS NOT NULL) OR ($2='active' AND deleted_at IS NULL)) ORDER BY updated_at DESC LIMIT 50`,
      [c.get("userId"), archived],
    );
    return c.json({ projects: result.rows });
  });
  app.route("/api/v1/projects", createProjectRoutes(options.db, syncBaseUrl));
  if (options.timeline)
    app.route(
      "/api/v1/projects",
      createTimelineHostRoutes(options.db, options.timeline),
    );
  app.post("/api/v1/projects/:id/cloud-admission", async (c) => {
    const parsed = ProjectCloudAdmissionRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (
      !parsed.success ||
      parsed.data.projectId !== c.req.param("id") ||
      parsed.data.metadata.projectId !== c.req.param("id")
    )
      return c.json({ error: "Invalid project cloud admission request" }, 400);
    try {
      return c.json(
        await admissions.admit({
          userId: c.get("userId"),
          request: parsed.data,
          syncBaseUrl,
        }),
        201,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Forbidden")
        return c.json({ error: "Project not found" }, 404);
      throw error;
    }
  });
  app.get("/api/v1/projects/:id/cloud-admission", async (c) => {
    const localReplicaId = c.req.query("localReplicaId");
    if (!localReplicaId?.trim())
      return c.json({ error: "localReplicaId is required" }, 400);
    const admission = await admissions.read({
      userId: c.get("userId"),
      projectId: c.req.param("id"),
      localReplicaId,
    });
    return admission
      ? c.json({ admission })
      : c.json({ error: "Project not found" }, 404);
  });
  app.onError(
    () =>
      new Response(JSON.stringify({ error: "Cloud request failed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  );
  return app;
}
