/**
 * Cloudflare Worker entry — gateway proxy + Better Auth handler + SPA
 * shell fallback.
 *
 * Routing:
 *   /health                     → 200 OK
 *   /api/better-auth/*          → handled in-worker via better-auth handler
 *   /api/v1/*                   → api-cf (auth-gated, x-user-id injected)
 *   /sync/*, /agents/*          → api-cf (WebSocket, Durable Objects)
 *   /assets/*                   → api-cf (signed capability delivery only)
 *   /api/*                      → api-cf (projects, settings, marketplace,
 *                                  tasks, describe, generate, internal)
 *   /*                          → ASSETS binding (SPA shell + static files)
 */
// Namespace import: a named `tracing` import would fail module linking on a
// workerd build that predates the export; property access yields undefined.
import * as workers from "cloudflare:workers";
import { installWorkersTracing } from "@clash/shared-telemetry/cloudflare";
import { createServerLogger } from "@clash/shared-telemetry/log";
import { createAuth } from "../app/lib/auth/better-auth.server";

installWorkersTracing(workers.tracing);
const gatewayLog = createServerLogger({ component: "web-gateway", module: "proxy" });

type CloudflareFetcher = {
  fetch: (request: Request) => Promise<Response>;
};

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  KV?: KVNamespace;
  API_CF?: CloudflareFetcher;
  /** Issue #130: stateless upload Worker (optional; falls back to API_CF). */
  API_UPLOAD?: CloudflareFetcher;
  API_CF_URL?: string;
  BETTER_AUTH_BASE_PATH?: string;
  BETTER_AUTH_ORIGIN?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
  ACTION_SECRET_KEY?: string;
  JWT_SECRET?: string;
  NODE_ENV?: string;
  ENVIRONMENT?: string;
  SKIP_LOGIN?: string;
}

export function isUploadServicePath(path: string): boolean {
  return (
    /^\/api\/v1\/projects\/[^/]+\/document-bodies\/[^/]+$/.test(path) ||
    path.startsWith("/assets/capability/")
  );
}

async function proxyToApiCf(request: Request, env: Env): Promise<Response> {
  if (!env.API_CF) {
    return new Response("api-cf service binding missing", { status: 503 });
  }
  try {
    return await env.API_CF.fetch(request);
  } catch (err) {
    gatewayLog.error("gateway.api_cf_proxy_failed", { error: err });
    return new Response("api-cf unavailable", { status: 502 });
  }
}

/** Issue #136: api-cf answers 401 itself when this is set and no credential
 * validates. Setting it can only make a request stricter, never looser. */
export const REQUIRE_IDENTITY_HEADER = "x-clash-require-identity";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// SPA mode: no server rendering. The static client built by `vite build`
// is served via the ASSETS binding (`not_found_handling = "single-page-application"`
// returns index.html for any path that doesn't match an asset). All data
// fetching lives in client loaders.

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return new Response("OK", { status: 200 });

    // Fast-fail /sync and /agents if the service binding is absent. These
    // paths must go to api-cf DOs — HTTP fallback can't carry WebSockets.
    if (
      (path.startsWith("/sync/") || path.startsWith("/agents/")) &&
      !env.API_CF
    ) {
      return new Response("api-cf service binding missing", { status: 503 });
    }

    // Better Auth handler (mounted directly in the worker so the session
    // cookie origin matches the browser-visible domain).
    if (path === "/api/better-auth/options" && request.method === "GET") {
      return json({password:true,emailOtp:true,google:!!(env.AUTH_GOOGLE_ID&&env.AUTH_GOOGLE_SECRET)});
    }
    if (path.startsWith("/api/better-auth/")) {
      return createAuth(env).handler(request);
    }

    // Discovery and PKCE code exchange must work before the client has a token.
    // The API validates the authorization code + verifier; no caller identity
    // is trusted on either public endpoint.
    if (
      (path === "/api/v1/cloud" && request.method === "GET") ||
      (path === "/api/v1/cli-auth/token" && request.method === "POST")
    ) {
      const publicRequest = new Request(request);
      publicRequest.headers.delete("x-user-id");
      return proxyToApiCf(publicRequest, env);
    }

    // Issue #130: uploads go straight to the stateless upload Worker, which
    // authenticates the request itself (no DO, no api-cf hop).
    if (env.API_UPLOAD && isUploadServicePath(path)) {
      const forwarded = new Request(request);
      forwarded.headers.delete("x-user-id");
      try {
        return await env.API_UPLOAD.fetch(forwarded);
      } catch (err) {
        gatewayLog.error("gateway.api_upload_proxy_failed", { error: err });
        return new Response("upload service unavailable", { status: 502 });
      }
    }

    // Auth-gated public REST API v1 — inject x-user-id then proxy.
    // Issue #136: api-cf's /api/* middleware already validates the clsh_
    // token or Better Auth session (and discards any x-user-id). Checking it
    // here too cost 1-2 extra D1 round trips per request (and a duplicate
    // api_token last_used_at write). The gateway now only asks api-cf to fail
    // closed when no credential validates.
    if (path.startsWith("/api/v1/")) {
      const proxied = new Request(request);
      proxied.headers.delete("x-user-id");
      proxied.headers.set(REQUIRE_IDENTITY_HEADER, "1");
      return proxyToApiCf(proxied, env);
    }

    // Everything else under /api/* + /sync/* + /agents/* + delivery paths
    // proxies straight to api-cf (projects, settings, marketplace, internal,
    // tasks, describe, generate, signed capability delivery).
    if (
      path.startsWith("/api/") ||
      path.startsWith("/assets/") ||
      path.startsWith("/loro/") ||
      path.startsWith("/sync/") ||
      path.startsWith("/agents/")
    ) {
      return proxyToApiCf(request, env);
    }

    // Everything else → ASSETS binding (SPA shell + static files).
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
