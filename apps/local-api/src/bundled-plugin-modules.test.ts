import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

import { ExecutablePluginManifestSchema } from "@clash/shared-types";
import { describe, expect, it } from "vitest";

import { BUNDLED_PLUGINS, bundledPluginPaths } from "./bundled-plugins.js";
import {
  loadTrustedBundledPluginModule,
  TRUSTED_BUNDLED_PLUGIN_MODULES,
} from "./bundled-plugin-modules.js";

describe("trusted bundled Plugin modules", () => {
  it("keeps in-process trust in one closed Host registry", () => {
    expect(TRUSTED_BUNDLED_PLUGIN_MODULES.map(({ id }) => id)).toEqual(
      BUNDLED_PLUGINS.map(({ id }) => id),
    );
    expect(
      TRUSTED_BUNDLED_PLUGIN_MODULES.every(
        (registration) => !Reflect.has(registration, "runtime"),
      ),
    ).toBe(true);
  });

  it("loads every first-party package as an inert module with its declared exports", async () => {
    for (const registration of TRUSTED_BUNDLED_PLUGIN_MODULES) {
      const loaded = await loadTrustedBundledPluginModule(registration.id);
      const manifest = ExecutablePluginManifestSchema.parse(
        JSON.parse(await readFile(loaded.manifestPath, "utf8")),
      );

      expect(loaded.id).toBe(manifest.id);
      expect(loaded.plugin.invoke).toBeTypeOf("function");
      expect(
        loaded.plugin.contributes.map(({ id, kind }) => ({ id, kind })),
      ).toEqual(
        manifest.contributes.functions.map(({ id, kind }) => ({ id, kind })),
      );
    }
  });

  it("loads every bundled plugin in native Node ESM without Vitest require interop", async () => {
    for (const registration of TRUSTED_BUNDLED_PLUGIN_MODULES) {
      const { entrypointPath } = bundledPluginPaths(registration.id);
      await expect(
        promisify(execFile)(process.execPath, [
          "--input-type=module",
          "-e",
          `const {plugin} = await import(${JSON.stringify(pathToFileURL(entrypointPath).href)}); if (typeof plugin.invoke !== "function") throw new Error("Missing plugin");`,
        ]),
      ).resolves.toMatchObject({ stderr: "" });
    }
  });

  it("loads clash.asr in the module realm without exposing a stdio start surface", async () => {
    const loaded = await loadTrustedBundledPluginModule("clash.asr");
    const manifest = ExecutablePluginManifestSchema.parse(
      JSON.parse(await readFile(loaded.manifestPath, "utf8")),
    );

    expect(manifest.contributes.generators).toEqual([
      {
        id: "speech-analysis",
        kind: "generator",
        path: "generators/speech-analysis.json",
      },
    ]);
    expect(loaded.plugin.invoke).toBeTypeOf("function");
    expect(loaded.plugin).not.toHaveProperty("start");
  });

  it("loads Asset Edit with both native Generator definitions on the same module", async () => {
    const loaded = await loadTrustedBundledPluginModule("clash.asset-edit");
    const manifest = ExecutablePluginManifestSchema.parse(
      JSON.parse(await readFile(loaded.manifestPath, "utf8")),
    );

    expect(manifest.contributes.generators.map(({ id }) => id)).toEqual([
      "image-editor",
      "video-clipper",
    ]);
    expect(loaded.plugin.contributes.map(({ id }) => id)).toEqual([
      "image-editor",
      "video-clipper",
    ]);
  });

  it("loads clash.meshy with its declared provider and model bindings discoverable", async () => {
    const loaded = await loadTrustedBundledPluginModule("clash.meshy");
    const manifest = ExecutablePluginManifestSchema.parse(
      JSON.parse(await readFile(loaded.manifestPath, "utf8")),
    );

    expect(manifest.contributes.providers).toEqual([
      { id: "meshy", kind: "provider", path: "providers/meshy.json" },
    ]);
    expect(manifest.contributes.modelBindings.map(({ id }) => id)).toEqual([
      "meshy-6",
      "meshy-7",
      "meshy-auto-rig",
    ]);
    expect(
      manifest.contributes.functions.map(({ id, kind }) => ({ id, kind })),
    ).toEqual([{ id: "meshy-execute", kind: "provider-executor" }]);
    expect(loaded.plugin.invoke).toBeTypeOf("function");
    expect(
      loaded.plugin.contributes.map(({ id, kind }) => ({ id, kind })),
    ).toEqual([{ id: "meshy-execute", kind: "provider-executor" }]);
  });

  it("loads clash.tripo with its declared provider and model bindings discoverable", async () => {
    const loaded = await loadTrustedBundledPluginModule("clash.tripo");
    const manifest = ExecutablePluginManifestSchema.parse(
      JSON.parse(await readFile(loaded.manifestPath, "utf8")),
    );

    expect(manifest.contributes.providers).toEqual([
      { id: "tripo", kind: "provider", path: "providers/tripo.json" },
    ]);
    expect(manifest.contributes.modelBindings.map(({ id }) => id)).toEqual([
      "tripo-h3.1",
      "tripo-auto-rig",
    ]);
    expect(
      manifest.contributes.functions.map(({ id, kind }) => ({ id, kind })),
    ).toEqual([{ id: "tripo-execute", kind: "provider-executor" }]);
    expect(loaded.plugin.invoke).toBeTypeOf("function");
    expect(
      loaded.plugin.contributes.map(({ id, kind }) => ({ id, kind })),
    ).toEqual([{ id: "tripo-execute", kind: "provider-executor" }]);
  });

  it("does not let a caller promote an unregistered package into the trusted realm", async () => {
    await expect(
      loadTrustedBundledPluginModule("third.party.plugin"),
    ).rejects.toThrow(/not a trusted bundled plugin/i);
  });
});
