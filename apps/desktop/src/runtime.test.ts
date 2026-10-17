import { describe, expect, it } from "vitest";
import {
  resolveDesktopHostStartupTimeoutMs,
  resolveDesktopRendererUrl,
  resolveDesktopRuntime,
  resolveDesktopSourceHostDaemonEnv,
  resolveDesktopSourceHostNodeArgs,
  shouldWatchDesktopSourceHost,
} from "./runtime";

describe("desktop runtime", () => {
  it("requires a live renderer URL in unpackaged development", () => {
    expect(
      resolveDesktopRendererUrl({
        isPackaged: false,
        forgeDevServerUrl: "http://127.0.0.1:3001",
        explicitWebUrl: undefined,
      }),
    ).toBe("http://127.0.0.1:3001");
    expect(
      resolveDesktopRendererUrl({
        isPackaged: false,
        forgeDevServerUrl: undefined,
        explicitWebUrl: "http://127.0.0.1:4173",
      }),
    ).toBe("http://127.0.0.1:4173");
    expect(() =>
      resolveDesktopRendererUrl({
        isPackaged: false,
        forgeDevServerUrl: undefined,
        explicitWebUrl: undefined,
      }),
    ).toThrow(
      "Desktop development requires MAIN_WINDOW_VITE_DEV_SERVER_URL",
    );
  });

  it("uses packaged protocol assets only in packaged builds", () => {
    expect(
      resolveDesktopRendererUrl({
        isPackaged: true,
        forgeDevServerUrl: undefined,
        explicitWebUrl: undefined,
      }),
    ).toBeUndefined();

    expect(
      resolveDesktopRendererUrl({
        isPackaged: false,
        useBuiltRenderer: true,
        forgeDevServerUrl: undefined,
        explicitWebUrl: undefined,
      }),
    ).toBeUndefined();
  });

  it("accepts an explicit positive host startup timeout without changing the default", () => {
    expect(resolveDesktopHostStartupTimeoutMs("60000")).toBe(60_000);
    expect(resolveDesktopHostStartupTimeoutMs(undefined)).toBeUndefined();
    expect(resolveDesktopHostStartupTimeoutMs("0")).toBeUndefined();
    expect(resolveDesktopHostStartupTimeoutMs("not-a-timeout")).toBeUndefined();
  });

  it("allows isolated E2E runs to disable source-host restarts", () => {
    expect(shouldWatchDesktopSourceHost(undefined)).toBe(false);
    expect(shouldWatchDesktopSourceHost("1")).toBe(true);
    expect(shouldWatchDesktopSourceHost("0")).toBe(false);
  });

  it("runs the source host in one process unless file watching is explicitly enabled", () => {
    expect(
      resolveDesktopSourceHostNodeArgs({
        watch: false,
        tsxLoaderPath: "/workspace/tsx/loader.mjs",
        tsxCliPath: "/workspace/tsx/cli.mjs",
        tsconfigPath: "/workspace/tsconfig.json",
        pluginsRoot: "/workspace/plugins",
      }),
    ).toEqual(["--import", "/workspace/tsx/loader.mjs"]);
  });

  it("excludes rebuilt plugin payloads from the source-host watcher", () => {
    expect(
      resolveDesktopSourceHostNodeArgs({
        watch: true,
        tsxLoaderPath: "/workspace/tsx/loader.mjs",
        tsxCliPath: "/workspace/tsx/cli.mjs",
        tsconfigPath: "/workspace/tsconfig.json",
        pluginsRoot: "/workspace/plugins",
      }),
    ).toEqual([
      "/workspace/tsx/cli.mjs",
      "watch",
      "--exclude",
      "/workspace/plugins/*/dist/**",
      "--tsconfig",
      "/workspace/tsconfig.json",
    ]);
  });

  it("reserves one port for every child of a source-host watcher", async () => {
    const resolvePort = async () => ({
      port: 54321,
      source: "ephemeral" as const,
      preferredPort: 49321,
    });

    await expect(
      resolveDesktopSourceHostDaemonEnv(
        {
          sourceHost: true,
          watchSourceHost: true,
          envPort: undefined,
        },
        resolvePort,
      ),
    ).resolves.toEqual({ PORT: "54321" });
    await expect(
      resolveDesktopSourceHostDaemonEnv(
        {
          sourceHost: true,
          watchSourceHost: false,
          envPort: undefined,
        },
        resolvePort,
      ),
    ).resolves.toEqual({});
  });

  it("derives local API and WebSocket endpoints from the API port", () => {
    expect(resolveDesktopRuntime({ apiPort: 49321 })).toEqual({
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:49321",
      wsBaseUrl: "ws://127.0.0.1:49321",
      webUrl: "clash://app/",
      capabilities: {
        assets: { storage: "local", signing: "unsigned", upload: "local" },
        workflows: { runner: "local-node", mediaPostprocess: "disabled" },
        loro: { persistence: "local", sync: "local-websocket" },
        host: { timelineRender: "available", textRevisions: "available", localAudio: "available" },
        auth: { mode: "local-user" },
      },
    });
  });

  it("allows environment overrides for desktop development", () => {
    expect(
      resolveDesktopRuntime({
        apiPort: 49321,
        apiBaseUrl: "http://localhost:8788",
        wsBaseUrl: "ws://localhost:8788",
        webUrl: "http://localhost:3001",
      }),
    ).toEqual({
      mode: "desktop",
      apiBaseUrl: "http://localhost:8788",
      wsBaseUrl: "ws://localhost:8788",
      webUrl: "http://localhost:3001",
      capabilities: {
        assets: { storage: "local", signing: "unsigned", upload: "local" },
        workflows: { runner: "local-node", mediaPostprocess: "disabled" },
        loro: { persistence: "local", sync: "local-websocket" },
        host: { timelineRender: "available", textRevisions: "available", localAudio: "available" },
        auth: { mode: "local-user" },
      },
    });
  });
});
