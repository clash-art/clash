import { Hono } from "hono";
import type { Env } from "../config";
import {
  createNewProject,
  getProjectById,
  listProjectsWithAssets,
  removeProject,
  renameProject,
} from "../services/projects-d1";
import { requireSessionUserId, sessionUserId } from "../services/request-identity";

export const projectsD1Routes = new Hono<{ Bindings: Env }>();

projectsD1Routes.get("/", async (c) => {
  const userId = await sessionUserId(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await listProjectsWithAssets(c.env, userId, 100));
});

projectsD1Routes.post("/", async (c) => {
  let userId: string;
  try {
    userId = await requireSessionUserId(c);
  } catch (err) {
    if (err instanceof Response) return err.clone();
    throw err;
  }
  const { prompt } = await c.req.json<{ prompt?: string }>();
  if (!prompt) return c.json({ error: "Missing prompt" }, 400);
  const p = await createNewProject(c.env, userId, prompt);
  return c.json({ id: p.id });
});

projectsD1Routes.get("/:id", async (c) => {
  let userId: string;
  try {
    userId = await requireSessionUserId(c);
  } catch (err) {
    if (err instanceof Response) return err.clone();
    throw err;
  }
  const id = c.req.param("id");
  const p = await getProjectById(c.env, userId, id);
  if (!p) return c.json({ error: "Not found" }, 404);
  return c.json(p);
});

projectsD1Routes.patch("/:id", async (c) => {
  let userId: string;
  try {
    userId = await requireSessionUserId(c);
  } catch (err) {
    if (err instanceof Response) return err.clone();
    throw err;
  }
  const id = c.req.param("id");
  const { name } = await c.req.json<{ name?: string }>();
  if (!name) return c.json({ error: "Missing name" }, 400);
  await renameProject(c.env, userId, id, name);
  return c.json({ ok: true });
});

projectsD1Routes.delete("/:id", async (c) => {
  let userId: string;
  try {
    userId = await requireSessionUserId(c);
  } catch (err) {
    if (err instanceof Response) return err.clone();
    throw err;
  }
  const id = c.req.param("id");
  await removeProject(c.env, userId, id);
  return new Response(null, { status: 204 });
});
