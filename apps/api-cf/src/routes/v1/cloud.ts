import { Hono } from "hono";
import { CloudServiceSchema, CloudAccountSchema } from "@clash/shared-types";
import type { Env } from "../../config";

export const cloudRoutes = new Hono<{ Bindings: Env }>();
cloudRoutes.get("/", (c) =>
  c.json(
    CloudServiceSchema.parse({
      protocol: "clash-cloud-v1",
      auth: {
        clientId: "clash-cli",
        authorizationPath: "/auth/cli",
        tokenPath: "/api/v1/cli-auth/token",
      },
    }),
  ),
);
// app.ts strips caller identity and supplies only a validated session/token owner.
cloudRoutes.get("/account", async (c) => {
  const id = c.req.header("x-user-id");
  if (!id) return c.json({ error: "Unauthorized" }, 401);
  const user = await c.env.DB.prepare(
    "SELECT id,email,name FROM users WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; email: string; name: string }>();
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  c.header("Cache-Control", "no-store");
  return c.json(CloudAccountSchema.parse({ user }));
});
