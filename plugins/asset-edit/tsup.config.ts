import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/stdio.ts"],
  format: ["esm"],
  clean: true,
  target: "node24",
  // Host runtime provides these Node packages; inlining breaks WASM file
  // resolution and CommonJS require inside the ESM payload.
  external: ["loro-crdt", "yaml"],
  noExternal: [/^@clash\//],
  outExtension: () => ({ js: ".mjs" }),
});
