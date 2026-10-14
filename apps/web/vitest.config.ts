import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import { fileURLToPath } from "node:url";
import { DEV_SOURCE_ALIASES } from "./vite.config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    /**
     * Workspace packages export `dist/`, which neither CI nor a fresh checkout has built when this
     * suite runs. `tsconfigPaths` only rewrites imports written inside this app, so a workspace
     * source file importing another workspace package (`shared-runtime` -> `shared-types`,
     * `shared-types` -> `shared-layout`) fell through to the unbuilt package entry and passed only
     * on machines with a leftover build. Reuse the dev server's source routing so every importer
     * reads source, as `vite dev` does.
     */
    alias: [
      {
        // Lives beside `src/`, so the dev `@clash/gui/*` -> `src/*` alias must not claim it.
        find: /^@clash\/gui\/test-support\/source-match$/,
        replacement: fileURLToPath(
          new URL(
            "../../packages/gui/test-support/source-match.ts",
            import.meta.url,
          ),
        ),
      },
      ...DEV_SOURCE_ALIASES,
    ],
  },
  test: {
    environment: "node",
    /**
     * Only hand-authored sources.
     *
     * vitest's default excludes cover `dist` but not `.next`, which is where this app builds, so a
     * compiled chunk that happens to match `*.test.*` is collected and run. A planted file under
     * `.next/server/chunks/` executed and failed the suite, which means a stale build could just as
     * easily contribute a passing test nobody wrote.
     *
     * Tests live beside the code in `app/` and at the root, not under `src/`.
     */
    include: [
      "*.test.{ts,tsx}",
      "app/**/*.test.{ts,tsx}",
      "lib/**/*.test.{ts,tsx}",
    ],
  },
});
