import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { Canvas } from "./canvas-ops.js";
import * as shared from "./index.js";
import {
  listActionAssetReferences,
  markActionAssetBindingAuthority,
} from "./action-asset-bindings.js";
import { createProjectAsset } from "./project-assets.js";

const emptyStageState = {
  schemaVersion: 1,
  scene: {
    backgroundColor: "#171816",
    grid: { visible: true, snap: false, size: 1 },
  },
  objects: [],
  cameras: [],
  shots: [],
};

const legacyCapturedShot = {
  id: "capture-opening",
  name: "Opening keyframe",
  cameraId: "camera-a",
  assetId: "asset-opening-still",
  aspectRatio: "16:9" as const,
  stageRevisionId: "stage-revision-a",
  createdAt: "2026-07-24T00:00:00.000Z",
  timeSeconds: 1.25,
};

describe("Project Director Stage model", () => {
  it.each([false, true])("publishes complete Stage ownership to live replicas (explicit canvas=%s)", (explicit) => {
    const doc = new LoroDoc();
    if (explicit) shared.ensureProjectCanvas(doc);
    shared.createProjectDirectorStage(doc, { id: "new-stage", name: "Stage", state: emptyStageState });
    doc.commit();
    const remote = new LoroDoc();
    remote.import(doc.export({ mode: "snapshot" }));
    const removed: string[] = [];
    const unsubscribe = doc.subscribeLocalUpdates((update) => {
      remote.import(update);
      const result = shared.reconcileProjectDirectorStageOwnership(remote);
      removed.push(...result.removedActionNodeIds, ...result.detachedStageIds);
      remote.commit();
    });
    expect(shared.attachDirectorStageToCanvas(doc, { stageId: "new-stage", canvasId: "main", actionNodeId: "new-director" }).ok).toBe(true);
    doc.commit();
    unsubscribe();
    expect(removed).toEqual([]);
    expect(new Canvas(remote, () => {}, "main").readNode("new-director")).not.toBeNull();
  });

  it("admits the curated full-body interact action", () => {
    expect((shared as any).DirectorStageActionNameSchema.parse("interact")).toBe("interact");
  });

  it("accepts the broader open humanoid action vocabulary", () => {
    const schema = (shared as any).DirectorStageActionNameSchema;
    const actions = [
      "talk",
      "dance",
      "jump",
      "roll",
      "pickup",
      "push",
      "punch",
      "swim",
      "drive",
      "death",
    ];
    expect(actions.map((action) => schema.parse(action))).toEqual(actions);
  });

  it("provides one canonical empty state for UI, CLI, and agent creation", () => {
    expect((shared as any).createDefaultDirectorStageState()).toEqual(emptyStageState);
  });

  it("publishes a validated scene contract for agents and the 3D UI", () => {
    expect((shared as any).DirectorStageStateSchema).toBeDefined();

    const parsed = (shared as any).DirectorStageStateSchema.parse(emptyStageState);

    expect(parsed).toEqual(emptyStageState);
  });

  it("reads legacy captured-shot state without admitting it through new Stage writers", () => {
    const doc = new LoroDoc();
    const legacyState = {
      ...emptyStageState,
      cameras: [{
        id: "camera-a",
        name: "Camera A",
        position: [0, 1.6, 6],
        rotation: [0, 0, 0],
        fov: 42,
      }],
      shots: [legacyCapturedShot],
    };
    const fields = doc.getMap("directorStages").ensureMergeableMap("legacy-stage");
    fields.set("name", "Legacy Stage");
    fields.set("owner", { kind: "project" });
    fields.set("revision", {
      state: legacyState,
      revisionId: "legacy-stage-revision",
    });

    expect(
      (shared as any).readProjectDirectorStage(doc, "legacy-stage")?.state.shots,
    ).toEqual([legacyCapturedShot]);

    const created = (shared as any).createProjectDirectorStage(new LoroDoc(), {
      id: "new-stage",
      name: "New Stage",
      state: legacyState,
    });
    expect(created).toEqual({
      ok: false,
      error:
        "Director Stage authoring state cannot contain capture outputs; use capture receipts and Project Asset references",
    });

    const updated = (shared as any).updateProjectDirectorStageState(
      doc,
      "legacy-stage",
      legacyState,
    );
    expect(updated).toEqual({
      ok: false,
      error:
        "Director Stage authoring state cannot contain capture outputs; use capture receipts and Project Asset references",
    });
  });

  it("persists story beats, camera cues, and multi-character camera targets", () => {
    const state = {
      ...emptyStageState,
      objects: [
        {
          id: "actor-a",
          name: "Actor A",
          kind: "mannequin",
          visible: true,
          transform: { position: [-1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          mannequin: { bodyType: "neutral", pose: { preset: "standing", joints: {} } },
        },
        {
          id: "actor-b",
          name: "Actor B",
          kind: "mannequin",
          visible: true,
          transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          mannequin: { bodyType: "neutral", pose: { preset: "standing", joints: {} } },
        },
      ],
      cameras: [{
        id: "camera-two-shot",
        name: "Two shot",
        position: [0, 2, 8],
        rotation: [0, 0, 0],
        fov: 45,
        targetObjectIds: ["actor-a", "actor-b"],
        targetOffset: [0, 1.1, 0],
      }],
      activeCameraId: "camera-two-shot",
      animation: {
        durationSeconds: 8,
        fps: 30,
        tracks: [],
        storyBeats: [{
          id: "beat-arrival",
          title: "Arrival",
          startTime: 0,
          durationSeconds: 4,
          participantIds: ["actor-a", "actor-b"],
          dialogue: { speakerId: "actor-a", text: "I brought the letter." },
        }],
        cameraCues: [{
          id: "cue-two-shot",
          name: "Two shot",
          cameraId: "camera-two-shot",
          startTime: 0,
          durationSeconds: 4,
        }],
      },
    };

    expect((shared as any).DirectorStageStateSchema.parse(state)).toEqual(state);
  });

  it("persists a timed mannequin action clip on the shared animation contract", () => {
    const withActor = (shared as any).applyDirectorStageCommand(emptyStageState, {
      op: "object.add",
      object: {
        id: "actor-a",
        name: "Actor A",
        kind: "mannequin",
        visible: true,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        mannequin: {
          bodyType: "neutral",
          pose: { preset: "standing", joints: {} },
        },
      },
    });

    const animated = (shared as any).applyDirectorStageCommand(withActor.state, {
      op: "action.upsert",
      durationSeconds: 10,
      fps: 30,
      clip: {
        id: "actor-a-wave",
        targetId: "actor-a",
        action: "wave",
        layer: "upper-body",
        startTime: 2,
        durationSeconds: 3,
        blendInSeconds: 0.2,
        blendOutSeconds: 0.3,
        playbackRate: 1,
      },
    });

    expect(animated).toMatchObject({
      ok: true,
      state: {
        animation: {
          durationSeconds: 10,
          fps: 30,
          actionClips: [{
            id: "actor-a-wave",
            targetId: "actor-a",
            action: "wave",
            layer: "upper-body",
            startTime: 2,
            durationSeconds: 3,
          }],
        },
      },
    });
    expect((shared as any).DirectorStageStateSchema.parse(animated.state)).toEqual(animated.state);
  });

  it("rejects non-mannequin action targets", () => {
    const withCamera = (shared as any).applyDirectorStageCommand(emptyStageState, {
      op: "camera.add",
      camera: {
        id: "camera-a",
        name: "Camera A",
        position: [0, 2, 8],
        rotation: [0, 0, 0],
        fov: 45,
      },
    });
    const rejected = (shared as any).applyDirectorStageCommand(withCamera.state, {
      op: "action.upsert",
      durationSeconds: 10,
      fps: 30,
      clip: {
        id: "camera-wave",
        targetId: "camera-a",
        action: "wave",
        layer: "upper-body",
        startTime: 0,
        durationSeconds: 2,
      },
    });

    expect(rejected).toEqual({
      ok: false,
      error: "Action target camera-a must be an action-capable object",
    });
  });

  it("persists actions for a rigged model but rejects a static model", () => {
    const withModels = {
      ...emptyStageState,
      objects: [
        {
          id: "rigged-model",
          name: "Rigged model",
          kind: "model",
          visible: true,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          model: {
            assetId: "builtin:rigged",
            animation: {
              jointCount: 62,
              clipNames: ["Idle", "Wave"],
              actionMap: { idle: "Idle", wave: "Wave" },
            },
          },
        },
        {
          id: "static-model",
          name: "Static model",
          kind: "model",
          visible: true,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          model: { assetId: "builtin:static" },
        },
      ],
    };
    const clip = {
      id: "model-wave",
      action: "wave",
      layer: "full-body",
      startTime: 0,
      durationSeconds: 2,
    };

    const animated = (shared as any).applyDirectorStageCommand(withModels, {
      op: "action.upsert",
      durationSeconds: 10,
      fps: 30,
      clip: { ...clip, targetId: "rigged-model" },
    });
    const rejected = (shared as any).applyDirectorStageCommand(withModels, {
      op: "action.upsert",
      durationSeconds: 10,
      fps: 30,
      clip: { ...clip, targetId: "static-model" },
    });

    expect(animated).toMatchObject({ ok: true });
    expect(rejected).toEqual({
      ok: false,
      error: "Action target static-model must be an action-capable object",
    });
  });

  it("removes a persisted action clip by id", () => {
    const state = {
      ...emptyStageState,
      objects: [{
        id: "actor-a",
        name: "Actor A",
        kind: "mannequin",
        visible: true,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        mannequin: {
          bodyType: "neutral",
          pose: { preset: "standing", joints: {} },
        },
      }],
      animation: {
        durationSeconds: 10,
        fps: 30,
        tracks: [],
        actionClips: [{
          id: "wave-a",
          targetId: "actor-a",
          action: "wave",
          layer: "upper-body",
          startTime: 2,
          durationSeconds: 3,
          blendInSeconds: 0.2,
          blendOutSeconds: 0.2,
          playbackRate: 1,
        }],
      },
    };

    const removed = (shared as any).applyDirectorStageCommand(state, {
      op: "action.remove",
      clipId: "wave-a",
    });

    expect(removed).toMatchObject({
      ok: true,
      state: { animation: { actionClips: [] } },
    });
  });

  it("removes a property keyframe and prunes its empty track", () => {
    const state = {
      ...emptyStageState,
      cameras: [{
        id: "camera-a",
        name: "Camera A",
        position: [0, 2, 8],
        rotation: [0, 0, 0],
        fov: 45,
      }],
      animation: {
        durationSeconds: 5,
        fps: 30,
        tracks: [{
          id: "camera-a-fov",
          targetId: "camera-a",
          property: "fov",
          keyframes: [{ id: "fov-a", time: 0, value: 45, interpolation: "bezier" }],
        }],
      },
    };

    const removed = (shared as any).applyDirectorStageCommand(state, {
      op: "keyframe.remove",
      trackId: "camera-a-fov",
      keyframeId: "fov-a",
    });

    expect(removed).toMatchObject({ ok: true, state: { animation: { tracks: [] } } });
  });

  it("removes a mannequin's action clips together with the mannequin", () => {
    const state = {
      ...emptyStageState,
      objects: [{
        id: "actor-a",
        name: "Actor A",
        kind: "mannequin",
        visible: true,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        mannequin: { bodyType: "neutral", pose: { preset: "standing", joints: {} } },
      }],
      animation: {
        durationSeconds: 10,
        fps: 30,
        tracks: [],
        actionClips: [{
          id: "walk-a",
          targetId: "actor-a",
          action: "walk",
          layer: "full-body",
          startTime: 0,
          durationSeconds: 5,
          blendInSeconds: 0.2,
          blendOutSeconds: 0.2,
          playbackRate: 1,
        }],
      },
    };

    const removed = (shared as any).applyDirectorStageCommand(state, {
      op: "object.remove",
      objectId: "actor-a",
    });

    expect(removed.state.animation.actionClips).toEqual([]);
  });

  it("rejects action clips that extend beyond the animation duration", () => {
    const state = {
      ...emptyStageState,
      objects: [{
        id: "actor-a",
        name: "Actor A",
        kind: "mannequin",
        visible: true,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        mannequin: { bodyType: "neutral", pose: { preset: "standing", joints: {} } },
      }],
    };
    const rejected = (shared as any).applyDirectorStageCommand(state, {
      op: "action.upsert",
      durationSeconds: 10,
      fps: 30,
      clip: {
        id: "walk-a",
        targetId: "actor-a",
        action: "walk",
        layer: "full-body",
        startTime: 9,
        durationSeconds: 2,
      },
    });

    expect(rejected).toEqual({
      ok: false,
      error: "Action clip walk-a ends after the 10s animation",
    });
  });

  it("persists panorama horizon and yaw calibration in the shared scene contract", () => {
    const result = (shared as any).applyDirectorStageCommand(emptyStageState, {
      op: "scene.update",
      patch: { environmentRotation: [0.12, -0.45, 0] },
    });

    expect(result).toMatchObject({
      ok: true,
      state: {
        scene: {
          environmentRotation: [0.12, -0.45, 0],
        },
      },
    });
    expect((shared as any).DirectorStageStateSchema.parse(result.state)).toEqual(result.state);
  });

  it("persists the deterministic capture geometry used to register a panorama", () => {
    const calibration = {
      projection: "equirectangular",
      capturePosition: [0, 1.6, 0],
      captureRotation: [0, 0, 0],
      horizonV: 0.5,
      forwardU: 0.5,
      gridCellMeters: 1,
    };
    const result = (shared as any).applyDirectorStageCommand(emptyStageState, {
      op: "scene.update",
      patch: { environmentCalibration: calibration },
    });

    expect(result).toMatchObject({
      ok: true,
      state: {
        scene: {
          environmentCalibration: calibration,
        },
      },
    });
    expect((shared as any).DirectorStageStateSchema.parse(result.state)).toEqual(result.state);
  });

  it("persists a bounded panorama working volume preset or custom upload calibration", () => {
    expect((shared as any).DirectorStageWorkingVolumeSchema).toBeDefined();
    expect((shared as any).DirectorStageWorkingVolumePresetSchema).toBeDefined();

    const workingVolume = {
      mode: "bounded-box",
      preset: "standard",
      size: [28, 5.2, 28],
      origin: [0, 0, 0],
    };
    const calibration = {
      projection: "equirectangular",
      capturePosition: [0, 1.6, 0],
      captureRotation: [0, 0, 0],
      horizonV: 0.5,
      forwardU: 0.5,
      gridCellMeters: 1,
      workingVolume,
    };
    const result = (shared as any).applyDirectorStageCommand(emptyStageState, {
      op: "scene.update",
      patch: { environmentCalibration: calibration },
    });

    expect(result).toMatchObject({
      ok: true,
      state: { scene: { environmentCalibration: { workingVolume } } },
    });
    expect((shared as any).DirectorStageStateSchema.parse(result.state)).toEqual(result.state);
    expect(() => (shared as any).DirectorStageWorkingVolumeSchema.parse({
      ...workingVolume,
      preset: "custom",
      size: [24, -1, 18],
    })).toThrow();
  });

  it("stores a Director Stage as an independently revisioned Project entity", () => {
    expect((shared as any).createProjectDirectorStage).toBeTypeOf("function");

    const doc = new LoroDoc();
    const created = (shared as any).createProjectDirectorStage(doc, {
      id: "stage-1",
      name: "Courtyard blocking",
      state: emptyStageState,
    });

    expect(created).toMatchObject({
      ok: true,
      stage: {
        id: "stage-1",
        name: "Courtyard blocking",
        owner: { kind: "project" },
      },
    });
    expect(created.stage.revisionId).toBe(
      (shared as any).projectDirectorStageRevisionId("stage-1", emptyStageState),
    );
    expect((shared as any).listProjectDirectorStages(doc)).toEqual([created.stage]);
  });

  it("persists Director models by Project Asset identity without Host URLs", () => {
    const doc = new LoroDoc();
    const created = (shared as any).createProjectDirectorStage(doc, {
      id: "stage-storage-free",
      name: "Storage-free stage",
      state: {
        ...emptyStageState,
        objects: [{
          id: "model-1",
          name: "Prop",
          kind: "model",
          visible: true,
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          model: {
            assetId: "asset-model",
            sourceUrl: "blob:https://host-a.invalid/local-preview",
          },
        }],
      },
    });

    expect(created).toMatchObject({ ok: true });
    expect(created.stage.state.objects[0].model).toEqual({
      assetId: "asset-model",
    });
    expect(
      (shared as any).readProjectDirectorStage(doc, "stage-storage-free")
        .state.objects[0].model,
    ).not.toHaveProperty("sourceUrl");
  });

  it("updates Director Action input bindings with the Stage revision", () => {
    const doc = new LoroDoc();
    for (const [id, kind] of [
      ["asset-panorama", "image"],
      ["asset-model", "model"],
    ] as const) {
      createProjectAsset(doc, {
        id,
        kind,
        source: { kind: "owned", resourceId: `resource-${id}` },
        lifecycle: { state: "active" },
        metadata: {},
      });
    }
    markActionAssetBindingAuthority(doc);

    const state = {
      ...emptyStageState,
      scene: {
        ...emptyStageState.scene,
        environmentAssetId: "asset-panorama",
      },
      objects: [{
        id: "model-1",
        name: "Prop",
        kind: "model",
        visible: true,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        model: { assetId: "asset-model" },
      }],
    };
    expect((shared as any).createProjectDirectorStage(doc, {
      id: "stage-bindings",
      name: "Bindings",
      state,
    })).toMatchObject({ ok: true });

    expect(listActionAssetReferences(doc, "asset-panorama")).toMatchObject([{
      owner: { kind: "draft", actionId: "director:stage-bindings" },
      slot: "director:environment",
      direction: "input",
    }]);
    expect(listActionAssetReferences(doc, "asset-model")).toMatchObject([{
      owner: { kind: "draft", actionId: "director:stage-bindings" },
      slot: "director:model:model-1",
      direction: "input",
    }]);

    (shared as any).ensureProjectCanvas(doc, "main");
    expect((shared as any).attachDirectorStageToCanvas(doc, {
      stageId: "stage-bindings",
      canvasId: "main",
      actionNodeId: "director-action",
      position: { x: 0, y: 0 },
    })).toMatchObject({ ok: true });
    expect(listActionAssetReferences(doc, "asset-model")).toMatchObject([{
      owner: { kind: "draft", actionId: "node:director-action" },
      slot: "director:model:model-1",
    }]);

    expect((shared as any).updateProjectDirectorStageState(
      doc,
      "stage-bindings",
      emptyStageState,
    )).toMatchObject({ ok: true });
    expect(listActionAssetReferences(doc, "asset-panorama")).toEqual([]);
    expect(listActionAssetReferences(doc, "asset-model")).toEqual([]);
  });

  it("attaches a Stage through a lightweight Canvas action node", () => {
    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {}, "main");
    (shared as any).createProjectDirectorStage(doc, {
      id: "stage-1",
      name: "Courtyard blocking",
      state: emptyStageState,
    });

    const attached = (shared as any).attachDirectorStageToCanvas(doc, {
      stageId: "stage-1",
      canvasId: "main",
      actionNodeId: "director-stage-action-1",
      position: { x: 120, y: 80 },
    });

    expect(attached).toMatchObject({
      ok: true,
      stage: {
        id: "stage-1",
        owner: {
          kind: "canvas-action",
          canvasId: "main",
          actionNodeId: "director-stage-action-1",
        },
      },
    });
    expect(canvas.readNode("director-stage-action-1")).toMatchObject({
      canvas_id: "main",
      type: "director-stage",
      data: { stageId: "stage-1", label: "Courtyard blocking" },
    });
    expect(canvas.readNode("director-stage-action-1")?.data).not.toHaveProperty("objects");
  });

  it("reconciles losing or deleted Director Actions without deleting non-Actions", () => {
    const doc = new LoroDoc();
    new Canvas(doc, () => {}, "main");
    (shared as any).createProjectDirectorStage(doc, {
      id: "stage-1",
      name: "Courtyard blocking",
      state: emptyStageState,
    });
    (shared as any).attachDirectorStageToCanvas(doc, {
      stageId: "stage-1",
      canvasId: "main",
      actionNodeId: "director-stage-action-1",
      position: { x: 0, y: 0 },
    });
    doc.getMap("nodes").set("losing-director-action", {
      canvasId: "main",
      type: "director-stage",
      data: { stageId: "stage-1", label: "Duplicate" },
      position: { x: 100, y: 0 },
    });
    doc.getMap("nodes").set("director-note", {
      canvasId: "main",
      type: "text",
      data: { stageId: "stage-1", content: "Keep me" },
      position: { x: 200, y: 0 },
    });

    expect((shared as any).reconcileProjectDirectorStageOwnership(doc)).toEqual({
      removedActionNodeIds: ["losing-director-action"],
      detachedStageIds: [],
    });
    expect(doc.getMap("nodes").get("director-note")).toBeDefined();

    doc.getMap("nodes").delete("director-stage-action-1");
    expect((shared as any).reconcileProjectDirectorStageOwnership(doc)).toEqual({
      removedActionNodeIds: [],
      detachedStageIds: ["stage-1"],
    });
    expect((shared as any).readProjectDirectorStage(doc, "stage-1")?.owner).toEqual({ kind: "project" });
  });

  it("keeps the Stage editable after a captured shot creates downstream lineage", () => {
    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {}, "main");
    (shared as any).createProjectDirectorStage(doc, {
      id: "stage-1",
      name: "Courtyard blocking",
      state: emptyStageState,
    });
    (shared as any).attachDirectorStageToCanvas(doc, {
      stageId: "stage-1",
      canvasId: "main",
      actionNodeId: "director-stage-action-1",
      position: { x: 0, y: 0 },
    });
    canvas.insertNode("shot-1", "image", { assetId: "asset-shot-1" }, null, { x: 300, y: 0 });
    canvas.insertEdge("stage-shot-1", "director-stage-action-1", "shot-1", "output");

    const updatedState = {
      ...emptyStageState,
      objects: [{
        id: "actor-a",
        name: "Actor A",
        kind: "mannequin",
        visible: true,
        color: "#d96554",
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        mannequin: { bodyType: "neutral", pose: { preset: "standing", joints: {} } },
      }],
    };
    const updated = (shared as any).updateProjectDirectorStageState(
      doc,
      "stage-1",
      updatedState,
    );

    expect(updated).toMatchObject({ ok: true, stage: { state: updatedState } });
    expect(updated.stage.revisionId).not.toBe(
      (shared as any).projectDirectorStageRevisionId("stage-1", emptyStageState),
    );
  });

  it("applies deterministic object and camera commands", () => {
    expect((shared as any).applyDirectorStageCommand).toBeTypeOf("function");

    const withActor = (shared as any).applyDirectorStageCommand(emptyStageState, {
      op: "object.add",
      object: {
        id: "actor-a",
        name: "Actor A",
        kind: "mannequin",
        visible: true,
        color: "#d96554",
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        mannequin: { bodyType: "neutral", pose: { preset: "standing", joints: {} } },
      },
    });
    const withCamera = (shared as any).applyDirectorStageCommand(withActor.state, {
      op: "camera.add",
      camera: {
        id: "camera-a",
        name: "Front medium",
        position: [0, 1.6, 6],
        rotation: [0, 0, 0],
        fov: 42,
        optics: {
          projection: "perspective",
          focalLengthMm: 50,
          sensorWidthMm: 36,
          sensorHeightMm: 24,
          focusDistanceM: 6,
          fStop: 2.8,
          shutterAngleDegrees: 180,
          iso: 400,
          nearClipM: 0.1,
          farClipM: 1000,
        },
        targetObjectId: "actor-a",
      },
    });
    expect(withActor).toMatchObject({ ok: true });
    expect(withCamera).toMatchObject({
      ok: true,
      state: {
        objects: [expect.objectContaining({ id: "actor-a" })],
        cameras: [expect.objectContaining({ id: "camera-a", targetObjectId: "actor-a" })],
        shots: [],
      },
    });
  });

  it("rejects capture output registration on the Stage command surface", () => {
    const result = (shared as any).applyDirectorStageCommand(
      {
        ...emptyStageState,
        cameras: [{
          id: "camera-a",
          name: "Camera A",
          position: [0, 1.6, 6],
          rotation: [0, 0, 0],
          fov: 42,
        }],
      },
      {
        op: "shot.register",
        shot: legacyCapturedShot,
      },
    );

    expect(result).toEqual({
      ok: false,
      error:
        "Director Stage capture outputs are external references and cannot be registered in Stage state",
    });
  });

  it("drops legacy captured-shot payloads when an old Stage enters the authoring path", () => {
    const result = (shared as any).applyDirectorStageCommand(
      {
        ...emptyStageState,
        cameras: [{
          id: "camera-a",
          name: "Camera A",
          position: [0, 1.6, 6],
          rotation: [0, 0, 0],
          fov: 42,
        }],
        shots: [legacyCapturedShot],
      },
      {
        op: "scene.update",
        patch: { backgroundColor: "#202126" },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      state: {
        scene: { backgroundColor: "#202126" },
        shots: [],
      },
    });
  });

  it("rejects a camera target that is not present in the scene", () => {
    const result = (shared as any).applyDirectorStageCommand(emptyStageState, {
      op: "camera.add",
      camera: {
        id: "camera-a",
        name: "Broken follow",
        position: [0, 1.6, 6],
        rotation: [0, 0, 0],
        fov: 50,
        targetObjectId: "missing-actor",
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "Camera camera-a targets missing object missing-actor",
    });
  });

  it("validates the complete first-party object catalog", () => {
    const transform = {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };
    const state = {
      ...emptyStageState,
      objects: [
        {
          id: "actor",
          name: "Actor",
          kind: "mannequin",
          visible: true,
          transform,
          mannequin: { bodyType: "feminine", pose: { preset: "standing", joints: {} } },
        },
        {
          id: "crate",
          name: "Crate",
          kind: "primitive",
          visible: true,
          transform,
          primitive: { shape: "box" },
        },
        {
          id: "horse",
          name: "Horse",
          kind: "creature",
          visible: true,
          transform,
          creature: { species: "horse", build: "warmblood", gait: "idle" },
        },
        {
          id: "chair",
          name: "Chair",
          kind: "prop",
          visible: true,
          transform,
          prop: { type: "chair" },
        },
        {
          id: "wall",
          name: "Wall",
          kind: "set",
          visible: true,
          transform,
          set: { type: "wall" },
        },
        {
          id: "car",
          name: "Car",
          kind: "vehicle",
          visible: true,
          transform,
          vehicle: { type: "car" },
        },
        {
          id: "key-light",
          name: "Key light",
          kind: "light",
          visible: true,
          color: "#fff1d6",
          transform,
          light: { type: "spot", intensity: 3, range: 18, angle: 0.65 },
        },
        {
          id: "extras",
          name: "Extras",
          kind: "crowd",
          visible: true,
          transform,
          crowd: { rows: 3, columns: 3, spacing: 1.25, bodyType: "neutral" },
        },
        {
          id: "prop",
          name: "Uploaded prop",
          kind: "model",
          visible: true,
          transform,
          model: { assetId: "asset-prop" },
        },
      ],
    };

    expect((shared as any).DirectorStageStateSchema.parse(state).objects.map(
      (object: any) => object.kind,
    )).toEqual([
      "mannequin",
      "primitive",
      "creature",
      "prop",
      "set",
      "vehicle",
      "light",
      "crowd",
      "model",
    ]);
  });

  it("updates, groups, hides, and removes scene objects through commands", () => {
    const actor = {
      id: "actor-a",
      name: "Actor A",
      kind: "mannequin",
      visible: true,
      color: "#d96554",
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      mannequin: { bodyType: "neutral", pose: { preset: "standing", joints: {} } },
    };
    const crate = {
      id: "crate",
      name: "Crate",
      kind: "primitive",
      visible: true,
      transform: {
        position: [1, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      primitive: { shape: "box" },
    };
    let result = (shared as any).applyDirectorStageCommand(emptyStageState, {
      op: "object.add",
      object: actor,
    });
    result = (shared as any).applyDirectorStageCommand(result.state, {
      op: "object.add",
      object: crate,
    });
    result = (shared as any).applyDirectorStageCommand(result.state, {
      op: "object.update",
      objectId: "actor-a",
      patch: {
        name: "Lead",
        visible: false,
        color: "#4f78d1",
        bodyType: "broad",
        bodyShape: 0.42,
        transform: { position: [2, 0, -1] },
        pose: {
          preset: "pointing",
          joints: { rightShoulder: [0, 0, -1.2] },
        },
      },
    });
    result = (shared as any).applyDirectorStageCommand(result.state, {
      op: "object.group",
      objectIds: ["actor-a", "crate"],
      groupId: "group-1",
    });

    expect(result.ok).toBe(true);
    expect(result.state.objects.find((object: any) => object.id === "actor-a")).toMatchObject({
      id: "actor-a",
      name: "Lead",
      visible: false,
      color: "#4f78d1",
      groupId: "group-1",
      transform: { position: [2, 0, -1] },
      mannequin: {
        bodyType: "broad",
        bodyShape: 0.42,
        pose: {
          preset: "pointing",
          joints: { rightShoulder: [0, 0, -1.2] },
        },
      },
    });
    expect(result.state.objects.find((object: any) => object.id === "crate")).toMatchObject({
      id: "crate",
      groupId: "group-1",
    });

    const ungrouped = (shared as any).applyDirectorStageCommand(result.state, {
      op: "object.ungroup",
      groupId: "group-1",
    });
    const removed = (shared as any).applyDirectorStageCommand(ungrouped.state, {
      op: "object.remove",
      objectId: "crate",
    });
    expect(removed.state.objects).toHaveLength(1);
    expect(removed.state.objects[0]).not.toHaveProperty("groupId");
  });

  it("persists a normalized mannequin body-shape value and rejects exaggerated input", () => {
    const actor = {
      id: "actor-shape",
      name: "Adjustable actor",
      kind: "mannequin",
      visible: true,
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      mannequin: {
        bodyType: "neutral",
        bodyShape: 0,
        pose: { preset: "standing", joints: {} },
      },
    };
    const added = (shared as any).applyDirectorStageCommand(emptyStageState, {
      op: "object.add",
      object: actor,
    });
    const adjusted = (shared as any).applyDirectorStageCommand(added.state, {
      op: "object.update",
      objectId: actor.id,
      patch: { bodyShape: -0.35 },
    });
    expect(adjusted.state.objects[0].mannequin.bodyShape).toBe(-0.35);

    const exaggerated = (shared as any).applyDirectorStageCommand(adjusted.state, {
      op: "object.update",
      objectId: actor.id,
      patch: { bodyShape: 1.01 },
    });
    expect(exaggerated.ok).toBe(false);
  });

  it("updates camera focus, scene panorama, and transform keyframes", () => {
    const withActor = (shared as any).applyDirectorStageCommand(emptyStageState, {
      op: "object.add",
      object: {
        id: "actor-a",
        name: "Actor A",
        kind: "mannequin",
        visible: true,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        mannequin: { bodyType: "neutral", pose: { preset: "standing", joints: {} } },
      },
    });
    const withCamera = (shared as any).applyDirectorStageCommand(withActor.state, {
      op: "camera.add",
      camera: {
        id: "camera-a",
        name: "Camera A",
        position: [0, 2, 6],
        rotation: [0, 0, 0],
        fov: 50,
      },
    });
    const focused = (shared as any).applyDirectorStageCommand(withCamera.state, {
      op: "camera.update",
      cameraId: "camera-a",
      patch: {
        fov: 35,
        rotation: [-0.12, 0.35, 0.04],
        targetObjectId: "actor-a",
        targetOffset: [0, 1.65, 0],
      },
    });
    const panoramic = (shared as any).applyDirectorStageCommand(focused.state, {
      op: "scene.update",
      patch: {
        environmentAssetId: "asset-panorama",
        grid: { snap: true },
      },
    });
    const animated = (shared as any).applyDirectorStageCommand(panoramic.state, {
      op: "keyframe.upsert",
      durationSeconds: 10,
      fps: 30,
      track: {
        id: "actor-a-position",
        targetId: "actor-a",
        property: "position",
      },
      keyframe: {
        id: "kf-1",
        time: 2.5,
        value: [2, 0, -1],
        interpolation: "linear",
      },
    });

    expect(animated).toMatchObject({
      ok: true,
      state: {
        scene: {
          environmentAssetId: "asset-panorama",
          grid: { visible: true, snap: true, size: 1 },
        },
        cameras: [expect.objectContaining({
          id: "camera-a",
          fov: 35,
          rotation: [-0.12, 0.35, 0.04],
          targetObjectId: "actor-a",
          targetOffset: [0, 1.65, 0],
        })],
        animation: {
          durationSeconds: 10,
          fps: 30,
          tracks: [{
            id: "actor-a-position",
            targetId: "actor-a",
            property: "position",
            keyframes: [expect.objectContaining({ id: "kf-1", time: 2.5 })],
          }],
        },
      },
    });
  });

  it("adds a horse and mounted rider as one validated composition", () => {
    const result = (shared as any).applyDirectorStageCommand(emptyStageState, {
      op: "object.addMany",
      objects: [
        {
          id: "horse-a",
          name: "Horse A",
          kind: "creature",
          visible: true,
          transform: { position: [2, 0, -1], rotation: [0, 0, 0], scale: [1, 1, 1] },
          creature: { species: "horse", build: "warmblood", gait: "auto" },
        },
        {
          id: "rider-a",
          name: "Rider A",
          kind: "mannequin",
          visible: true,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          attachment: {
            parentId: "horse-a",
            socket: "saddle",
            offset: { position: [0, 1.62, -0.08], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
          mannequin: { bodyType: "neutral", pose: { preset: "riding", joints: {} } },
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.state.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "horse-a", kind: "creature" }),
      expect.objectContaining({
        id: "rider-a",
        attachment: expect.objectContaining({ parentId: "horse-a", socket: "saddle" }),
      }),
    ]));
    expect((shared as any).DirectorStageStateSchema.parse(result.state)).toEqual(result.state);
  });

  it("prevents attachment cycles and invalid saddle targets", () => {
    const withObjects = {
      ...emptyStageState,
      objects: [
        {
          id: "horse-a",
          name: "Horse A",
          kind: "creature",
          visible: true,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          creature: { species: "horse", build: "warmblood", gait: "auto" },
        },
        {
          id: "actor-a",
          name: "Actor A",
          kind: "mannequin",
          visible: true,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          mannequin: { bodyType: "neutral", pose: { preset: "standing", joints: {} } },
        },
        {
          id: "crate-a",
          name: "Crate A",
          kind: "primitive",
          visible: true,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          primitive: { shape: "box" },
        },
      ],
    };

    const mounted = (shared as any).applyDirectorStageCommand(withObjects, {
      op: "object.attach",
      objectId: "actor-a",
      parentId: "horse-a",
      socket: "saddle",
    });
    expect(mounted.ok).toBe(true);

    expect((shared as any).applyDirectorStageCommand(mounted.state, {
      op: "object.attach",
      objectId: "horse-a",
      parentId: "actor-a",
      socket: "origin",
    })).toEqual({ ok: false, error: "Attachment would create a cycle" });

    expect((shared as any).applyDirectorStageCommand(withObjects, {
      op: "object.attach",
      objectId: "actor-a",
      parentId: "crate-a",
      socket: "saddle",
    })).toEqual({ ok: false, error: "Saddle attachments require a horse parent" });
  });

  it("detaches children when their parent object is removed", () => {
    const state = {
      ...emptyStageState,
      objects: [
        {
          id: "horse-a",
          name: "Horse A",
          kind: "creature",
          visible: true,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          creature: { species: "horse", build: "warmblood", gait: "auto" },
        },
        {
          id: "rider-a",
          name: "Rider A",
          kind: "mannequin",
          visible: true,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          attachment: {
            parentId: "horse-a",
            socket: "saddle",
            offset: { position: [0, 1.62, -0.08], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
          mannequin: { bodyType: "neutral", pose: { preset: "riding", joints: {} } },
        },
      ],
    };
    const result = (shared as any).applyDirectorStageCommand(state, {
      op: "object.remove",
      objectId: "horse-a",
    });

    expect(result.ok).toBe(true);
    expect(result.state.objects).toEqual([
      expect.not.objectContaining({ attachment: expect.anything() }),
    ]);
    expect(result.state.objects[0].id).toBe("rider-a");
  });

  it("updates horse build and gait through the shared object reducer", () => {
    const state = {
      ...emptyStageState,
      objects: [{
        id: "horse-a",
        name: "Horse A",
        kind: "creature",
        visible: true,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        creature: { species: "horse", build: "warmblood", gait: "auto" },
      }],
    };
    const result = (shared as any).applyDirectorStageCommand(state, {
      op: "object.update",
      objectId: "horse-a",
      patch: { creatureBuild: "draft", creatureGait: "trot" },
    });
    expect(result.state.objects[0].creature).toEqual({
      species: "horse",
      build: "draft",
      gait: "trot",
    });
  });

  it("updates catalog variants and light controls through the shared object reducer", () => {
    const transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const state = {
      ...emptyStageState,
      objects: [
        { id: "prop-a", name: "Prop", kind: "prop", visible: true, transform, prop: { type: "crate" } },
        { id: "set-a", name: "Set", kind: "set", visible: true, transform, set: { type: "wall" } },
        { id: "vehicle-a", name: "Vehicle", kind: "vehicle", visible: true, transform, vehicle: { type: "car" } },
        {
          id: "light-a",
          name: "Light",
          kind: "light",
          visible: true,
          transform,
          light: { type: "point", intensity: 1, range: 10, angle: 0.6 },
        },
      ],
    };
    let result = (shared as any).applyDirectorStageCommand(state, {
      op: "object.update",
      objectId: "prop-a",
      patch: { propType: "sofa" },
    });
    result = (shared as any).applyDirectorStageCommand(result.state, {
      op: "object.update",
      objectId: "set-a",
      patch: { setType: "tree" },
    });
    result = (shared as any).applyDirectorStageCommand(result.state, {
      op: "object.update",
      objectId: "vehicle-a",
      patch: { vehicleType: "bicycle" },
    });
    result = (shared as any).applyDirectorStageCommand(result.state, {
      op: "object.update",
      objectId: "light-a",
      patch: { lightType: "spot", lightIntensity: 4, lightRange: 24, lightAngle: 0.8 },
    });

    expect(result.state.objects).toEqual([
      expect.objectContaining({ prop: { type: "sofa" } }),
      expect.objectContaining({ set: { type: "tree" } }),
      expect.objectContaining({ vehicle: { type: "bicycle" } }),
      expect.objectContaining({ light: { type: "spot", intensity: 4, range: 24, angle: 0.8 } }),
    ]);
  });

  it("persists physical camera optics and a first-class timed shot sequence", () => {
    const state = {
      ...emptyStageState,
      cameras: [{
        id: "camera-a",
        name: "Camera A",
        position: [0, 1.6, 6],
        rotation: [0, 0, 0],
        fov: 27,
        optics: {
          projection: "perspective",
          focalLengthMm: 50,
          sensorWidthMm: 36,
          sensorHeightMm: 24,
          focusDistanceM: 6,
          fStop: 2.8,
          shutterAngleDegrees: 180,
          iso: 400,
          nearClipM: 0.1,
          farClipM: 1_000,
        },
      }],
      shotSequence: [{
        id: "shot-opening",
        name: "Opening push",
        cameraId: "camera-a",
        startTime: 0,
        durationSeconds: 4,
        aspectRatio: "16:9",
        transition: "cut",
        cameraMove: {
          preset: "dolly-in",
          easing: "ease-in-out",
          rig: {
            kind: "dolly",
            settleInSeconds: 0.5,
            settleOutSeconds: 0.5,
            path: {
              interpolation: "catmull-rom",
              points: [
                [0, 1.6, 6],
                [0, 1.6, 5],
                [0.4, 1.7, 3],
              ],
            },
            orientation: {
              mode: "fixed-target",
              target: [0, 1.35, 0],
            },
            lens: {
              mode: "locked",
              focalLengthMm: 50,
            },
            maxAngularVelocityDegPerSecond: 40,
            maxAngularAccelerationDegPerSecondSquared: 80,
          },
        },
        composition: {
          primarySubjectId: "actor-a",
          headroomRatio: 0.1,
          leadRoomRatio: 0.16,
          minimumCameraDistanceM: 1.5,
          minimumSubjectSeparationM: 0.6,
        },
      }],
    };

    expect((shared as any).DirectorStageStateSchema.parse(state)).toEqual(state);
  });

  it("persists reusable motion assets and retargeted action clip playback semantics", () => {
    const actorState = {
      ...emptyStageState,
      objects: [{
        id: "actor-a",
        name: "Actor A",
        kind: "mannequin",
        visible: true,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        mannequin: { bodyType: "neutral", pose: { preset: "standing", joints: {} } },
      }],
    };
    const withMotion = (shared as any).applyDirectorStageCommand(actorState, {
      op: "motion.upsert",
      motion: {
        id: "motion-natural-walk",
        name: "Natural walk",
        assetId: "asset-natural-walk",
        sourceFormat: "glb",
        clipName: "Walk",
        durationSeconds: 1.2,
        sourceRig: {
          profileId: "mixamo-v1",
          skeletonType: "biped",
          restPose: "t-pose",
          upAxis: "+Y",
          forwardAxis: "+Z",
          metersPerUnit: 1,
          rootBone: "mixamorig:Hips",
          hipsBone: "mixamorig:Hips",
        },
        tags: ["locomotion", "walk"],
      },
    });

    expect(withMotion).toMatchObject({
      ok: true,
      state: {
        motionAssets: [expect.objectContaining({
          id: "motion-natural-walk",
          sourceRig: expect.objectContaining({ profileId: "mixamo-v1" }),
        })],
      },
    });

    const animated = (shared as any).applyDirectorStageCommand(withMotion.state, {
      op: "action.upsert",
      durationSeconds: 8,
      fps: 30,
      clip: {
        id: "actor-a-walk",
        targetId: "actor-a",
        action: "walk",
        layer: "full-body",
        motionAssetId: "motion-natural-walk",
        sourceStartSeconds: 0.1,
        sourceDurationSeconds: 1,
        loopMode: "repeat",
        rootMotionMode: "in-place",
        retargeting: {
          mode: "humanoid",
          targetRigProfileId: "clash-humanoid-v1",
        },
        startTime: 0,
        durationSeconds: 8,
        blendInSeconds: 0.2,
        blendOutSeconds: 0.2,
        playbackRate: 1,
      },
    });

    expect(animated).toMatchObject({
      ok: true,
      state: {
        animation: {
          actionClips: [expect.objectContaining({
            motionAssetId: "motion-natural-walk",
            loopMode: "repeat",
            rootMotionMode: "in-place",
            retargeting: {
              mode: "humanoid",
              targetRigProfileId: "clash-humanoid-v1",
            },
          })],
        },
      },
    });
  });

  it("builds a lineage-complete Director reference packet from one Stage revision", () => {
    const state = {
      ...emptyStageState,
      cameras: [{
        id: "camera-a",
        name: "Camera A",
        position: [0, 1.6, 6],
        rotation: [0, 0, 0],
        fov: 42,
        optics: {
          projection: "perspective",
          focalLengthMm: 50,
          sensorWidthMm: 36,
          sensorHeightMm: 24,
          focusDistanceM: 6,
          fStop: 2.8,
          shutterAngleDegrees: 180,
          iso: 400,
          nearClipM: 0.1,
          farClipM: 1000,
        },
      }],
      shots: [],
      shotSequence: [{
        id: "shot-opening",
        name: "Opening push",
        cameraId: "camera-a",
        startTime: 0,
        durationSeconds: 4,
        aspectRatio: "16:9",
        transition: "cut",
      }],
      animation: {
        durationSeconds: 4,
        fps: 30,
        tracks: [],
      },
    };

    const packet = (shared as any).createDirectorReferencePacket({
      stageId: "stage-a",
      stageRevisionId: "stage-revision-a",
      state,
      exportedAt: "2026-07-24T00:01:00.000Z",
      referenceVideo: {
        assetId: "asset-reference-video",
        src: "https://assets.example/reference.webm",
        previewUrl: "https://assets.example/reference-poster.jpg",
        mimeType: "video/webm",
      },
      referenceStills: [{
        assetId: "asset-opening-still",
        cameraId: "camera-a",
        shotId: "shot-opening",
        aspectRatio: "16:9",
        stageRevisionId: "stage-revision-a",
        timeSeconds: 1.25,
      }],
    });

    expect((shared as any).DirectorReferencePacketSchema.parse(packet)).toEqual(packet);
    expect(packet.referenceVideo).not.toHaveProperty("src");
    expect(packet.referenceVideo).not.toHaveProperty("previewUrl");
    expect(packet).toMatchObject({
      schemaVersion: 1,
      stageId: "stage-a",
      stageRevisionId: "stage-revision-a",
      cameraIds: ["camera-a"],
      durationSeconds: 4,
      fps: 30,
      aspectRatio: "16:9",
      referenceVideo: { assetId: "asset-reference-video" },
      referenceStills: [{
        assetId: "asset-opening-still",
        cameraId: "camera-a",
        shotId: "shot-opening",
        timeSeconds: 1.25,
      }],
      cameraSpec: {
        cameras: [expect.objectContaining({
          id: "camera-a",
          name: "Camera A",
          position: [0, 1.6, 6],
          rotation: [0, 0, 0],
          fov: 42,
          optics: expect.objectContaining({
            focalLengthMm: 50,
            focusDistanceM: 6,
            fStop: 2.8,
          }),
        })],
      },
      shotSpec: {
        shots: [expect.objectContaining({
          id: "shot-opening",
          cameraId: "camera-a",
          startTime: 0,
          durationSeconds: 4,
        })],
      },
    });
  });

  it("uses explicit export metadata when a still-only Stage has no animation clock", () => {
    const packet = (shared as any).createDirectorReferencePacket({
      stageId: "stage-static",
      stageRevisionId: "stage-static-revision",
      state: {
        ...emptyStageState,
        cameras: [{
          id: "camera-static",
          name: "Static camera",
          position: [0, 1.6, 6],
          rotation: [0, 0, 0],
          fov: 42,
        }],
        activeCameraId: "camera-static",
      },
      exportedAt: "2026-07-24T00:01:00.000Z",
      aspectRatio: "9:16",
      durationSeconds: 10,
      fps: 24,
      referenceVideo: {
        assetId: "asset-static-reference",
        mimeType: "video/webm",
      },
    });

    expect(packet).toMatchObject({
      aspectRatio: "9:16",
      durationSeconds: 10,
      fps: 24,
      cameraIds: ["camera-static"],
    });
  });

  it("builds a normalized single-Shot packet without leaking other cameras or stills", () => {
    const packet = (shared as any).createDirectorReferencePacket({
      stageId: "stage-selected",
      stageRevisionId: "stage-selected-revision",
      state: {
        ...emptyStageState,
        cameras: [{
          id: "camera-a",
          name: "Camera A",
          position: [0, 1.6, 6],
          rotation: [0, 0, 0],
          fov: 42,
        }, {
          id: "camera-b",
          name: "Camera B",
          position: [4, 1.8, 2],
          rotation: [0, 0.5, 0],
          fov: 35,
        }],
        activeCameraId: "camera-a",
        shots: [{
          id: "still-a",
          name: "A start",
          cameraId: "camera-a",
          sequenceShotId: "shot-a",
          assetId: "asset-still-a",
          aspectRatio: "16:9",
          stageRevisionId: "stage-selected-revision",
          createdAt: "2026-07-24T00:00:00.000Z",
          timeSeconds: 0,
        }, {
          id: "still-b",
          name: "B start",
          cameraId: "camera-b",
          sequenceShotId: "shot-b",
          assetId: "asset-still-b",
          aspectRatio: "16:9",
          stageRevisionId: "stage-selected-revision",
          createdAt: "2026-07-24T00:00:04.000Z",
          timeSeconds: 4,
        }],
        shotSequence: [{
          id: "shot-a",
          name: "Opening",
          cameraId: "camera-a",
          startTime: 0,
          durationSeconds: 4,
          aspectRatio: "16:9",
          transition: "cut",
        }, {
          id: "shot-b",
          name: "Reverse",
          cameraId: "camera-b",
          startTime: 4,
          durationSeconds: 3,
          aspectRatio: "16:9",
          transition: "cut",
        }],
        animation: { durationSeconds: 7, fps: 30, tracks: [] },
      },
      exportedAt: "2026-07-24T00:01:00.000Z",
      selectedShotIds: ["shot-b"],
      normalizeShotTimes: true,
      durationSeconds: 3,
      referenceVideo: {
        assetId: "asset-shot-b-video",
        mimeType: "video/webm",
      },
    });

    expect(packet).toMatchObject({
      scope: {
        kind: "shot",
        selectedShotIds: ["shot-b"],
      },
      durationSeconds: 3,
      cameraIds: ["camera-b"],
      referenceVideo: { assetId: "asset-shot-b-video" },
      referenceStills: [{
        assetId: "asset-still-b",
        cameraId: "camera-b",
        shotId: "shot-b",
        timeSeconds: 0,
        sequenceTimeSeconds: 4,
      }],
      shotSpec: {
        shots: [{
          id: "shot-b",
          cameraId: "camera-b",
          startTime: 0,
          sequenceStartTime: 4,
          durationSeconds: 3,
        }],
      },
    });
    expect(packet.cameraSpec.cameras.map((camera: any) => camera.id)).toEqual(["camera-b"]);
  });
});
