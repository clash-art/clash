import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { RemotePluginEndpointError } from "@clash/shared-runtime/executable-plugin-remote";

import { durableRunIdempotencyKey } from "@clash/shared-runtime/durable-run-engine";

import type { Env } from "../config";
import { createCloudActionInvoker } from "../generation/plugin-execution/action-invoker";
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

it("invokes a text-only remote Action without a configured media origin", async () => {
  // Staging has neither MEDIA_GATEWAY_URL nor WORKER_PUBLIC_URL; a text-only
  // Action has nothing to sign and must still reach its endpoint exactly once.
  const bindings = {
    ...(env as unknown as Env),
    MEDIA_GATEWAY_URL: "",
    WORKER_PUBLIC_URL: undefined,
  } as Env;
  const userId = `remote-user-${crypto.randomUUID()}`;
  const remoteBinding = {
    pluginId: "third.remote",
    version: "1.0.0",
    exportId: "run",
    schemaHash: `sha256:${"b".repeat(64)}`,
  };
  await createPluginEndpointSetting(bindings, userId, {
    pluginId: remoteBinding.pluginId,
    endpoint: "https://plugins.example.com/invoke",
    secret: "remote-signing-secret",
    version: remoteBinding.version,
    schemaHash: remoteBinding.schemaHash,
    exportIds: ["run"],
  });
  const run = { actionRunId: `remote-run-${crypto.randomUUID()}`, outputSlot: "text" };
  const invocationId = durableRunIdempotencyKey(run);
  const calls: { url: string; references: unknown }[] = [];
  const invoke = createCloudActionInvoker(bindings, {
    userIdForProject: async () => userId,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        references: JSON.parse(String(init.body)).references,
      });
      return Response.json({
        protocol: "clash.plugin.result/v1",
        invocationId,
        status: "completed",
        outputs: [{ slot: "text", kind: "value", value: "echo" }],
      });
    }) as typeof fetch,
  });
  const result = await invoke({
    binding: remoteBinding,
    invocationId,
    taskId: run.actionRunId,
    outputSlot: run.outputSlot,
    projectId: "project-remote",
    input: { values: { prompt: "hi" }, references: [] },
    actor: { kind: "user", id: userId },
    timeoutMs: 10_000,
  });
  expect(result).toMatchObject({
    status: "completed",
    outputs: [{ slot: "text", value: "echo" }],
  });
  expect(calls).toEqual([
    { url: "https://plugins.example.com/invoke", references: [] },
  ]);
});
