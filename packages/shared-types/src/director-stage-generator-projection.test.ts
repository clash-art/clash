import { describe, expect, it } from "vitest";

import {
  DirectorStageStateSchema,
  GeneratorDefinitionSchema,
  type GeneratorDefinition,
  type GeneratorRevision,
  type ProjectDirectorStage,
  type ProjectGenerator,
} from "./index.js";
import {
  projectDirectorStageFromGeneratorRevision,
  projectDirectorStageToGeneratorRevisionState,
} from "./director-stage-generator-projection.js";

const HASH = `sha256:${"4".repeat(64)}`;

it("pins registered code Documents through state edits and rejects dangling component uses", () => {
  const source = { kind: "document" as const, documentAssetId: "light-source", revisionId: "source-before-edit" };
  const original = stage();
  const input = { ...original, state: { ...original.state,
    codeComponents: [{ id: "window-light", name: "Window light", source }],
    objects: [{ id: "light-use", name: "Light", kind: "code", visible: true,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      code: { componentId: "window-light", parameters: { power: 3 } },
    }],
  } } as unknown as ProjectDirectorStage;
  const output = projectDirectorStageToGeneratorRevisionState(input, definition());
  expect(output.ok).toBe(true);
  if (!output.ok) return;
  expect(output.persistentInputRefs.some(ref => JSON.stringify(ref.target) === JSON.stringify(source))).toBe(true);
  expect((output.state.stage as any).state.objects[0].code.parameters.power).toBe(3);
  const dangling = projectDirectorStageToGeneratorRevisionState({ ...input, state: { ...input.state, codeComponents: [] } } as any, definition());
  expect(dangling.ok).toBe(false);
});

function definition(
  overrides: Record<string, unknown> = {},
): GeneratorDefinition {
  return GeneratorDefinitionSchema.parse({
    pluginId: "clash.director",
    definitionId: "director-stage",
    version: "1.0.0",
    schemaHash: HASH,
    stateSchema: { type: "object" },
    editPolicy: "advance-head",
    persistentInputs: [
      {
        slot: "stage:media",
        accepts: [{ kind: "media", mediaKind: "image" }],
        cardinality: { minItems: 0, maxItems: null },
      },
    ],
    actions: [
      {
        id: "capture-frame",
        executorExportId: "capture-frame",
        parametersSchema: { type: "object" },
        invocationInputs: [],
        outputs: [
          {
            slot: "capture:output",
            assetType: { kind: "media", mediaKind: "image" },
            cardinality: { minItems: 1, maxItems: 1 },
          },
        ],
      },
    ],
    projectionSurface: {
      id: "clash.director-stage",
      stateKey: "stage",
      mediaInputSlot: "stage:media",
      primaryActionId: "capture-frame",
    },
    ...overrides,
  });
}

function stage(): ProjectDirectorStage {
  return {
    id: "stage-1",
    name: "Blocking",
    owner: { kind: "canvas-action", canvasId: "canvas", actionNodeId: "node" },
    revisionId: "legacy-revision",
    state: DirectorStageStateSchema.parse({
      schemaVersion: 1,
      scene: {
        backgroundColor: "#000000",
        grid: { visible: true, snap: false, size: 1 },
        environmentAssetId: "environment",
      },
      objects: [
        {
          id: "model",
          name: "Model",
          kind: "model",
          visible: true,
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          model: { assetId: "mesh" },
        },
      ],
      cameras: [],
      shots: [],
    }),
  };
}

function facts(d: GeneratorDefinition) {
  const projected = projectDirectorStageToGeneratorRevisionState(stage(), d);
  expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error(projected.message);
  const ref = {
    pluginId: d.pluginId,
    definitionId: d.definitionId,
    version: d.version,
    schemaHash: d.schemaHash,
  };
  const head: ProjectGenerator = {
    id: "stage-1",
    headRevisionId: "revision-1",
    definitionRef: ref,
  };
  const revision: GeneratorRevision = {
    id: "revision-1",
    generatorId: "stage-1",
    definitionRef: ref,
    state: projected.state,
    persistentInputRefs: projected.persistentInputRefs,
  };
  return { head, revision };
}

describe("Director Stage native Generator projection", () => {
  it("round-trips stage state, owner, and media references through only revision facts", () => {
    const d = definition();
    const { head, revision } = facts(d);
    expect(revision.persistentInputRefs).toEqual([
      {
        slot: "stage:media",
        itemKey: "environment",
        target: { kind: "media", projectAssetId: "environment" },
      },
      {
        slot: "stage:media",
        itemKey: "model:model",
        target: { kind: "media", projectAssetId: "mesh" },
      },
    ]);
    expect(
      projectDirectorStageFromGeneratorRevision({ head, revision }, d),
    ).toEqual({
      ok: true,
      stage: { ...stage(), revisionId: "revision-1" },
    });
  });

  it.each([
    [
      "wrong surface",
      definition({
        projectionSurface: {
          id: "clash.timeline",
          stateKey: "stage",
          mediaInputSlot: "stage:media",
          primaryActionId: "capture-frame",
        },
      }),
    ],
    [
      "wrong profile action",
      definition({
        projectionSurface: {
          id: "clash.director-stage",
          stateKey: "stage",
          mediaInputSlot: "stage:media",
          primaryActionId: "other",
        },
        actions: [
          {
            id: "other",
            executorExportId: "capture-frame",
            parametersSchema: { type: "object" },
            invocationInputs: [],
            outputs: [
              {
                slot: "capture:output",
                assetType: { kind: "media", mediaKind: "image" },
                cardinality: { minItems: 1, maxItems: 1 },
              },
            ],
          },
        ],
      }),
    ],
  ])("fails closed for %s", (_name, d) => {
    expect(
      projectDirectorStageToGeneratorRevisionState(stage(), d),
    ).toMatchObject({ ok: false });
  });

  it.each([
    ["multiple outputs", [
      { slot: "capture:output", assetType: { kind: "media", mediaKind: "image" }, cardinality: { minItems: 1, maxItems: 1 } },
      { slot: "extra", assetType: { kind: "media", mediaKind: "image" }, cardinality: { minItems: 1, maxItems: 1 } },
    ]],
    ["optional output", [
      { slot: "capture:output", assetType: { kind: "media", mediaKind: "image" }, cardinality: { minItems: 0, maxItems: 1 } },
    ]],
    ["unbounded output", [
      { slot: "capture:output", assetType: { kind: "media", mediaKind: "image" }, cardinality: { minItems: 1, maxItems: null } },
    ]],
  ])("rejects a capture-frame profile with %s", (_name, outputs) => {
    const valid = definition();
    const d = {
      ...valid,
      actions: [{
        ...valid.actions[0]!,
        outputs,
      }],
    } as GeneratorDefinition;
    expect(projectDirectorStageToGeneratorRevisionState(stage(), d)).toMatchObject({
      ok: false,
      code: "GENERATOR_PROJECTION_PROFILE_INVALID",
    });
  });

  it("fails closed for a mismatched Definition ref or malformed state-key envelope", () => {
    const d = definition();
    const { head, revision } = facts(d);
    expect(
      projectDirectorStageFromGeneratorRevision(
        {
          head: {
            ...head,
            definitionRef: { ...head.definitionRef, version: "2" },
          },
          revision,
        },
        d,
      ),
    ).toMatchObject({ ok: false, code: "GENERATOR_DEFINITION_REF_MISMATCH" });
    expect(
      projectDirectorStageFromGeneratorRevision(
        {
          head,
          revision: { ...revision, state: { wrong: revision.state.stage! } },
        },
        d,
      ),
    ).toMatchObject({
      ok: false,
      code: "GENERATOR_PROJECTION_ENVELOPE_INVALID",
    });
  });
});
