import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generatorSchemaKey } from "@clash/shared-runtime/generator-contract";
import {
  compileGeneratorSchema,
  generatorDefinitionSchemas,
} from "@clash/shared-runtime/generator-validator-codegen";
import {
  CLOUD_PLUGIN_VALIDATORS_PATH,
  renderCloudPluginValidators,
} from "../../scripts/generate-cloud-plugin-validators";
import { buildCloudPluginCatalog } from "../services/cloud-plugin-packages";
import { cloudPluginValidators } from "./cloud-plugin-validators";

const schemas = generatorDefinitionSchemas(
  buildCloudPluginCatalog().generatorDefinitions(),
);

describe("generated cloud plugin validators", () => {
  it("match the current cloud plugin catalog", () => {
    // Run `pnpm --dir apps/api-cf generate:cloud-plugin-validators` when this fails.
    expect(readFileSync(CLOUD_PLUGIN_VALIDATORS_PATH, "utf8")).toBe(
      renderCloudPluginValidators(),
    );
  });

  it("cover every schema the catalog exposes", () => {
    const keys = new Set(cloudPluginValidators.map(([key]) => key));
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas)
      expect(keys.has(generatorSchemaKey(schema))).toBe(true);
  });

  it("agree with runtime Ajv compilation on valid and invalid values", () => {
    const samples: unknown[] = [
      { timeline: { name: "Cut", owner: { kind: "project" }, state: {} } },
      {
        timeline: {
          name: "😀",
          owner: { kind: "canvas-action", canvasId: "c", actionNodeId: "a" },
          state: { tracks: [] },
        },
      },
      { timeline: { name: "", owner: { kind: "project" }, state: {} } },
      { timeline: { name: "Cut", owner: { kind: "canvas-action" }, state: [] } },
      { timeline: { name: "Cut", owner: { kind: "other" }, state: {} } },
      { timeline: {}, extra: true },
      {},
      { unexpected: 1 },
      [],
      null,
      "text",
    ];
    const validators = new Map(cloudPluginValidators);
    for (const schema of schemas) {
      const precompiled = validators.get(generatorSchemaKey(schema))!;
      const compiled = compileGeneratorSchema(schema);
      for (const sample of samples) {
        expect(precompiled(sample)).toBe(compiled(sample));
        expect(precompiled.errors ?? null).toEqual(compiled.errors ?? null);
      }
    }
  });
});
