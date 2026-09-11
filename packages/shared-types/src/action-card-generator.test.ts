import { describe, expect, it } from "vitest";
import {
  ExecutablePluginCardRegistrationSchema,
  validateExecutablePluginPackage,
} from "./executable-plugin.js";
import {
  generatorDefinitionFromCustomActionDefinition,
  generatorDefinitionFromExecutableActionCard,
} from "./generator-v1-compat.js";

const generator = {
  apiVersion: "clash.generator/v1",
  kind: "generator",
  spec: {
    definitionId: "writer",
    stateSchema: { type: "object" },
    editPolicy: "fork-when-materialized",
    persistentInputs: [],
    actions: ["draft", "revise"].map((id) => ({
      id,
      executorExportId: "write",
      parametersSchema: { type: "object" },
      invocationInputs: [],
      outputs: [
        {
          slot: "result",
          assetType: {
            kind: "document",
            documentKind: "text.plain",
            schemaVersion: 1,
          },
          cardinality: { minItems: 1, maxItems: 1 },
        },
      ],
    })),
  },
};
const manifest = {
  apiVersion: "clash.plugin/v1",
  id: "test.writer",
  version: "1.0.0",
  name: "Writer",
  runtime: { kind: "local", transport: "stdio", entrypoint: "dist/stdio.mjs" },
  contributes: {
    cards: [{ id: "revise-card", kind: "action-card", path: "card.json" }],
    generators: [{ id: "writer", kind: "generator", path: "generator.json" }],
    functions: [
      { id: "write", kind: "action" },
      { id: "other", kind: "action" },
    ],
  },
};
const card = {
  apiVersion: "clash.card/v1",
  kind: "action-card",
  spec: {
    id: "revise-card",
    name: "Revise",
    functionExportId: "write",
    outputType: "text",
    generator: { definitionId: "writer", actionId: "revise", inputSlots: {} },
  },
};
function validate(document: unknown = card, definition: unknown = generator) {
  return validateExecutablePluginPackage(
    manifest,
    { "card.json": document },
    {},
    {
      generators: { "generator.json": definition },
    },
  );
}

describe("Action Card native Generator projection", () => {
  it("keeps the explicitly selected Action when one executor implements several Actions", () => {
    const result = validate();
    expect(result.cards["card.json"].spec).toMatchObject({
      generator: card.spec.generator,
    });
  });

  it.each([
    { definitionId: "missing", actionId: "revise", inputSlots: {} },
    { definitionId: "writer", actionId: "missing", inputSlots: {} },
    {
      definitionId: "writer",
      actionId: "revise",
      inputSlots: { image: "missing" },
    },
  ])(
    "rejects a card that does not resolve to its declared native contract",
    (link) => {
      expect(() =>
        validate({ ...card, spec: { ...card.spec, generator: link } }),
      ).toThrow();
    },
  );

  it("rejects a mapped Action backed by a different executor or output kind", () => {
    expect(() =>
      validate({ ...card, spec: { ...card.spec, functionExportId: "other" } }),
    ).toThrow();
    expect(() =>
      validate({ ...card, spec: { ...card.spec, outputType: "image" } }),
    ).toThrow();
  });

  it("maps text to a declared plain-text Document port and rejects a different kind", () => {
    const linked = { ...card, spec: { ...card.spec, generator: { ...card.spec.generator, inputSlots: { text: "sources" } } } };
    const textPort = { slot: "sources", accepts: [{ kind: "document", documentKind: "text.plain", schemaVersion: 1 }], cardinality: { minItems: 0, maxItems: null } };
    const definition = { ...generator, spec: { ...generator.spec, persistentInputs: [textPort] } };
    expect(validate(linked, definition).cards["card.json"].spec).toMatchObject({ generator: linked.spec.generator });
    expect(() => validate(linked, { ...definition, spec: { ...definition.spec, persistentInputs: [{ ...textPort, accepts: [{ kind: "document", documentKind: "media.transcript", schemaVersion: 1 }] }] } })).toThrow(/mapping/);
  });

  it("does not synthesize a second Definition for an explicitly native card", () => {
    const registration = ExecutablePluginCardRegistrationSchema.parse({
      pluginId: manifest.id,
      version: manifest.version,
      schemaHash: `sha256:${"a".repeat(64)}`,
      runtime: manifest.runtime,
      document: card,
    });
    expect(() =>
      generatorDefinitionFromExecutableActionCard(registration),
    ).toThrow(/native Generator/);
    expect(() =>
      generatorDefinitionFromCustomActionDefinition({
        ...card.spec,
        pluginBinding: {
          pluginId: registration.pluginId,
          version: registration.version,
          schemaHash: registration.schemaHash,
          exportId: card.spec.functionExportId,
        },
      }),
    ).toThrow(/native Generator/);
  });
});
