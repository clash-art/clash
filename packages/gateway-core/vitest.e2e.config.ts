import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Agent E2E suites (`pnpm test:e2e`): a real agent binary against the gateway
 * on a loopback port with a mock upstream. No production endpoint is called.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@clash\/shared-types\/(.+)$/,
        replacement: resolve(__dirname, "../shared-types/src/$1.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.e2e.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
