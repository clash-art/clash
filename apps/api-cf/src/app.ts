import { createProjectContentResolver, type ProjectContentPorts } from "./services/project-content";
import { createProjectContentRoutes } from "./routes/v1/project-content";
/**
 * Hono app factory.
 *
 * OSS deployments call createApp() with no plugins → all hook sites run
 * their default behavior. Hosted (or any downstream) deployments call
 * createApp({ plugins: [...] }) to install plugin hooks before any
 * request or workflow runs.
 *
 * Workflow / Durable Object bodies share the same JS isolate as the
 * fetch handler, so the plugin registry installed here is also visible
 * to GenerationWorkflow.run, ProjectRoom, etc.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";

import type { AssetDeliveryStore } from "@clash/asset-sdk/delivery";
import {
  ProjectCloudAdmissionRequestSchema,
  ProjectCloudAdmissionResponseSchema,
  ProjectMetadataEnvelopeSchema,
} from "@clash/shared-types";
import type { Env } from "./config";
import { api } from "./routes/index";
import { v1Routes } from "./routes/v1/index";
import { assetDeliveryRoutes } from "./routes/assets";
import {
  createAssetCapabilityRoutes,
  type AssetCapabilityRoutesOptions,
} from "./routes/asset-capability";
import { betterAuthRoutes } from "./routes/better-auth";
import { projectsD1Routes } from "./routes/projects-d1";
import { internalProjectsContextRoutes } from "./routes/internal-projects-context";
import { settingsD1Routes } from "./routes/settings-d1";
import { marketplaceRoutes } from "./routes/marketplace";
import { authenticateRuntimeToken } from "./routes/v1/runtimes";
import { setPlugins, getPlugins } from "./plugins/registry";
import type { Plugin } from "./plugins/types";
import {
  getUserIdFromApiToken,
  getUserIdFromRequest,
} from "./services/session";
import { authenticateRequest } from "./loro/auth";
import { setResolvedIdentity } from "./services/request-identity";
import {
  DEFERRED_HEADER as METADATA_DEFERRED_HEADER,
  isMetadataServiceRequest,
} from "@clash/metadata-service/routes";
import {
  createD1ProjectMetadataStore,
  type CloudProjectMetadataStore,
} from "./services/cloud-project-metadata";
import {
  cloudSyncBaseUrl,
  type CloudProjectAdmissionStore,
} from "./services/cloud-project-admission";


/** Set by the web gateway on /api/v1/*: answer 401 when no credential validates. */
export const REQUIRE_IDENTITY_HEADER = "x-clash-require-identity";

export const PROJECT_METADATA_NAME_MAX = 512;
export const PROJECT_METADATA_DESCRIPTION_MAX = 64 * 1024;

export interface CreateAppOptions {
  plugins?: Plugin[];
  /** Resolver supplied by the deployment's Resource Registry; storage locators stay private. */
  projectContentPorts?: (env: Env) => ProjectContentPorts;
  assetDeliveryResolver?: AssetCapabilityRoutesOptions["resolve"];
  /** Optional R2/S3/filesystem adapter behind the standalone capability route. */
  assetDeliveryStore?: AssetDeliveryStore;
  /** Optional Node/SaaS adapter; Cloudflare defaults to D1. */
  projectMetadataStore?: (env: Env) => CloudProjectMetadataStore;
  /** Optional Node/SaaS admission authority; Cloudflare defaults to D1. */
  projectAdmissionStore?: CloudProjectAdmissionStore;
}

export function isUploadServicePath(path: string): boolean {
  return (
    /^\/api\/v1\/projects\/[^/]+\/document-bodies\/[^/]+$/.test(path) ||
    path.startsWith("/assets/capability/")
  );
}

function decodeProjectIdParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Public callers cannot attest to an internal DO identity. */
function publicProjectRequest(request: Request): Request {
  const sanitized = new Request(request);
  for (const name of [
    "x-internal-agent",
    "x-internal-loro",
    "x-loro-project-id",
    "x-user-id",
    "x-partykit-room",
    "x-partykit-namespace",
    "x-partykit-props",
  ]) {
    sanitized.headers.delete(name);
  }
  return sanitized;
}

async function forwardLoroPersistenceRequest(
  c: Context<{ Bindings: Env }>,
  projectId: string,
): Promise<Response> {
  const id = c.env.ROOM.idFromName(projectId);
  const req = new Request(c.req.raw);
  req.headers.set("x-internal-loro", "true");
  req.headers.set("x-loro-project-id", projectId);
  return c.env.ROOM.get(id).fetch(req);
}

function clshBearerToken(authorization: string): string | null {
  const match = /^Bearer[\t ]+(\S+)$/i.exec(authorization.trim());
  const token = match?.[1] ?? "";
  return token.startsWith("clsh_") ? token : null;
}

async function applyValidatedPublicIdentity(
  c: Context<{ Bindings: Env }>,
): Promise<string | null> {
  const request = new Request(c.req.raw);
  request.headers.delete("x-user-id");

  const token = clshBearerToken(request.headers.get("authorization") ?? "");
  let userId: string | null = null;
  let via: "session" | "api-token" | "none" = "none";
  if (token) {
    request.headers.set("authorization", `Bearer ${token}`);
    try {
      userId = await getUserIdFromApiToken(request, c.env as any);
    } catch {
      userId = null;
    }
    if (userId) via = "api-token";
  }
  if (!userId) {
    try {
      userId = await getUserIdFromRequest(
        request,
        c.env as any,
        c.req.raw.cf as any,
      );
    } catch {
      userId = null;
    }
    if (userId) via = "session";
  }

  if (userId) request.headers.set("x-user-id", userId);
  c.req.raw = request;
  // Routes read this instead of re-running getSession (2 D1 queries).
  setResolvedIdentity(
    c,
    userId && via !== "none" ? { via, userId } : { via: "none", userId: null },
  );
  return userId;
}

export function createApp(
  opts: CreateAppOptions = {},
): Hono<{ Bindings: Env }> {
  setPlugins(opts.plugins ?? []);

  const app = new Hono<{ Bindings: Env }>();

  app.use("/*", cors());

  // Issue #130: Document-body and capability uploads belong to the stateless
  // upload Worker. Forward before identity resolution (that Worker
  // authenticates itself); without the binding they are served in-process.
  app.use("/*", async (c, next) => {
    if (c.env?.API_UPLOAD && isUploadServicePath(c.req.path))
      return c.env.API_UPLOAD.fetch(c.req.raw);
    await next();
  });

  // Issue #138: metadata reads + Project metadata replication belong to the
  // lean metadata Worker when it is bound. Requests it handed back (a Better
  // Auth session due for refresh) carry DEFERRED_HEADER and are served here.
  app.use("/*", async (c, next) => {
    if (
      c.env?.API_META &&
      c.req.header(METADATA_DEFERRED_HEADER) !== "1" &&
      isMetadataServiceRequest(c.req.method, c.req.path)
    )
      return c.env.API_META.fetch(c.req.raw);
    await next();
  });

  // Public API identity is always derived here. An x-user-id supplied by a
  // browser, CLI, reverse proxy, or service binding is untrusted input.
  app.use("/api/*", async (c, next) => {
    if (
      c.req.path === "/api/better-auth" ||
      c.req.path.startsWith("/api/better-auth/")
    ) {
      const request = new Request(c.req.raw);
      request.headers.delete("x-user-id");
      c.req.raw = request;
      await next();
      return;
    }
    const required = c.req.raw.headers.get(REQUIRE_IDENTITY_HEADER) === "1";
    const userId = await applyValidatedPublicIdentity(c);
    c.req.raw.headers.delete(REQUIRE_IDENTITY_HEADER);
    // Issue #136: the web gateway no longer pre-authenticates /api/v1/*; it
    // asks this Worker to fail closed instead (one identity check, not two).
    if (required && !userId) return c.json({ error: "Unauthorized" }, 401);
    await next();
  });

  // ─── WebSocket: /sync/:projectId → ProjectRoom DO ──────────
  app.all("/sync/:projectId{.*}", async (c) => {
    const rawProjectId = c.req.param("projectId");
    // Only the public WebSocket endpoint is exposed. DO maintenance HTTP
    // routes are reached via service bindings, never this wildcard proxy.
    if (rawProjectId.includes("/")) return c.notFound();
    if (c.req.method !== "GET" || c.req.header("Upgrade") !== "websocket") {
      return c.text("WebSocket only", 400);
    }
    const projectId = rawProjectId;
    const request = publicProjectRequest(c.req.raw);
    try {
      const identity = await authenticateRequest(request, c.env, projectId);
      request.headers.set("x-user-id", identity.userId);
    } catch {
      return c.text("Unauthorized", 401);
    }
    const id = c.env.ROOM.idFromName(projectId);
    return c.env.ROOM.get(id).fetch(request);
  });

  // ─── Local-first Loro remote persistence ───────────────────
  app.get("/loro/:projectId/snapshot", async (c) => {
    const projectId = decodeProjectIdParam(c.req.param("projectId"));
    try {
      await authenticateRequest(c.req.raw, c.env as any, projectId);
    } catch (error) {
      return c.text("Unauthorized", 401);
    }
    return forwardLoroPersistenceRequest(c, projectId);
  });

  app.post("/loro/:projectId/updates", async (c) => {
    const projectId = decodeProjectIdParam(c.req.param("projectId"));
    try {
      await authenticateRequest(c.req.raw, c.env as any, projectId);
    } catch (error) {
      return c.text("Unauthorized", 401);
    }
    return forwardLoroPersistenceRequest(c, projectId);
  });

  // Project metadata is ordinary client-server state, not part of the CRDT
  // byte stream and not owned by the ProjectRoom Durable Object. It carries
  // the soft-delete tombstone, so the owner must still reach it for a deleted
  // Project: otherwise no Host can pull the deletion or push a restore.
  app.get("/loro/:projectId/metadata", async (c) => {
    const projectId = decodeProjectIdParam(c.req.param("projectId"));
    try {
      await authenticateRequest(c.req.raw, c.env as any, projectId, {
        allowDeleted: true,
      });
    } catch {
      return c.text("Unauthorized", 401);
    }
    const store =
      opts.projectMetadataStore?.(c.env) ??
      createD1ProjectMetadataStore(c.env.DB);
    const metadata = await store.read(projectId);
    return metadata
      ? c.json({ schemaVersion: 1 as const, metadata })
      : c.json({ error: "Project metadata not found" }, 404);
  });

  app.put("/loro/:projectId/metadata", async (c) => {
    const projectId = decodeProjectIdParam(c.req.param("projectId"));
    try {
      await authenticateRequest(c.req.raw, c.env as any, projectId, {
        allowDeleted: true,
      });
    } catch {
      return c.text("Unauthorized", 401);
    }
    const parsed = ProjectMetadataEnvelopeSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success || parsed.data.metadata.projectId !== projectId) {
      return c.json({ error: "Invalid Project metadata envelope" }, 400);
    }
    // Issue #116: bound free-text fields before they reach D1, so one PUT
    // cannot store megabytes in the project row that every Host then pulls.
    if (
      parsed.data.metadata.name.length > PROJECT_METADATA_NAME_MAX ||
      (parsed.data.metadata.description?.length ?? 0) >
        PROJECT_METADATA_DESCRIPTION_MAX
    ) {
      return c.json({ error: "Project metadata too large" }, 413);
    }
    const store =
      opts.projectMetadataStore?.(c.env) ??
      createD1ProjectMetadataStore(c.env.DB);
    const result = await store.write(parsed.data.metadata);
    if (result.status === "written") return new Response(null, { status: 204 });
    if (result.status === "stale") {
      return c.json(
        {
          error: "Project metadata is stale",
          schemaVersion: 1,
          metadata: result.current,
        },
        409,
      );
    }
    return c.json({ error: "Project metadata not found" }, 404);
  });

  // ─── AI Chat: /agents/supervisor/:room → SupervisorAgent DO ──
  // Room name format: "projectId:agentId" — each room is an independent agent instance.
  // Multiple agents can share the same project canvas via ProjectRoom.
  app.all("/agents/supervisor/:room{.*}", async (c) => {
    const rawRoom = c.req.param("room");
    const room = rawRoom.split("/")[0];
    const projectId = room.split(":")[0];
    const req = publicProjectRequest(c.req.raw);
    // Protect both the WebSocket and the agent's HTTP session endpoints.
    // Resolving identity alone does not authorize access to this project.
    try {
      const identity = await authenticateRequest(req, c.env, projectId);
      req.headers.set("x-user-id", identity.userId);
    } catch {
      return c.text("Unauthorized", 401);
    }
    const id = c.env.SUPERVISOR.idFromName(room);
    req.headers.set("x-partykit-room", room);
    req.headers.set("x-partykit-namespace", "SUPERVISOR");
    return c.env.SUPERVISOR.get(id).fetch(req);
  });

  // WS attach for the long-running daemon ↔ RuntimeRoom DO link.
  // Bearer token in Authorization header → identifies which runtime row.
  // We resolve the token here (rather than inside the DO) so the DO never
  // sees raw secrets and so we can 401 cheaply without spinning a DO.
  app.get("/agents/runtime/_attach", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") {
      return c.text("WebSocket only", 400);
    }
    const auth =
      c.req.header("Authorization") ?? c.req.header("authorization") ?? "";
    if (!auth) return c.text("missing Authorization", 401);
    const ident = await authenticateRuntimeToken(c.env, auth);
    if (!ident) return c.text("invalid token", 401);

    const id = c.env.RUNTIME_ROOM.idFromName(ident.runtime_id);
    const fwd = new Request(c.req.raw);
    fwd.headers.set("x-attach-role", "daemon");
    fwd.headers.set("x-runtime-id", ident.runtime_id);
    fwd.headers.set("x-runtime-user", ident.user_id);
    return c.env.RUNTIME_ROOM.get(id).fetch(fwd);
  });

  // Production default resolves only admitted Project Resource references.
  // SaaS/Node deployments may supply the same authorization and storage ports.
  app.route("/assets/capability", createAssetCapabilityRoutes({
    resolve: opts.assetDeliveryResolver ?? createProjectContentResolver(opts.projectContentPorts),
    ...(opts.assetDeliveryStore ? { store: opts.assetDeliveryStore } : {}),
  }));
  if (opts.projectContentPorts) app.route("/api/v1/projects", createProjectContentRoutes({
    ports: opts.projectContentPorts,
    ...(opts.assetDeliveryStore ? { store: opts.assetDeliveryStore } : {}),
  }));

  // Signed capability delivery is a transport adapter, not Asset authority.
  app.route("/assets", assetDeliveryRoutes);

  // ─── Better Auth — runs server-side so frontends just proxy ──
  app.route("/api/better-auth", betterAuthRoutes);

  // A Node/SaaS deployment can supply the same admission contract without
  // binding the control plane to D1. Mount these specific paths before the
  // default D1-backed v1 project router when an adapter is supplied.
  const projectAdmissionStore = opts.projectAdmissionStore;
  if (projectAdmissionStore) {
    app.post("/api/v1/projects/:projectId/cloud-admission", async (c) => {
      const userId = c.req.header("x-user-id");
      if (!userId) return c.json({ error: "unauthorized" }, 401);
      const projectId = c.req.param("projectId");
      const parsed = ProjectCloudAdmissionRequestSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success || parsed.data.projectId !== projectId) {
        return c.json({ error: "Invalid project cloud admission request" }, 400);
      }
      try {
        const response = await projectAdmissionStore.admit({
          userId,
          request: parsed.data,
          syncBaseUrl: cloudSyncBaseUrl(c.req.raw, c.env),
        });
        return c.json(ProjectCloudAdmissionResponseSchema.parse(response), 201);
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error ? error.message : "Cloud admission failed",
          },
          500,
        );
      }
    });
    app.get("/api/v1/projects/:projectId/cloud-admission", async (c) => {
      const userId = c.req.header("x-user-id");
      const localReplicaId = c.req.query("localReplicaId")?.trim();
      if (!userId || !localReplicaId) {
        return c.json({ error: "unauthorized or localReplicaId missing" }, 401);
      }
      const admission = await projectAdmissionStore.read({
        userId,
        projectId: c.req.param("projectId"),
        localReplicaId,
      });
      return admission
        ? c.json({ admission })
        : c.json({ error: "Project not found" }, 404);
    });
  }

  // ─── Public REST API v1 ─────────────────────────────────────
  app.route("/api/v1", v1Routes);

  // ─── OSS web's /api/* endpoints (ported from apps/web) ──────
  app.route("/api/projects", projectsD1Routes);
  app.route("/api/internal/projects", internalProjectsContextRoutes);
  app.route("/api/settings", settingsD1Routes);
  app.route("/api/marketplace", marketplaceRoutes);

  // ─── REST API routes ────────────────────────────────────────
  app.route("/", api);

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // ─── Plugin-mounted routes (e.g. /api/v1/billing/*) ─────────
  // Run after core routes so plugins can override or extend them.
  getPlugins().routes?.register?.(app);

  return app;
}
