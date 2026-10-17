/**
 * Lazily built remainder of the Hono app (#161). `createApp` registers the
 * hot transport routes eagerly and dispatches every other request here, so
 * the REST route modules (shared-types zod schemas, drizzle, generation
 * services, …) evaluate on first use instead of at Worker startup.
 *
 * Registration order is the original `createApp` order: this app only ever
 * sees requests that no eager route answered, and none of its paths overlap
 * the eager routes.
 */
import { Hono } from "hono";
import type { Context } from "hono";

import {
  ProjectCloudAdmissionRequestSchema,
  ProjectCloudAdmissionResponseSchema,
  ProjectMetadataEnvelopeSchema,
} from "@clash/shared-types";
import type { Env } from "./config";
import {
  PROJECT_METADATA_DESCRIPTION_MAX,
  PROJECT_METADATA_NAME_MAX,
  REQUIRE_IDENTITY_HEADER,
  decodeProjectIdParam,
  type CreateAppOptions,
} from "./app";
import { createProjectContentResolver } from "./services/project-content";
import { createProjectContentRoutes } from "./routes/v1/project-content";
import { api } from "./routes/index";
import { v1Routes } from "./routes/v1/index";
import { assetDeliveryRoutes } from "./routes/assets";
import { createAssetCapabilityRoutes } from "./routes/asset-capability";
import { betterAuthRoutes } from "./routes/better-auth";
import { projectsD1Routes } from "./routes/projects-d1";
import { internalProjectsContextRoutes } from "./routes/internal-projects-context";
import { settingsD1Routes } from "./routes/settings-d1";
import { marketplaceRoutes } from "./routes/marketplace";
import { getPlugins } from "./plugins/registry";
import {
  getUserIdFromApiToken,
  getUserIdFromRequest,
} from "./services/session";
import { authenticateRequest } from "./loro/auth";
import { setResolvedIdentity } from "./services/request-identity";
import { createD1ProjectMetadataStore } from "./services/cloud-project-metadata";
import { cloudSyncBaseUrl } from "./services/cloud-project-admission";

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

export function createAppRoutes(
  opts: CreateAppOptions,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

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

  // ─── Plugin-mounted routes (e.g. /api/v1/billing/*) ─────────
  // Run after core routes so plugins can override or extend them.
  getPlugins().routes?.register?.(app);

  return app;
}
