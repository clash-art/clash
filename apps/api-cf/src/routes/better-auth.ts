/**
 * Better Auth handler mount. Forwards every request under
 * /api/better-auth/* to the configured handler.
 *
 * We forward Hono's raw request directly so Better Auth sees the URL,
 * method, headers, and body it expects — no shape adaptation.
 */
import { Hono } from "hono";
import type { Env } from "../config";
import { loadAuth, type AuthBindings } from "../services/auth-loader";

export const betterAuthRoutes = new Hono<{ Bindings: Env }>();

betterAuthRoutes.all("/*", async (c) => {
  const { createAuthForHandler } = await loadAuth();
  const auth = createAuthForHandler(c.env as unknown as AuthBindings);
  return auth.handler(c.req.raw);
});
