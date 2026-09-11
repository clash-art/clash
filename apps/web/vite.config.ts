import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import wasm from "vite-plugin-wasm";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const openmaCommonRoot = resolve(repoRoot, "../openma-common");
const webNodeModules = resolve(__dirname, "node_modules");
const hostUiNodeModules = resolve(repoRoot, "packages/web-ui/node_modules");
const persistStatePath = process.env.CLASH_WEB_E2E_PERSIST_STATE?.trim()
  ? resolve(process.env.CLASH_WEB_E2E_PERSIST_STATE)
  : resolve(repoRoot, ".wrangler/state");

// During development, load shared workspaces from source instead of their
// generated package exports. This preserves source HMR while allowing Vite to
// ignore dist writes produced by tests/builds without serving stale modules.
export const DEV_SOURCE_ALIASES = [
  {
    find: /^@tanstack\/react-virtual$/,
    replacement: realpathSync(resolve(openmaCommonRoot, "node_modules/@tanstack/react-virtual/dist/esm/index.js")),
  },
  {
    find: /^eventsource-parser\/stream$/,
    replacement: realpathSync(
      resolve(webNodeModules, "eventsource-parser/dist/stream.js"),
    ),
  },
  {
    find: /^@radix-ui\/react-collapsible$/,
    replacement: realpathSync(
      resolve(hostUiNodeModules, "@radix-ui/react-collapsible/dist/index.mjs"),
    ),
  },
  {
    find: /^streamdown$/,
    replacement: realpathSync(
      resolve(hostUiNodeModules, "streamdown/dist/index.js"),
    ),
  },
  // @openma/common is intentionally linked from a sibling checkout while the
  // two products are developed together. Its package exports point at dist,
  // which can be replaced underneath Vite and leave a stale named-export
  // transform in the module graph. Source aliases make HMR observe the files
  // that actually changed and keep generated output out of the dev runtime.
  {
    find: /^@openma\/common\/chat-ui\/styles\.css$/,
    replacement: resolve(openmaCommonRoot, "src/chat-ui/styles.css"),
  },
  {
    find: /^@openma\/common\/chat-ui$/,
    replacement: resolve(openmaCommonRoot, "src/chat-ui/index.ts"),
  },
  {
    find: /^@openma\/common\/agent-ui\/react$/,
    replacement: resolve(openmaCommonRoot, "src/agent-ui/react.tsx"),
  },
  {
    find: /^@openma\/common\/agent-ui$/,
    replacement: resolve(openmaCommonRoot, "src/agent-ui/index.ts"),
  },
  {
    find: /^@openma\/common\/protocol\/acp$/,
    replacement: resolve(openmaCommonRoot, "src/protocol/acp/index.ts"),
  },
  {
    find: /^@openma\/common\/session-events\/openma$/,
    replacement: resolve(openmaCommonRoot, "src/session-events/openma.ts"),
  },
  {
    find: /^@openma\/common\/session-ui$/,
    replacement: resolve(openmaCommonRoot, "src/session-ui/index.tsx"),
  },
  {
    find: /^@clash\/action-sdk\/browser$/,
    replacement: resolve(repoRoot, "packages/action-sdk/src/browser.ts"),
  },
  {
    find: /^@clash\/asset-sdk$/,
    replacement: resolve(repoRoot, "packages/asset-sdk/src/index.ts"),
  },
  {
    find: /^@clash\/web-ui\/(.+)$/,
    replacement: resolve(repoRoot, "packages/web-ui/src/$1"),
  },
  {
    find: /^@clash\/web-ui$/,
    replacement: resolve(repoRoot, "packages/web-ui/src/index.ts"),
  },
  {
    find: /^@clash\/remotion-ui$/,
    replacement: resolve(repoRoot, "packages/remotion-ui/src/index.ts"),
  },
  {
    find: /^@clash\/gui\/(.+)$/,
    replacement: resolve(repoRoot, "packages/gui/src/$1"),
  },
  {
    find: /^@clash\/gui$/,
    replacement: resolve(repoRoot, "packages/gui/src/index.ts"),
  },
  {
    find: /^@clash\/shared-layout$/,
    replacement: resolve(repoRoot, "packages/shared-layout/src/index.ts"),
  },
  {
    find: /^@clash\/shared-types\/actions\/asset-edit$/,
    replacement: resolve(
      repoRoot,
      "packages/shared-types/src/actions/asset-edit.ts",
    ),
  },
  {
    find: /^@clash\/shared-types\/executable-plugin$/,
    replacement: resolve(
      repoRoot,
      "packages/shared-types/src/executable-plugin.ts",
    ),
  },
  {
    find: /^@clash\/shared-types\/timeline-contract$/,
    replacement: resolve(
      repoRoot,
      "packages/shared-types/src/timeline-contract.ts",
    ),
  },
  {
    find: /^@clash\/shared-types$/,
    replacement: resolve(repoRoot, "packages/shared-types/src/index.ts"),
  },
  {
    find: /^@clash\/shared-types\/assets$/,
    replacement: resolve(repoRoot, "packages/shared-types/src/assets.ts"),
  },
  {
    find: /^@clash\/shared-types\/timeline-library$/,
    replacement: resolve(
      repoRoot,
      "packages/shared-types/src/timeline-library.ts",
    ),
  },
  {
    find: /^@clash\/shared-runtime$/,
    replacement: resolve(repoRoot, "packages/shared-runtime/src/browser.ts"),
  },
  {
    find: /^@clash\/shared-runtime\/local-paths$/,
    replacement: resolve(
      repoRoot,
      "packages/shared-runtime/src/local-paths.ts",
    ),
  },
];

// Prebundling these breaks the mixed zod v3/v4 graph (see optimizeDeps note
// below). Shared by the client graph and the auxiliary api-cf worker
// environment, which does not inherit the top-level exclusion.
export const NO_PREBUNDLE_DEPS = [
  "@clash/web-ui",
  "@clash/remotion-ui",
  "@clash/remotion-components",
  "@clash/remotion-core",
  "@clash/remotion-effects",
  "@clash/director-ui",
  "loro-crdt",
  "zod",
  "zod-to-json-schema",
];

export const DEV_WATCH_IGNORES = ["**/dist/**", "**/release/**", "**/.tmp/**"];

// Pure Vite SPA. index.html is the entry; main.tsx mounts a
// createBrowserRouter-based React app. No SSR at any layer.
//
// `@cloudflare/vite-plugin` is enabled only in `vite dev` so workers/app.ts
// runs inside the same vite dev process and `env.API_CF` resolves to the
// auxiliary api-cf worker (same path as prod).
//
// `vite build` skips the plugin so it emits a plain SPA bundle without the
// plugin's wrangler.json redirect. The deploy step (`wrangler deploy` with
// the project's own wrangler.toml — or the wrapper wrangler.toml in
// clash-hosted/apps/web-hosted) bundles workers/app.ts itself.
export default defineConfig(async ({ command, isPreview }) => {
  const cloudflarePlugins =
    command === "serve" &&
    !isPreview &&
    process.env.CLASH_WEB_E2E_NO_CLOUDFLARE !== "1"
      ? [
          (await import("@cloudflare/vite-plugin")).cloudflare({
            remoteBindings: false,
            // Share .wrangler/state with api-cf (whose dev script also uses
            // ../../.wrangler/state). Without this each worker gets its own
            // miniflare D1 -> Better Auth verification rows written by web
            // don't exist when api-cf reads them, breaking Google OAuth.
            persistState: { path: persistStatePath },
            auxiliaryWorkers: [{ configPath: "../api-cf/wrangler.toml" }],
          }),
        ]
      : [];

  return {
    plugins: [
      // command is 'serve' for `vite dev` and `vite preview`; `isPreview`
      // distinguishes static preview from the development server.
      // Skip plugin in build so deploys (which read wrangler.toml directly) get
      // a plain SPA bundle without the plugin's wrangler.json redirect.
      ...cloudflarePlugins,
      react(),
      tailwindcss(),
      // wasm support for loro-crdt; modern build target lets the runtime
      // handle top-level await natively (no vite-plugin-top-level-await
      // needed, which had esbuild version-skew issues across workspaces).
      wasm(),
      tsconfigPaths(),
    ],
    build: {
      outDir: "dist/client",
      emptyOutDir: true,
      assetsDir: "_app",
      // Workers/CF Pages run a modern V8 — no need to transpile destructuring
      // etc., and skipping the transform avoids esbuild version-skew issues
      // hit by vite-plugin-top-level-await on the WASM init code.
      target: "esnext",
      rollupOptions: {
        output: {
          // Force @phosphor-icons/react into its own chunk. Default chunk
          // splitting picks the icon defs into whichever chunk first uses
          // them and emits `let X; X = forwardRef(...)` patterns that read
          // as `undefined` from cross-chunk named imports → React #130.
          // Keeping the whole package in one chunk preserves top-level
          // const exports so cross-chunk imports resolve correctly.
          manualChunks(id: string) {
            if (id.includes("@phosphor-icons")) return "phosphor";
          },
        },
      },
    },
    // Force single copy of react / remotion so <Player> and <VideoComposition>
    // share the same React Context. pnpm's peer-dep-scoped store creates 4
    // remotion copies (one per react/react-dom peer combo) — useVideoConfig()
    // returns null otherwise.
    resolve: {
      alias: command === "serve" && !isPreview ? DEV_SOURCE_ALIASES : undefined,
      dedupe: [
        "react",
        "react-dom",
        "remotion",
        "@remotion/player",
        "@remotion/media-utils",
        "@remotion/transitions",
      ],
    },
    server: {
      port: 3000,
      host: "0.0.0.0",
      // Vite restricts dev fs to cwd by default; in our pnpm monorepo,
      // workspace packages (packages/web-ui, etc.) live above apps/web/.
      // Without this, dynamic imports of those files 403 in dev.
      fs: { allow: [repoRoot, openmaCommonRoot] },
      // Tests and package builds rewrite workspace dist files. They are not
      // runtime inputs in dev (the aliases above point at source), so watching
      // them only causes expensive full-page reloads and lost editor state.
      watch: { ignored: DEV_WATCH_IGNORES },
    },
    preview: {
      port: 3000,
    },
    // `@cloudflare/vite-plugin` names the auxiliary api-cf worker environment
    // `clash_api`. Vite environment optimizers do not inherit the top-level
    // optimizeDeps.exclude, so the worker prebundled its own zod copy into
    // .vite/deps_clash_api and Timeline DSL startup failed.
    environments: {
      clash_api: {
        optimizeDeps: {
          exclude: NO_PREBUNDLE_DEPS,
        },
      },
    },
    optimizeDeps: {
      // The project editor is route-lazy. Make it a first-class scan entry so
      // its workspace graph and CommonJS browser dependencies are optimized
      // before the first project is opened instead of failing one package at
      // a time after Dashboard has already mounted.
      entries: [
        resolve(__dirname, "index.html"),
        resolve(__dirname, "app/routes/project.$id.tsx"),
        resolve(repoRoot, "packages/web-ui/src/components/HomePageClient.tsx"),
        resolve(repoRoot, "packages/web-ui/src/components/ProjectEditor.tsx"),
        resolve(repoRoot, "packages/web-ui/src/components/MilkdownEditor.tsx"),
        resolve(repoRoot, "packages/remotion-ui/src/index.ts"),
        resolve(repoRoot, "packages/remotion-components/src/index.ts"),
      ],
      // loro-crdt ships a .wasm alongside JS — exclude from esbuild prebundle so
      // vite-plugin-wasm handles it at request time.
      // zod / zod-to-json-schema: the dev source aliases put shared-types
      // (zod v3 + zod-to-json-schema 3.24.x) in the same graph as apps/web and
      // the auxiliary api-cf worker (zod v4). esbuild prebundling collapses the
      // two majors into one optimized copy, and the v4 runtime then loses v3
      // internals zod-to-json-schema walks -> "Timeline DSL JSON Schema missing
      // nested items". Excluding them keeps each importer on its own resolved
      // copy.
      exclude: NO_PREBUNDLE_DEPS,
      include: [
        "react-dom/client",
        "react/jsx-runtime",
        "react-dropzone",
        "attr-accept",
        "react-markdown",
        "@cloudflare/ai-chat/react",
        "debug",
        "extend",
        // ProjectEditor is route-lazy, so the initial dependency crawl cannot
        // discover remotion-components' CommonJS TypeScript compiler. Without
        // an explicit entry Vite serves typescript.js as native ESM and the
        // project route fails before React can mount it.
        "typescript",
        "use-sync-external-store/shim/with-selector",
        "use-sync-external-store/shim/with-selector.js",
        "scheduler",
        "stats.js",
      ],
    },
  };
});
