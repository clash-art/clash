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
import { createAuth } from "../app/lib/auth/better-auth.server";

type AuthSession = {
  user?: {
    id?: string | null;
  } | null;
} | null;

type CloudflareFetcher = {
  fetch: (request: Request) => Promise<Response>;
};

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  KV?: KVNamespace;
  API_CF?: CloudflareFetcher;
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
  SKIP_LOGIN?: string;
}

async function proxyToApiCf(request: Request, env: Env): Promise<Response> {
  if (!env.API_CF) {
    return new Response("api-cf service binding missing", { status: 503 });
  }
  try {
    return await env.API_CF.fetch(request);
  } catch (err) {
    console.error("[worker] api-cf proxy failure:", err);
    return new Response("api-cf unavailable", { status: 502 });
  }
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getUserIdFromApiToken(
  request: Request,
  env: Env,
): Promise<string | null> {
  const auth = request.headers.get("authorization") ?? "";
  let token: string | null = null;
  if (auth.startsWith("Bearer clsh_")) {
    token = auth.slice(7);
  } else {
    const url = new URL(request.url);
    const q = url.searchParams.get("token");
    if (q?.startsWith("clsh_")) token = q;
  }
  if (!token) return null;
  const hash = await sha256Hex(token);
  const { results } = await env.DB.prepare(
    "SELECT user_id FROM api_token WHERE token_hash = ? LIMIT 1",
  )
    .bind(hash)
    .all();
  if (!results?.[0]) return null;
  // Fire-and-forget last_used_at
  env.DB.prepare(
    "UPDATE api_token SET last_used_at = unixepoch() WHERE token_hash = ?",
  )
    .bind(hash)
    .run()
    .catch(() => {});
  return (results[0] as { user_id: string }).user_id ?? null;
}

async function getUserIdFromBetterAuth(
  request: Request,
  env: Env,
): Promise<string | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  if (!cookie && !authorization) return null;
  try {
    const auth = createAuth(env);
    const session = (await auth.api.getSession({
      headers: new Headers(request.headers),
    })) as AuthSession;
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

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
    if (path.startsWith("/api/better-auth/")) {
      return createAuth(env).handler(request);
    }

    // Auth-gated public REST API v1 — inject x-user-id then proxy.
    if (path.startsWith("/api/v1/")) {
      const userId =
        (await getUserIdFromApiToken(request, env)) ??
        (await getUserIdFromBetterAuth(request, env));
      if (!userId) return json({ error: "Unauthorized" }, 401);
      const proxied = new Request(request);
      proxied.headers.set("x-user-id", userId);
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
