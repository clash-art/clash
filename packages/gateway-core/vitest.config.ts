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
  },
});
