/**
 * Cloudflare adapter: Project Host capabilities this adapter does not serve
 * yet, answered with the shared 501 instead of an unrouted 404. The UI does
 * not call them (RuntimeCapabilities `host.textRevisions: "unavailable"`).
 */
import { Hono } from "hono";
import { projectHostCapabilityUnavailable } from "@clash/shared-runtime/cloud-project-host/unavailable";
import type { Env } from "../../config";

export function createUnavailableHostRoutes() {
  const app = new Hono<{ Bindings: Env }>();
  const textRevisions = (c: any) => {
    const { status, body } = projectHostCapabilityUnavailable("text-revisions");
    return c.json(body, status);
  };
  app.post("/text-revisions", textRevisions);
  app.get("/projects/:projectId/text-revisions", textRevisions);
  app.get("/projects/:projectId/text-revisions/:revisionId/content", textRevisions);
  return app;
}
