import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";

import {
  createActionAssetBinding,
  markActionAssetBindingAuthority,
  storedDraftActionAssetInputs,
  trashProjectAssetIfUnreferenced,
} from "./action-asset-bindings.js";
import { ACTION_TYPE, buildPendingAssetNode, CanvasNodeSchema } from "./canvas.js";
import { createDefaultDirectorStageState } from "./director-stage.js";
import {
  planLegacyActionAssetBindingMaterialization,
  planLegacyActionAssetBindingMaterializationForDoc,
} from "./legacy-action-asset-bindings.js";
import { createProjectAsset, readProjectAsset } from "./project-assets.js";
import type { ProjectTimeline } from "./project-workspace.js";

function node(
  id: string,
  type: string,
  data: Record<string, unknown>,
  upstream: string[] = [],
) {
  return CanvasNodeSchema.parse({
    id,
    canvasId: "main",
    type,
    position: { x: 0, y: 0 },
    data,
    upstream: upstream.map((nodeId, index) => ({
      nodeId,
      edgeId: `edge-${index}`,
      type: "reference",
    })),
  });
}

describe("legacy Action Asset binding materialization", () => {
  it("materializes executable Canvas inputs without treating loose placements as usage", () => {
    const looseImage = node("loose-image", "image", { assetId: "asset-image" });
    const looseAudio = node("loose-audio", "audio", { assetId: "asset-audio" });
    const action = node(
      "generation",
      "video",
      {
        actionType: "video-gen",
        modelId: "provider-model",
        assetId: "generated-output",
        prompt: "Use @[Frame](node:loose-image)",
        referenceImageAssetIds: ["asset-image"],
        referenceVideoAssetIds: ["asset-video"],
        directorReferencePacket: {
          schemaVersion: 1,
          stageId: "stage-1",
          stageRevisionId: "revision-1",
          exportedAt: "2026-08-13T00:00:00.000Z",
          aspectRatio: "16:9",
          durationSeconds: 1,
          fps: 30,
          cameraIds: ["camera-1"],
          referenceVideo: {
            assetId: "asset-packet-video",
            mimeType: "video/webm",
          },
          referenceStills: [
            {
              assetId: "asset-still",
              cameraId: "camera-1",
              shotId: "shot-1",
              aspectRatio: "16:9",
              stageRevisionId: "revision-1",
            },
          ],
          shotSpec: { shots: [] },
        },
      },
      ["loose-image", "loose-audio"],
    );

    const plan = planLegacyActionAssetBindingMaterialization({
      projectAssetIds: [
        "asset-image",
        "asset-audio",
        "asset-video",
        "asset-packet-video",
        "asset-still",
        "generated-output",
      ],
      canvasNodes: [looseImage, looseAudio, action],
    });

    expect(plan.conflicts).toEqual([]);
    expect(
      plan.bindings.map(({ owner, direction, slot, projectAssetId }) => ({
        owner,
        direction,
        slot,
        projectAssetId,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          owner: { kind: "draft", actionId: "node:generation" },
          direction: "input",
          slot: "image:0",
          projectAssetId: "asset-image",
        },
        {
          owner: { kind: "draft", actionId: "node:generation" },
          direction: "input",
          slot: "video:0",
          projectAssetId: "asset-video",
        },
        {
          owner: { kind: "draft", actionId: "node:generation" },
          direction: "input",
          slot: "video:1",
          projectAssetId: "asset-packet-video",
        },
        {
          owner: { kind: "draft", actionId: "node:generation" },
          direction: "input",
          slot: "image:1",
          projectAssetId: "asset-still",
        },
        {
          owner: { kind: "draft", actionId: "node:generation" },
          direction: "input",
          slot: "audio:0",
          projectAssetId: "asset-audio",
        },
      ]),
    );
    expect(
      plan.bindings.some(
        (binding) => binding.projectAssetId === "generated-output",
      ),
    ).toBe(false);
    expect(
      plan.bindings.filter(
        (binding) => binding.projectAssetId === "asset-image",
      ),
    ).toHaveLength(1);
    expect(
      plan.bindings.filter(
        (binding) => binding.projectAssetId === "asset-audio",
      ),
    ).toHaveLength(1);
  });

  it("materializes only placed Timeline items and resolves catalog backing identity", () => {
    const projectTimeline: ProjectTimeline = {
      id: "edit",
      name: "Edit",
      owner: { kind: "project" },
      revisionId: "revision-edit",
      state: {
        assets: [
          { id: "catalog-used", backingAssetId: "asset-used" },
          { id: "catalog-unused", backingAssetId: "asset-unused" },
        ],
        tracks: [
          {
            id: "visual",
            items: [
              { id: "clip-1", type: "video", assetId: "catalog-used" },
              { id: "clip-2", type: "image", backingAssetId: "asset-direct" },
            ],
          },
        ],
      },
    };
    const canvasTimeline: ProjectTimeline = {
      ...projectTimeline,
      id: "attached",
      owner: {
        kind: "canvas-action",
        canvasId: "main",
        actionNodeId: "timeline-action",
      },
      state: {
        tracks: [{ id: "audio", items: [{ id: "bed", assetId: "asset-bed" }] }],
      },
    };

    const plan = planLegacyActionAssetBindingMaterialization({
      projectAssetIds: [
        "asset-used",
        "asset-unused",
        "asset-direct",
        "asset-bed",
      ],
      timelines: [projectTimeline, canvasTimeline],
    });

    expect(plan.conflicts).toEqual([]);
    expect(
      plan.bindings.map(({ owner, slot, projectAssetId }) => ({
        owner,
        slot,
        projectAssetId,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          owner: { kind: "draft", actionId: "timeline:edit" },
          slot: "timeline:item:clip-1",
          projectAssetId: "asset-used",
        },
        {
          owner: { kind: "draft", actionId: "timeline:edit" },
          slot: "timeline:item:clip-2",
          projectAssetId: "asset-direct",
        },
        {
          owner: { kind: "draft", actionId: "node:timeline-action" },
          slot: "timeline:item:bed",
          projectAssetId: "asset-bed",
        },
      ]),
    );
    expect(
      plan.bindings.some(
        (binding) => binding.projectAssetId === "asset-unused",
      ),
    ).toBe(false);
  });

  it("maps Director inputs and output lineage while ignoring unused catalog media", () => {
    const state = createDefaultDirectorStageState();
    state.scene.environmentAssetId = "asset-panorama";
    state.objects.push(
      {
        id: "uploaded-model",
        name: "Uploaded",
        kind: "model",
        visible: true,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        model: { assetId: "asset-model" },
      },
      {
        id: "builtin-model",
        name: "Builtin",
        kind: "model",
        visible: true,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        model: { assetId: "builtin:catalog:model" },
      },
    );
    state.motionAssets = [
      {
        id: "motion-used",
        name: "Used",
        assetId: "asset-motion",
        sourceFormat: "glb",
        clipName: "Walk",
        sourceRig: {
          profileId: "rig",
          skeletonType: "biped",
          restPose: "t-pose",
          upAxis: "+Y",
          forwardAxis: "+Z",
          metersPerUnit: 1,
          rootBone: "root",
        },
      },
      {
        id: "motion-unused",
        name: "Unused",
        assetId: "asset-unused-motion",
        sourceFormat: "glb",
        clipName: "Idle",
        sourceRig: {
          profileId: "rig",
          skeletonType: "biped",
          restPose: "t-pose",
          upAxis: "+Y",
          forwardAxis: "+Z",
          metersPerUnit: 1,
          rootBone: "root",
        },
      },
    ];
    state.animation = {
      durationSeconds: 2,
      fps: 30,
      tracks: [],
      actionClips: [
        {
          id: "walk",
          targetId: "uploaded-model",
          action: "walk",
          layer: "full-body",
          startTime: 0,
          durationSeconds: 1,
          blendInSeconds: 0.2,
          blendOutSeconds: 0.2,
          playbackRate: 1,
          motionAssetId: "motion-used",
        },
      ],
    };
    state.shots.push({
      id: "shot-1",
      name: "Shot",
      cameraId: "camera-1",
      assetId: "asset-shot",
      aspectRatio: "16:9",
      stageRevisionId: "stage-revision",
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    const plan = planLegacyActionAssetBindingMaterialization({
      projectAssetIds: [
        "asset-panorama",
        "asset-model",
        "asset-motion",
        "asset-unused-motion",
        "asset-shot",
      ],
      directorStages: [
        {
          id: "stage",
          name: "Stage",
          owner: { kind: "project" },
          revisionId: "stage-revision",
          state,
        },
      ],
    });

    expect(plan.conflicts).toEqual([]);
    expect(
      plan.bindings.map(({ owner, direction, slot, projectAssetId }) => ({
        owner,
        direction,
        slot,
        projectAssetId,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          owner: { kind: "draft", actionId: "director:stage" },
          direction: "input",
          slot: "director:environment",
          projectAssetId: "asset-panorama",
        },
        {
          owner: { kind: "draft", actionId: "director:stage" },
          direction: "input",
          slot: "director:model:uploaded-model",
          projectAssetId: "asset-model",
        },
        {
          owner: { kind: "draft", actionId: "director:stage" },
          direction: "input",
          slot: "director:action:walk:motion",
          projectAssetId: "asset-motion",
        },
        {
          owner: {
            kind: "run",
            actionId: "director:stage",
            actionRevisionId: "stage-revision",
            actionRunId: "legacy-director-shot:shot-1",
          },
          direction: "output",
          slot: "director:shot:shot-1",
          projectAssetId: "asset-shot",
        },
      ]),
    );
    expect(
      plan.bindings.some(
        (binding) => binding.projectAssetId === "asset-unused-motion",
      ),
    ).toBe(false);
    expect(
      plan.bindings.some((binding) =>
        binding.projectAssetId.startsWith("builtin:"),
      ),
    ).toBe(false);
  });

  it("migrates a pending Action on a legacy implicit Canvas so trashing its Asset is refused (#239)", () => {
    const doc = new LoroDoc();
    expect(
      createProjectAsset(doc, {
        id: "asset-reference",
        kind: "image",
        source: { kind: "owned", resourceId: `sha256:${"a".repeat(64)}` },
        lifecycle: { state: "active" },
        metadata: { bytes: 1, contentType: "image/png" },
      }).ok,
    ).toBe(true);
    // A legacy Project: no Canvas registry, no canvasId, a generation in flight.
    const pending = buildPendingAssetNode({
      nodeId: "pending",
      prompt: "Animate it",
      modelId: "gpt-image-2",
      modelParams: {},
      actionType: ACTION_TYPE.ImageGen,
      referenceImageAssetIds: ["asset-reference"],
    });
    doc.getMap("nodes").set("pending", {
      type: pending.type,
      position: { x: 0, y: 0 },
      data: { ...pending.data, status: "generating" },
    });
    expect(doc.getMap("canvases").size).toBe(0);

    const plan = planLegacyActionAssetBindingMaterializationForDoc(doc, [
      "asset-reference",
    ]);
    expect(plan.conflicts).toEqual([]);
    for (const binding of plan.bindings) {
      expect(createActionAssetBinding(doc, binding).ok).toBe(true);
    }
    expect(markActionAssetBindingAuthority(doc).ok).toBe(true);

    expect(storedDraftActionAssetInputs(doc, "node:pending")).toEqual([
      expect.objectContaining({ projectAssetId: "asset-reference" }),
    ]);
    expect(
      trashProjectAssetIfUnreferenced(doc, {
        id: "asset-reference",
        deleteOperationId: "trash-1",
        deletedAt: "2026-10-01T00:00:00.000Z",
        purgeAfter: "2026-11-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "ASSET_IN_USE",
        references: [
          expect.objectContaining({
            owner: { kind: "draft", actionId: "node:pending" },
            direction: "input",
          }),
        ],
      },
    });
    expect(readProjectAsset(doc, "asset-reference")?.lifecycle.state).toBe(
      "active",
    );
  });

  it("reports missing identities and conflicting stable slots before cutover", () => {
    const timeline: ProjectTimeline = {
      id: "edit",
      name: "Edit",
      owner: { kind: "project" },
      revisionId: "revision",
      state: {
        tracks: [
          {
            id: "visual",
            items: [
              { id: "same-item", assetId: "asset-a" },
              { id: "same-item", assetId: "asset-b" },
              { id: "missing-item", assetId: "asset-missing" },
            ],
          },
        ],
      },
    };

    const plan = planLegacyActionAssetBindingMaterialization({
      projectAssetIds: ["asset-a", "asset-b"],
      timelines: [timeline],
    });

    expect(plan.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ACTION_ASSET_SLOT_CONFLICT",
          slot: "timeline:item:same-item",
        }),
        expect.objectContaining({
          code: "PROJECT_ASSET_NOT_FOUND",
          slot: "timeline:item:missing-item",
          projectAssetId: "asset-missing",
        }),
      ]),
    );
  });
});
