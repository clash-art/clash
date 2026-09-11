import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import viteConfig, {
  DEV_SOURCE_ALIASES,
  DEV_WATCH_IGNORES,
} from "./vite.config";

const originalDisableCloudflare = process.env.CLASH_WEB_E2E_NO_CLOUDFLARE;
const testDirectory = dirname(fileURLToPath(import.meta.url));

function collectPluginNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectPluginNames);
  if (!value || typeof value !== "object" || !("name" in value)) return [];

  const name = (value as { name?: unknown }).name;
  return typeof name === "string" ? [name] : [];
}

beforeEach(() => {
  process.env.CLASH_WEB_E2E_NO_CLOUDFLARE = "1";
});

afterEach(() => {
  if (originalDisableCloudflare === undefined) {
    delete process.env.CLASH_WEB_E2E_NO_CLOUDFLARE;
  } else {
    process.env.CLASH_WEB_E2E_NO_CLOUDFLARE = originalDisableCloudflare;
  }
});

describe("Vite workspace source routing", () => {
  it("loads the dev copilot preview without unresolved workspace modules", async () => {
    const route = await import("./app/routes/__codex-copilot-preview");

    expect(route.default).toEqual(expect.any(Function));
  }, 20_000);

  it("keeps React component state across source updates with Fast Refresh", async () => {
    if (typeof viteConfig !== "function") {
      throw new Error("Expected Vite config to be a function.");
    }

    const resolved = await viteConfig({
      command: "serve",
      mode: "development",
      isPreview: false,
      isSsrBuild: false,
    });
    const pluginNames = collectPluginNames(resolved.plugins);

    expect(pluginNames).toEqual(
      expect.arrayContaining(["vite:react-babel", "vite:react-refresh"]),
    );
  });

  it("serves shared packages from source and ignores generated package output", async () => {
    expect(DEV_SOURCE_ALIASES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          find: /^@clash\/asset-sdk$/,
          replacement: expect.stringMatching(
            /\/packages\/asset-sdk\/src\/index\.ts$/,
          ),
        }),
        expect.objectContaining({
          find: /^@clash\/web-ui\/(.+)$/,
          replacement: expect.stringMatching(/\/packages\/web-ui\/src\/\$1$/),
        }),
        expect.objectContaining({
          find: /^@clash\/web-ui$/,
          replacement: expect.stringMatching(
            /\/packages\/web-ui\/src\/index\.ts$/,
          ),
        }),
        expect.objectContaining({
          find: /^@clash\/gui\/(.+)$/,
          replacement: expect.stringMatching(/\/packages\/gui\/src\/\$1$/),
        }),
        expect.objectContaining({
          find: /^@clash\/shared-types\/actions\/asset-edit$/,
          replacement: expect.stringMatching(
            /\/packages\/shared-types\/src\/actions\/asset-edit\.ts$/,
          ),
        }),
        expect.objectContaining({
          find: /^@clash\/shared-types\/executable-plugin$/,
          replacement: expect.stringMatching(
            /\/packages\/shared-types\/src\/executable-plugin\.ts$/,
          ),
        }),
        expect.objectContaining({
          find: /^@clash\/shared-types\/timeline-contract$/,
          replacement: expect.stringMatching(
            /\/packages\/shared-types\/src\/timeline-contract\.ts$/,
          ),
        }),
        expect.objectContaining({
          find: /^@clash\/shared-types$/,
          replacement: expect.stringMatching(
            /\/packages\/shared-types\/src\/index\.ts$/,
          ),
        }),
        expect.objectContaining({
          find: /^@clash\/shared-runtime$/,
          replacement: expect.stringMatching(
            /\/packages\/shared-runtime\/src\/browser\.ts$/,
          ),
        }),
      ]),
    );
    expect(DEV_WATCH_IGNORES).toEqual(
      expect.arrayContaining(["**/dist/**", "**/release/**", "**/.tmp/**"]),
    );

    if (typeof viteConfig !== "function") {
      throw new Error("Expected Vite config to be a function.");
    }

    const resolved = await viteConfig({
      command: "serve",
      mode: "development",
      isPreview: false,
      isSsrBuild: false,
    });

    expect(resolved.resolve?.alias).toBe(DEV_SOURCE_ALIASES);
    expect(resolved.server?.watch?.ignored).toBe(DEV_WATCH_IGNORES);
    expect(resolved.server?.port).toBe(3000);
    expect(resolved.preview?.port).toBe(3000);
  });

  it("resolves linked OpenMA entrypoints from source instead of mutable dist output", async () => {
    const server = await createServer({
      configFile: resolve(testDirectory, "vite.config.ts"),
      mode: "development",
      server: { middlewareMode: true },
    });

    try {
      const importer = resolve(testDirectory, "app/main.tsx");
      const entrypoints = [
        ["@openma/common/chat-ui", "/src/chat-ui/index.ts"],
        ["@openma/common/chat-ui/styles.css", "/src/chat-ui/styles.css"],
        ["@openma/common/agent-ui", "/src/agent-ui/index.ts"],
        ["@openma/common/agent-ui/react", "/src/agent-ui/react.tsx"],
        ["@openma/common/protocol/acp", "/src/protocol/acp/index.ts"],
        [
          "@openma/common/session-events/openma",
          "/src/session-events/openma.ts",
        ],
        ["@openma/common/session-ui", "/src/session-ui/index.tsx"],
      ] as const;

      for (const [specifier, sourceSuffix] of entrypoints) {
        const resolved = await server.pluginContainer.resolveId(
          specifier,
          importer,
        );

        expect(resolved?.id).toMatch(/\/openma-common\/src\//u);
        expect(resolved?.id.endsWith(sourceSuffix)).toBe(true);
        expect(resolved?.id).not.toContain("/openma-common/dist/");
      }
    } finally {
      await server.close();
    }
  });

  it("resolves the virtualizer's transitive dependency from the linked common package", async () => {
    const server = await createServer({
      configFile: resolve(testDirectory, "vite.config.ts"),
      mode: "development",
      resolve: { preserveSymlinks: true },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true },
    });
    try {
      const importer = resolve(testDirectory, "../../../openma-common/src/chat-ui/components.tsx");
      const entry = await server.pluginContainer.resolveId("@tanstack/react-virtual", importer);
      expect(entry).not.toBeNull();
      const core = await server.pluginContainer.resolveId("@tanstack/virtual-core", entry!.id);
      expect(core).not.toBeNull();
    } finally {
      await server.close();
    }
  }, 30_000);

  it("canonicalizes Remotion UI imports to one source identity for HMR", async () => {
    const server = await createServer({
      configFile: resolve(testDirectory, "vite.config.ts"),
      mode: "development",
      resolve: { preserveSymlinks: true },
      server: { middlewareMode: true },
    });

    try {
      const importer = resolve(
        testDirectory,
        "../../packages/web-ui/src/components/ProjectWorkspaceSurfaces.tsx",
      );
      const resolved = await server.pluginContainer.resolveId(
        "@clash/remotion-ui",
        importer,
      );

      expect(resolved?.id).toMatch(
        /\/packages\/remotion-ui\/src\/index\.ts$/u,
      );
      expect(resolved?.id).not.toContain(
        "/packages/web-ui/node_modules/@clash/remotion-ui/",
      );
    } finally {
      await server.close();
    }
  }, 30_000);

  it("resolves the AI SDK event stream parser from its logical workspace path", async () => {
    const server = await createServer({
      configFile: resolve(testDirectory, "vite.config.ts"),
      mode: "development",
      resolve: { preserveSymlinks: true },
      server: { middlewareMode: true },
    });

    try {
      const importer = resolve(
        testDirectory,
        "../../node_modules/@ai-sdk/provider-utils/dist/index.mjs",
      );
      const resolved = await server.pluginContainer.resolveId(
        "eventsource-parser/stream",
        importer,
      );

      expect(resolved?.id).toMatch(
        /\/eventsource-parser(?:_stream|\/dist\/stream)\.js(?:\?.*)?$/u,
      );
    } finally {
      await server.close();
    }
  }, 30_000);

  it("excludes mixed-version and sibling UI graphs from dev prebundling", async () => {
    if (typeof viteConfig !== "function") {
      throw new Error("Expected Vite config to be a function.");
    }

    const resolved = await viteConfig({
      command: "serve",
      mode: "development",
      isPreview: false,
      isSsrBuild: false,
    });

    // Source aliases pull shared-types (zod v3 + zod-to-json-schema) into the
    // same module graph as apps/web + api-cf (zod v4). Prebundling would merge
    // the two majors into one optimized copy, breaking the Timeline DSL JSON
    // Schema conversion ("missing nested items").
    expect(resolved.optimizeDeps?.exclude).toEqual(
      expect.arrayContaining([
        "@clash/web-ui",
        "@clash/remotion-ui",
        "@clash/remotion-components",
        "@clash/remotion-core",
        "@clash/remotion-effects",
        "@clash/director-ui",
        "loro-crdt",
        "zod",
        "zod-to-json-schema",
      ]),
    );

    // react-dropzone's attr-accept dependency publishes CommonJS syntax from
    // its `module` entry. When web-ui is reached through a workspace symlink,
    // Vite's entry crawl does not discover that transitive package in time and
    // serves it as native ESM, leaving the renderer blank at startup.
    expect(resolved.optimizeDeps?.include).toEqual(
      expect.arrayContaining([
        "react-dropzone",
        "attr-accept",
        "react-markdown",
        "@cloudflare/ai-chat/react",
        "debug",
        "extend",
        "typescript",
        "use-sync-external-store/shim/with-selector",
        "use-sync-external-store/shim/with-selector.js",
        "scheduler",
        "stats.js",
      ]),
    );
    expect(resolved.optimizeDeps?.include).not.toContain(
      "@clash/web-ui > @clash/remotion-ui > @clash/remotion-components > typescript",
    );
    expect(resolved.optimizeDeps?.entries).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/app\/routes\/project\.\$id\.tsx$/u),
        expect.stringMatching(
          /\/packages\/web-ui\/src\/components\/HomePageClient\.tsx$/u,
        ),
        expect.stringMatching(
          /\/packages\/web-ui\/src\/components\/ProjectEditor\.tsx$/u,
        ),
        expect.stringMatching(
          /\/packages\/web-ui\/src\/components\/MilkdownEditor\.tsx$/u,
        ),
        expect.stringMatching(/\/packages\/remotion-ui\/src\/index\.ts$/u),
        expect.stringMatching(
          /\/packages\/remotion-components\/src\/index\.ts$/u,
        ),
      ]),
    );
  });

  it("resolves OpenMA UI peers through the Clash host dependency graph", () => {
    expect(DEV_SOURCE_ALIASES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          find: /^@radix-ui\/react-collapsible$/,
          replacement: expect.stringMatching(
            /\/node_modules\/\.pnpm\/.*\/node_modules\/@radix-ui\/react-collapsible\/dist\/index\.mjs$/,
          ),
        }),
        expect.objectContaining({
          find: /^streamdown$/,
          replacement: expect.stringMatching(
            /\/node_modules\/\.pnpm\/.*\/node_modules\/streamdown\/dist\/index\.js$/,
          ),
        }),
      ]),
    );
  });

  it("excludes the same deps for the clash_api worker environment", async () => {
    if (typeof viteConfig !== "function") {
      throw new Error("Expected Vite config to be a function.");
    }

    const resolved = await viteConfig({
      command: "serve",
      mode: "development",
      isPreview: false,
      isSsrBuild: false,
    });

    // The Cloudflare plugin creates a `clash_api` environment for the
    // auxiliary api-cf worker. Environment optimizers do not inherit the
    // top-level optimizeDeps.exclude, so the worker graph must repeat it.
    expect(resolved.environments?.clash_api?.optimizeDeps?.exclude).toEqual(
      expect.arrayContaining(["loro-crdt", "zod", "zod-to-json-schema"]),
    );
  });

  it("keeps production builds on package exports", async () => {
    if (typeof viteConfig !== "function") {
      throw new Error("Expected Vite config to be a function.");
    }

    const resolved = await viteConfig({
      command: "build",
      mode: "production",
      isPreview: false,
      isSsrBuild: false,
    });

    expect(resolved.resolve?.alias).toBeUndefined();
  });
});
