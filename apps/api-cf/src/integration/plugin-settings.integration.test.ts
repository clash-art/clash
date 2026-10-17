import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { RemotePluginEndpointError } from "@clash/shared-runtime/executable-plugin-remote";

import type { Env } from "../config";
import { pluginSettingsRoutes } from "../routes/v1/plugin-settings";
import {
  createPluginEndpointSetting,
  resolveRemotePluginSettings,
} from "../services/plugin-settings";

it("stores the plugin secret as a sealed envelope and never returns it", async () => {
  const bindings = env as unknown as Env;
  const userId = `settings-user-${crypto.randomUUID()}`;
  const secret = "super-secret-signing-value";
  const created = await createPluginEndpointSetting(bindings, userId, {
    pluginId: "third.party",
    endpoint: "https://plugins.example.com/invoke",
    secret,
    version: "1.0.0",
    schemaHash: `sha256:${"a".repeat(64)}`,
    exportIds: ["run"],
  });
  expect(created).not.toHaveProperty("signingSecret");
  expect(JSON.stringify(created)).not.toContain(secret);

  const stored = await bindings.DB.prepare(
    "SELECT encrypted_secret FROM plugin_endpoint_settings WHERE user_id = ? AND plugin_id = ?",
  )
    .bind(userId, "third.party")
    .first<{ encrypted_secret: string }>();
  expect(stored?.encrypted_secret).not.toContain(secret);

  const resolved = await resolveRemotePluginSettings(
    bindings,
    userId,
    "third.party",
  );
  expect(resolved?.signingSecret).toBe(secret);

  const response = await pluginSettingsRoutes.request(
    "/",
    { headers: { "x-user-id": userId } },
    bindings,
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(secret);
  expect(JSON.parse(text)).toMatchObject({
    settings: [
      {
        pluginId: "third.party",
        endpoint: "https://plugins.example.com/invoke",
        version: "1.0.0",
        exportIds: ["run"],
      },
    ],
  });

  const deleted = await pluginSettingsRoutes.request(
    "/third.party",
    { method: "DELETE", headers: { "x-user-id": userId } },
    bindings,
  );
  expect(deleted.status).toBe(200);
});

it("rejects http, IP-literal and internal endpoints at save", async () => {
  const bindings = env as unknown as Env;
  const userId = `settings-user-${crypto.randomUUID()}`;
  for (const endpoint of [
    "http://plugins.example.com/invoke",
    "https://127.0.0.1/invoke",
    "https://localhost/invoke",
    "https://plugin.internal/invoke",
  ]) {
    await expect(
      createPluginEndpointSetting(bindings, userId, {
        pluginId: "third.party",
        endpoint,
        secret: "value",
      }),
    ).rejects.toThrow(RemotePluginEndpointError);
  }
  expect(
    await bindings.DB.prepare(
      "SELECT id FROM plugin_endpoint_settings WHERE user_id = ?",
    )
      .bind(userId)
      .all(),
  ).toMatchObject({ results: [] });
});
