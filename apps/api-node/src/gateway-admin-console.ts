/**
 * Shared `/admin` console static assets on the Node admin listener (#372, N15).
 *
 * The admin API itself lives in gateway-admin.ts (#371). This module only
 * mounts the same `apps/web` build Epic A ships (GATEWAY_ADMIN_WEB_DIR =
 * apps/web/dist/client): `/admin` and `/admin/*` get index.html; `/_app/*`
 * and the build's top-level files are served as static assets. Mounted only
 * when GATEWAY_ROLE=admin|all — api-role admin listeners (GATEWAY_ADMIN_PORT
 * alone) keep API-only behaviour from #371.
 *
 * Guide: apps/docs/guide/gateway-admin.md#node-admin-listener.
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { GATEWAY_ADMIN_AUTH_BASE_PATH } from "@clash/gateway-core";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";

const NO_STORE = { "cache-control": "no-store" };

/** The shared console build a Node admin listener serves (apps/web `vite build` output). */
export interface AdminWebBuild {
  /** Absolute directory holding index.html and `_app/`. */
  directory: string;
  indexHtml: string;
}

/** Read the console build once at startup; a missing or incomplete build fails the start. */
export function loadAdminWebBuild(directory: string | undefined): AdminWebBuild {
  if (!directory?.trim())
    throw Error("GATEWAY_ROLE=admin requires GATEWAY_ADMIN_WEB_DIR (the apps/web build: apps/web/dist/client)");
  const absolute = resolve(directory.trim());
  const index = resolve(absolute, "index.html");
  if (!existsSync(index)) throw Error(`GATEWAY_ADMIN_WEB_DIR has no index.html: ${absolute}`);
  return { directory: absolute, indexHtml: readFileSync(index, "utf8") };
}

/**
 * Mount the shared console SPA and optional admin Better Auth handler onto an
 * existing admin API app (createGatewayAdminApp). Call before the app's
 * notFound so console paths are answered.
 */
export function mountAdminConsole(
  app: Hono,
  deps: {
    build: AdminWebBuild;
    /** Admin Better Auth handler for /api/admin-auth/* (SPA sign-in). */
    adminAuthHandler?: (request: Request) => Promise<Response>;
  },
): void {
  if (deps.adminAuthHandler) {
    const handler = deps.adminAuthHandler;
    app.on(["GET", "POST"], `${GATEWAY_ADMIN_AUTH_BASE_PATH}/*`, (c) => handler(c.req.raw));
  }

  const index = (c: Context) =>
    c.html(deps.build.indexHtml, 200, {
      ...NO_STORE,
      "x-content-type-options": "nosniff",
      "content-security-policy": "frame-ancestors 'none'",
    });
  app.get("/admin", index);
  app.get("/admin/*", index);

  // serveStatic resolves its root against the working directory.
  const root = relative(process.cwd(), deps.build.directory) || ".";
  app.use(
    "/_app/*",
    async (c, next) => {
      await next();
      // Vite content-hashes every file under _app.
      if (c.res.status === 200) c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
    },
    serveStatic({ root }),
  );
  // The build's top-level files (favicon, manifest, icons) only.
  app.get("/:file{[A-Za-z0-9][A-Za-z0-9._-]*\\.[A-Za-z0-9]+}", serveStatic({ root }));
}
