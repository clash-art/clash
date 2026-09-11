import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { clashHomeForLocalDataDir } from "@clash/shared-runtime/local-paths";
import {
  prependPythonPath,
  resolveAcpBinDir,
  resolveAgentBundleRoot,
  resolveClashBuiltinPluginRoot,
  resolveClashCliEntryPath,
  resolveClashCliNodePath,
  resolveClashDevTsconfigPath,
  resolveClashHostEntryPath,
  resolveDesktopStatePaths,
  resolveClashSdkPythonPath,
  resolveWebDistDir,
} from "./paths";

describe("desktop paths", () => {
  it("places logs beside Host logs even with a custom data directory name", () => {
    const dataDir = "/tmp/custom-host-store";
    expect(resolveDesktopStatePaths(dataDir).logs).toBe(join(clashHomeForLocalDataDir(dataDir), "logs", "desktop"));
  });
  it("keeps mutable NLE handoffs under the canonical Clash home", () => {
    const mainSource = readFileSync(
      new URL("./main.ts", import.meta.url),
      "utf8",
    );
    const windowControllerSource = readFileSync(
      new URL("./controller/windows.ts", import.meta.url),
      "utf8",
    );

    expect(mainSource).not.toContain('app.getPath("userData")');
    expect(windowControllerSource).toContain(
      'join(dirname(dataDir), "nle-handoffs")',
    );
  });

  it("keeps Electron-owned browser state below the canonical Clash home", () => {
    expect(resolveDesktopStatePaths("/Users/me/.clash/local-api")).toEqual({
      root: join("/Users/me/.clash", "desktop"),
      userData: join("/Users/me/.clash", "desktop", "user-data"),
      sessionData: join("/Users/me/.clash", "desktop", "session-data"),
      logs: join("/Users/me/.clash", "logs", "desktop"),
      crashDumps: join("/Users/me/.clash", "desktop", "crash-dumps"),
    });
  });

  it("lets an explicit web dist directory override packaged and dev defaults", () => {
    expect(
      resolveWebDistDir({
        envWebDistDir: "/tmp/clash-web",
        isPackaged: true,
        moduleDir: "/app/dist",
        resourcesPath: "/app/resources",
      }),
    ).toBe("/tmp/clash-web");
  });

  it("loads bundled web assets from resources in packaged apps", () => {
    expect(
      resolveWebDistDir({
        isPackaged: true,
        moduleDir: "/app/dist",
        resourcesPath: "/app/resources",
      }),
    ).toBe(join("/app/resources", "web-dist"));
  });

  it("loads the Desktop-owned renderer build outside a packaged app", () => {
    expect(
      resolveWebDistDir({
        isPackaged: false,
        moduleDir: "/repo/apps/desktop/dist",
        resourcesPath: "/app/resources",
      }),
    ).toBe(
      resolve(
        "/repo/apps/desktop/dist",
        "../.vite/renderer/main_window",
      ),
    );
  });

  it("uses the managed ACP install directory in packaged apps", () => {
    expect(resolveAcpBinDir("/Users/me/.clash/local-api")).toBe(
      join("/Users/me/.clash/local-api", "acp-bin"),
    );
  });

  it("uses the managed ACP install directory in development", () => {
    expect(resolveAcpBinDir("/tmp/clash-local-api")).toBe(
      join("/tmp/clash-local-api", "acp-bin"),
    );
  });

  it("exposes the unified Clash runtime from resources for packaged child processes", () => {
    expect(
      resolveClashCliEntryPath({
        isPackaged: true,
        moduleDir: "/app/dist",
        resourcesPath: "/app/resources",
      }),
    ).toBe(join("/app/resources", "clash-runtime", "dispatcher.js"));
    expect(
      resolveClashCliNodePath({
        isPackaged: true,
        moduleDir: "/app/dist",
        resourcesPath: "/app/resources",
      }),
    ).toBe(join("/app/resources", "clash-runtime", "node_modules"));
    expect(
      resolveClashHostEntryPath({
        isPackaged: true,
        moduleDir: "/app/dist",
        resourcesPath: "/app/resources",
      }),
    ).toBe(join("/app/resources", "clash-runtime", "local-api.cjs"));
  });

  it("exposes built-in agents from Resources instead of app.asar", () => {
    expect(
      resolveAgentBundleRoot({
        isPackaged: true,
        moduleDir: "/app/Resources/app.asar/dist",
        resourcesPath: "/app/Resources",
      }),
    ).toBe(join("/app/Resources", "clash-runtime", "agents"));
    expect(
      resolveAgentBundleRoot({
        isPackaged: false,
        moduleDir: "/repo/apps/desktop/dist",
        resourcesPath: "/app/Resources",
      }),
    ).toBe(
      resolve("/repo/apps/desktop/dist", "../../../packages/cli/assets/agents"),
    );
  });

  it("runs host and CLI sources directly in development", () => {
    expect(
      resolveClashCliEntryPath({
        isPackaged: false,
        moduleDir: "/repo/apps/desktop/dist",
        resourcesPath: "/app/resources",
      }),
    ).toBe(
      resolve("/repo/apps/desktop/dist", "../../../packages/cli/src/index.ts"),
    );
    expect(
      resolveClashCliNodePath({
        isPackaged: false,
        moduleDir: "/repo/apps/desktop/dist",
        resourcesPath: "/app/resources",
      }),
    ).toBe(resolve("/repo/apps/desktop/dist", "../../../node_modules"));
    expect(
      resolveClashHostEntryPath({
        isPackaged: false,
        moduleDir: "/repo/apps/desktop/dist",
        resourcesPath: "/app/resources",
      }),
    ).toBe(
      resolve(
        "/repo/apps/desktop/dist",
        "../../../plugins/clash/src/local-api-entry.ts",
      ),
    );
    expect(resolveClashDevTsconfigPath("/repo/apps/desktop/dist")).toBe(
      resolve(
        "/repo/apps/desktop/dist",
        "../../../plugins/clash/tsconfig.dev.json",
      ),
    );
    expect(resolveClashBuiltinPluginRoot("/repo/apps/desktop/dist")).toBe(
      resolve("/repo/apps/desktop/dist", "../../../plugins/clash"),
    );
  });

  it("resolves the bundled local-model Python SDK without losing an existing PYTHONPATH", () => {
    expect(
      resolveClashSdkPythonPath({
        isPackaged: true,
        moduleDir: "/app/Resources/app.asar/dist",
        resourcesPath: "/app/Resources",
      }),
    ).toBe(join("/app/Resources", "clash-sdk", "python"));
    expect(
      resolveClashSdkPythonPath({
        isPackaged: false,
        moduleDir: "/repo/apps/desktop/dist",
        resourcesPath: "/app/Resources",
      }),
    ).toBe(
      resolve("/repo/apps/desktop/dist", "../../../packages/clash-sdk/python"),
    );
    expect(
      resolveClashSdkPythonPath({
        envPythonSdkPath: "/tmp/custom-clash-sdk-python",
        isPackaged: true,
        moduleDir: "/app/Resources/app.asar/dist",
        resourcesPath: "/app/Resources",
      }),
    ).toBe("/tmp/custom-clash-sdk-python");
    expect(
      prependPythonPath("/tmp/user-python", "/app/Resources/clash-sdk/python"),
    ).toBe(
      `/app/Resources/clash-sdk/python${process.platform === "win32" ? ";" : ":"}/tmp/user-python`,
    );
    expect(
      prependPythonPath(
        "/app/Resources/clash-sdk/python",
        "/app/Resources/clash-sdk/python",
      ),
    ).toBe("/app/Resources/clash-sdk/python");
  });
});
