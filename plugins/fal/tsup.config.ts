import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/stdio.ts", "src/module.ts"],
  format: ["esm"],
  clean: true,
  target: "node24",
  noExternal: [/^@clash\//],
  outExtension: () => ({ js: ".mjs" }),
});
