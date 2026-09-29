import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import {
  bundledPluginPaths,
  bundledPluginPayloadPaths,
  ensureBundledPlugin,
} from "./bundled-plugins";
import * as bundledPlugins from "./bundled-plugins";

it("explains why built-in checkout is unavailable and how to create a project draft", async () => {
  const reader = (bundledPlugins as Record<string, unknown>).readEditablePluginPackage as
    ((root: string, id: string) => Promise<unknown>) | undefined;
  expect(reader).toBeTypeOf("function");
  if (!reader) return;
  const root = await mkdtemp(join(tmpdir(), "clash-builtin-checkout-"));
  await expect(reader(root, "clash.asset-edit"))
    .rejects.toMatchObject({ code: "BUILTIN_PLUGIN_CHECKOUT_UNSUPPORTED", message: expect.stringMatching(/clash plugin create/) });
  expect(existsSync(join(root, "clash.asset-edit"))).toBe(false);
});

it("resolves an official Provider from the payload beside the shipped host bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-packaged-provider-"));
  const runtimeRoot = join(root, "runtime");
  const providerRoot = join(runtimeRoot, "bundled-plugins", "minimax");
  await mkdir(join(providerRoot, "dist"), { recursive: true });
  await writeFile(join(providerRoot, "manifest.json"), "{}");
  await writeFile(
    join(providerRoot, "dist", "stdio.mjs"),
    "// bundled MiniMax\n",
  );

  expect(
    bundledPluginPaths(
      "clash.minimax",
      pathToFileURL(join(runtimeRoot, "local-api.cjs")).href,
    ),
  ).toEqual({
    manifestPath: join(providerRoot, "manifest.json"),
    entrypointPath: join(providerRoot, "dist", "stdio.mjs"),
  });
});

it("reads built-in ImageGen installation from a relocated desktop payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-imagegen-payload-"));
  const pluginRoot = join(root, "bundled-plugins", "codex-imagegen");
  await mkdir(join(pluginRoot, "dist"), { recursive: true });
  const manifest = JSON.parse(
    await readFile(
      new URL("../../../plugins/codex-imagegen/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  manifest.version = `${manifest.version}-relocated`;
  await writeFile(join(pluginRoot, "manifest.json"), JSON.stringify(manifest));
  await writeFile(
    join(pluginRoot, "dist", "stdio.mjs"),
    "// fixture runtime\n",
  );
  const marketplace = bundledPlugins.createCodexImagegenMarketplace({
    actionsRoot: join(root, "actions"),
    moduleUrl: pathToFileURL(join(root, "local-api.cjs")).href,
  });
  await expect(marketplace.listInstalled()).resolves.toContainEqual(
    expect.objectContaining({ version: manifest.version, builtIn: true }),
  );
  await expect(marketplace.install(manifest.id)).resolves.toMatchObject({
    version: manifest.version,
    bundled: true,
  });
});

it("keeps declared Generator documents in an immutable bundled payload", () => {
  expect(
    bundledPluginPayloadPaths({
      apiVersion: "clash.plugin/v1",
      id: "test.generator-payload",
      version: "1.0.0",
      name: "Generator payload fixture",
      runtime: {
        kind: "local",
        transport: "stdio",
        entrypoint: "dist/stdio.mjs",
        resources: ["dist/browser-bundle"],
      },
      contributes: {
        generators: [
          {
            id: "test-generator",
            kind: "generator",
            path: "generators/test-generator.json",
          },
        ],
      },
    }),
  ).toEqual([
    "manifest.json",
    "dist/stdio.mjs",
    "dist/browser-bundle",
    "generators/test-generator.json",
  ]);
});

it("explicitly activates a standalone package once without replacing a local edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-bundled-plugin-"));
  const source = join(root, "source");
  const actionsRoot = join(root, "actions");
  await mkdir(join(source, "dist"), { recursive: true });
  await mkdir(join(source, "dist", "browser-bundle", "public"), {
    recursive: true,
  });
  await mkdir(join(source, "contract-tests"), { recursive: true });
  const manifest = {
    apiVersion: "clash.plugin/v1",
    id: "test.bundled-media",
    version: "0.1.0",
    name: "Bundled Media Fixture",
    runtime: {
      kind: "local",
      transport: "stdio",
      entrypoint: "dist/stdio.mjs",
      resources: ["dist/browser-bundle"],
    },
    contributes: {
      cards: [],
      functions: [{ id: "project-video", kind: "provider-projector" }],
    },
    contractTests: ["contract-tests/project-video.json"],
  };
  await writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
  await writeFile(
    join(source, "dist", "stdio.mjs"),
    [
      'import { createInterface } from "node:readline";',
      'createInterface({ input: process.stdin }).on("line", (line) => {',
      "  const message = JSON.parse(line);",
      '  process.stdout.write(JSON.stringify({ protocol: "clash.plugin.result/v1",',
      '    invocationId: message.invocationId, status: "completed", outputs: [] }) + "\\n");',
      "});",
    ].join("\n"),
  );
  await writeFile(
    join(source, "contract-tests", "project-video.json"),
    JSON.stringify({
      apiVersion: "clash.plugin.contract-test/v1",
      id: "project-video-basic",
      target: { exportId: "project-video", kind: "provider-projector" },
      input: { values: {}, references: [] },
      expect: { status: "completed", outputs: [] },
    }),
  );
  await writeFile(
    join(source, "dist", "browser-bundle", "index.html"),
    "<!doctype html>",
  );
  await writeFile(
    join(source, "dist", "browser-bundle", "public", "sound.wav"),
    "frozen-sound",
  );

  await expect(
    ensureBundledPlugin({
      id: "test.bundled-media",
      actionsRoot,
      manifestPath: join(source, "manifest.json"),
      entrypointPath: join(source, "dist", "stdio.mjs"),
    }),
  ).resolves.toMatchObject({ installed: true });
  const installedEntrypoint = join(
    actionsRoot,
    "test.bundled-media",
    "dist",
    "stdio.mjs",
  );
  expect(
    await readFile(
      join(
        actionsRoot,
        "test.bundled-media",
        "contract-tests",
        "project-video.json",
      ),
      "utf8",
    ),
  ).toContain("project-video-basic");
  expect(
    await readFile(
      join(
        actionsRoot,
        "test.bundled-media",
        "dist",
        "browser-bundle",
        "public",
        "sound.wav",
      ),
      "utf8",
    ),
  ).toBe("frozen-sound");

  await writeFile(installedEntrypoint, "// edited by agent\n");
  await expect(
    ensureBundledPlugin({
      id: "test.bundled-media",
      actionsRoot,
      manifestPath: join(source, "manifest.json"),
      entrypointPath: join(source, "dist", "stdio.mjs"),
    }),
  ).resolves.toMatchObject({ installed: false });
  expect(await readFile(installedEntrypoint, "utf8")).toBe(
    "// edited by agent\n",
  );
});

it("presents Codex ImageGen as an immutable built-in without creating an actions install", async () => {
  const createMarketplace = (bundledPlugins as Record<string, unknown>)
    .createCodexImagegenMarketplace as
    ((options: Record<string, unknown>) => any) | undefined;
  expect(createMarketplace).toBeTypeOf("function");
  if (!createMarketplace) return;

  const root = await mkdtemp(
    join(tmpdir(), "clash.codex-imagegen-marketplace-"),
  );
  const source = join(root, "source");
  const actionsRoot = join(root, "actions");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify({
      apiVersion: "clash.plugin/v1",
      id: "clash.codex-imagegen",
      version: "0.1.0",
      name: "Codex ImageGen",
      runtime: {
        kind: "local",
        transport: "stdio",
        entrypoint: "dist/stdio.mjs",
      },
      contributes: {
        cards: [
          {
            id: "codex-imagegen",
            kind: "action-card",
            path: "cards/codex-imagegen.json",
          },
        ],
        functions: [{ id: "generate-image", kind: "action" }],
        hostTools: ["codex.imagegen"],
      },
      contractTests: ["contract-tests/generate-image.json"],
    }),
  );

  const marketplace = createMarketplace({
    actionsRoot,
    manifestPath: join(source, "manifest.json"),
  });
  expect(marketplace.plugins).toEqual([
    expect.objectContaining({
      id: "clash.codex-imagegen",
      type: "plugin",
      packageId: "clash.codex-imagegen",
      outputs: expect.arrayContaining([
        expect.objectContaining({ kind: "generator" }),
      ]),
    }),
  ]);
  await expect(marketplace.listInstalled()).resolves.toEqual([
    expect.objectContaining({
      actionId: "codex-imagegen",
      runtime: "local",
      version: "0.1.0",
      builtIn: true,
      immutable: true,
    }),
  ]);
  await expect(
    marketplace.install("clash.codex-imagegen"),
  ).resolves.toMatchObject({
    actionId: "codex-imagegen",
    installed: false,
    bundled: true,
  });
  expect(existsSync(actionsRoot)).toBe(false);
  await expect(
    marketplace.uninstall("clash.codex-imagegen"),
  ).rejects.toMatchObject({
    status: 409,
    code: "BUILTIN_PLUGIN_IMMUTABLE",
  });
  await expect(marketplace.listInstalled()).resolves.toHaveLength(1);
});

it("installs the official Storyboard package only when the marketplace requests it", async () => {
  const createMarketplace = (bundledPlugins as Record<string, unknown>)
    .createOfficialPluginsMarketplace as
    | ((options: Record<string, unknown>) => {
        plugins: unknown[];
        listInstalled(): Promise<unknown[]>;
        install(packageId: string): Promise<Record<string, unknown>>;
        uninstall(pluginId: string): Promise<void>;
      })
    | undefined;
  expect(createMarketplace).toBeTypeOf("function");
  if (!createMarketplace) return;

  const root = await mkdtemp(join(tmpdir(), "clash-storyboard-marketplace-"));
  const source = join(root, "source");
  const actionsRoot = join(root, "actions");
  await mkdir(join(source, "dist"), { recursive: true });
  await mkdir(join(source, "views"), { recursive: true });
  await writeFile(join(source, "dist", "stdio.mjs"), "// storyboard\n");
  await writeFile(
    join(source, "views", "storyboard.json"),
    JSON.stringify({
      apiVersion: "clash.view/v1",
      kind: "view",
      spec: {
        definitionId: "storyboard",
        name: "Storyboard",
        presentation: { type: "storyboard" },
        initialState: {
          keyElements: [],
          shots: [],
          audioLayers: [],
          uncategorized: [],
        },
      },
    }),
  );
  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify({
      apiVersion: "clash.plugin/v1",
      id: "clash.storyboard",
      version: "1.0.0",
      name: "Storyboard",
      runtime: {
        kind: "local",
        transport: "stdio",
        entrypoint: "dist/stdio.mjs",
      },
      contributes: {
        views: [
          { id: "storyboard", kind: "view", path: "views/storyboard.json" },
        ],
      },
    }),
  );

  const marketplace = createMarketplace({
    actionsRoot,
    manifestPath: join(source, "manifest.json"),
    entrypointPath: join(source, "dist", "stdio.mjs"),
  });
  expect(marketplace.plugins).toEqual([
    expect.objectContaining({
      id: "clash.storyboard",
      type: "plugin",
      packageId: "clash.storyboard",
      artwork: {
        src: "/brand/avatar-storyboard.png",
        alt: "Clash Storyboard plugin",
      },
    }),
  ]);
  await expect(marketplace.listInstalled()).resolves.toEqual([]);
  await expect(marketplace.install("clash.storyboard")).resolves.toMatchObject({
    id: "clash.storyboard",
    installed: true,
  });
  await expect(marketplace.listInstalled()).resolves.toEqual([
    expect.objectContaining({ id: "clash.storyboard", version: "1.0.0" }),
  ]);
  await marketplace.uninstall("clash.storyboard");
  await expect(marketplace.listInstalled()).resolves.toEqual([]);

  const tamperedManifest = JSON.parse(
    await readFile(join(source, "manifest.json"), "utf8"),
  ) as { id: string };
  tamperedManifest.id = "evil.storyboard";
  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify(tamperedManifest),
  );
  await expect(marketplace.install("clash.storyboard")).rejects.toThrow(
    /clash\.storyboard.*evil\.storyboard/i,
  );
  expect(existsSync(join(actionsRoot, "clash.storyboard"))).toBe(false);
});
