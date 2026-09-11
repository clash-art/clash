import { LoroDoc } from "loro-crdt";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createProjectAsset,
  createProjectDocumentAsset,
  createProjectGenerator,
  type GeneratorDefinition,
} from "@clash/shared-types";

import { buildLocalGeneratorActionRun } from "./local-generator-contract.js";

const definitionRef = {
  pluginId: "clash.stage",
  definitionId: "director-stage",
  version: "1.0.0",
  schemaHash: `sha256:${"a".repeat(64)}`,
} as const;

const definition: GeneratorDefinition = {
  ...definitionRef,
  stateSchema: {
    type: "object",
    properties: { scene: { type: "string", minLength: 1 } },
    required: ["scene"],
    additionalProperties: false,
  },
  editPolicy: "advance-head",
  persistentInputs: [
    {
      slot: "background",
      accepts: [{ kind: "media", mediaKind: "image" }],
      cardinality: { minItems: 1, maxItems: 1 },
    },
  ],
  actions: [
    {
      id: "render-still",
      executorExportId: "render-still",
      parametersSchema: {
        type: "object",
        properties: { exposure: { type: "number" } },
        required: ["exposure"],
        additionalProperties: false,
      },
      invocationInputs: [
        {
          slot: "script",
          accepts: [
            {
              kind: "document",
              documentKind: "media.transcript",
              schemaVersion: 1,
            },
          ],
          cardinality: { minItems: 0, maxItems: 1 },
        },
      ],
      outputs: [
        {
          slot: "image",
          assetType: { kind: "media", mediaKind: "image" },
          cardinality: { minItems: 1, maxItems: 1 },
        },
      ],
    },
  ],
};

function projectDoc(): LoroDoc {
  const doc = new LoroDoc();
  const media = createProjectAsset(doc, {
    id: "background",
    kind: "image",
    source: { kind: "owned", resourceId: "resource-background" },
    lifecycle: { state: "active" },
    metadata: { width: 1920, height: 1080, contentType: "image/png" },
  });
  if (!media.ok) throw new Error(media.error.message);
  const document = createProjectDocumentAsset(doc, {
    id: "transcript:r1",
    documentAssetId: "transcript",
    documentKind: "media.transcript",
    schemaVersion: 1,
    mutability: "versioned",
    body: {
      digest: `sha256:${"b".repeat(64)}`,
      byteLength: 100,
      contentType: "application/json",
    },
    producer: { kind: "actor", actor: { kind: "agent" } },
    sourceRefs: [],
  });
  if (!document.ok) throw new Error(document.error.message);
  const generator = createProjectGenerator(doc, {
    head: { id: "stage", headRevisionId: "stage:r1" },
    revision: {
      id: "stage:r1",
      generatorId: "stage",
      definitionRef,
      state: { scene: "courtyard" },
      persistentInputRefs: [
        {
          slot: "background",
          target: { kind: "media", projectAssetId: "background" },
        },
      ],
    },
  });
  if (!generator.ok) throw new Error(generator.error.message);
  return doc;
}

function build(
  doc = projectDoc(),
  overrides: Partial<Parameters<typeof buildLocalGeneratorActionRun>[0]> = {},
) {
  return buildLocalGeneratorActionRun({
    doc,
    definition,
    actionRunId: "run-1",
    generatorRevision: {
      generatorId: "stage",
      generatorRevisionId: "stage:r1",
    },
    actionId: "render-still",
    parameters: { exposure: 1 },
    invocationInputRefs: [
      {
        slot: "script",
        target: {
          kind: "document",
          documentAssetId: "transcript",
          revisionId: "transcript:r1",
        },
      },
    ],
    ...overrides,
  });
}

describe("Local Generator contract boundary", () => {
  it("pins a model Action to the selected Provider while keeping its Generator definition identity", () => {
    const { executorExportId: _export, ...action } = definition.actions[0]!;
    const modelDefinition = { ...definition, actions: [{ ...action, modelExecution: true as const }] };
    const selected = {
      semanticShape: "image_generation",
      modelId: "selected-model",
      route: {
        upstreamId: "selected-provider",
        upstreamModel: "upstream-model",
        apiShape: "provider-native",
        executorBinding: { pluginId: "provider.image", exportId: "execute", version: "1.0.0",
          schemaHash: `sha256:${"c".repeat(64)}` },
      },
    };
    const built = build(projectDoc(), { definition: modelDefinition, modelSelection: selected });
    expect(built.request.executor).toEqual(selected.route.executorBinding);
    expect(built.revision.definitionRef).toEqual(definitionRef);
    const moved = build(projectDoc(), { definition: modelDefinition, modelSelection: {
      ...selected, route: { ...selected.route, executorBinding: { ...selected.route.executorBinding, version: "2.0.0" } },
    } });
    expect(moved.request.invocationFingerprint).not.toBe(built.request.invocationFingerprint);
    expect(() => build(projectDoc(), { definition: modelDefinition })).toThrow(/selected.*Provider/i);
  });

  it("selects the answer output for a prompt-only media analysis and rejects ambiguous inputs", () => {
    const media = JSON.parse(readFileSync(
      new URL("../../../plugins/media-analysis/generators/media-analysis.json", import.meta.url), "utf8",
    ));
    const overrides = {
      definition: { ...definition, actions: media.spec.actions },
      actionId: "analyze",
      invocationInputRefs: [{ slot: "source", target: { kind: "media" as const, projectAssetId: "background" } }],
    };
    const prompt = "Which object is closest to the camera?";
    const built = build(projectDoc(), { ...overrides, parameters: { prompt } });
    expect(built.request.parameters).toEqual({ prompt });
    expect(built.request.outputContract).toMatchObject([{ slot: "description" }]);
    const invalidParameters: Array<Record<string, string | string[]>> = [
      {}, { prompt: " " }, { prompt, categories: ["tags"] },
    ];
    for (const parameters of invalidParameters) {
      expect(() => build(projectDoc(), { ...overrides, parameters })).toThrow();
    }
  });

  it("derives the immutable Run contract and realm-free executor from the trusted definition", () => {
    const built = build();

    expect(built.action.id).toBe("render-still");
    expect(built.request).toMatchObject({
      actionRunId: "run-1",
      actionId: "render-still",
      executor: {
        pluginId: "clash.stage",
        version: "1.0.0",
        exportId: "render-still",
        schemaHash: definitionRef.schemaHash,
      },
      outputContract: definition.actions[0]!.outputs,
    });
    expect(built.request.invocationFingerprint).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(built.request.executor).not.toHaveProperty("realm");
  });

  it("freezes a generic Host-selected model and exact Provider route in the public Run request and fingerprint", () => {
    const routeA = {
      providerId: "dummy-provider",
      upstreamId: "dummy-upstream",
      upstreamModel: "dummy/upstream-a",
      apiShape: "dummy-shape",
    };
    const selected = build(undefined, {
      modelSelection: {
        semanticShape: "dummy_analysis",
        modelId: "dummy-card",
        route: routeA,
      },
    });
    const other = build(undefined, {
      modelSelection: {
        semanticShape: "dummy_analysis",
        modelId: "other-card",
        route: routeA,
      },
    });
    const otherRoute = build(undefined, {
      modelSelection: {
        semanticShape: "dummy_analysis",
        modelId: "dummy-card",
        route: { ...routeA, upstreamModel: "dummy/upstream-b" },
      },
    });

    expect(selected.request.modelSelection).toEqual({
      semanticShape: "dummy_analysis",
      modelId: "dummy-card",
      route: routeA,
    });
    expect(selected.request.invocationFingerprint).not.toBe(
      other.request.invocationFingerprint,
    );
    expect(selected.request.invocationFingerprint).not.toBe(
      otherRoute.request.invocationFingerprint,
    );
  });

  it("derives a selected multi-output Run contract from the trusted definition declaration", () => {
    const selectedDefinition: GeneratorDefinition = {
      ...definition,
      actions: [
        {
          id: "analyze",
          executorExportId: "analyze",
          parametersSchema: {
            type: "object",
            properties: {
              categories: {
                type: "array",
                items: { type: "string" },
                minItems: 1,
                uniqueItems: true,
              },
            },
            required: ["categories"],
            additionalProperties: false,
          },
          selectOutputsByParameter: "categories",
          invocationInputs: [
            {
              slot: "source",
              accepts: [{ kind: "media", mediaKind: "image" }],
              cardinality: { minItems: 1, maxItems: 1 },
            },
          ],
          outputs: ["description", "tags"].map((slot) => ({
            slot,
            title: slot,
            sourceMediaKinds: ["image" as const],
            prompt: `Return ${slot}`,
            assetType: {
              kind: "document" as const,
              documentKind: `media.analysis.${slot}`,
              schemaVersion: 1,
            },
            cardinality: { minItems: 0, maxItems: 1 },
          })),
        },
      ],
    };
    const doc = projectDoc();
    const created = createProjectAsset(doc, {
      id: "source-image",
      kind: "image",
      source: { kind: "owned", resourceId: "resource-source" },
      lifecycle: { state: "active" },
      metadata: { contentType: "image/png" },
    });
    if (!created.ok) throw new Error(created.error.message);

    const built = buildLocalGeneratorActionRun({
      doc,
      definition: selectedDefinition,
      actionRunId: "analysis-run",
      generatorRevision: {
        generatorId: "stage",
        generatorRevisionId: "stage:r1",
      },
      actionId: "analyze",
      parameters: { categories: ["tags"] },
      invocationInputRefs: [
        {
          slot: "source",
          target: { kind: "media", projectAssetId: "source-image" },
        },
      ],
    });

    expect(built.request.outputContract).toEqual([
      expect.objectContaining({
        slot: "tags",
        cardinality: { minItems: 1, maxItems: 1 },
      }),
    ]);
    expect(built.request.parameters).toEqual({ categories: ["tags"] });
  });

  it("rejects duplicate, unknown, and source-inapplicable selected outputs", () => {
    const action = definition.actions[0]!;
    const selectedDefinition: GeneratorDefinition = {
      ...definition,
      actions: [{
        ...action,
        selectOutputsByParameter: "categories",
        parametersSchema: {
          type: "object",
          properties: {
            categories: { type: "array", items: { type: "string" }, minItems: 1 },
          },
          required: ["categories"],
          additionalProperties: false,
        },
        invocationInputs: [{
          slot: "source",
          accepts: [{ kind: "media", mediaKind: "image" }],
          cardinality: { minItems: 1, maxItems: 1 },
        }],
        outputs: [
          {
            slot: "description",
            sourceMediaKinds: ["image"],
            assetType: { kind: "document", documentKind: "media.analysis.description", schemaVersion: 1 },
            cardinality: { minItems: 0, maxItems: 1 },
          },
          {
            slot: "audio-semantics",
            sourceMediaKinds: ["audio"],
            assetType: { kind: "document", documentKind: "media.analysis.audio-semantics", schemaVersion: 1 },
            cardinality: { minItems: 0, maxItems: 1 },
          },
        ],
      }],
    };
    const doc = projectDoc();
    expect(createProjectAsset(doc, {
      id: "source-image",
      kind: "image",
      source: { kind: "owned", resourceId: "resource-source" },
      lifecycle: { state: "active" },
      metadata: { contentType: "image/png" },
    })).toMatchObject({ ok: true });
    const invoke = (categories: string[]) => buildLocalGeneratorActionRun({
      doc,
      definition: selectedDefinition,
      actionRunId: "analysis-rejected",
      generatorRevision: { generatorId: "stage", generatorRevisionId: "stage:r1" },
      actionId: "render-still",
      parameters: { categories },
      invocationInputRefs: [{
        slot: "source",
        target: { kind: "media", projectAssetId: "source-image" },
      }],
    });
    expect(() => invoke(["description", "description"])).toThrow(/duplicate/i);
    expect(() => invoke(["invented"])).toThrow(/unknown category/i);
    expect(() => invoke(["audio-semantics"])).toThrow(/not applicable/i);
  });

  it("keeps retry equivalence separate from intentional Run identity", () => {
    const first = build();
    const rerun = build(projectDoc(), { actionRunId: "run-2" });
    const changed = build(projectDoc(), { parameters: { exposure: 2 } });

    expect(rerun.request.actionRunId).not.toBe(first.request.actionRunId);
    expect(rerun.request.invocationFingerprint).toBe(
      first.request.invocationFingerprint,
    );
    expect(changed.request.invocationFingerprint).not.toBe(
      first.request.invocationFingerprint,
    );
  });

  it("rejects an installed definition that does not match the frozen revision", () => {
    expect(() =>
      build(projectDoc(), {
        definition: { ...definition, version: "2.0.0" },
      }),
    ).toThrow(/definition.*revision/i);
  });

  it("validates state and invocation parameters against the plugin JSON Schemas", () => {
    expect(() =>
      build(projectDoc(), { parameters: { exposure: "bright" } }),
    ).toThrow(/parameters.*number/i);

    const doc = projectDoc();
    const rawRevision = doc.getMap("generatorRevisions").get("stage") as
      { set(key: string, value: unknown): void } | undefined;
    rawRevision?.set("stage:r1", {
      id: "stage:r1",
      generatorId: "stage",
      definitionRef,
      state: {},
      persistentInputRefs: [
        {
          slot: "background",
          target: { kind: "media", projectAssetId: "background" },
        },
      ],
    });
    expect(() => build(doc)).toThrow(/state.*scene/i);
  });

  it("enforces declared slots, cardinality, exact target type, and active media", () => {
    expect(() =>
      build(projectDoc(), {
        invocationInputRefs: [
          {
            slot: "other",
            target: { kind: "media", projectAssetId: "background" },
          },
        ],
      }),
    ).toThrow(/unknown.*other/i);
    expect(() =>
      build(projectDoc(), {
        invocationInputRefs: [
          {
            slot: "script",
            target: { kind: "media", projectAssetId: "background" },
          },
        ],
      }),
    ).toThrow(/script.*type/i);
    expect(() =>
      build(projectDoc(), {
        invocationInputRefs: [
          {
            slot: "script",
            target: {
              kind: "document",
              documentAssetId: "missing",
              revisionId: "missing:r1",
            },
          },
        ],
      }),
    ).toThrow(/document.*not found/i);
  });
});
