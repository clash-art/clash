import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHostPluginScopes } from "./host-plugin-scope";
import { createClashUserConfigStore } from "./user-config";

it("persists selected projects, excludes other projects and global discovery, and restores global scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clash-plugin-scope-"));
  try {
    const scopes = createHostPluginScopes(createClashUserConfigStore(dir));
    await scopes.set("example.plugin", { scope: "projects", projectIds: ["a", "b"] });
    const reloaded = createHostPluginScopes(createClashUserConfigStore(dir));
    expect(await reloaded.allows("example.plugin", "a")).toBe(true);
    expect(await reloaded.allows("example.plugin", "b")).toBe(true);
    expect(await reloaded.allows("example.plugin", "c")).toBe(false);
    expect(await reloaded.allows("example.plugin")).toBe(false);
    await reloaded.set("example.plugin", { scope: "global" });
    expect(await scopes.allows("example.plugin", "new-project")).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
