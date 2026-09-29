import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCloudAccounts } from "./cloud-accounts.js";
it("keeps credentials bound to an origin across selection, restart and logout", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-cloud-account-"));
  try {
    const a = createCloudAccounts(dataDir);
    await a.save("https://official.example", {
      token: "official-secret",
      user: { id: "a", email: "a@example.test", name: "A" },
    });
    await a.save("https://selfhost.example/", {
      token: "self-secret",
      user: { id: "b", email: "b@example.test", name: "B" },
    });
    await a.select("https://selfhost.example");
    expect(await a.token("https://official.example")).toBe("official-secret");
    expect(await a.token("https://unknown.example")).toBeUndefined();
    expect(JSON.stringify(await a.status())).not.toContain("secret");
    const restarted = createCloudAccounts(dataDir);
    expect((await restarted.status()).serviceUrl).toBe(
      "https://selfhost.example",
    );
    await restarted.logout("https://selfhost.example");
    expect(await a.token("https://selfhost.example")).toBeUndefined();
    expect(await a.token("https://official.example")).toBe("official-secret");
    await expect(
      a.select("https://user:password@evil.example"),
    ).rejects.toThrow();
    await expect(a.select("http://public.example")).rejects.toThrow();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
it("uses legacy credentials only for their explicitly configured origin and logout cannot revive them", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-cloud-legacy-"));
  try {
    const { createClashUserConfigStore } = await import("./user-config.js");
    const store = createClashUserConfigStore(dataDir);
    await store.setSection("sync", {
      remote_loro: { url: "https://old.example" },
    });
    await store.updateCredentials(() => ({ syncRemoteLoroToken: "legacy" }));
    const accounts = createCloudAccounts(dataDir);
    expect(await accounts.resolveToken("https://old.example")).toBe("legacy");
    expect(await accounts.resolveToken("https://new.example")).toBeUndefined();
    await accounts.logout("https://old.example");
    expect(await accounts.resolveToken("https://old.example")).toBeUndefined();
    expect(JSON.stringify(await store.getCredentials())).not.toContain(
      "legacy",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
it("changing the default service does not forward or discard the prior service token", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-cloud-switch-"));
  try {
    const { createLocalSyncConfigStore } = await import("./sync-config.js");
    const sync = createLocalSyncConfigStore({ dataDir, env: {} });
    await sync.updateFromRequest({
      mode: "cloud-sync",
      remote_loro_url: "https://a.example",
      remote_loro_token: "a-token",
    });
    await sync.updateFromRequest({
      mode: "cloud-sync",
      remote_loro_url: "https://b.example",
    });
    const accounts = createCloudAccounts(dataDir);
    expect(await accounts.resolveToken("https://b.example")).toBeUndefined();
    expect(await accounts.resolveToken("https://a.example")).toBe("a-token");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
