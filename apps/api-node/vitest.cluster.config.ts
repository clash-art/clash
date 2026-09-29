import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";
export default defineConfig({
  resolve: base.resolve,
  test: {
    include: ["src/integration/*.integration.test.ts"],
    testTimeout: 120000,
    hookTimeout: 30000,
    maxWorkers: 1,
  },
});
