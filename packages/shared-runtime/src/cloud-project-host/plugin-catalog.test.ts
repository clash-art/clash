import { describe, expect, it } from "vitest";
import {
  generatorDefinitionFromExecutablePluginRegistration,
  validateExecutablePluginPackage,
} from "@clash/shared-types";
import remotionManifest from "../../../../plugins/remotion/manifest.json";
import timeline from "../../../../plugins/remotion/generators/timeline.json";
import directorManifest from "../../../../plugins/director/manifest.json";
import directorStage from "../../../../plugins/director/generators/director-stage.json";
import humanoidRetarget from "../../../../plugins/director/generators/humanoid-retarget.json";
import { executablePluginSchemaHash } from "../executable-plugin-schema-hash.js";
import { createCloudPluginCatalog } from "./plugin-catalog.js";

const remotion = {
  manifest: remotionManifest,
  generators: { "generators/timeline.json": timeline },
};
const director = {
  manifest: directorManifest,
  generators: {
    "generators/director-stage.json": directorStage,
    "generators/humanoid-retarget.json": humanoidRetarget,
  },
};

describe("createCloudPluginCatalog", () => {
  it("registers bundled Generators with the package provenance local-api derives", async () => {
    const catalog = createCloudPluginCatalog([remotion, director], {
      executableGeneratorIds: ["clash.timeline"],
    });
    const pkg = validateExecutablePluginPackage(remotionManifest, {}, {}, {
      generators: remotion.generators,
    });
    const registration = {
      pluginId: pkg.manifest.id,
      version: pkg.manifest.version,
      schemaHash: executablePluginSchemaHash(
        pkg.manifest,
        pkg.cards,
        pkg.providers,
        pkg.modelBindings,
        pkg.generators,
        pkg.views,
      ),
      document: pkg.generators["generators/timeline.json"]!,
    };
    expect(await catalog.listPluginGenerators()).toEqual([registration]);
    expect(catalog.generatorDefinitions()).toEqual([
      generatorDefinitionFromExecutablePluginRegistration(registration),
    ]);
    expect(
      catalog.resolveGeneratorDefinition(pkg.manifest.id, "timeline"),
    ).toEqual(catalog.generatorDefinitions()[0]);
    expect(
      catalog.resolveGeneratorDefinition("clash.director", "director-stage"),
    ).toBeUndefined();
  });

  it("lists only Generators whose projection surface the adapter executes", async () => {
    expect(
      await createCloudPluginCatalog([remotion, director], {
        executableGeneratorIds: [],
      }).listPluginGenerators(),
    ).toEqual([]);
    const stages = createCloudPluginCatalog([remotion, director], {
      executableGeneratorIds: ["clash.director-stage"],
    });
    expect(
      stages.generatorDefinitions().map((definition) => [
        definition.pluginId,
        definition.definitionId,
      ]),
    ).toEqual([["clash.director", "director-stage"]]);
  });

  it("never advertises local-runtime Actions and has no Views without View documents", () => {
    const catalog = createCloudPluginCatalog([remotion, director], {
      executableGeneratorIds: ["clash.timeline"],
    });
    expect(catalog.actions()).toEqual([]);
    expect(catalog.views()).toEqual([]);
  });

  it("rejects a package whose declared Generator document is missing", () => {
    expect(() =>
      createCloudPluginCatalog([{ manifest: remotionManifest, generators: {} }], {
        executableGeneratorIds: ["clash.timeline"],
      }),
    ).toThrow();
  });
});
