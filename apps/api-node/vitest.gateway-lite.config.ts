import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";
// Gateway lite multi-process harness (#379): see scripts/test-gateway-lite.ts.
export default defineConfig({
  resolve: base.resolve,
  test: {
    include: ["src/integration/*.lite.test.ts"],
    testTimeout: 120000,
    hookTimeout: 180000,
    maxWorkers: 1,
  },
});
