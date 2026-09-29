import { Hono } from "hono";
import { createCloudAccounts, cloudOrigin } from "./cloud-accounts.js";
import { createCloudLogin } from "./cloud-login.js";
export function createCloudRoutes(options: {
  dataDir: string;
  login: ReturnType<typeof createCloudLogin>;
}) {
  const app = new Hono();
  const accounts = createCloudAccounts(options.dataDir);
  app.get("/", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await accounts.status(c.req.query("serviceUrl")));
  });
  app.post("/login", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.serviceUrl !== "string")
      return c.json({ error: "Service address is required" }, 400);
    try {
      return c.json(await options.login.start(body.serviceUrl), 201);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Sign-in could not start",
        },
        400,
      );
    }
  });
  app.get("/login/:id", (c) => {
    try {
      return c.json(options.login.status(c.req.param("id")));
    } catch {
      return c.json({ error: "Sign-in session not found" }, 404);
    }
  });
  app.delete("/login/:id", (c) => {
    try {
      options.login.status(c.req.param("id"));
      options.login.cancel();
      return c.body(null, 204);
    } catch {
      return c.json({ error: "Sign-in session not found" }, 404);
    }
  });
  app.post("/logout", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.serviceUrl !== "string")
      return c.json({ error: "Service address is required" }, 400);
    try {
      const url = cloudOrigin(body.serviceUrl);
      options.login.cancel();
      await accounts.logout(url);
      return c.json(await accounts.status());
    } catch {
      return c.json({ error: "Invalid service address" }, 400);
    }
  });
  return app;
}
