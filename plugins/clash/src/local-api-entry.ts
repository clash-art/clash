import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import {
  createBoundedJsonlLogSink,
  DEFAULT_JSONL_LOG_RETENTION,
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
import {
  clearLocalApiCompileCacheEnvironment,
  enableLocalApiCompileCache,
  localApiCompileCacheDir,
  localApiCompileCacheRoot,
  pruneLocalApiCompileCache,
} from "@clash/shared-runtime/local-compile-cache";
import { createDevelopmentBrowserAssets } from "./development-browser-assets.js";

const dataDir = defaultLocalApiDataDir(process.env);
// Enable the V8 cache as early as this bundle can run. The launcher also sets NODE_COMPILE_CACHE
// before spawn so the main bundle itself is cached; this call covers lazily imported plugin
// modules and direct `node local-api.cjs` launches. Failure is data, never a startup error.
const compileCache = enableLocalApiCompileCache({ env: process.env });
// Resolve the fingerprint key before clearing the selectors. The launcher's Node child would
// otherwise inherit NODE_COMPILE_CACHE and populate this Host's bytecode directory with modules
// from ACP agents, the Codex/Claude CLIs and plugin workers. Honor either selector when a direct
// launch supplied one; the explicit directory is compared with the CLASH_HOME root before pruning.
const configuredCompileCacheDirectory =
  process.env.NODE_COMPILE_CACHE?.trim() ||
  process.env.CLASH_COMPILE_CACHE_DIR?.trim();
const compileCacheDirectory = configuredCompileCacheDirectory
  ? resolve(configuredCompileCacheDirectory)
  : localApiCompileCacheDir(process.env, dataDir);
const compileCacheRoot = localApiCompileCacheRoot(process.env, dataDir);
clearLocalApiCompileCacheEnvironment(process.env);

type LocalApiServer = Awaited<ReturnType<typeof startLocalApiServer>>;

let server: LocalApiServer | undefined;
let stopping = false;
// Aborts an in-flight browser warm-up download so a stopping Host leaves no child behind.
const browserWarmup = new AbortController();
const BROWSER_WARMUP_DELAY_MS = 5_000;
const logSink = createBoundedJsonlLogSink({
  directory: join(clashHomeForLocalDataDir(dataDir), "logs", "local-api"),
  filePrefix: "local-api",
  maxBytes: 5 * 1024 * 1024,
  retention: DEFAULT_JSONL_LOG_RETENTION,
});
const observability = installProcessStdioCapture({
  component: "local-api",
  sink: logSink,
  maxEventsPerWindow: 200,
  windowMs: 10_000,
});
if (compileCache.enabled) {
  observability.event("info", "host.compile_cache_ready", {
    directory: compileCache.directory,
  });
} else {
  observability.event("warn", "host.compile_cache_unavailable", {
    code: compileCache.code,
    reason: compileCache.reason,
    directory: compileCache.directory,
  });
}
observability.event("info", "process.started", { pid: process.pid });

/**
 * Retire fingerprint-keyed cache directories left by earlier Host installs.
 *
 * Called from the Host's post-listen idle window, so cleanup never competes with startup or a
 * user request. Only direct children of the CLASH_HOME compile root are eligible; an explicit
 * cache directory outside that root is left alone.
 */
function pruneCompileCache(): void {
  if (!compileCache.enabled) return;
  if (resolve(dirname(compileCacheDirectory)) !== resolve(compileCacheRoot)) return;
  const result = pruneLocalApiCompileCache({
    root: compileCacheRoot,
    currentKey: basename(compileCacheDirectory),
    onFailure: (failure) => {
      observability.event("warn", "host.compile_cache_prune_failed", {
        code: failure.code,
        path: failure.path,
        reason: failure.reason,
      });
    },
  });
  if (result.removed.length > 0) {
    observability.event("info", "host.compile_cache_pruned", {
      removed: result.removed,
    });
  }
}

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
    warmPluginRuntime: true,
    onPostListenIdle: pruneCompileCache,
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
