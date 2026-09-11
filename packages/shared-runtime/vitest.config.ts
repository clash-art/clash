import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@clash\/action-sdk\/(.+)$/,
        replacement: resolve(__dirname, "../action-sdk/src/$1.ts"),
      },
      {
        find: /^@clash\/action-sdk$/,
        replacement: resolve(__dirname, "../action-sdk/src/index.ts"),
      },
      {
        find: /^@clash\/asset-sdk$/,
        replacement: resolve(__dirname, "../asset-sdk/src/index.ts"),
      },
      {
        find: /^@clash\/shared-types\/(.+)$/,
        replacement: resolve(__dirname, "../shared-types/src/$1.ts"),
      },
      {
        find: /^@clash\/shared-types$/,
        replacement: resolve(__dirname, "../shared-types/src/index.ts"),
      },
    ],
  },
  test: {
    // Google's hosts resolve to both families here, and Node tries IPv6 first and waits for the
    // connect to time out -- `EHOSTUNREACH 2607:f8b0:...` after tens of seconds, while curl on the
    // same machine answers immediately because it falls back on reachability and Node does not.
    // A suite that talks to Google fails as a timeout with nothing naming the cause.
    env: { NODE_OPTIONS: "--dns-result-order=ipv4first" },
    environment: "node",
    // Only source suites are authoritative. Without this, the compiled copies
    // under dist/ are collected too, so every suite runs twice and a stale
    // build can pass or fail independently of the code under review.
    include: ["src/**/*.test.ts"],
  },
});
