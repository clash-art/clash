import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

// Pull D1 migrations from the web app (the canonical schema location).
const migrationsPath = path.resolve(__dirname, "../web/drizzle");

export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsPath);

  return {
    resolve: {
      alias: [
        ...[
          "shared-types",
          "shared-runtime",
          "action-sdk",
          "asset-sdk",
          "shared-cloud-schema",
        ].flatMap((name) => [
          {
            find: new RegExp(`^@clash/${name}/(.+)$`),
            replacement: path.resolve(
              __dirname,
              `../../packages/${name}/src/$1.ts`,
            ),
          },
          {
            find: new RegExp(`^@clash/${name}$`),
            replacement: path.resolve(
              __dirname,
              `../../packages/${name}/src/index.ts`,
            ),
          },
        ]),
        {
          find: /^@clash\/replica\/(.+)$/,
          replacement: path.resolve(
            __dirname,
            "../../packages/shared-replica/src/$1.ts",
          ),
        },
        {
          find: /^@clash\/replica$/,
          replacement: path.resolve(
            __dirname,
            "../../packages/shared-replica/src/index.ts",
          ),
        },
        {
          find: /^@clash\/shared-layout$/,
          replacement: path.resolve(
            __dirname,
            "../../packages/shared-layout/src/index.ts",
          ),
        },
        {
          find: /^@clash\/remotion-core$/,
          replacement: path.resolve(
            __dirname,
            "../../packages/remotion-core/src/index.ts",
          ),
        },
      ],
    },
    plugins: [
      cloudflareTest({
        singleWorker: true,
        // Workflows require shared storage in pool-workers; tests must clean up themselves.
        isolatedStorage: false,
        main: "./src/integration/test-worker.ts",
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations as unknown } as Record<
            string,
            unknown
          >,
          // loro-crdt ships .wasm; load anything matching as a CompiledWasm module.
          modulesRules: [
            { type: "CompiledWasm", include: ["**/*.wasm"], fallthrough: true },
          ],
        },
        wrangler: { configPath: "./wrangler.integration.toml" },
      }),
    ],
    test: {
      testTimeout: 60_000,
      include: ["src/**/*.integration.test.ts"],
      setupFiles: ["./test/integration-setup.ts"],
      deps: {
        optimizer: {
          ssr: {
            enabled: true,
            include: ["loro-crdt"],
          },
        },
      },
    },
  };
});
