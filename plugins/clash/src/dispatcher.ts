import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ClashEntrypoint = "cli" | "mcp";

export type ClashEntrypointLoaders = {
  cli(): Promise<unknown>;
  mcp(): Promise<unknown>;
};

export function resolveClashDistributionVersion(
  moduleUrl: string = import.meta.url,
): string | undefined {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  for (const candidate of [
    { path: join(moduleDir, "..", "package.json"), nested: false },
    { path: join(moduleDir, "runtime-manifest.json"), nested: true },
  ]) {
    try {
      const value = JSON.parse(readFileSync(candidate.path, "utf8")) as {
        version?: unknown;
        package?: { version?: unknown };
      };
      const version = candidate.nested ? value.package?.version : value.version;
      if (typeof version === "string" && version.trim()) return version.trim();
    } catch {
      // Source packages and flattened Desktop resources use different manifests.
    }
  }
  return undefined;
}

export function normalizeClashArgv(
  argv: readonly string[] = process.argv,
): string[] {
  const normalized = [...argv];
  let index = 2;
  while (index < normalized.length) {
    const argument = normalized[index];
    if (argument === "--profile") {
      index += 2;
      continue;
    }
    if (argument?.startsWith("--profile=")) {
      index += 1;
      continue;
    }
    break;
  }
  if (normalized[index] === "--") normalized.splice(index, 1);
  return normalized;
}

export function selectClashEntrypoint(
  argv: readonly string[] = process.argv,
): ClashEntrypoint {
  const args = normalizeClashArgv(argv).slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--profile") {
      index += 1;
      continue;
    }
    if (argument?.startsWith("--profile=")) continue;
    return argument === "mcp" ? "mcp" : "cli";
  }
  return "cli";
}

export function shouldStartCliHost(argv: readonly string[] = process.argv): boolean {
  const args = normalizeClashArgv(argv).slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--profile") { index++; continue; }
    if (args[index]?.startsWith("--profile=")) continue;
    return args[index] !== "logs";
  }
  return true;
}

function useSourceRuntime(): boolean {
  return (
    process.env.CLASH_SOURCE_RUNTIME === "1" ||
    import.meta.url.endsWith("/src/dispatcher.ts")
  );
}

const runtimeLoaders: ClashEntrypointLoaders = {
  cli: async () => {
    if (useSourceRuntime()) {
      if (shouldStartCliHost()) {
        const { createPluginHostManager } = (await import(
          new URL("./plugin-host.ts", import.meta.url).href
        )) as typeof import("./plugin-host.js");
        const host = await createPluginHostManager({ startedBy: "cli" }).ensureHost();
        process.env.CLASH_API_URL = host.endpoint;
      }
      await import(
        new URL("../../../packages/cli/src/index.ts", import.meta.url).href
      );
      return;
    }
    await import(new URL("./clash-cli.cjs", import.meta.url).href);
  },
  mcp: async () => {
    const sourceRuntime = useSourceRuntime();
    const runtime = (await import(
      new URL(sourceRuntime ? "./index.ts" : "./index.js", import.meta.url).href
    )) as {
      serveClashPluginStdio(options?: {
        appBundles?: Record<
          "project" | "studio" | "canvas" | "timeline" | "director",
          string
        >;
      }): Promise<void>;
    };
    const projectBundle = sourceRuntime
      ? (await (await import("esbuild")).build({
          entryPoints: [fileURLToPath(new URL("../../../packages/mcp-server/src/project-app-client.ts", import.meta.url))],
          bundle: true,
          write: false,
          format: "esm",
          platform: "browser",
          target: "es2022",
          minify: true,
        })).outputFiles[0]!.text
      : undefined;
    await runtime.serveClashPluginStdio(
      sourceRuntime
        ? {
            appBundles: {
              project: projectBundle!,
              studio: "",
              canvas: "",
              timeline: "",
              director: "",
            },
          }
        : undefined,
    );
  },
};

export async function runClashEntrypoint(
  argv: readonly string[] = process.argv,
  loaders: ClashEntrypointLoaders = runtimeLoaders,
): Promise<void> {
  const normalizedArgv = normalizeClashArgv(argv);
  const args = normalizedArgv.slice(2);
  const profileIndex = args.indexOf("--profile");
  const explicitProfile =
    profileIndex >= 0
      ? args[profileIndex + 1]
      : args
          .find((argument) => argument.startsWith("--profile="))
          ?.slice("--profile=".length);
  if (explicitProfile === "dev" || explicitProfile === "prod") {
    process.env.CLASH_PROFILE = explicitProfile;
  }
  process.env.CLASH_DISTRIBUTION_VERSION ??=
    resolveClashDistributionVersion() ?? "0.1.0";
  if (argv === process.argv) process.argv = normalizedArgv;
  await loaders[selectClashEntrypoint(normalizedArgv)]();
}

export function isDirectExecution(
  moduleUrl: string,
  argvEntry = process.argv[1],
  cwd = process.cwd(),
): boolean {
  if (!argvEntry) return false;
  const canonicalPath = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return (
    pathToFileURL(canonicalPath(resolve(cwd, argvEntry))).href ===
    pathToFileURL(canonicalPath(fileURLToPath(moduleUrl))).href
  );
}

if (isDirectExecution(import.meta.url)) await runClashEntrypoint();
