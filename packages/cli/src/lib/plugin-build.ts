import { build, type Message } from "esbuild";
import { mkdir, access } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

async function resolveAuthoringSdk(specifier: string): Promise<string> {
  const entry = specifier === "@clash/action-sdk" ? "index" : specifier.slice("@clash/action-sdk/".length);
  const bundled = fileURLToPath(new URL(`./plugin-sdk/${entry}.mjs`, import.meta.url));
  try {
    await access(bundled);
    return bundled;
  } catch {
    // Source/standalone CLI development uses its declared workspace dependency.
    // Installed distributions resolve the versioned SDK shipped beside the CLI.
    return createRequire(import.meta.url).resolve(specifier);
  }
}

/**
 * Compiling a plugin entrypoint.
 *
 * The host owns this convenience step so every TypeScript draft is built the same
 * way before validation and activation. The artifact is one self-contained ESM file
 * with only `node:` builtins left external, so an activated package does not depend
 * on a source tree or a sibling `node_modules` directory being present.
 *
 * Which entrypoints are derived is declared by `runtime.build.source`. When it is
 * absent the entrypoint was authored directly -- the ordinary case for Python, where
 * the source is what runs -- and the host never overwrites it.
 */

export interface PluginBuildPlan {
  /** Plugin-relative TypeScript or JavaScript entry module. */
  source: string;
  /** Plugin-relative artifact the manifest points the runtime at. */
  entrypoint: string;
}

/**
 * The parts of a runtime declaration this module reads.
 *
 * Structural rather than the full schema type so a caller can pass a parsed manifest, a fixture, or a
 * partially-filled draft. Unknown keys are accepted because they belong to the runtime, not here.
 */
interface RuntimeLike {
  kind?: string;
  entrypoint?: string;
  build?: { source?: string };
  [key: string]: unknown;
}

/** The declared build for a runtime, or undefined when the entrypoint is authored. */
export function pluginBuildPlan(
  runtime: RuntimeLike,
): PluginBuildPlan | undefined {
  if (runtime.kind !== "local") return undefined;
  const source = runtime.build?.source;
  const entrypoint = runtime.entrypoint;
  if (!source || !entrypoint) return undefined;
  return { source, entrypoint };
}

function assertInsidePlugin(
  pluginDir: string,
  candidate: string,
  label: string,
): string {
  const absolute = resolve(pluginDir, candidate);
  const rel = relative(pluginDir, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Plugin ${label} must stay inside the plugin directory: ${candidate}`,
    );
  }
  return absolute;
}

function formatMessages(messages: readonly Message[]): string {
  return messages
    .map((message) => {
      const where = message.location
        ? `${message.location.file}:${message.location.line}:${message.location.column}`
        : "";
      return where ? `${where}: ${message.text}` : message.text;
    })
    .join("\n");
}

/**
 * Compile the declared source into the declared entrypoint.
 *
 * Returns the absolute artifact path. Throws with the offending file when the source
 * is missing or does not compile, and writes nothing in that case, so a failed build
 * can never leave a half-written bundle for the plugin runtime to load.
 */
export async function buildPluginEntrypoint(
  pluginDirInput: string,
  runtime: RuntimeLike,
): Promise<string> {
  const pluginDir = resolve(pluginDirInput);
  const plan = pluginBuildPlan(runtime);
  if (!plan) {
    throw new Error(
      "This runtime declares no build; its entrypoint is authored directly.",
    );
  }

  const sourcePath = assertInsidePlugin(pluginDir, plan.source, "build source");
  const outputPath = assertInsidePlugin(
    pluginDir,
    plan.entrypoint,
    "entrypoint",
  );

  try {
    await access(sourcePath);
  } catch {
    throw new Error(`Plugin build source is missing: ${plan.source}`);
  }

  await mkdir(dirname(outputPath), { recursive: true });

  const result = await build({
    entryPoints: [sourcePath],
    outfile: outputPath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    // Only builtins may stay external; nothing else is resolvable at runtime.
    packages: "bundle",
    external: [],
    plugins: [{
      name: "clash-authoring-sdk",
      setup(builder) {
        builder.onResolve({ filter: /^@clash\/action-sdk(?:\/(?:browser|executable-failure))?$/ }, async ({ path }) => ({ path: await resolveAuthoringSdk(path) }));
      },
    }],
    logLevel: "silent",
    absWorkingDir: pluginDir,
    sourcemap: false,
    // esbuild's readable module-header comments contain relative installation
    // paths. They must not change immutable plugin bytes when the CLI moves.
    // Keep identifiers/syntax intact and retain esbuild's legal comments.
    minifyWhitespace: true,
    write: true,
  }).catch((error: unknown) => {
    const errors = (error as { errors?: Message[] }).errors ?? [];
    const detail =
      errors.length > 0 ? formatMessages(errors) : (error as Error).message;
    throw new Error(`Plugin build failed:\n${detail}`);
  });

  if (result.errors.length > 0) {
    throw new Error(`Plugin build failed:\n${formatMessages(result.errors)}`);
  }

  return outputPath;
}

/** Compile when the runtime declares a build; otherwise leave the entrypoint alone. */
export async function buildPluginEntrypointIfDeclared(
  pluginDir: string,
  runtime: RuntimeLike,
): Promise<string | undefined> {
  if (!pluginBuildPlan(runtime)) return undefined;
  return buildPluginEntrypoint(pluginDir, runtime);
}
