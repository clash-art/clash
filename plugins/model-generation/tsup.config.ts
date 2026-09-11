import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/stdio.ts"],
  format: ["esm"],
  clean: true,
  target: "node24",
  // The bundled payload cannot resolve workspace dependencies after packaging.
  noExternal: [/^@clash\//],
  outExtension: () => ({ js: ".mjs" }),
});
