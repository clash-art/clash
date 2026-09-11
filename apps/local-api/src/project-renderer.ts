import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

/** The daemon serves the shipped renderer; it never starts Vite or Electron. */
export function registerProjectRenderer(app: Hono, root: string): void {
  app.get("/projects/:id", async (c) => {
    try {
      const html = await readFile(join(root, "index.html"), "utf8");
      const config =
        '<script>globalThis.__CLASH_RUNTIME_CONFIG__={"mode":"local"};globalThis.__CLASH_MCP_APP__=true;</script>';
      c.header("Cache-Control", "no-store");
      return c.html(
        html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${config}`),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return c.text(
        "The Clash project renderer is not installed. Install the complete Clash distribution or build its project renderer assets.",
        503,
      );
    }
  });
  // Static middleware only reads files inside the installed renderer. Do not
  // turn missing API routes into an HTML SPA fallback.
  app.get("/_app/*", serveStatic({ root }));
  app.get("/fonts/*", serveStatic({ root }));
  app.get("/brand/*", serveStatic({ root }));
  app.get("/favicon.svg", serveStatic({ root }));
}
