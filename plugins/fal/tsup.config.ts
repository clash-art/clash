import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/stdio.ts", "src/module.ts"],
  format: ["esm"],
  clean: true,
  // The packaged Host copies only manifest-declared payload files, so each entry
  // must be self-contained: a shared chunk is never shipped (clash.fal failed to
  // load with "Cannot find module .../dist/chunk-*.mjs").
  splitting: false,
  target: "node24",
  noExternal: [/^@clash\//],
  outExtension: () => ({ js: ".mjs" }),
});
