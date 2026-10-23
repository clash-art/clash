/**
 * Admin Better Auth handler mount (#394): every request under /api/admin-auth/*
 * (sign-in/email, sign-out, get-session) goes to the admin instance
 * (src/admin-auth.ts), never the product one. Sign-up is disabled there.
 */
import { Hono } from "hono";

import type { Env } from "../config";

export const adminAuthRoutes = new Hono<{ Bindings: Env }>();

adminAuthRoutes.all("/*", async (c) => {
  const { createAdminAuth } = await import("../admin-auth");
  return createAdminAuth(c.env).handler(c.req.raw);
});
