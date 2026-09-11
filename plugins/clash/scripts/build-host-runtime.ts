import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import {
  BUNDLED_PLUGINS,
  OFFICIAL_MARKETPLACE_PLUGIN_PACKAGES,
  bundledPluginPayloadFiles,
} from "../../../apps/local-api/src/bundled-plugins.js";
import { assertDependencyDistIsFresh } from "./host-runtime-freshness.js";

const pluginRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(pluginRoot, "../..");
const runtimeDir = resolve(pluginRoot, "runtime");
const importMetaUrlShim = "__clash_import_meta_url";
const require = createRequire(import.meta.url);

assertDependencyDistIsFresh([
  resolve(import.meta.dirname, "../../../packages/cli"),
  resolve(import.meta.dirname, "../../../packages/shared-types"),
  resolve(import.meta.dirname, "../../../apps/local-api"),
  ...BUNDLED_PLUGINS.map((plugin) =>
    resolve(import.meta.dirname, `../../${plugin.workspaceDir}`),
  ),
  ...OFFICIAL_MARKETPLACE_PLUGIN_PACKAGES.map((plugin) =>
    resolve(import.meta.dirname, `../../${plugin.workspaceDir}`),
  ),
]);

await mkdir(runtimeDir, { recursive: true });
// One shipped renderer, served by local-api. No Vite or Electron process is
// needed when the npm distribution is used as an MCP App.
const projectRendererRoot = resolve(repoRoot, "apps/web/dist/client");
await readFile(resolve(projectRendererRoot, "index.html"));
await rm(resolve(runtimeDir, "project-ui"), { recursive: true, force: true });
await cp(projectRendererRoot, resolve(runtimeDir, "project-ui"), { recursive: true });
// A core build must never let a stale agent tree leak into the host bundle.
// Agent metadata is installed after the host runtime is fresh.
await rm(resolve(runtimeDir, "agents"), { recursive: true, force: true });
// Remotion is now a declared bundled Action payload. Remove the retired
// daemon-level browser bundle so incremental builds cannot ship both paths.
await rm(resolve(runtimeDir, "remotion-bundle"), {
  recursive: true,
  force: true,
});

/**
 * Prefixed to every emitted bundle.
 *
 * A bundle sits beside the sources it inlined, so a reader who opens one -- or who searches with
 * `--no-ignore-dot` to compare what shipped against what the source says -- needs to know inside one
 * line that this is machine output. Minified `esbuild` code otherwise opens with anonymous helper
 * declarations that read exactly like authored source, and an identifier found here proves only that
 * it was inlined at some past build, not that it exists in the tree today.
 */
const GENERATED_BANNER =
  "// GENERATED FILE -- DO NOT EDIT. Written by plugins/clash/scripts/build-host-runtime.ts;\n" +
  "// edit the TypeScript sources it bundles and rebuild. Identifiers here may be stale or renamed.\n";

await build({
  entryPoints: [resolve(pluginRoot, "src/local-api-entry.ts")],
  outfile: resolve(runtimeDir, "local-api.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  // Development-only builders stay lazy and external. Packaged hosts always use the browser
  // assets copied below and never load these modules. Provider HTTP instrumentation is likewise a
  // test-harness-only dynamic import; keeping its preload module external prevents its ESM
  // top-level await from entering this production CJS bundle.
  external: [
    "@remotion/renderer",
    "@remotion/bundler",
    "esbuild",
    "./provider-http-instrumentation.js",
  ],
  define: { "import.meta.url": importMetaUrlShim },
  banner: {
    js: `${GENERATED_BANNER}const ${importMetaUrlShim} = require("node:url").pathToFileURL(__filename).href;`,
  },
});

/**
 * Official Providers are part of the Clash distribution, not packages a user installs later.
 *
 * esbuild cannot inline manifests, declarative artifacts, contract fixtures, and module
 * entrypoints reached through dynamic `import()`. Copy those exact declared files beside
 * local-api.cjs; the Host imports this immutable payload directly from its closed trust registry.
 */
const bundledPluginRuntimeRoot = resolve(runtimeDir, "bundled-plugins");
await rm(bundledPluginRuntimeRoot, { recursive: true, force: true });
for (const plugin of BUNDLED_PLUGINS) {
  const sourceRoot = resolve(repoRoot, "plugins", plugin.workspaceDir);
  const targetRoot = resolve(bundledPluginRuntimeRoot, plugin.workspaceDir);
  const declaredFiles = new Set(
    await bundledPluginPayloadFiles(
      JSON.parse(await readFile(resolve(sourceRoot, "manifest.json"), "utf8")),
      sourceRoot,
    ),
  );
  for (const relativePath of declaredFiles) {
    const target = resolve(targetRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(sourceRoot, relativePath), target);
  }
}

// Official Marketplace packages ship beside the Host so installation is local and deterministic,
// but they stay outside bundled-plugins and are never loaded until the user installs one.
const officialPluginRuntimeRoot = resolve(runtimeDir, "official-plugins");
await rm(officialPluginRuntimeRoot, { recursive: true, force: true });
for (const plugin of OFFICIAL_MARKETPLACE_PLUGIN_PACKAGES) {
  const sourceRoot = resolve(repoRoot, "plugins", plugin.workspaceDir);
  const targetRoot = resolve(officialPluginRuntimeRoot, plugin.packagedDir);
  const declaredFiles = new Set(
    await bundledPluginPayloadFiles(
      JSON.parse(await readFile(resolve(sourceRoot, "manifest.json"), "utf8")),
      sourceRoot,
    ),
  );
  for (const relativePath of declaredFiles) {
    const target = resolve(targetRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(sourceRoot, relativePath), target);
  }
}

await build({
  entryPoints: [resolve(repoRoot, "packages/cli/src/plugin.ts")],
  outfile: resolve(runtimeDir, "clash-cli.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  define: { "import.meta.url": importMetaUrlShim },
  banner: {
    js: `#!/usr/bin/env node\n${GENERATED_BANNER}const ${importMetaUrlShim} = require("node:url").pathToFileURL(__filename).href;`,
  },
});

// Keep tracked package artefacts diff-clean even when an inlined dependency
// emits whitespace-only lines. This is a deterministic formatting pass over
// generated output, not an authored-source rewrite.
for (const filename of ["local-api.cjs", "clash-cli.cjs"]) {
  const path = resolve(runtimeDir, filename);
  const source = await readFile(path, "utf8");
  const normalized = source.replace(/[ \t]+$/gm, "");
  if (normalized !== source) await writeFile(path, normalized, "utf8");
}

const directorBundleDir = resolve(runtimeDir, "director-bundle");
await rm(directorBundleDir, { recursive: true, force: true });
await mkdir(directorBundleDir, { recursive: true });
await build({
  entryPoints: [
    resolve(repoRoot, "packages/director-ui/src/headless-entry.tsx"),
  ],
  outfile: resolve(directorBundleDir, "index.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "chrome120",
  minify: true,
});
await writeFile(
  resolve(directorBundleDir, "index.html"),
  [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#171816}</style></head>',
    '<body><div id="root"></div><script type="module" src="./index.js"></script></body></html>',
    "",
  ].join("\n"),
  "utf8",
);
await rm(resolve(runtimeDir, "assets"), { recursive: true, force: true });
await cp(
  resolve(repoRoot, "packages/director-ui/assets"),
  resolve(runtimeDir, "assets"),
  { recursive: true },
);

await cp(
  require.resolve("loro-crdt/nodejs/loro_wasm_bg.wasm"),
  resolve(runtimeDir, "loro_wasm_bg.wasm"),
);
