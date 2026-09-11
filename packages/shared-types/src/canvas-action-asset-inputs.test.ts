import { describe, expect, it } from "vitest";

import {
  canvasActionAssetInputs,
  type CanvasActionAssetInputNode,
} from "./canvas-action-asset-inputs.js";

describe("canvasActionAssetInputs", () => {
  it("does not compile legacy draft bindings for a native Generator placement", () => {
    const node = { id: "placement", type: "action-badge", data: {
      generatorId: "draft", actionType: "video-gen", referenceImageAssetIds: ["source-image"],
    } };
    expect(canvasActionAssetInputs({ node, nodes: [node], edges: [] })).toBeNull();
  });

  it("freezes Director packet Assets from the referenced output node", () => {
    const output = {
      id: "director-output",
      type: "video",
      data: {
        assetId: "director-video",
        status: "completed",
        directorReferencePacket: {
          schemaVersion: 1,
          stageId: "stage-1",
          stageRevisionId: "stage-revision-1",
          exportedAt: "2026-07-24T00:00:00.000Z",
          aspectRatio: "16:9",
          durationSeconds: 6,
          fps: 30,
          cameraIds: ["camera-a"],
          referenceVideo: {
            assetId: "director-video",
            mimeType: "video/webm",
          },
          referenceStills: [
            {
              assetId: "director-still-start",
              cameraId: "camera-a",
              shotId: "shot-a",
              aspectRatio: "16:9",
              stageRevisionId: "stage-revision-1",
              timeSeconds: 0,
            },
            {
              assetId: "director-still-end",
              cameraId: "camera-a",
              shotId: "shot-a",
              aspectRatio: "16:9",
              stageRevisionId: "stage-revision-1",
              timeSeconds: 6,
            },
          ],
          shotSpec: { shots: [] },
        },
      },
    } satisfies CanvasActionAssetInputNode;
    const consumer = {
      id: "video-generator",
      type: "action-badge",
      data: { actionType: "video-gen" },
    } satisfies CanvasActionAssetInputNode;

    const inputs = canvasActionAssetInputs({
      node: consumer,
      nodes: [output, consumer],
      edges: [{ source: output.id, target: consumer.id }],
    });

    expect(inputs?.map(({ projectAssetId }) => projectAssetId)).toEqual([
      "director-video",
      "director-still-start",
      "director-still-end",
    ]);
    expect(inputs?.every(({ role }) => role === "reference")).toBe(true);
  });

  it("freezes an explicit referenceModelAssetIds list into model:N input slots", () => {
    const consumer = {
      id: "auto-rig",
      type: "action-badge",
      data: {
        actionType: "model-gen",
        modelId: "meshy-auto-rig",
        referenceModelAssetIds: ["model-asset-1"],
      },
    } satisfies CanvasActionAssetInputNode;

    const inputs = canvasActionAssetInputs({
      node: consumer,
      nodes: [consumer],
      edges: [],
    });

    expect(inputs).toEqual([
      { slot: "model:0", projectAssetId: "model-asset-1", role: "reference" },
    ]);
  });

  it("freezes an upstream model-kind node (node.type === 'model') connected by an edge into model:0", () => {
    const modelOutput = {
      id: "generated-model",
      type: "model",
      data: { assetId: "model-asset-2", status: "completed" },
    } satisfies CanvasActionAssetInputNode;
    const consumer = {
      id: "auto-rig",
      type: "action-badge",
      data: { actionType: "model-gen", modelId: "meshy-auto-rig" },
    } satisfies CanvasActionAssetInputNode;

    const inputs = canvasActionAssetInputs({
      node: consumer,
      nodes: [modelOutput, consumer],
      edges: [{ source: modelOutput.id, target: consumer.id }],
    });

    expect(inputs).toEqual([
      { slot: "model:0", projectAssetId: "model-asset-2", role: "reference" },
    ]);
  });

  it("freezes a node whose outputType is 'model' the same way as node.type === 'model'", () => {
    const modelOutput = {
      id: "generated-model",
      type: "custom-action-output",
      data: { outputType: "model", assetId: "model-asset-3", status: "completed" },
    } satisfies CanvasActionAssetInputNode;
    const consumer = {
      id: "auto-rig",
      type: "action-badge",
      data: { actionType: "model-gen", modelId: "meshy-auto-rig" },
    } satisfies CanvasActionAssetInputNode;

    const inputs = canvasActionAssetInputs({
      node: consumer,
      nodes: [modelOutput, consumer],
      edges: [{ source: modelOutput.id, target: consumer.id }],
    });

    expect(inputs).toEqual([
      { slot: "model:0", projectAssetId: "model-asset-3", role: "reference" },
    ]);
  });

  it("freezes a prompt @-mention of a model-kind node into model:0", () => {
    const modelOutput = {
      id: "generated-model",
      type: "model",
      data: { assetId: "model-asset-4", status: "completed" },
    } satisfies CanvasActionAssetInputNode;
    const consumer = {
      id: "auto-rig",
      type: "action-badge",
      data: {
        actionType: "model-gen",
        modelId: "meshy-auto-rig",
        prompt: `Rig @[Model](node:${modelOutput.id})`,
      },
    } satisfies CanvasActionAssetInputNode;

    const inputs = canvasActionAssetInputs({
      node: consumer,
      nodes: [modelOutput, consumer],
      edges: [],
    });

    expect(inputs).toEqual([
      { slot: "model:0", projectAssetId: "model-asset-4", role: "reference" },
    ]);
  });

  it("assigns independent, monotonically increasing model:N indexes alongside image:N indexes", () => {
    const image = {
      id: "ref-image",
      type: "image",
      data: { assetId: "image-asset-1" },
    } satisfies CanvasActionAssetInputNode;
    const modelA = {
      id: "ref-model-a",
      type: "model",
      data: { assetId: "model-asset-a" },
    } satisfies CanvasActionAssetInputNode;
    const modelB = {
      id: "ref-model-b",
      type: "model",
      data: { assetId: "model-asset-b" },
    } satisfies CanvasActionAssetInputNode;
    const consumer = {
      id: "combo",
      type: "action-badge",
      data: { actionType: "model-gen" },
    } satisfies CanvasActionAssetInputNode;

    const inputs = canvasActionAssetInputs({
      node: consumer,
      nodes: [image, modelA, modelB, consumer],
      edges: [
        { source: image.id, target: consumer.id },
        { source: modelA.id, target: consumer.id },
        { source: modelB.id, target: consumer.id },
      ],
    });

    expect(inputs).toEqual([
      { slot: "image:0", projectAssetId: "image-asset-1", role: "reference" },
      { slot: "model:0", projectAssetId: "model-asset-a", role: "reference" },
      { slot: "model:1", projectAssetId: "model-asset-b", role: "reference" },
    ]);
  });
});
