import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ExecutablePluginManifestSchema } from "@clash/shared-types";

import {
  activateHostExecutablePluginPackage,
  listHostExecutablePluginPackages,
  removeHostExecutablePluginPackage,
} from "./runtime/plugin-package.js";

const CODEX_IMAGEGEN_PLUGIN_ID = "clash.codex-imagegen";
const CODEX_IMAGEGEN_ACTION_ID = "codex-imagegen";

export const CODEX_IMAGEGEN_MARKETPLACE_PLUGIN = {
  id: CODEX_IMAGEGEN_PLUGIN_ID,
  name: "Codex ImageGen",
  type: "plugin",
  description:
    "Generate or edit images with Codex's built-in image generation tool and your ChatGPT subscription.",
  runtime: "local",
  outputType: "image",
  packageId: CODEX_IMAGEGEN_PLUGIN_ID,
  version: "0.1.0",
  author: "Clash",
  icon: "✨",
  color: "#57534e",
  tags: ["image", "codex", "local", "chatgpt"],
  promptModalities: ["text", "image"],
  outputs: [
    { kind: "generator", name: "Image Generator" },
    { kind: "action", name: "Generate Image" },
  ],
  builtIn: true,
  immutable: true,
} as const;

export const STORYBOARD_MARKETPLACE_PLUGIN = {
  id: "clash.storyboard",
  name: "Storyboard",
  type: "plugin",
  description:
    "Draft key elements, shots, audio layers, and loose Project Assets before assembling a Timeline.",
  artwork: {
    src: "/brand/avatar-storyboard.png",
    alt: "Clash Storyboard plugin",
  },
  packageId: "clash.storyboard",
  version: "1.0.0",
  author: "Clash",
  runtime: "local",
  tags: ["storyboard", "view", "canvas", "video"],
  outputs: [{ kind: "view", name: "Storyboard" }],
} as const;

export const OFFICIAL_MARKETPLACE_PLUGIN_PACKAGES = [
  {
    id: STORYBOARD_MARKETPLACE_PLUGIN.id,
    workspaceDir: "official/storyboard",
    packagedDir: "storyboard",
  },
] as const;

export class BuiltinPluginImmutableError extends Error {
  readonly status = 409 as const;
  readonly code = "BUILTIN_PLUGIN_IMMUTABLE" as const;

  constructor(readonly pluginId: string) {
    super(
      `Built-in plugin ${pluginId} is immutable and cannot be uninstalled.`,
    );
    this.name = "BuiltinPluginImmutableError";
  }
}

/**
 * The Providers that ship with the host.
 *
 * This closed source registry is the first-party trust root. The Host imports each declared module
 * directly from its immutable distribution payload; it never installs these packages into the
 * user's actions directory, and an actions-directory package cannot promote or shadow one of these
 * reserved ids.
 *
 * A third-party Provider takes the process/stdio path: it is downloaded, attested, explicitly
 * activated under the actions directory, and never appears here. `hrhrng.hub` is one.
 */
export const BUNDLED_PLUGINS = [
  { id: "clash.gpt-image", packageName: "@clash-plugin/gpt-image", workspaceDir: "gpt-image" },
  {
    id: "clash.agent-text",
    packageName: "@clash-plugin/agent-text",
    workspaceDir: "agent-text",
  },
  {
    id: "clash.model-generation",
    packageName: "@clash-plugin/model-generation",
    workspaceDir: "model-generation",
  },
  {
    id: "clash.asset-edit",
    packageName: "@clash-plugin/asset-edit",
    workspaceDir: "asset-edit",
  },
  {
    id: "clash.director",
    packageName: "@clash-plugin/director",
    workspaceDir: "director",
  },
  {
    id: "clash.asr",
    packageName: "@clash-plugin/asr",
    workspaceDir: "asr",
  },
  {
    id: "clash.media-analysis",
    packageName: "@clash-plugin/media-analysis",
    workspaceDir: "media-analysis",
  },
  {
    id: "clash.video-enhance",
    packageName: "@clash-plugin/video-enhance",
    workspaceDir: "video-enhance",
  },
  {
    id: "clash.remotion",
    packageName: "@clash-plugin/remotion",
    workspaceDir: "remotion",
  },
  {
    id: "clash.fal",
    packageName: "@clash-plugin/fal",
    workspaceDir: "fal",
  },
  {
    id: "clash.google",
    packageName: "@clash-plugin/google",
    workspaceDir: "google",
  },
  {
    id: "clash.minimax",
    packageName: "@clash-plugin/minimax",
    workspaceDir: "minimax",
  },
  {
    id: "clash.pika",
    packageName: "@clash-plugin/pika",
    workspaceDir: "pika",
  },
  {
    id: "clash.volcengine",
    packageName: "@clash-plugin/volcengine",
    workspaceDir: "volcengine",
  },
  {
    id: CODEX_IMAGEGEN_PLUGIN_ID,
    packageName: "@clash-plugin/codex-imagegen",
    workspaceDir: "codex-imagegen",
  },
  {
    id: "clash.meshy",
    packageName: "@clash-plugin/meshy",
    workspaceDir: "meshy",
  },
  {
    id: "clash.tripo",
    packageName: "@clash-plugin/tripo",
    workspaceDir: "tripo",
  },
  {
    id: "clash.move-ai",
    packageName: "@clash-plugin/move-ai",
    workspaceDir: "move-ai",
  },
] as const;

/** Exact immutable files a bundled Host must carry for one validated plugin manifest. */
export function bundledPluginPayloadPaths(manifestInput: unknown): string[] {
  const manifest = ExecutablePluginManifestSchema.parse(manifestInput);
  if (manifest.runtime.kind !== "local") {
    throw new Error(
      `Bundled plugin ${manifest.id} must have a local entrypoint.`,
    );
  }
  return [
    "manifest.json",
    manifest.runtime.entrypoint,
    ...(manifest.runtime.resources ?? []),
    ...manifest.contributes.cards.map(({ path }) => path),
    ...manifest.contributes.providers.map(({ path }) => path),
    ...manifest.contributes.modelBindings.map(({ path }) => path),
    ...manifest.contributes.generators.map(({ path }) => path),
    ...manifest.contributes.views.map(({ path }) => path),
    ...manifest.contractTests,
  ];
}

/** Expands declared resource directories to the exact regular files in one immutable package. */
export async function bundledPluginPayloadFiles(
  manifestInput: unknown,
  pluginRoot: string,
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (relativePath: string): Promise<void> => {
    const path = join(pluginRoot, relativePath);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(
        `Bundled plugin payload ${relativePath} must not be a symbolic link.`,
      );
    }
    if (info.isFile()) {
      files.push(relativePath);
      return;
    }
    if (!info.isDirectory()) {
      throw new Error(
        `Bundled plugin payload ${relativePath} is not a regular file or directory.`,
      );
    }
    const entries = (await readdir(path, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      await visit(`${relativePath}/${entry.name}`);
    }
  };

  for (const relativePath of bundledPluginPayloadPaths(manifestInput)) {
    await visit(relativePath);
  }
  return [...new Set(files)];
}

export function bundledPluginPaths(
  id: string,
  moduleUrl: string = import.meta.url,
): { manifestPath: string; entrypointPath: string } {
  const plugin = BUNDLED_PLUGINS.find((candidate) => candidate.id === id);
  if (!plugin) throw new Error(`${id} is not a bundled plugin.`);

  // The shipped `clash` package is a single host bundle plus adjacent immutable plugin payloads.
  // `createRequire().resolve()` works in the monorepo, but those workspace packages are not present
  // after `clash` is packed. Prefer the payload copied beside local-api.cjs so an official Provider
  // never turns into a post-install dependency.
  const packagedPlugin = resolve(
    dirname(fileURLToPath(moduleUrl)),
    "bundled-plugins",
    plugin.workspaceDir,
  );
  const packagedManifest = join(packagedPlugin, "manifest.json");
  const packagedEntrypoint = join(packagedPlugin, "dist", "stdio.mjs");
  if (existsSync(packagedManifest) && existsSync(packagedEntrypoint)) {
    return {
      manifestPath: packagedManifest,
      entrypointPath: packagedEntrypoint,
    };
  }

  const require = createRequire(import.meta.url);
  try {
    return {
      manifestPath: require.resolve(`${plugin.packageName}/manifest.json`),
      entrypointPath: require.resolve(`${plugin.packageName}/stdio`),
    };
  } catch (error) {
    // Workspace development fallback. Packaged builds resolve the declared
    // dependency above; this path is never copied into the installed plugin.
    const workspacePlugin = resolve(
      dirname(fileURLToPath(import.meta.url)),
      `../../../plugins/${plugin.workspaceDir}`,
    );
    const manifestPath = join(workspacePlugin, "manifest.json");
    const entrypointPath = join(workspacePlugin, "dist", "stdio.mjs");
    if (existsSync(manifestPath) && existsSync(entrypointPath)) {
      return { manifestPath, entrypointPath };
    }
    throw error;
  }
}

function bundledCodexImagegenPaths(): {
  manifestPath: string;
  entrypointPath: string;
} {
  const require = createRequire(import.meta.url);
  try {
    return {
      manifestPath:
        require.resolve("@clash-plugin/codex-imagegen/manifest.json"),
      entrypointPath: require.resolve("@clash-plugin/codex-imagegen/stdio"),
    };
  } catch (error) {
    const workspacePlugin = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../plugins/codex-imagegen",
    );
    const manifestPath = join(workspacePlugin, "manifest.json");
    const entrypointPath = join(workspacePlugin, "dist", "stdio.mjs");
    if (existsSync(manifestPath) && existsSync(entrypointPath)) {
      return { manifestPath, entrypointPath };
    }
    throw error;
  }
}

export function officialStoryboardPluginPaths(
  moduleUrl: string = import.meta.url,
): { manifestPath: string; entrypointPath: string } {
  const packagedPlugin = resolve(
    dirname(fileURLToPath(moduleUrl)),
    "official-plugins",
    "storyboard",
  );
  const packagedManifest = join(packagedPlugin, "manifest.json");
  const packagedEntrypoint = join(packagedPlugin, "dist", "stdio.mjs");
  if (existsSync(packagedManifest) && existsSync(packagedEntrypoint)) {
    return {
      manifestPath: packagedManifest,
      entrypointPath: packagedEntrypoint,
    };
  }

  const workspacePlugin = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../plugins/official/storyboard",
  );
  return {
    manifestPath: join(workspacePlugin, "manifest.json"),
    entrypointPath: join(workspacePlugin, "dist", "stdio.mjs"),
  };
}

export function createCodexImagegenMarketplace(options: {
  actionsRoot: string;
  manifestPath?: string;
  entrypointPath?: string;
}) {
  const readBundledManifest = async () => {
    const manifestPath =
      options.manifestPath ?? bundledCodexImagegenPaths().manifestPath;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      id?: string;
      version?: string;
    };
    if (
      manifest.id !== CODEX_IMAGEGEN_PLUGIN_ID ||
      typeof manifest.version !== "string"
    ) {
      throw new Error("Bundled Codex ImageGen package is invalid.");
    }
    return manifest;
  };

  return {
    plugins: [CODEX_IMAGEGEN_MARKETPLACE_PLUGIN],
    async listInstalled() {
      const manifest = await readBundledManifest();
      return [
        {
          actionId: CODEX_IMAGEGEN_ACTION_ID,
          name: "Codex ImageGen",
          runtime: "local",
          version: manifest.version,
          builtIn: true,
          immutable: true,
          manifest: JSON.stringify({
            ...CODEX_IMAGEGEN_MARKETPLACE_PLUGIN,
            id: CODEX_IMAGEGEN_ACTION_ID,
          }),
        },
      ];
    },
    async install(packageId: string) {
      if (packageId !== CODEX_IMAGEGEN_PLUGIN_ID) {
        throw new Error(`Unknown local action package: ${packageId}`);
      }
      const manifest = await readBundledManifest();
      return {
        actionId: CODEX_IMAGEGEN_ACTION_ID,
        packageId,
        version: manifest.version,
        installed: false,
        bundled: true,
      };
    },
    async uninstall(pluginId: string) {
      if (pluginId !== CODEX_IMAGEGEN_PLUGIN_ID) {
        throw new Error(`Unknown local plugin: ${pluginId}`);
      }
      throw new BuiltinPluginImmutableError(CODEX_IMAGEGEN_PLUGIN_ID);
    },
  };
}

export async function ensureBundledPlugin(options: {
  id: string;
  actionsRoot: string;
  manifestPath?: string;
  entrypointPath?: string;
}): Promise<{ installed: boolean; targetDir: string }> {
  const targetDir = join(options.actionsRoot, options.id);
  // Compatibility utility for an explicit standalone activation. First-party startup never calls
  // this path: its package payload stays immutable and outside the actions activation authority.
  // An existing explicit install remains user-owned and must not be overwritten here.
  if (existsSync(join(targetDir, "manifest.json"))) {
    return { installed: false, targetDir };
  }
  const defaults =
    options.manifestPath && options.entrypointPath
      ? null
      : bundledPluginPaths(options.id);
  const manifestPath = options.manifestPath ?? defaults!.manifestPath;
  const entrypointPath = options.entrypointPath ?? defaults!.entrypointPath;
  const manifest = ExecutablePluginManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  // Seeding a plugin under another's directory name gives two ids for one install, and a route
  // bound to either finds a manifest that disagrees with where it lives.
  if (manifest.id !== options.id) {
    throw new Error(
      `Expected the bundled manifest for ${options.id}, but it declares ${manifest.id}.`,
    );
  }
  if (manifest.runtime.kind !== "local") {
    throw new Error(
      `Bundled plugin ${options.id} must have a local entrypoint.`,
    );
  }
  const runtimeEntrypoint = manifest.runtime.entrypoint;
  const entrypoint = await readFile(entrypointPath);
  const files: Record<string, string> = {
    [runtimeEntrypoint]: entrypoint.toString("base64"),
  };
  const manifestDir = dirname(manifestPath);
  const declaredDocuments = (
    await bundledPluginPayloadFiles(manifest, manifestDir)
  ).filter((path) => path !== "manifest.json" && path !== runtimeEntrypoint);
  for (const relativePath of declaredDocuments) {
    if (!relativePath) continue;
    files[relativePath] = (
      await readFile(join(manifestDir, relativePath))
    ).toString("base64");
  }
  const activated = await activateHostExecutablePluginPackage(
    {
      id: options.id,
      manifest,
      files,
    },
    options.actionsRoot,
  );
  return { installed: true, targetDir: activated.targetDir };
}

/** Official packages are catalogued with the Host but activated only by an explicit install. */
export function createOfficialPluginsMarketplace(options: {
  actionsRoot: string;
  manifestPath?: string;
  entrypointPath?: string;
}) {
  const packagePaths = () => {
    const defaults =
      options.manifestPath && options.entrypointPath
        ? undefined
        : officialStoryboardPluginPaths();
    return {
      manifestPath: options.manifestPath ?? defaults!.manifestPath,
      entrypointPath: options.entrypointPath ?? defaults!.entrypointPath,
    };
  };

  return {
    plugins: [STORYBOARD_MARKETPLACE_PLUGIN],
    async listInstalled() {
      const installed = await listHostExecutablePluginPackages(
        options.actionsRoot,
      );
      return installed.filter(
        (plugin) => plugin.id === STORYBOARD_MARKETPLACE_PLUGIN.id,
      );
    },
    async install(packageId: string) {
      if (packageId !== STORYBOARD_MARKETPLACE_PLUGIN.packageId) {
        throw new Error(`Unknown official plugin package: ${packageId}`);
      }
      const paths = packagePaths();
      const manifest = ExecutablePluginManifestSchema.parse(
        JSON.parse(await readFile(paths.manifestPath, "utf8")),
      );
      const result = await ensureBundledPlugin({
        id: STORYBOARD_MARKETPLACE_PLUGIN.id,
        actionsRoot: options.actionsRoot,
        ...paths,
      });
      return {
        id: manifest.id,
        packageId,
        version: manifest.version,
        installed: result.installed,
      };
    },
    async uninstall(pluginId: string) {
      if (pluginId !== STORYBOARD_MARKETPLACE_PLUGIN.id) {
        throw new Error(`Unknown official plugin: ${pluginId}`);
      }
      await removeHostExecutablePluginPackage(options.actionsRoot, pluginId);
    },
  };
}
