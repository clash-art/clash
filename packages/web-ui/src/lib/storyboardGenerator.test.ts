import { describe, expect, it, vi } from "vitest";

import { runStoryboardMaterialGenerator } from "./storyboardGenerator";

describe("runStoryboardMaterialGenerator", () => {
  it("uses a native Generator Action Run and returns its Output Commit asset", async () => {
    const client = {
      createGenerator: vi.fn(async () => ({ generator: {}, revision: {} })),
      submitActionRun: vi.fn(async () => ({ run: { status: "running" } })),
      getActionRun: vi
        .fn()
        .mockResolvedValueOnce({ run: { status: "running" } })
        .mockResolvedValueOnce({ run: { status: "succeeded" } }),
      getOutputCommit: vi.fn(async () => ({
        commit: {
          id: "output-commit-1",
          asset: { kind: "media", projectAssetId: "asset-1" },
        },
      })),
    };
    const definition = {
      pluginId: "clash.codex-imagegen",
      definitionId: "codex-imagegen",
      version: "1.0.0",
      schemaHash: `sha256:${"b".repeat(64)}`,
      stateSchema: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
      editPolicy: "fork-when-materialized",
      persistentInputs: [],
      actions: [
        {
          id: "generate",
          executorExportId: "generate-image",
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
      ],
    } as const;

    const result = await runStoryboardMaterialGenerator({
      client: client as never,
      projectId: "project-1",
      definition: definition as never,
      actionId: "generate",
      outputSlot: "image",
      prompt: "weathered football player",
      ids: {
        generatorId: "generator-1",
        generatorRevisionId: "generator-1:r1",
        actionRunId: "run-1",
      },
      sleep: async () => undefined,
    });

    expect(client.createGenerator).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        pluginId: "clash.codex-imagegen",
        state: { prompt: "weathered football player" },
      }),
    );
    expect(client.submitActionRun).toHaveBeenCalledWith(
      "project-1",
      "generator-1",
      "generate",
      expect.objectContaining({ generatorRevisionId: "generator-1:r1" }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        projectAssetId: "asset-1",
        generatedBy: expect.objectContaining({
          outputCommitId: "output-commit-1",
          outputSlot: "image",
        }),
      }),
    );
  });
});

it("submits an existing composer revision without creating a prompt-only replacement", async () => {
  const client = {
    createGenerator: vi.fn(),
    submitActionRun: vi.fn(),
    getActionRun: vi.fn(async () => ({ run: { status: "succeeded" } })),
    getOutputCommit: vi.fn(async () => ({
      commit: { asset: { kind: "media", projectAssetId: "result" } },
    })),
  };
  const refs = [
    {
      slot: "reference",
      target: { kind: "media", projectAssetId: "original" },
    },
  ];
  await runStoryboardMaterialGenerator({
    client: client as never,
    projectId: "p",
    definition: {
      definitionId: "image",
      actions: [
        {
          id: "generate",
          outputs: [
            { slot: "image", assetType: { kind: "media", mediaKind: "image" } },
          ],
        },
      ],
    } as never,
    actionId: "generate",
    outputSlot: "image",
    prompt: "",
    ids: {
      generatorId: "composer",
      generatorRevisionId: "edited-revision",
      actionRunId: "new-run",
    },
    existingRevision: true,
    invocationInputRefs: refs,
  } as never);
  expect(client.createGenerator).not.toHaveBeenCalled();
  expect(client.submitActionRun).toHaveBeenCalledWith(
    "p",
    "composer",
    "generate",
    expect.objectContaining({
      generatorRevisionId: "edited-revision",
      invocationInputRefs: refs,
    }),
  );
});
