import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@clash\/action-sdk\/browser$/,
        replacement: resolve(
          __dirname,
          "../../packages/action-sdk/src/browser.ts",
        ),
      },
      {
        find: /^@clash\/action-sdk$/,
        replacement: resolve(
          __dirname,
          "../../packages/action-sdk/src/index.ts",
        ),
      },
      {
        find: /^@clash\/shared-types\/(.+)$/,
        replacement: resolve(__dirname, "../../packages/shared-types/src/$1.ts"),
      },
      {
        find: /^@clash\/shared-types$/,
        replacement: resolve(__dirname, "../../packages/shared-types/src/index.ts"),
      },
      {
        find: /^@clash\/shared-runtime\/(.+)$/,
        replacement: resolve(__dirname, "../../packages/shared-runtime/src/$1.ts"),
      },
      {
        find: /^@clash\/shared-runtime$/,
        replacement: resolve(__dirname, "../../packages/shared-runtime/src/index.ts"),
      },
      { find: /^@clash\/asset-sdk\/delivery$/, replacement: resolve(__dirname, "../../packages/asset-sdk/src/delivery.ts") },
      {
        find: /^@clash\/asset-sdk$/,
        replacement: resolve(
          __dirname,
          "../../packages/asset-sdk/src/index.ts",
        ),
      },
      {
        find: /^@clash\/shared-layout$/,
        replacement: resolve(__dirname, "../../packages/shared-layout/src/index.ts"),
      },
      {
        find: /^@clash\/sdk$/,
        replacement: resolve(__dirname, "../../packages/clash-sdk/js/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    // Only source suites are authoritative. Without this, the compiled copies
    // under dist/ are collected too: every suite runs twice and the stale copy
    // fails against current fixtures while being unmaintainable.
    include: ["src/**/*.test.ts"],
    // Local API suites exercise process-global env, plugin seeding, SQLite,
    // filesystem watchers, and recursive temp cleanup. Keep test files serial
    // so one suite cannot starve or outlive another suite's lifecycle cleanup.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
