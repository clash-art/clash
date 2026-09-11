import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { createClashUserConfigStore, watchClashUserConfig } from "./user-config";

it("updates separate installation entries under the shared Host configuration lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-config-skill-scopes-"));
  try {
    const one = createClashUserConfigStore(root);
    const two = createClashUserConfigStore(root);
    await Promise.all([
      one.updateSection("skills", (current) => ({ ...(current as object ?? {}), one: { scope: "global" } })),
      two.updateSection("skills", (current) => ({ ...(current as object ?? {}), two: { scope: "projects", projectIds: ["p"] } })),
    ]);
    expect(await one.getSection("skills")).toEqual({ one: { scope: "global" }, two: { scope: "projects", projectIds: ["p"] } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

describe("self-hosted user configuration", () => {
  it("serializes independent writers and preserves unrelated YAML sections", async () => {
    const clashHome = await mkdtemp(join(tmpdir(), "clash-user-config-"));
    try {
      const first = createClashUserConfigStore(clashHome);
      const second = createClashUserConfigStore(clashHome);

      await Promise.all([
        first.setSection("harnesses", { enabled: ["codex-acp"] }),
        second.setSection("audio", { asr: { enabled: true } }),
      ]);

      const parsed = parse(await readFile(join(clashHome, "config.yaml"), "utf8"));
      expect(parsed).toMatchObject({
        version: 1,
        harnesses: { enabled: ["codex-acp"] },
        audio: { asr: { enabled: true } },
      });
    } finally {
      await rm(clashHome, { recursive: true, force: true });
    }
  });

  it("refuses to replace a valid non-mapping YAML document", async () => {
    const clashHome = await mkdtemp(join(tmpdir(), "clash-user-config-root-"));
    try {
      const configPath = join(clashHome, "config.yaml");
      await writeFile(configPath, "- user-owned\n- document\n");
      const store = createClashUserConfigStore(clashHome);

      await expect(
        store.setSection("harnesses", { enabled: ["codex-acp"] }),
      ).rejects.toThrow("config.yaml root must be a mapping");
      await expect(readFile(configPath, "utf8")).resolves.toBe(
        "- user-owned\n- document\n",
      );
    } finally {
      await rm(clashHome, { recursive: true, force: true });
    }
  });

  it("rejects malformed public storage settings before any plugin can use them", async () => {
    // Regression caught: permissive YAML would turn a misspelled provider into a silently missing
    // Host capability even though the settings file appeared configured.
    const clashHome = await mkdtemp(join(tmpdir(), "clash-user-config-storage-"));
    try {
      await writeFile(
        join(clashHome, "config.yaml"),
        "version: 1\npublic_storage:\n  mode: byos\n  provider: s-three\n  bucket: assets\n",
      );

      await expect(
        createClashUserConfigStore(clashHome).getSection("public_storage"),
      ).rejects.toThrow("public_storage.provider");
    } finally {
      await rm(clashHome, { recursive: true, force: true });
    }
  });

  it("observes editor saves from the parent directory and reloads valid YAML", async () => {
    const clashHome = await mkdtemp(join(tmpdir(), "clash-user-config-watch-"));
    let stop: () => void = () => undefined;
    try {
      const store = createClashUserConfigStore(clashHome);
      await store.setSection("harnesses", { enabled: ["codex-acp"] });
      const changed = new Promise<Record<string, unknown>>((resolve, reject) => {
        stop = watchClashUserConfig(clashHome, {
          debounceMs: 10,
          onChange: resolve,
          onError: reject,
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      await writeFile(
        join(clashHome, "config.yaml"),
        "version: 1\nharnesses:\n  enabled:\n    - codex-acp\n    - claude-acp\n",
      );

      await expect(changed).resolves.toMatchObject({
        harnesses: { enabled: ["codex-acp", "claude-acp"] },
      });
    } finally {
      stop();
      await rm(clashHome, { recursive: true, force: true });
    }
  });

  it("serializes editor reload callbacks so an older reconcile cannot finish last", async () => {
    const clashHome = await mkdtemp(join(tmpdir(), "clash-user-config-watch-serial-"));
    let stop: () => void = () => undefined;
    try {
      const store = createClashUserConfigStore(clashHome);
      await store.setSection("harnesses", { enabled: ["codex-acp"] });
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstStarted!: () => void;
      const firstRunning = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      let activeCallbacks = 0;
      let maxActiveCallbacks = 0;
      const applied: string[][] = [];
      const secondApplied = vi.fn();
      stop = watchClashUserConfig(clashHome, {
        debounceMs: 5,
        async onChange(config) {
          activeCallbacks += 1;
          maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
          const enabled = (
            config.harnesses as { enabled?: string[] } | undefined
          )?.enabled ?? [];
          applied.push(enabled);
          if (applied.length === 1) {
            firstStarted();
            await firstBlocked;
          } else {
            secondApplied();
          }
          activeCallbacks -= 1;
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      await writeFile(
        join(clashHome, "config.yaml"),
        "version: 1\nharnesses:\n  enabled:\n    - codex-acp\n    - claude-acp\n",
      );
      await firstRunning;
      await writeFile(
        join(clashHome, "config.yaml"),
        "version: 1\nharnesses:\n  enabled:\n    - codex-acp\n    - gemini\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(maxActiveCallbacks).toBe(1);
      releaseFirst();
      await vi.waitFor(() => expect(secondApplied).toHaveBeenCalledOnce());
      expect(applied.at(-1)).toEqual(["codex-acp", "gemini"]);
    } finally {
      stop();
      await rm(clashHome, { recursive: true, force: true });
    }
  });

  it("moves legacy CLI JSON into YAML and the shared credential store once", async () => {
    const clashHome = await mkdtemp(join(tmpdir(), "clash-user-config-migrate-"));
    try {
      await writeFile(
        join(clashHome, "config.json"),
        JSON.stringify({
          serverUrl: "https://api.example",
          apiKey: "clsh_legacy",
        }),
      );
      const store = createClashUserConfigStore(clashHome);

      await expect(store.getSection("server")).resolves.toEqual({
        url: "https://api.example",
      });
      await expect(store.getCredentials()).resolves.toMatchObject({
        cliApiKey: "clsh_legacy",
      });
      await expect(readFile(join(clashHome, "config.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(clashHome, { recursive: true, force: true });
    }
  });

  it("keeps legacy root migration idempotent across concurrent section stores", async () => {
    const clashHome = await mkdtemp(join(tmpdir(), "clash-user-config-race-"));
    try {
      await writeFile(
        join(clashHome, "config.json"),
        JSON.stringify({ serverUrl: "https://api.example", apiKey: "clsh_race" }),
      );
      const stores = [
        createClashUserConfigStore(clashHome),
        createClashUserConfigStore(clashHome),
        createClashUserConfigStore(clashHome),
      ];

      await expect(Promise.all([
        stores[0].getSection("harnesses"),
        stores[1].getSection("audio"),
        stores[2].getSection("sync"),
      ])).resolves.toEqual([null, null, null]);
      await expect(stores[0].getSection("server")).resolves.toEqual({
        url: "https://api.example",
      });
      await expect(stores[1].getCredentials()).resolves.toMatchObject({
        cliApiKey: "clsh_race",
      });
    } finally {
      await rm(clashHome, { recursive: true, force: true });
    }
  });
});
