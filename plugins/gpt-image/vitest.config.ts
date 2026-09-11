import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace tests must observe shared-types source without requiring a package build first.
  resolve: {
    alias: [
      {
        find: /^@clash\/shared-types\/(.+)$/,
        replacement: resolve(
          __dirname,
          "../../packages/shared-types/src/$1.ts",
        ),
      },
      {
        find: /^@clash\/shared-types$/,
        replacement: resolve(
          __dirname,
          "../../packages/shared-types/src/index.ts",
        ),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
