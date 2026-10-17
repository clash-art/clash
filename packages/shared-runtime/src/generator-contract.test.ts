import { LoroDoc } from "loro-crdt";
import { describe, expect, it, vi } from "vitest";
import {
  generatorDefinitionFromExecutablePluginRegistration,
  type ExecutablePluginGeneratorRegistration,
} from "@clash/shared-types";
import timeline from "../../../plugins/remotion/generators/timeline.json";
import {
  generatorSchemaKey,
  registerPrecompiledGeneratorValidators,
  type PrecompiledGeneratorValidator,
} from "./generator-contract.js";
import { createLocalTimelineGenerator } from "./timeline-generator-product.js";

const ajvConstructions = vi.hoisted(() => ({ count: 0 }));
vi.mock("ajv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ajv")>();
  class CountingAjv extends actual.default {
    constructor(...args: ConstructorParameters<typeof actual.default>) {
      ajvConstructions.count += 1;
      super(...args);
    }
  }
  return { ...actual, default: CountingAjv };
});

const definitionWith = (stateSchema: unknown) =>
  generatorDefinitionFromExecutablePluginRegistration({
    pluginId: "clash.remotion",
    version: "1.0.0",
    schemaHash: `sha256:${"a".repeat(64)}`,
    document: {
      ...timeline,
      spec: { ...timeline.spec, stateSchema },
    } as ExecutablePluginGeneratorRegistration["document"],
  });

const create = (stateSchema: unknown, name = "Cut") => {
  const doc = new LoroDoc();
  try {
    return createLocalTimelineGenerator(doc, definitionWith(stateSchema), {
      id: "tl",
      name,
      owner: { kind: "project" },
      revisionId: "genesis",
      state: { tracks: [] },
    });
  } finally {
    doc.free();
  }
};

// One module instance: the registry and the lazy Ajv are process-global, so
// these cases run in order.
describe("Generator schema validation", () => {
  it("does not construct Ajv at module load", () => {
    expect(ajvConstructions.count).toBe(0);
  });

  it("uses a registered precompiled validator instead of compiling", () => {
    const seen: unknown[] = [];
    const accept = Object.assign(
      (data: unknown) => {
        seen.push(data);
        return true;
      },
      { errors: null },
    ) satisfies PrecompiledGeneratorValidator;
    registerPrecompiledGeneratorValidators([
      [generatorSchemaKey(timeline.spec.stateSchema), accept],
    ]);
    expect(create(timeline.spec.stateSchema).ok).toBe(true);
    expect(seen).not.toEqual([]);
    expect(ajvConstructions.count).toBe(0);
  });

  it("looks schemas up by canonical JSON, independent of key order", () => {
    const reject: PrecompiledGeneratorValidator = Object.assign(
      () => false,
      {
        errors: [
          {
            instancePath: "/timeline",
            schemaPath: "#/required",
            keyword: "required",
            params: {},
            message: "rejected by the registry",
          },
        ],
      },
    );
    const reordered = Object.fromEntries(
      Object.entries(timeline.spec.stateSchema).reverse(),
    );
    registerPrecompiledGeneratorValidators([
      [generatorSchemaKey(reordered), reject],
    ]);
    expect(create(timeline.spec.stateSchema)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("rejected by the registry") },
    });
    expect(ajvConstructions.count).toBe(0);
  });

  it("falls back to one lazily constructed Ajv for unregistered schemas", () => {
    const unregistered = { ...timeline.spec.stateSchema, title: "Timeline" };
    expect(create(unregistered).ok).toBe(true);
    expect(create(unregistered, "")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("GENERATOR_CONTRACT_VIOLATION") },
    });
    expect(ajvConstructions.count).toBe(1);
  });
});
