import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@clash\/gateway-core$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/gateway-core/src/index.ts",
        ),
      },
      {
        find: /^@clash\/shared-types\/(.+)$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/shared-types/src/$1.ts",
        ),
      },
      {
        find: /^@clash\/metadata-service\/(.+)$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/metadata-service/src/$1.ts",
        ),
      },
      {
        find: /^@clash\/metadata-service$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/metadata-service/src/index.ts",
        ),
      },
      {
        find: /^@clash\/asset-sdk\/(.+)$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/asset-sdk/src/$1.ts",
        ),
      },
      {
        find: /^@clash\/asset-sdk$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/asset-sdk/src/index.ts",
        ),
      },
      {
        find: /^@clash\/shared-runtime\/project-host-contract$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/shared-runtime/src/project-host-contract/index.ts",
        ),
      },
      {
        find: /^@clash\/shared-runtime\/(.+)$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/shared-runtime/src/$1.ts",
        ),
      },
      {
        find: /^@clash\/shared-layout$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/shared-layout/src/index.ts",
        ),
      },
      {
        find: /^@clash\/shared-types$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/shared-types/src/index.ts",
        ),
      },
    ],
  },
  test: {
    exclude: ["src/integration/**"],
    include: ["src/**/*.test.ts"],
    testTimeout: 60000,
    maxWorkers: 1,
  },
});
