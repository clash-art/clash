import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createBoundedJsonlLogSink,
  installProcessStdioCapture,
} from "@clash/shared-runtime/observability";
import {
  clashHomeForLocalDataDir,
  createHeadlessDirectorStageRenderer,
  defaultLocalApiDataDir,
  prepareDevelopmentBundledPlugins,
  startLocalApiServer,
} from "@clash/local-api";
import { createDevelopmentBrowserAssets } from "./development-browser-assets.js";

type LocalApiServer = Awaited<ReturnType<typeof startLocalApiServer>>;

let server: LocalApiServer | undefined;
let stopping = false;
const dataDir = defaultLocalApiDataDir(process.env);
const logSink = createBoundedJsonlLogSink({
  directory: join(clashHomeForLocalDataDir(dataDir), "logs", "local-api"),
  filePrefix: "local-api",
  maxBytes: 5 * 1024 * 1024,
  maxFiles: 5,
});
const observability = installProcessStdioCapture({
  component: "local-api",
  sink: logSink,
  maxEventsPerWindow: 200,
  windowMs: 10_000,
});
observability.event("info", "process.started", { pid: process.pid });

async function closeServer(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  observability.event("info", "server.stopping", { exitCode });
  if (!server) {
    observability.close();
    process.exit(exitCode);
    return;
  }
  await new Promise<void>((resolveClose) => {
    server!.close(() => resolveClose());
  });
  observability.event("info", "server.stopped", { exitCode });
  observability.close();
  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void closeServer(0);
});
process.once("SIGTERM", () => {
  void closeServer(0);
});
process.once("uncaughtExceptionMonitor", (error, origin) => {
  observability.event("error", "process.uncaught_exception", {
    origin,
    error,
  });
});

async function main(): Promise<void> {
  const startedBy =
    process.env.CLASH_DAEMON_STARTED_BY === "desktop"
      ? "desktop"
      : process.env.CLASH_DAEMON_STARTED_BY === "cli"
        ? "cli"
        : "plugin";
  const sourceRuntime = process.env.CLASH_SOURCE_RUNTIME === "1";
  const pluginDevelopment = sourceRuntime
    ? await prepareDevelopmentBundledPlugins({
        actionsRoot: join(clashHomeForLocalDataDir(dataDir), "actions"),
      })
    : undefined;
  if (pluginDevelopment && pluginDevelopment.rebuilt.length > 0) {
    observability.event("info", "plugins.rebuilt", { pluginIds: pluginDevelopment.rebuilt });
  }
  const configuredDirectorBundle =
    process.env.CLASH_DIRECTOR_BUNDLE_PATH?.trim();
  const developmentAssets =
    sourceRuntime && !configuredDirectorBundle
      ? createDevelopmentBrowserAssets({
          repoRoot: fileURLToPath(new URL("../../..", import.meta.url)),
        })
      : undefined;
  const directorBundle =
    configuredDirectorBundle ||
    (sourceRuntime
      ? developmentAssets!.directorBundleDir
      : fileURLToPath(new URL("./director-bundle", import.meta.url)));
  if (
    (configuredDirectorBundle || !sourceRuntime) &&
    !existsSync(directorBundle)
  ) {
    throw new Error(`Director bundle is missing: ${directorBundle}`);
  }
  const directorStageRenderer = createHeadlessDirectorStageRenderer({
    bundleDir: directorBundle,
    ...(configuredDirectorBundle || !sourceRuntime
      ? {}
      : { prepareBundle: () => developmentAssets!.prepareDirectorBundle() }),
    openBrowser: async () => {
      const renderer = await import("@remotion/renderer");
      return renderer.openBrowser("chrome", {
        chromiumOptions: { gl: "angle" },
        logLevel: "error",
      }) as never;
    },
  });
  const runDir =
    process.env.CLASH_HOST_RUN_DIR?.trim() ||
    join(clashHomeForLocalDataDir(dataDir), "run");
  server = await startLocalApiServer({
    port: Number(process.env.PORT ?? 0),
    dataDir,
    agentRuntime: process.env.CLASH_AGENT_RUNTIME === "disabled" ? "disabled" : "enabled",
    projectRendererRoot: process.env.CLASH_PROJECT_RENDERER_ROOT,
    directorStageRenderer,
    discovery: {
      enabled: true,
      runDir,
      launchMode: "user-service",
      startedBy,
    },
  });
  observability.event("info", "server.ready", {
    pid: process.pid,
    startedBy,
  });
  if (process.env.CLASH_LOCAL_API_WRAPPER_ENTRY === "1") {
    observability.stopStdioForwarding();
  }
}

void main().catch((error) => {
  observability.event("error", "process.failed", {
    error,
  });
  observability.close();
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
