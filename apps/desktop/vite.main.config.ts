import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(desktopRoot, "../..");

const desktopSourceAliases = [
  {
    find: /^@clash\/action-sdk\/(.+)$/,
    replacement: resolve(repoRoot, "packages/action-sdk/src/$1.ts"),
  },
  {
    find: "@clash/action-sdk",
    replacement: resolve(repoRoot, "packages/action-sdk/src/index.ts"),
  },
  {
    find: "@clash/asset-sdk",
    replacement: resolve(repoRoot, "packages/asset-sdk/src/index.ts"),
  },
  {
    find: /^@clash\/shared-types\/(.+)$/,
    replacement: resolve(repoRoot, "packages/shared-types/src/$1.ts"),
  },
  {
    find: "@clash/shared-types",
    replacement: resolve(repoRoot, "packages/shared-types/src/index.ts"),
  },
  {
    find: "@clash/shared-layout",
    replacement: resolve(repoRoot, "packages/shared-layout/src/index.ts"),
  },
  {
    find: /^@clash\/shared-runtime\/(.+)$/,
    replacement: resolve(repoRoot, "packages/shared-runtime/src/$1.ts"),
  },
  {
    find: "@clash/shared-runtime",
    replacement: resolve(repoRoot, "packages/shared-runtime/src/index.ts"),
  },
  {
    find: "@clash/sdk",
    replacement: resolve(repoRoot, "packages/clash-sdk/js/src/index.ts"),
  },
] as const;

export default defineConfig(({ command }) => ({
  define:
    command === "build"
      ? { MAIN_WINDOW_VITE_DEV_SERVER_URL: "undefined" }
      : undefined,
  resolve: {
    alias: desktopSourceAliases,
  },
  ssr: {
    noExternal: ["zod", "zod-to-json-schema"],
  },
  build: {
    outDir: resolve(desktopRoot, "dist"),
    emptyOutDir: false,
    sourcemap: true,
    ssr: resolve(desktopRoot, "src/main.ts"),
    lib: {
      entry: resolve(desktopRoot, "src/main.ts"),
      formats: ["cjs"],
      fileName: () => "main.cjs",
    },
    rollupOptions: {
      external: [
        "electron",
        "electron-updater",
        "@remotion/bundler",
        "@remotion/renderer",
        "loro-crdt",
      ],
      output: {
        format: "cjs",
        entryFileNames: "[name].cjs",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
}));
