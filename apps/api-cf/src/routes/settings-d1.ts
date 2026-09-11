import { Hono } from "hono";
import type { Env } from "../config";
import {
  createApiToken,
  deleteVariable,
  installAction,
  installSkill,
  listApiTokens,
  listInstalledActions,
  listInstalledSkills,
  listVariables,
  revokeApiToken,
  setVariable,
  uninstallAction,
  uninstallSkill,
} from "../services/settings-d1";
import { requireUserId } from "../services/session";

export const settingsD1Routes = new Hono<{ Bindings: Env }>();

async function auth(c: {
  req: { raw: Request };
  env: Env;
}): Promise<string | Response> {
  try {
    return await requireUserId(c.req.raw, c.env as any, c.req.raw.cf as any);
  } catch (err) {
    if (err instanceof Response) return err.clone();
    throw err;
  }
}

// ───── /tokens ─────
settingsD1Routes.get("/tokens", async (c) => {
  const userId = await auth(c);
  if (userId instanceof Response) return userId;
  return c.json(await listApiTokens(c.env, userId));
});

settingsD1Routes.post("/tokens", async (c) => {
  const userId = await auth(c);
  if (userId instanceof Response) return userId;
  const { name } = await c.req.json<{ name?: string }>();
  return c.json(await createApiToken(c.env, userId, name ?? ""));
});

settingsD1Routes.delete("/tokens/:id", async (c) => {
  const userId = await auth(c);
  if (userId instanceof Response) return userId;
  await revokeApiToken(c.env, userId, c.req.param("id"));
  return new Response(null, { status: 204 });
});

// ───── /variables ─────
settingsD1Routes.get("/variables", async (c) => {
  const userId = await auth(c);
  if (userId instanceof Response) return userId;
  return c.json(await listVariables(c.env, userId));
});

settingsD1Routes.post("/variables", async (c) => {
  const userId = await auth(c);
  if (userId instanceof Response) return userId;
  const { key, value } = await c.req.json<{ key?: string; value?: string }>();
  if (!key || typeof value !== "string") {
    return c.json({ error: "Missing key/value" }, 400);
  }
  return c.json(await setVariable(c.env, userId, key, value));
});

settingsD1Routes.delete("/variables/:id", async (c) => {
  const userId = await auth(c);
  if (userId instanceof Response) return userId;
  await deleteVariable(c.env, userId, c.req.param("id"));
  return new Response(null, { status: 204 });
});

// ───── /actions ─────
settingsD1Routes.get("/actions", async (c) => {
  const userId = await auth(c);
  if (userId instanceof Response) return userId;
  return c.json(await listInstalledActions(c.env, userId));
});

settingsD1Routes.post("/actions", async (c) => {
  const userId = await auth(c);
  if (userId instanceof Response) return userId;
  try {
    await installAction(c.env, userId);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
});

settingsD1Routes.delete("/actions/:id", async (c) => {
  const userId = await auth(c);
  if (userId instanceof Response) return userId;
  // Hono's c.req.param decodes once; OSS used decodeURIComponent on a raw regex
  // capture group (still encoded). Same effective behavior here.
  await uninstallAction(c.env, userId, c.req.param("id"));
  return new Response(null, { status: 204 });
});

// ───── /skills ─────
settingsD1Routes.get("/skills", async (c) => {
  const userId = await auth(c);
  if (userId instanceof Response) return userId;
  return c.json(await listInstalledSkills(c.env, userId));
});

settingsD1Routes.post("/skills", async (c) => {
  const userId = await auth(c);
  if (userId instanceof Response) return userId;
  const body = await c.req.json<{ skill?: Record<string, any> }>();
  if (!body.skill) return c.json({ error: "Missing skill" }, 400);
  return c.json(await installSkill(c.env, userId, body.skill));
});

settingsD1Routes.delete("/skills/:id", async (c) => {
  const userId = await auth(c);
  if (userId instanceof Response) return userId;
  await uninstallSkill(c.env, userId, c.req.param("id"));
  return new Response(null, { status: 204 });
});
