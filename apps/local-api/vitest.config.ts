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
        // shared-runtime's root entry imports this subpath from source.
        // The package export points at dist/, which Desktop Checks does not build.
        find: /^@clash\/action-sdk\/executable-failure$/,
        replacement: resolve(
          __dirname,
          "../../packages/action-sdk/src/executable-failure.ts",
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
        // Package root exports dist/, which Desktop Checks does not build.
        // Subpath exports already point their import condition at source.
        find: /^@clash\/replica$/,
        replacement: resolve(
          __dirname,
          "../../packages/shared-replica/src/index.ts",
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
        find: /^@clash\/shared-runtime\/project-host-contract$/,
        replacement: resolve(__dirname, "../../packages/shared-runtime/src/project-host-contract/index.ts"),
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
      { find: /^@clash\/asset-sdk\/upload-service$/, replacement: resolve(__dirname, "../../packages/asset-sdk/src/upload-service.ts") },
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
      {
        find: /^@clash\/gateway-core\/testing$/,
        replacement: resolve(__dirname, "../../packages/gateway-core/src/testing/memory-ports.ts"),
      },
      {
        find: /^@clash\/gateway-core$/,
        replacement: resolve(__dirname, "../../packages/gateway-core/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    // Drain and close the process-wide SQLite worker before every suite's own
    // afterEach removes its temporary data dir. "list" keeps hook registration
    // order for teardown, so this file hook runs before the suite cleanups
    // (the default "stack" order would run it after them).
    setupFiles: ["./vitest.setup.ts"],
    sequence: { hooks: "list" },
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
