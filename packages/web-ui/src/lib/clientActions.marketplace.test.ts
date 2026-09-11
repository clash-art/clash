import { afterEach, describe, expect, it, vi } from "vitest";

import {
  marketplaceInstallAction,
  marketplaceInstallPlugin,
  marketplaceInstallSkill,
  marketplaceUninstallSkill,
  type RegistryItem,
} from "./clientActions.js";

const skill: RegistryItem = {
  id: "clash.video.sd25-pe",
  name: "sd25-pe",
  type: "skill",
  installation: { kind: "skill", skillId: "clash.video.sd25-pe" },
};

describe("marketplace skill actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks local-api to install a trusted registry id instead of posting a skill definition", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ installed: true, skillId: skill.id }));
    vi.stubGlobal("fetch", fetchMock);

    await marketplaceInstallSkill(skill);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/marketplace/skills/clash.video.sd25-pe/install",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("asks local-api to uninstall the same trusted registry id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await marketplaceUninstallSkill(skill.id);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/marketplace/skills/clash.video.sd25-pe/install",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("asks local-api to install an official executable plugin by package id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ installed: true, id: "clash.storyboard" }));
    vi.stubGlobal("fetch", fetchMock);

    await marketplaceInstallPlugin({
      id: "clash.storyboard",
      packageId: "clash.storyboard",
      name: "Storyboard",
      type: "plugin",
      runtime: "local",
      installation: { kind: "executable-plugin", packageId: "clash.storyboard", pluginId: "clash.storyboard" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/marketplace/plugins/clash.storyboard/install",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

it("never falls back to storing an arbitrary Action manifest, even when it has a package id", async () => {
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  for (const packageId of [undefined, "unverified.package"]) {
    await expect(marketplaceInstallAction({ id: "worker", name: "Worker", type: "action", workerUrl: "https://example.invalid", packageId })).rejects.toThrow(/retired|unsupported/i);
  }
  expect(request).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("does not trust a plugin package id or an unconfirmed installation response", async () => {
  const item: RegistryItem = { id: "example.plugin", packageId: "example.plugin", type: "plugin", runtime: "local", name: "Plugin" };
  const request = vi.fn().mockResolvedValue(Response.json({ installed: false })); vi.stubGlobal("fetch", request);
  await expect(marketplaceInstallPlugin(item)).rejects.toThrow(/does not support/);
  expect(request).not.toHaveBeenCalled();
  await expect(marketplaceInstallPlugin({ ...item, installation: { kind: "executable-plugin", packageId: item.packageId!, pluginId: item.id } })).rejects.toThrow(/did not confirm/);
  vi.unstubAllGlobals();
});
