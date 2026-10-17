/**
 * clash-upload: stateless Project content upload Worker (issue #130).
 *
 * Thin composition root: Cloudflare adapters (D1 admission + content-reference
 * index, R2 multipart store, R2 Resource registry, ProjectRoom notifier) wired
 * into the platform-agnostic `@clash/asset-sdk/upload-service`. Exports NO
 * Durable Object class, no Workflow and no Container, and never loads Loro.
 * The ROOM binding points at api-cf's ProjectRoom (script_name) and is used
 * only for the index-miss fallback and the small `content.published` notice.
 *
 * Routes (same wire contract as api-cf, which keeps serving them as fallback):
 *   GET|HEAD|PUT /api/v1/projects/:id/document-bodies/:digest[?upload=…]
 *   GET|HEAD|PUT /assets/capability/:token
 */
import { Hono } from "hono";
import {
  createUploadService,
  type UploadIdentityVerifier,
} from "@clash/asset-sdk/upload-service";
import {
  createCapabilityResolver,
  createD1ContentReferenceIndex,
  createD1ProjectContentAdmission,
  createDurableObjectContentRoomPort,
  createR2ResourceRegistry,
} from "./services/project-content-cloud";
import { createContentReferenceResolver } from "@clash/asset-sdk/upload-service";
import {
  createAssetCapabilityRoutes,
  createR2AssetDeliveryStore,
} from "./routes/asset-capability";
import { getUserIdFromApiToken } from "./services/api-token";
import { serverLog } from "./logger";
import type { Env } from "./config";

export type UploadEnv = Pick<
  Env,
  "DB" | "R2_BUCKET" | "ROOM" | "JWT_SECRET" | "ENVIRONMENT"
> &
  Partial<Env>;

/** Reuses api-cf's identity rules: `clsh_` API token first (D1 lookup), then
 * the Better Auth session cookie (loaded lazily so token-authenticated Host
 * uploads never initialise better-auth). Client-supplied x-user-id is ignored. */
export function createCloudflareIdentity(
  env: UploadEnv,
  cf?: unknown,
): UploadIdentityVerifier {
  return {
    async verify(request) {
      // Headers-only copy: `new Request(request)` would take over (lock) the
      // request body in workerd, and the upload service still has to read it.
      const headers = new Headers(request.headers);
      headers.delete("x-user-id");
      const clean = new Request(request.url, { method: "GET", headers });
      const auth = clean.headers.get("authorization") ?? "";
      if (/^Bearer[\t ]+clsh_\S+$/i.test(auth.trim())) {
        const userId = await getUserIdFromApiToken(clean, env as never).catch(
          () => null,
        );
        if (userId) return { userId };
      }
      if (!clean.headers.get("cookie")) return null;
      const { getUserIdFromRequest } = await import("./services/session");
      const userId = await getUserIdFromRequest(
        clean,
        env as never,
        cf as never,
      ).catch(() => null);
      return userId ? { userId } : null;
    },
  };
}

const log = (
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) => (serverLog as any)[level]?.(event, { ...fields, worker: "clash-upload" });

function cloudflarePorts(env: UploadEnv) {
  const admission = createD1ProjectContentAdmission(env.DB as never);
  return {
    authorize: admission.authorize,
    index: createD1ContentReferenceIndex(env.DB as never),
    room: createDurableObjectContentRoomPort(env.ROOM as never),
    resource: createR2ResourceRegistry(env.R2_BUCKET as never),
  };
}

export function createUploadWorkerApp() {
  const app = new Hono<{ Bindings: UploadEnv }>();
  app.get("/health", (c) => c.json({ status: "ok", service: "clash-upload" }));

  app.on(
    ["GET", "HEAD", "PUT"],
    "/api/v1/projects/:id/document-bodies/:digest",
    (c) => {
      const ports = cloudflarePorts(c.env);
      return createUploadService({
        identity: createCloudflareIdentity(c.env, c.req.raw.cf),
        admission: ports,
        index: ports.index,
        room: ports.room,
        store: createR2AssetDeliveryStore(c.env.R2_BUCKET),
        telemetry: { log },
        defer: (work) => c.executionCtx.waitUntil(work.catch(() => {})),
      }).documentBody(c.req.raw, c.req.param("id"), c.req.param("digest"));
    },
  );

  app.route(
    "/assets/capability",
    createAssetCapabilityRoutes({
      resolve: createCapabilityResolver(
        (env: Env) => cloudflarePorts(env),
        (ports) => createContentReferenceResolver(ports.index, ports.room),
      ) as never,
    }),
  );

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}

const app = createUploadWorkerApp();
export default { fetch: app.fetch };
