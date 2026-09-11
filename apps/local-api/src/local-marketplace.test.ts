import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalApiApp } from "./app";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function app(options: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-marketplace-contract-"));
  dirs.push(dataDir);
  return createLocalApiApp({ dataDir, ...options });
}
const plugin = {
  id: "example.plugin",
  packageId: "example.plugin",
  name: "Plugin",
  type: "plugin",
  runtime: "local",
};
it("advertises installation only when the matching Host installer and active-package verifier exist", async () => {
  const unsupported = await app({
    marketplacePlugins: [plugin],
    installMarketplacePlugin: async () => ({ installed: true }),
  });
  const catalog = await (
    await unsupported.request("/api/marketplace/registry")
  ).json();
  expect(catalog.plugins[0]).not.toHaveProperty("installation");
  const supported = await app({
    marketplacePlugins: [plugin, { ...plugin, id: "builtin", builtIn: true }],
    installMarketplacePlugin: async () => ({ installed: true }),
    pluginPackages: { read: async () => ({}) },
  });
  const next = await (
    await supported.request("/api/marketplace/registry")
  ).json();
  expect(next.plugins[0].installation).toMatchObject({
    kind: "executable-plugin",
    packageId: plugin.packageId,
    pluginId: plugin.id,
  });
  expect(next.plugins[1]).not.toHaveProperty("installation");
});
it("does not claim installed when the callback returns success without a valid active package", async () => {
  const install = vi.fn(async () => ({ installed: true }));
  const host = await app({
    marketplacePlugins: [plugin],
    installMarketplacePlugin: install,
    pluginPackages: {
      read: async () => {
        throw new Error("Missing activation receipt");
      },
    },
  });
  const response = await host.request(
    `/api/marketplace/plugins/${plugin.packageId}/install`,
    { method: "POST" },
  );
  expect(response.ok).toBe(false);
  expect(await response.text()).toContain("activation receipt");
  expect(install).toHaveBeenCalledWith(plugin.packageId);
  expect(
    (
      await host.request("/api/marketplace/plugins/untrusted/install", {
        method: "POST",
      })
    ).status,
  ).toBe(404);
});
it("retires Action writes even when a legacy injection is present, preserving historical reads and removal", async () => {
  const install = vi.fn(),
    remove = vi.fn();
  const host = await app({
    installMarketplaceAction: install,
    listInstalledMarketplaceActions: async () => [{ actionId: "old" }],
    uninstallMarketplaceAction: remove,
  });
  expect(
    (
      await host.request("/api/settings/actions", {
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(410);
  expect(
    (
      await host.request("/api/marketplace/actions/old/install", {
        method: "POST",
      })
    ).status,
  ).toBe(410);
  expect(install).not.toHaveBeenCalled();
  expect(await (await host.request("/api/settings/actions")).json()).toEqual([
    { actionId: "old", removable: true },
  ]);
  expect(
    (await host.request("/api/settings/actions/old", { method: "DELETE" }))
      .status,
  ).toBe(204);
  expect(remove).toHaveBeenCalledWith("old");
});
