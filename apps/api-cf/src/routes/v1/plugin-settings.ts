/**
 * Third-party executable plugin settings.
 *
 * POST   /api/v1/plugin-settings             create/update endpoint + secret
 * GET    /api/v1/plugin-settings             list (never returns the secret)
 * DELETE /api/v1/plugin-settings/:pluginId   remove one plugin's endpoint
 */
import { Hono } from "hono";
import { RemotePluginEndpointError } from "@clash/shared-runtime/executable-plugin-remote";
import type { Env } from "../../config";
import {
  createPluginEndpointSetting,
  deletePluginEndpointSetting,
  listPluginEndpointSettings,
  PluginSettingInputError,
} from "../../services/plugin-settings";

export const pluginSettingsRoutes = new Hono<{ Bindings: Env }>();

function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

pluginSettingsRoutes.post("/", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return unauthorized();
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid plugin settings body" }, 400);
  }
  try {
    const setting = await createPluginEndpointSetting(
      c.env,
      userId,
      body as Record<string, unknown>,
    );
    return c.json({ setting });
  } catch (error) {
    if (
      error instanceof RemotePluginEndpointError ||
      error instanceof PluginSettingInputError
    ) {
      return c.json({ error: error.message }, 400);
    }
    // Storage or key-configuration faults are not the caller's fault.
    throw error;
  }
});

pluginSettingsRoutes.get("/", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return unauthorized();
  const settings = await listPluginEndpointSettings(c.env, userId);
  return c.json({ settings });
});

pluginSettingsRoutes.delete("/:pluginId", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return unauthorized();
  const deleted = await deletePluginEndpointSetting(
    c.env,
    userId,
    c.req.param("pluginId"),
  );
  return deleted
    ? c.json({ ok: true })
    : c.json({ error: "Plugin setting not found" }, 404);
});
