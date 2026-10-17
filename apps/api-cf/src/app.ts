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
 *
 * Startup CPU (#161): only the realtime transport routes below are built
 * eagerly. Every other route lives in `./app-routes`, imported and built on
 * the first request that reaches it (see the final catch-all).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";

import type { AssetDeliveryStore } from "@clash/asset-sdk/delivery";
import type { Env } from "./config";
import type { ProjectContentPorts } from "./services/project-content";
import type { AssetCapabilityRoutesOptions } from "./routes/asset-capability";
import { authenticateRuntimeToken } from "./routes/v1/runtimes";
import { setPlugins } from "./plugins/registry";
import type { Plugin } from "./plugins/types";
import { authenticateRequest } from "./loro/auth";
import {
  DEFERRED_HEADER as METADATA_DEFERRED_HEADER,
  isMetadataServiceRequest,
} from "@clash/metadata-service/routes";
import type { CloudProjectMetadataStore } from "./services/cloud-project-metadata";
import type { CloudProjectAdmissionStore } from "./services/cloud-project-admission";

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

export function decodeProjectIdParam(raw: string): string {
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

/** Hono throws when a request was dispatched without an ExecutionContext. */
function executionCtxOf(c: Context): ExecutionContext | undefined {
  try {
    return c.executionCtx as ExecutionContext;
  } catch {
    return undefined;
  }
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

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Everything else: identity middleware, REST routes and plugin routes, in
  // their original registration order, built once on first use.
  let routes: Promise<Hono<{ Bindings: Env }>> | undefined;
  app.all("*", async (c) => {
    routes ??= import("./app-routes").then(
      (m) => m.createAppRoutes(opts),
      (error: unknown) => {
        routes = undefined;
        throw error;
      },
    );
    return (await routes).fetch(c.req.raw, c.env, executionCtxOf(c));
  });

  return app;
}
