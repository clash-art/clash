import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, normalize, resolve } from "node:path";

import { app } from "electron";
import {
  createLocalDaemonBootstrap,
  launchDetachedLocalDaemon,
  resolveLocalDaemonRuntimeFingerprint,
} from "@clash/shared-runtime/local-daemon";
import {
  clashHomeForLocalDataDir,
  resolveClashProfile,
} from "@clash/shared-runtime/local-paths";

import { DEFAULT_DESKTOP_API_PORT } from "../api-port";
import {
  prependPythonPath,
  resolveAcpBinDir,
  resolveAgentBundleRoot,
  resolveClashBuiltinPluginRoot,
  resolveClashCliEntryPath,
  resolveClashCliNodePath,
  resolveClashDevTsconfigPath,
  resolveClashHostEntryPath,
  resolveClashSdkPythonPath,
} from "../paths";
import {
  resolveDesktopHostStartupTimeoutMs,
  resolveDesktopRendererUrl,
  resolveDesktopRuntime,
  resolveDesktopSourceHostDaemonEnv,
  resolveDesktopSourceHostNodeArgs,
  shouldWatchDesktopSourceHost,
  type DesktopRuntime,
} from "../runtime";
import type { DesktopControllerLogger } from "./types";

const require = createRequire(import.meta.url);
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

export function createDesktopRuntimeController({
  moduleDir,
  hostDiagnosticLogPath,
  log,
}: {
  moduleDir: string;
  hostDiagnosticLogPath: string;
  log: DesktopControllerLogger;
}) {
  let runtime: DesktopRuntime | null = null;

  function current(): DesktopRuntime {
    if (!runtime) throw new Error("Desktop runtime is not initialized");
    return runtime;
  }

  async function configureAcpHarnessEnvironment(
    dataDir: string,
  ): Promise<void> {
    const acpBinDir = resolveAcpBinDir(dataDir);
    process.env.CLASH_ACP_BIN_DIR =
      process.env.CLASH_ACP_TEST_BIN_DIR || acpBinDir;
    process.env.OPENMA_ACP_BIN_DIR =
      process.env.CLASH_ACP_TEST_BIN_DIR || acpBinDir;
    process.env.CLASH_AGENT_BUNDLE_ROOT = resolveAgentBundleRoot({
      isPackaged: app.isPackaged,
      moduleDir,
      resourcesPath: process.resourcesPath,
    });
    const clashCliEntryPath = resolveClashCliEntryPath({
      isPackaged: app.isPackaged,
      moduleDir,
      resourcesPath: process.resourcesPath,
    });
    process.env.CLASH_CLI_ENTRY_PATH = clashCliEntryPath;
    if (!app.isPackaged) {
      process.env.TSX_TSCONFIG_PATH = normalize(
        resolveClashDevTsconfigPath(moduleDir),
      );
      process.env.CLASH_BUILTIN_PLUGIN_ROOT =
        resolveClashBuiltinPluginRoot(moduleDir);
    }
    const clashCliNodePath = resolveClashCliNodePath({
      isPackaged: app.isPackaged,
      moduleDir,
      resourcesPath: process.resourcesPath,
    });
    if (clashCliNodePath) process.env.CLASH_CLI_NODE_PATH = clashCliNodePath;
    process.env.CLASH_NODE_EXEC_PATH ??= process.execPath;
    const clashSdkPythonPath = resolveClashSdkPythonPath({
      envPythonSdkPath: process.env.CLASH_PYTHON_SDK_PATH,
      isPackaged: app.isPackaged,
      moduleDir,
      resourcesPath: process.resourcesPath,
    });
    process.env.PYTHONPATH = prependPythonPath(
      process.env.PYTHONPATH,
      clashSdkPythonPath,
    );

    await mkdir(acpBinDir, { recursive: true });
  }

  async function initialize(dataDir: string): Promise<DesktopRuntime> {
    let apiPort = DEFAULT_DESKTOP_API_PORT;
    let apiBaseUrl = process.env.CLASH_API_BASE_URL;
    await configureAcpHarnessEnvironment(dataDir);

    if (!apiBaseUrl) {
      const runDir = join(clashHomeForLocalDataDir(dataDir), "run");
      const hostEntryPath = resolveClashHostEntryPath({
        isPackaged: app.isPackaged,
        moduleDir,
        resourcesPath: process.resourcesPath,
      });
      const sourceHost = hostEntryPath.endsWith(".ts");
      const watchSourceHost = shouldWatchDesktopSourceHost(
        process.env.CLASH_DESKTOP_SOURCE_HOST_WATCH,
      );
      const runtimeFingerprint =
        resolveLocalDaemonRuntimeFingerprint(hostEntryPath);
      const hostStartupTimeoutMs = resolveDesktopHostStartupTimeoutMs(
        process.env.CLASH_DESKTOP_HOST_STARTUP_TIMEOUT_MS,
      );
      const daemon = createLocalDaemonBootstrap({
        runDir,
        profile: resolveClashProfile(process.env),
        runtimeFingerprint,
        startupTimeoutMs: hostStartupTimeoutMs,
        // Source-watch restarts briefly leave the stable supervisor alive while
        // its HTTP child is replaced. Reuse that writer once it is healthy.
        unhealthyRecoveryTimeoutMs: hostStartupTimeoutMs ?? 15_000,
        launch: async () => {
          const sourceHostDaemonEnv = await resolveDesktopSourceHostDaemonEnv({
            sourceHost,
            watchSourceHost,
            envPort: process.env.CLASH_LOCAL_API_PORT,
          });
          return launchDetachedLocalDaemon({
            entryPath: hostEntryPath,
            diagnosticLogPath: hostDiagnosticLogPath,
            runtimeFingerprint,
            nodeArgs: sourceHost
              ? resolveDesktopSourceHostNodeArgs({
                  watch: watchSourceHost,
                  tsxLoaderPath: require.resolve("tsx"),
                  tsxCliPath: require.resolve("tsx/cli"),
                  tsconfigPath: resolveClashDevTsconfigPath(moduleDir),
                  pluginsRoot: resolve(
                    resolveClashBuiltinPluginRoot(moduleDir),
                    "..",
                  ),
                })
              : undefined,
            cliEntryPath: resolveClashCliEntryPath({
              isPackaged: app.isPackaged,
              moduleDir,
              resourcesPath: process.resourcesPath,
            }),
            dataDir,
            runDir,
            env: process.env,
            nodePath: process.execPath,
            nodeVersion: process.versions.node,
            electronRunAsNode: true,
            daemonEnv: {
              ...sourceHostDaemonEnv,
              CLASH_DAEMON_STARTED_BY: "desktop",
              CLASH_NODE_EXEC_PATH: process.execPath,
              CLASH_AGENT_BUNDLE_ROOT: resolveAgentBundleRoot({
                isPackaged: app.isPackaged,
                moduleDir,
                resourcesPath: process.resourcesPath,
              }),
              ...(process.env.CLASH_CLI_NODE_PATH
                ? { NODE_PATH: process.env.CLASH_CLI_NODE_PATH }
                : {}),
              ...(sourceHost
                ? {
                    CLASH_SOURCE_RUNTIME: "1",
                    TSX_TSCONFIG_PATH: resolveClashDevTsconfigPath(moduleDir),
                    CLASH_BUILTIN_PLUGIN_ROOT:
                      resolveClashBuiltinPluginRoot(moduleDir),
                  }
                : {}),
            },
          });
        },
      });
      try {
        const host = await daemon.ensureDaemon();
        apiBaseUrl = host.endpoint;
        log.info(
          `[desktop] using detached Clash host ${host.hostId} at ${host.endpoint} (pid ${host.pid}, started by ${host.startedBy})`,
        );
        const discoveredPort = Number(new URL(host.endpoint).port);
        if (Number.isInteger(discoveredPort) && discoveredPort > 0)
          apiPort = discoveredPort;
      } finally {
        await daemon.close();
      }
    }

    runtime = resolveDesktopRuntime({
      apiPort,
      apiBaseUrl,
      wsBaseUrl: process.env.CLASH_WS_BASE_URL,
      webUrl: resolveDesktopRendererUrl({
        isPackaged: app.isPackaged,
        useBuiltRenderer: process.argv.includes("--desktop-static-renderer"),
        forgeDevServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
        explicitWebUrl: process.env.CLASH_WEB_URL,
      }),
    });
    process.env.CLASH_DESKTOP_RUNTIME = JSON.stringify(runtime);
    return runtime;
  }

  return {
    initialize,
    current,
  };
}
