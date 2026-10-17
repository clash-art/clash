// Structural enforcement of the Project Host boundary (design §11):
// UI packages and shared Project Host modules depend only on ports; concrete
// adapters (local-api, api-node, api-cf) are chosen at composition roots.
// This test proves the lint rules actually fire and ratchets every allowlist.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configFile = path.join(root, ".eslintrc.boundaries.json");

const eslint = new ESLint({
  cwd: root,
  useEslintrc: false,
  overrideConfigFile: configFile,
  allowInlineConfig: false,
});

async function violations(
  relativePath: string,
  code: string,
): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(root, relativePath),
  });
  return (result?.messages ?? []).map((message) => message.ruleId ?? "parse");
}

const UI_FILE = "packages/web-ui/src/components/BoundaryProbe.tsx";
const SHARED_FILE =
  "packages/shared-runtime/src/cloud-project-host/boundary-probe.ts";
const CONTRACT_FILE =
  "packages/shared-runtime/src/project-host-contract/boundary-probe.ts";

test("UI packages cannot import backend adapters or platform runtimes", async () => {
  for (const source of [
    'import { createApp } from "@clash/local-api";',
    'import { app } from "@clash/api-cf/app";',
    'import { x } from "../../../../apps/local-api/src/app";',
    'import type { R2Bucket } from "@cloudflare/workers-types";',
    'import { env } from "cloudflare:workers";',
    'import { discoverHost } from "@clash/shared-runtime/host-discovery";',
    'import { executeTimelineHostCommand } from "@clash/shared-runtime/cloud-project-host/timeline-commands";',
    'import { resolveRuntimeConfig } from "@clash/shared-runtime";',
  ]) {
    assert.deepEqual(
      await violations(UI_FILE, source),
      ["no-restricted-imports"],
      source,
    );
  }
  assert.deepEqual(
    await violations(
      UI_FILE,
      'import { createProjectAssetHttpClient } from "@clash/asset-sdk";',
    ),
    [],
  );
});

test("UI packages cannot branch on the backend runtime", async () => {
  for (const source of [
    "if (hasLocalHostRuntime()) load();",
    'if (getRuntimeConfig().mode === "hosted") skip();',
    'const mode = readRuntimeModeAtCompositionRoot();',
    "const config = globalThis.__CLASH_RUNTIME_CONFIG__;",
  ]) {
    assert.ok(
      (await violations(UI_FILE, source)).includes("no-restricted-syntax"),
      source,
    );
  }
  assert.deepEqual(
    await violations(UI_FILE, 'if (getRuntimeCapabilities().host.timelineRender === "available") render();'),
    [],
  );
});

test("shared Project Host modules cannot see the platform", async () => {
  for (const file of [SHARED_FILE, CONTRACT_FILE]) {
    for (const source of [
      'import { DurableObject } from "cloudflare:workers";',
      'import type { R2Bucket } from "@cloudflare/workers-types";',
      'import { readFile } from "node:fs/promises";',
      'import path from "path";',
      'import pg from "pg";',
      'import { PGlite } from "@electric-sql/pglite";',
      'import { Hono } from "hono";',
      'import { ProjectRoom } from "../../../../apps/api-cf/src/agents/project-room";',
    ]) {
      assert.ok(
        (await violations(file, source)).includes("no-restricted-imports"),
        `${file}: ${source}`,
      );
    }
    for (const source of [
      "const stage = process.env.STAGE;",
      "const now = Date.now();",
      "const at = new Date();",
      "const id = crypto.randomUUID();",
      "const r = Math.random();",
      "const desktop = globalThis.__CLASH_DESKTOP__;",
      "export function put(bucket: R2Bucket) { return bucket; }",
    ]) {
      assert.ok(
        (await violations(file, source)).includes("no-restricted-syntax"),
        `${file}: ${source}`,
      );
    }
  }
  assert.deepEqual(
    await violations(
      SHARED_FILE,
      'import { LoroDoc } from "loro-crdt";\nexport const at = (clock: { now(): number }) => new Date(clock.now());',
    ),
    [],
  );
});

test("the asset SDK cannot see the platform", async () => {
  const file = "packages/asset-sdk/src/boundary-probe.ts";
  for (const source of [
    'import type { R2Bucket } from "@cloudflare/workers-types";',
    'import { readFile } from "node:fs/promises";',
    'import { Hono } from "hono";',
  ]) {
    assert.ok(
      (await violations(file, source)).includes("no-restricted-imports"),
      source,
    );
  }
  for (const source of [
    "const stage = process.env.STAGE;",
    "export const put = (bucket: R2Bucket) => bucket;",
  ]) {
    assert.ok(
      (await violations(file, source)).includes("no-restricted-syntax"),
      source,
    );
  }
});

test("boundary lint exemptions cannot grow (ratchet)", () => {
  const config = JSON.parse(readFileSync(configFile, "utf8")) as {
    overrides: Array<{ files: string[]; rules: Record<string, unknown> }>;
  };
  const exempt = config.overrides
    .filter((override) =>
      Object.values(override.rules).every((rule) => rule === "off"),
    )
    .flatMap((override) => override.files)
    .sort();
  assert.deepEqual(exempt, [
    // Chat/auth transport clients (not the editor path); frozen.
    "packages/web-ui/src/hooks/useAgentCopilot.ts",
    "packages/web-ui/src/lib/betterAuthClient.ts",
    // The single place that resolves the injected runtime config.
    "packages/web-ui/src/lib/runtimeConfig.ts",
  ]);
});

const UI_PACKAGES = [
  "web-ui",
  "remotion-ui",
  "director-ui",
  "gui",
  "remotion-components",
];
const FORBIDDEN_UI_DEPENDENCY =
  /^(@clash\/(local-api|api-node|api-cf|render-server|desktop|web)$|wrangler$|pg$|postgres$|@electric-sql\/)/;
const FROZEN_UI_PLATFORM_DEPENDENCIES: Record<string, string[]> = {
  "web-ui": ["@cloudflare/ai-chat", "agents", "better-auth-cloudflare"],
};
const SHARED_RUNTIME_DEPENDENCIES = [
  "@clash/action-sdk",
  "@clash/asset-sdk",
  "@clash/shared-types",
  "@noble/hashes",
  "ajv",
  "loro-crdt",
];

function runtimeDependencies(pkg: string): string[] {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "packages", pkg, "package.json"), "utf8"),
  ) as Record<string, Record<string, string> | undefined>;
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  }).sort();
}

test("UI package manifests depend only on shared interfaces", () => {
  for (const pkg of UI_PACKAGES) {
    const dependencies = runtimeDependencies(pkg);
    assert.deepEqual(
      dependencies.filter((name) => FORBIDDEN_UI_DEPENDENCY.test(name)),
      [],
      pkg,
    );
    assert.deepEqual(
      dependencies.filter((name) =>
        /^(@cloudflare\/|agents$|better-auth-cloudflare$)/.test(name),
      ),
      FROZEN_UI_PLATFORM_DEPENDENCIES[pkg] ?? [],
      `${pkg}: platform dependencies are frozen`,
    );
  }
});

test("shared-runtime gains no platform runtime dependencies", () => {
  assert.deepEqual(
    runtimeDependencies("shared-runtime"),
    SHARED_RUNTIME_DEPENDENCIES,
  );
});

// Desktop-shell chrome (window controls, native bridges) may probe the Electron
// shell; it never selects a backend. These sites are frozen: new UI code must
// read RuntimeCapabilities instead.
const DESKTOP_SHELL_PROBES: Record<string, number> = {
  "packages/web-ui/src/components/BrowserSurface.tsx": 1,
  "packages/web-ui/src/components/ChatbotCopilot.tsx": 2,
  "packages/web-ui/src/components/CloudConnection.tsx": 3,
  "packages/web-ui/src/components/LayoutContent.tsx": 1,
  "packages/web-ui/src/components/MarketplacePluginDetail.tsx": 1,
  "packages/web-ui/src/components/ProjectCard.tsx": 2,
  "packages/web-ui/src/components/ProjectEditor.tsx": 4,
  "packages/web-ui/src/components/ProjectWorkspaceSurfaces.tsx": 4,
  "packages/web-ui/src/components/SettingsClient.tsx": 1,
  "packages/web-ui/src/components/TopNavigation.tsx": 2,
  "packages/web-ui/src/components/UserControls.tsx": 1,
  "packages/web-ui/src/lib/runtimeConfig.ts": 4,
};

test("desktop-shell probes in UI packages only shrink (ratchet)", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const counts: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (entry === "node_modules" || entry === "dist") continue;
      if (statSync(full).isDirectory()) {
        if (entry !== "test-support") walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry))
        continue;
      const hits = readFileSync(full, "utf8").match(
        /isDesktopRuntime\(|__CLASH_DESKTOP__/g,
      );
      if (hits) counts[path.relative(root, full)] = hits.length;
    }
  };
  for (const pkg of UI_PACKAGES) walk(path.join(root, "packages", pkg, "src"));
  for (const [file, count] of Object.entries(counts)) {
    assert.ok(
      count <= (DESKTOP_SHELL_PROBES[file] ?? 0),
      `${file}: ${count} desktop-shell probes (allowed ${DESKTOP_SHELL_PROBES[file] ?? 0}); read getRuntimeCapabilities() instead`,
    );
  }
});

// Lint checks each file; this follows the whole import graph, so a shared
// module cannot reach a platform through a helper it imports.
const PLATFORM_IMPORT =
  /^(node:|cloudflare:|@cloudflare\/|wrangler($|\/)|agents($|\/)|partyserver($|\/)|pg($|\/)|postgres$|@electric-sql\/|drizzle-orm($|\/)|better-sqlite3$|hono($|\/)|better-auth($|\/)|(fs|path|os|child_process|crypto|stream|worker_threads|http|https|net)$)/;
const SHARED_ENTRIES = [
  "packages/shared-runtime/src/cloud-project-host/timeline-commands.ts",
  "packages/shared-runtime/src/cloud-project-host/project-assets.ts",
  "packages/shared-runtime/src/cloud-project-host/plugin-catalog.ts",
  "packages/shared-runtime/src/cloud-project-host/text-revisions.ts",
  "packages/shared-runtime/src/project-host-contract/index.ts",
];

test("shared Project Host modules reach no platform transitively", async () => {
  const { build } = await import("esbuild");
  const reached = new Map<string, string>();
  await build({
    entryPoints: SHARED_ENTRIES.map((entry) => path.join(root, entry)),
    absWorkingDir: root,
    bundle: true,
    write: false,
    outdir: "/tmp/clash-architecture-boundaries",
    platform: "neutral",
    format: "esm",
    mainFields: ["module", "main"],
    conditions: ["import"],
    // Follow workspace sources (not dist), exactly as the typecheck does.
    tsconfig: path.join(root, "tsconfig.source.json"),
    logLevel: "silent",
    plugins: [
      {
        name: "record-external",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /.*/ }, (args) => {
            if (
              args.path.startsWith(".") ||
              args.path.startsWith("/") ||
              args.path.startsWith("@clash/")
            )
              return undefined;
            reached.set(args.path, path.relative(root, args.importer));
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  const leaks = [...reached].filter(([specifier]) =>
    PLATFORM_IMPORT.test(specifier),
  );
  assert.deepEqual(
    leaks,
    [],
    "platform modules reached from shared Project Host code",
  );
});
