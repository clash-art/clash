import { describe, expect, it } from "vitest";

import {
  ExecutablePluginGeneratorRegistrationSchema,
  generatorDefinitionFromExecutablePluginRegistration,
  validateExecutablePluginPackage,
} from "./executable-plugin.js";

const SHA = `sha256:${"a".repeat(64)}`;

const stageDocument = {
  apiVersion: "clash.generator/v1",
  kind: "generator",
  spec: {
    definitionId: "director-stage",
    stateSchema: {
      type: "object",
      properties: { scene: { type: "object" } },
      required: ["scene"],
    },
    editPolicy: "advance-head",
    persistentInputs: [],
    actions: [
      {
        id: "capture-still",
        executorExportId: "capture-still",
        parametersSchema: { type: "object" },
        invocationInputs: [],
        outputs: [
          {
            slot: "image",
            assetType: { kind: "media", mediaKind: "image" },
            cardinality: { minItems: 1, maxItems: 1 },
          },
        ],
      },
      {
        id: "render-video",
        executorExportId: "render-video",
        parametersSchema: { type: "object" },
        invocationInputs: [],
        outputs: [
          {
            slot: "video",
            assetType: { kind: "media", mediaKind: "video" },
            cardinality: { minItems: 1, maxItems: 1 },
          },
        ],
      },
    ],
  },
} as const;

function manifest() {
  return {
    apiVersion: "clash.plugin/v1",
    id: "clash.director",
    version: "1.2.3",
    name: "Director",
    runtime: {
      kind: "local",
      transport: "stdio",
      language: "node",
      entrypoint: "dist/stdio.mjs",
    },
    contributes: {
      cards: [],
      providers: [],
      modelBindings: [],
      generators: [
        {
          id: "director-stage",
          kind: "generator",
          path: "generators/director-stage.json",
        },
      ],
      functions: [
        { id: "capture-still", kind: "action", operations: ["submit"] },
        { id: "render-video", kind: "action", operations: ["submit"] },
      ],
      hostTools: [],
    },
    contractTests: [],
  } as const;
}

describe("native Generator plugin contributions", () => {
  it("admits a declarative model Action without inventing a plugin function", () => {
    const base = manifest();
    const { executorExportId: _export, ...baseAction } = stageDocument.spec.actions[0];
    const document = { ...stageDocument, spec: { ...stageDocument.spec,
      actions: [{ ...baseAction, modelExecution: true }],
    } };
    const validated = validateExecutablePluginPackage({ ...base,
      contributes: { ...base.contributes, functions: [] },
    }, {}, {}, { generators: { "generators/director-stage.json": document } });
    expect(validated.generators["generators/director-stage.json"]).toEqual(document);
  });

  it("loads one versioned definition with several Actions and injects package provenance", () => {
    const validated = validateExecutablePluginPackage(
      manifest(),
      {},
      {},
      {
        generators: {
          "generators/director-stage.json": stageDocument,
        },
      },
    );

    expect(validated.generators).toEqual({
      "generators/director-stage.json": stageDocument,
    });

    const registration = ExecutablePluginGeneratorRegistrationSchema.parse({
      pluginId: "clash.director",
      version: "1.2.3",
      schemaHash: SHA,
      document: stageDocument,
    });
    const definition =
      generatorDefinitionFromExecutablePluginRegistration(registration);

    expect(definition).toMatchObject({
      pluginId: "clash.director",
      definitionId: "director-stage",
      version: "1.2.3",
      schemaHash: SHA,
      editPolicy: "advance-head",
      actions: [
        { id: "capture-still", executorExportId: "capture-still" },
        { id: "render-video", executorExportId: "render-video" },
      ],
    });
    expect(definition).not.toHaveProperty("runtime");
    expect(definition).not.toHaveProperty("realm");
  });

  it("rejects a Generator Action without its exact action executor export", () => {
    const base = manifest();
    const invalid = {
      ...base,
      contributes: {
        ...base.contributes,
        functions: [
          base.contributes.functions[0],
          {
            id: "render-video",
            kind: "provider-executor",
            operations: ["submit"],
          },
        ],
      },
    };

    expect(() =>
      validateExecutablePluginPackage(
        invalid,
        {},
        {},
        {
          generators: {
            "generators/director-stage.json": stageDocument,
          },
        },
      ),
    ).toThrow(/render-video.*action export/i);
  });

  it("rejects a document whose stable definition id differs from its export", () => {
    expect(() =>
      validateExecutablePluginPackage(
        manifest(),
        {},
        {},
        {
          generators: {
            "generators/director-stage.json": {
              ...stageDocument,
              spec: { ...stageDocument.spec, definitionId: "other-stage" },
            },
          },
        },
      ),
    ).toThrow(/other-stage.*director-stage/i);
  });

  it("does not let a declarative Generator select a trusted execution realm", () => {
    expect(() =>
      validateExecutablePluginPackage(
        manifest(),
        {},
        {},
        {
          generators: {
            "generators/director-stage.json": {
              ...stageDocument,
              spec: { ...stageDocument.spec, realm: "bundled-module" },
            },
          },
        },
      ),
    ).toThrow();
  });
});
