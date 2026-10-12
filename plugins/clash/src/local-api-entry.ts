import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createBoundedJsonlLogSink,
  installProcessStdioCapture,
} from "@clash/shared-runtime/observability";
import {
  clashBrowserWarmupEnabled,
  ensureClashBrowser,
  resolveClashBrowserGlOverride,
} from "@clash/shared-runtime/render-browser";
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
// Aborts an in-flight browser warm-up download so a stopping Host leaves no child behind.
const browserWarmup = new AbortController();
const BROWSER_WARMUP_DELAY_MS = 5_000;
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
  browserWarmup.abort();
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

/**
 * Fetch the render browser in the background so the first render does not wait for it.
 *
 * Strictly best-effort: an offline or library-less machine must still get a working Host, so a
 * failure is one structured log record and nothing else. Renders ensure the browser themselves.
 * The short delay keeps a Host that only lives for one command from starting a large download.
 */
function warmBrowser(): void {
  if (!clashBrowserWarmupEnabled(process.env)) return;
  const timer = setTimeout(() => {
    if (stopping) return;
    void ensureClashBrowser({ signal: browserWarmup.signal }).then(
      (browser) => {
        observability.event("info", "browser.ready", {
          source: browser.source,
          version: browser.version,
          executablePath: browser.executablePath,
        });
      },
      (error) => {
        if (stopping) return;
        observability.event("warn", "browser.warmup_failed", { error });
      },
    );
  }, BROWSER_WARMUP_DELAY_MS);
  timer.unref();
}

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
  // A mistyped backend stops the Host here, by name, rather than failing the first capture.
  const directorGlOverride = await resolveClashBrowserGlOverride(
    async () =>
      (await import("@remotion/renderer")).RenderInternals.validOpenGlRenderers,
  );
  const directorStageRenderer = createHeadlessDirectorStageRenderer({
    bundleDir: directorBundle,
    ...(configuredDirectorBundle || !sourceRuntime
      ? {}
      : { prepareBundle: () => developmentAssets!.prepareDirectorBundle() }),
    ...(directorGlOverride ? { glOverride: directorGlOverride } : {}),
    onGlSelected: ({ gl, reason }) => {
      observability.event("info", "director.browser_gl", { gl, reason });
    },
    openBrowser: async (gl) => {
      const renderer = await import("@remotion/renderer");
      // The pinned headless shell from the Clash browser cache; Remotion's own default would
      // download into the installation's node_modules.
      const browser = await ensureClashBrowser();
      return renderer.openBrowser("chrome", {
        browserExecutable: browser.executablePath,
        chromiumOptions: { gl },
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
  warmBrowser();
}

void main().catch((error) => {
  observability.event("error", "process.failed", {
    error,
  });
  observability.close();
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
