import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@clash\/action-sdk$/,
        replacement: resolve(
          __dirname,
          "../../packages/action-sdk/src/index.ts",
        ),
      },
      {
        find: /^@clash\/shared-runtime\/(.+)$/,
        replacement: resolve(
          __dirname,
          "../../packages/shared-runtime/src/$1.ts",
        ),
      },
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
