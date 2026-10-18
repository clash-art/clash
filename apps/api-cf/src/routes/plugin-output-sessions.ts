/**
 * `/assets/plugin-output/*`: the transport of a remote plugin's run-scoped
 * output upload. The signed grant in the path is the only authority (no
 * session or token); the session and multipart protocol are the shared
 * Project Asset import ones. See services/plugin-output-sessions.ts.
 *
 * Mounted from app-routes, so the session modules load on first use and stay
 * out of Worker startup.
 */
import { Hono } from "hono";

import type { Env } from "../config";
import { serverLog } from "../logger";

const sessions = () =>
  Promise.all([
    import("@clash/shared-runtime/cloud-project-host/plugin-output-sessions"),
    import("../services/plugin-output-sessions"),
  ]);

export function createPluginOutputSessionRoutes() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  });
  app.post("/:grant", async (c) => {
    const [shared, cloud] = await sessions();
    const result = await shared.beginPluginOutputSession(
      {
        grant: c.req.param("grant"),
        // A malformed body is answered by the shared validation as a 400.
        body: await c.req.json().catch(() => null),
      },
      cloud.cloudPluginOutputSessionPorts(c.env),
    );
    return c.json(result.body, result.status);
  });
  app.put("/:grant/:sessionId", async (c) => {
    const [shared, cloud] = await sessions();
    return shared.handlePluginOutputSessionContent(
      c.req.raw,
      { grant: c.req.param("grant"), sessionId: c.req.param("sessionId") },
      cloud.cloudPluginOutputSessionPorts(c.env),
    );
  });
  app.onError((error, c) => {
    // The plugin sees the failed upload; the run then fails contract_violation
    // when it answers with an Asset this session never completed.
    serverLog.error("plugin_output_session.failed", {
      code: "PLUGIN_OUTPUT_UPLOAD_FAILED",
      error,
    });
    return c.json(
      {
        error: "Plugin output upload failed on the Host; retry the upload.",
        code: "PLUGIN_OUTPUT_UPLOAD_FAILED",
      },
      503,
    );
  });
  return app;
}
