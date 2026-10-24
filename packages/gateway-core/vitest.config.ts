import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

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
    // Only source suites are authoritative; never collect compiled copies.
    include: ["src/**/*.test.ts"],
    // Agent E2E suites spawn real agent binaries: `pnpm test:e2e` (vitest.e2e.config.ts).
    exclude: ["src/**/*.e2e.test.ts"],
  },
});
