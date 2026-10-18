import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Metafile } from "esbuild";

import { assertLazyHostDependenciesStayLazy } from "./host-lazy-dependencies.js";

type Imports = Metafile["inputs"][string]["imports"];

function metafile(graph: Record<string, Imports>): Pick<Metafile, "inputs"> {
  return {
    inputs: Object.fromEntries(
      Object.entries(graph).map(([path, imports]) => [path, { bytes: 1, imports }]),
    ),
  };
}

const ENTRY = "src/local-api-entry.ts";
const SERVER = "../../apps/local-api/dist/server.js";
const CODEC = "../../apps/local-api/dist/local-image-codec.js";
const SHARP = "../../node_modules/.pnpm/sharp@0.34.5/node_modules/sharp/lib/index.js";

describe("lazy Host dependencies", () => {
  it("accepts a dependency that is reached only through dynamic import()", () => {
    assert.doesNotThrow(() =>
      assertLazyHostDependenciesStayLazy(
        metafile({
          [ENTRY]: [{ path: SERVER, kind: "import-statement" }],
          [SERVER]: [{ path: CODEC, kind: "import-statement" }],
          [CODEC]: [{ path: SHARP, kind: "dynamic-import" }],
          [SHARP]: [],
        }),
        ENTRY,
        ["sharp"],
      ),
    );
  });

  it("names the static import chain that would evaluate a lazy dependency at startup", () => {
    assert.throws(
      () =>
        assertLazyHostDependenciesStayLazy(
          metafile({
            [ENTRY]: [{ path: SERVER, kind: "import-statement" }],
            [SERVER]: [
              { path: CODEC, kind: "import-statement" },
              { path: SHARP, kind: "import-statement" },
            ],
            [CODEC]: [{ path: SHARP, kind: "dynamic-import" }],
            [SHARP]: [],
          }),
          ENTRY,
          ["sharp"],
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(`sharp: ${ENTRY} -> ${SERVER} -> ${SHARP}`),
    );
  });

  it("ignores packages that are not declared lazy", () => {
    assert.doesNotThrow(() =>
      assertLazyHostDependenciesStayLazy(
        metafile({
          [ENTRY]: [{ path: SHARP, kind: "import-statement" }],
          [SHARP]: [],
        }),
        ENTRY,
        ["@aws-sdk/client-s3"],
      ),
    );
  });
});
