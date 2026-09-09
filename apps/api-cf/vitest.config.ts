import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@clash\/replica\/loro-protocol$/,
        replacement: resolve(
          __dirname,
          "../../packages/shared-replica/src/loro-protocol.ts",
        ),
      },
      {
        find: /^@clash\/replica\/loro$/,
        replacement: resolve(
          __dirname,
          "../../packages/shared-replica/src/loro.ts",
        ),
      },
      {
        find: /^@clash\/replica$/,
        replacement: resolve(
          __dirname,
          "../../packages/shared-replica/src/index.ts",
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
      {
        find: /^@clash\/shared-runtime\/(.+)$/,
        replacement: resolve(
          __dirname,
          "../../packages/shared-runtime/src/$1.ts",
        ),
      },
      {
        find: /^@clash\/shared-runtime$/,
        replacement: resolve(
          __dirname,
          "../../packages/shared-runtime/src/index.ts",
        ),
      },
      {
        find: /^@clash\/shared-layout$/,
        replacement: resolve(
          __dirname,
          "../../packages/shared-layout/src/index.ts",
        ),
      },
      {
        find: /^@clash\/asset-sdk\/delivery$/,
        replacement: resolve(
          __dirname,
          "../../packages/asset-sdk/src/delivery.ts",
        ),
      },
      {
        find: /^@clash\/remotion-core$/,
        replacement: resolve(
          __dirname,
          "../../packages/remotion-core/src/index.ts",
        ),
      },
    ],
  },
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
  },
});
