import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUNDLED_PLUGINS,
  OFFICIAL_MARKETPLACE_PLUGIN_PACKAGES,
  bundledPluginPayloadFiles,
  ensureBundledPlugin,
} from "./bundled-plugins.js";

/**
 * First-party Providers ship with the host.
 *
 * They are not installed the way a third-party plugin is. `clash.google` and `clash.minimax` were
 * activated through `clash plugin activate` during development, which put them under
 * `~/.clash/actions` -- and the host still reported only `hilo-hub`, because what the host seeds at
 * startup is this list, not that directory.
 *
 * The seeding function was written for exactly one plugin: its id was a constant, its paths came
 * from one hard-coded `require.resolve`, and it threw if the manifest said anything else. Splitting
 * one plugin per Provider made that shape untenable, which is what this covers.
 */
function pluginSource(id: string) {
  const dir = mkdtempSync(join(tmpdir(), "bundled-"));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "stdio.mjs"), "// entrypoint");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      apiVersion: "clash.plugin/v1",
      id,
      version: "0.1.0",
      name: id,
      runtime: {
        kind: "local",
        transport: "stdio",
        entrypoint: "dist/stdio.mjs",
        args: [],
      },
      contributes: { functions: [] },
    }),
  );
  return dir;
}

describe("bundled plugins", () => {
  it("keeps the official Storyboard View installable but unpreloaded", () => {
    const workspace = join(
      __dirname,
      "../../../plugins/official/storyboard",
    );
    expect(existsSync(join(workspace, "manifest.json"))).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(workspace, "manifest.json"), "utf8"),
    ) as {
      id: string;
      author?: string;
      contributes?: {
        views?: unknown[];
        generators?: unknown[];
        functions?: unknown[];
      };
    };

    expect(manifest).toMatchObject({
      id: "clash.storyboard",
      author: "Clash",
      contributes: {
        generators: [],
        functions: [],
      },
    });
    expect(manifest.contributes?.views).toHaveLength(1);
    expect(
      BUNDLED_PLUGINS.map(({ id }): string => id),
    ).not.toContain("clash.storyboard");
  });

  it("registers Asset Edit as one trusted local/cloud/client Generator module", () => {
    expect(
      BUNDLED_PLUGINS.find((plugin) => plugin.id === "clash.asset-edit"),
    ).toEqual({
      id: "clash.asset-edit",
      packageName: "@clash-plugin/asset-edit",
      workspaceDir: "asset-edit",
    });
  });

  it("registers the Remotion renderer as a trusted bundled Action", () => {
    expect(
      BUNDLED_PLUGINS.find((plugin) => plugin.id === "clash.remotion"),
    ).toEqual({
      id: "clash.remotion",
      packageName: "@clash-plugin/remotion",
      workspaceDir: "remotion",
    });
  });

  it("registers first-party media analysis in the closed bundled-module trust root", () => {
    expect(
      BUNDLED_PLUGINS.find((plugin) => plugin.id === "clash.media-analysis"),
    ).toEqual({
      id: "clash.media-analysis",
      packageName: "@clash-plugin/media-analysis",
      workspaceDir: "media-analysis",
    });
  });

  it("registers first-party ASR in the closed bundled-module trust root", () => {
    expect(BUNDLED_PLUGINS.find((plugin) => plugin.id === "clash.asr")).toEqual(
      {
        id: "clash.asr",
        packageName: "@clash-plugin/asr",
        workspaceDir: "asr",
      },
    );
  });

  it("registers first-party Meshy in the closed bundled-module trust root", () => {
    expect(
      BUNDLED_PLUGINS.find((plugin) => plugin.id === "clash.meshy"),
    ).toEqual({
      id: "clash.meshy",
      packageName: "@clash-plugin/meshy",
      workspaceDir: "meshy",
    });
  });

  it("registers first-party Tripo3D in the closed bundled-module trust root", () => {
    expect(
      BUNDLED_PLUGINS.find((plugin) => plugin.id === "clash.tripo"),
    ).toEqual({
      id: "clash.tripo",
      packageName: "@clash-plugin/tripo",
      workspaceDir: "tripo",
    });
  });

  it("registers first-party Move AI in the closed bundled-module trust root", () => {
    expect(
      BUNDLED_PLUGINS.find((plugin) => plugin.id === "clash.move-ai"),
    ).toEqual({
      id: "clash.move-ai",
      packageName: "@clash-plugin/move-ai",
      workspaceDir: "move-ai",
    });
  });

  it("names every first-party Provider, not just one", () => {
    // One plugin per Provider. A list with a single entry is what left clash.google and
    // clash.minimax unseeded after the split.
    const ids = BUNDLED_PLUGINS.map((plugin) => plugin.id);
    expect(ids).toContain("clash.fal");
    expect(ids).toContain("clash.google");
    expect(ids).toContain("clash.minimax");
    expect(ids).toContain("clash.pika");
    expect(ids).toContain("clash.volcengine");
    expect(ids).toContain("clash.meshy");
    expect(ids).toContain("clash.tripo");
    expect(ids).toContain("clash.move-ai");
  });

  it("seeds a plugin into the actions root", async () => {
    const source = pluginSource("clash.google");
    const actionsRoot = mkdtempSync(join(tmpdir(), "actions-"));
    const result = await ensureBundledPlugin({
      id: "clash.google",
      actionsRoot,
      manifestPath: join(source, "manifest.json"),
      entrypointPath: join(source, "dist", "stdio.mjs"),
    });
    expect(result.installed).toBe(true);
    expect(existsSync(join(actionsRoot, "clash.google", "manifest.json"))).toBe(
      true,
    );
  });

  it("refuses a manifest whose id is not the one being seeded", async () => {
    // Seeding a plugin under another's directory name gives two ids for one install, and the route
    // bound to either finds a manifest that disagrees with where it lives.
    const source = pluginSource("clash.minimax");
    const actionsRoot = mkdtempSync(join(tmpdir(), "actions-"));
    await expect(
      ensureBundledPlugin({
        id: "clash.google",
        actionsRoot,
        manifestPath: join(source, "manifest.json"),
        entrypointPath: join(source, "dist", "stdio.mjs"),
      }),
    ).rejects.toThrow(/clash\.google/);
  });

  it("leaves an existing install alone", async () => {
    // The installed directory is the user's editable copy. Overwriting it at startup would discard
    // an agent's edits every time the app restarted.
    const source = pluginSource("clash.google");
    const actionsRoot = mkdtempSync(join(tmpdir(), "actions-"));
    mkdirSync(join(actionsRoot, "clash.google"), { recursive: true });
    writeFileSync(
      join(actionsRoot, "clash.google", "manifest.json"),
      '{"id":"edited"}',
    );

    const result = await ensureBundledPlugin({
      id: "clash.google",
      actionsRoot,
      manifestPath: join(source, "manifest.json"),
      entrypointPath: join(source, "dist", "stdio.mjs"),
    });
    expect(result.installed).toBe(false);
    expect(
      readFileSync(join(actionsRoot, "clash.google", "manifest.json"), "utf8"),
    ).toContain("edited");
  });

  it("carries the provider declarations the real Provider ships", async () => {
    // Seeding the entrypoint without these produces a Provider nobody can configure: the
    // declaration is what the settings screen renders and what `--set` validates against.
    //
    // The real plugin rather than a fixture, because seeding runs the contract tests -- a stub
    // entrypoint answers nothing and fails as "closed its stdio channel", which says nothing about
    // provider documents either way.
    const workspace = join(__dirname, "../../../plugins/google");
    const actionsRoot = mkdtempSync(join(tmpdir(), "actions-"));
    await ensureBundledPlugin({
      id: "clash.google",
      actionsRoot,
      manifestPath: join(workspace, "manifest.json"),
      entrypointPath: join(workspace, "dist", "stdio.mjs"),
    });
    expect(
      existsSync(join(actionsRoot, "clash.google", "providers", "google.json")),
    ).toBe(true);
    const declared = JSON.parse(
      readFileSync(
        join(actionsRoot, "clash.google", "providers", "google.json"),
        "utf8",
      ),
    ) as {
      spec: { auth?: { methods: { id: string; form?: { key?: string }[] }[] } };
    };

    // `methods`, not a flat `form`: Google has three coherent configurations and they do not share
    // a field list -- AI Studio has no region, and a service account must not be offered a service.
    const methods = declared.spec.auth?.methods ?? [];
    expect(methods.map((method) => method.id)).toEqual([
      "ai-studio",
      "agent-platform-key",
      "service-account",
    ]);
    expect(
      methods.flatMap((method) => (method.form ?? []).map((item) => item.key)),
    ).toContain("apiKey");
  });

  it("exposes the Meshy provider and model bindings in the immutable bundled payload", async () => {
    // `bundledPluginPayloadFiles` is the exact enumeration the Host trusts to seed an actions
    // install (`ensureBundledPlugin`) or pack a release; a provider/binding document missing from
    // it is a document Settings and `--set` can never see, no matter what the manifest claims.
    const workspace = join(__dirname, "../../../plugins/meshy");
    const manifest = JSON.parse(
      readFileSync(join(workspace, "manifest.json"), "utf8"),
    );
    const files = await bundledPluginPayloadFiles(manifest, workspace);
    expect(files).toContain("providers/meshy.json");
    expect(files).toContain("bindings/meshy-6.json");
    expect(files).toContain("bindings/meshy-7.json");
    // The auto-rig binding is the one Meshy model that targets an upstream Asset it did not
    // generate rather than a fresh prompt; losing this document silently strands that model.
    expect(files).toContain("bindings/meshy-auto-rig.json");

    const declaredProvider = JSON.parse(
      readFileSync(join(workspace, "providers", "meshy.json"), "utf8"),
    ) as {
      spec: {
        executorExportId?: string;
        auth?: { methods: { id: string; form?: { key?: string }[] }[] };
      };
    };
    expect(declaredProvider.spec.executorExportId).toBe("meshy-execute");
    const meshyMethods = declaredProvider.spec.auth?.methods ?? [];
    expect(meshyMethods.map((method) => method.id)).toEqual(["api-key"]);
    expect(
      meshyMethods.flatMap((method) =>
        (method.form ?? []).map((item) => item.key),
      ),
    ).toContain("apiKey");

    const rigBinding = JSON.parse(
      readFileSync(
        join(workspace, "bindings", "meshy-auto-rig.json"),
        "utf8",
      ),
    ) as { spec: { modelId?: string; upstreamModel?: string } };
    expect(rigBinding.spec.modelId).toBe("meshy-auto-rig");
    expect(rigBinding.spec.upstreamModel).toBe("rig");
  });

  it("exposes the Tripo3D provider and model bindings in the immutable bundled payload", async () => {
    const workspace = join(__dirname, "../../../plugins/tripo");
    const manifest = JSON.parse(
      readFileSync(join(workspace, "manifest.json"), "utf8"),
    );
    const files = await bundledPluginPayloadFiles(manifest, workspace);
    expect(files).toContain("providers/tripo.json");
    expect(files).toContain("bindings/tripo-h3.1.json");
    expect(files).toContain("bindings/tripo-auto-rig.json");

    const declaredProvider = JSON.parse(
      readFileSync(join(workspace, "providers", "tripo.json"), "utf8"),
    ) as {
      spec: {
        executorExportId?: string;
        auth?: { methods: { id: string; form?: { key?: string }[] }[] };
      };
    };
    expect(declaredProvider.spec.executorExportId).toBe("tripo-execute");
    const tripoMethods = declaredProvider.spec.auth?.methods ?? [];
    expect(tripoMethods.map((method) => method.id)).toEqual(["api-key"]);
    expect(
      tripoMethods.flatMap((method) =>
        (method.form ?? []).map((item) => item.key),
      ),
    ).toContain("apiKey");

    const h31Binding = JSON.parse(
      readFileSync(join(workspace, "bindings", "tripo-h3.1.json"), "utf8"),
    ) as { spec: { modelId?: string; upstreamModel?: string } };
    expect(h31Binding.spec.modelId).toBe("tripo-h3.1");
    expect(h31Binding.spec.upstreamModel).toBe("v3.1-20260211");
  });

  it("exposes the Move AI provider and model binding in the immutable bundled payload", async () => {
    const workspace = join(__dirname, "../../../plugins/move-ai");
    const manifest = JSON.parse(
      readFileSync(join(workspace, "manifest.json"), "utf8"),
    );
    const files = await bundledPluginPayloadFiles(manifest, workspace);
    expect(files).toContain("providers/move-ai.json");
    expect(files).toContain("bindings/move-ai-s2.json");

    const declaredProvider = JSON.parse(
      readFileSync(join(workspace, "providers", "move-ai.json"), "utf8"),
    ) as {
      spec: {
        executorExportId?: string;
        auth?: { methods: { id: string; form?: { key?: string }[] }[] };
      };
    };
    expect(declaredProvider.spec.executorExportId).toBe("move-ai-execute");
    const moveAiMethods = declaredProvider.spec.auth?.methods ?? [];
    expect(moveAiMethods.map((method) => method.id)).toEqual(["api-key"]);
    expect(
      moveAiMethods.flatMap((method) =>
        (method.form ?? []).map((item) => item.key),
      ),
    ).toContain("apiKey");

    // Move AI's assetInputs are bytes-only -- it has no provider-fetchable-URL upload mode -- so
    // this is the one binding in this suite that must not carry "provider-url" here.
    const binding = JSON.parse(
      readFileSync(join(workspace, "bindings", "move-ai-s2.json"), "utf8"),
    ) as {
      spec: {
        modelId?: string;
        upstreamModel?: string;
        assetInputs?: { representations?: string[] }[];
      };
    };
    expect(binding.spec.modelId).toBe("move-ai-s2");
    expect(binding.spec.upstreamModel).toBe("S2");
    expect(binding.spec.assetInputs).toEqual([
      {
        match: { kinds: ["video"] },
        representations: ["bytes"],
        mediaTypes: ["video/mp4", "video/quicktime", "video/x-msvideo"],
      },
    ]);
  });

  // Turbo orders `build` by declared workspace dependencies, and the host runtime build copies each
  // payload's dist. An undeclared payload is never built first, so a clean build fails on ENOENT.
  it("declares every copied plugin payload as a workspace dependency of its packager", () => {
    const pluginsRoot = join(__dirname, "../../../plugins");
    const readPackage = (dir: string) =>
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
    const localApi = readPackage(join(__dirname, ".."));
    const hostRuntime = readPackage(join(pluginsRoot, "clash"));

    for (const plugin of BUNDLED_PLUGINS) {
      expect(localApi.dependencies?.[plugin.packageName], plugin.packageName).toBe(
        "workspace:*",
      );
    }
    for (const plugin of OFFICIAL_MARKETPLACE_PLUGIN_PACKAGES) {
      const { name } = readPackage(join(pluginsRoot, plugin.workspaceDir));
      expect(hostRuntime.devDependencies?.[name], name).toBe("workspace:*");
    }
  });
});
