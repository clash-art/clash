import { createBoundedJsonlLogSink, installProcessStdioCapture } from "@clash/shared-runtime/observability";
import { clashHomeForLocalDataDir, defaultLocalApiDataDir } from "@clash/shared-runtime/local-paths";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Source development must never mutate the production profile under ~/.clash. Setting the default
// here still lets an explicit CLASH_PROFILE/CLASH_HOME select another isolated development home.
process.env.CLASH_PROFILE ??= "dev";
process.env.CLASH_CLI_ENTRY_PATH ??= fileURLToPath(
  new URL("../../../packages/cli/src/index.ts", import.meta.url),
);
process.env.TSX_TSCONFIG_PATH ??= fileURLToPath(
  new URL("../../../packages/cli/tsconfig.dev.json", import.meta.url),
);

const dataDir = defaultLocalApiDataDir();
const observability = installProcessStdioCapture({
  component: "local-api",
  sink: createBoundedJsonlLogSink({ directory: join(clashHomeForLocalDataDir(dataDir), "logs", "local-api"), filePrefix: "local-api", maxBytes: 5 * 1024 * 1024, maxFiles: 5 }),
  maxEventsPerWindow: 200,
  windowMs: 10_000,
});
observability.event("info", "process.started", { pid: process.pid, startedBy: "dev" });
process.once("exit", () => observability.close());
process.once("uncaughtExceptionMonitor", (error, origin) => observability.event("error", "process.uncaught_exception", { error, origin }));
const { startLocalApiServer } = await import("./server.js");
const { prepareDevelopmentBundledPlugins } =
  await import("./development-bundled-plugins.js");
const pluginDevelopment = await prepareDevelopmentBundledPlugins({
  actionsRoot: join(clashHomeForLocalDataDir(dataDir), "actions"),
});
if (pluginDevelopment.rebuilt.length > 0) {
  observability.event("info", "plugins.rebuilt", { pluginIds: pluginDevelopment.rebuilt });
}

await startLocalApiServer({
  port: Number(process.env.PORT ?? 49321),
  dataDir,
});
