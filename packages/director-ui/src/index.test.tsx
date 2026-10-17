import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AnimationMixer, Box3, Group, Matrix4, Object3D, SkinnedMesh, Vector3 } from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { describe, expect, it } from "vitest";
import type { DirectorStageState } from "@clash/shared-types";
import * as directorUI from "./index";
import * as directorViewport from "./DirectorViewport";
import {
  DIRECTOR_MANNEQUIN_POSE_PRESETS,
  DIRECTOR_CAPTURE_RENDERER_OPTIONS,
  DIRECTOR_RENDERER_OPTIONS,
  DirectorKeyframeTimeline,
  applyDirectorMannequinPose,
  animateDirectorMannequinWalkCycle,
  bindDirectorMannequinRig,
  readDirectorMannequinSkeleton,
  directorShortcut,
  preferredDirectorVideoMimeType,
} from "./index";

const animation: NonNullable<DirectorStageState["animation"]> = {
  durationSeconds: 10,
  fps: 30,
  tracks: [
    {
      id: "actor-position",
      targetId: "actor-a",
      property: "position",
      keyframes: [
        { id: "start", time: 0, value: [0, 0, 0], interpolation: "linear" },
        { id: "end", time: 5, value: [2, 0, 0], interpolation: "linear" },
      ],
    },
  ],
};

const storyAnimation = {
  ...animation,
  storyBeats: [{
    id: "beat-arrival",
    title: "Arrival",
    startTime: 0,
    durationSeconds: 4,
    participantIds: ["actor-a"],
    dialogue: { speakerId: "actor-a", text: "I brought the letter." },
  }],
  cameraCues: [{
    id: "cue-opening",
    name: "Opening push",
    cameraId: "camera-a",
    startTime: 0,
    durationSeconds: 4,
  }],
} as any;

it("resolves custom model bytes only from the current Host projection", () => {
  const resolveProjection = (directorViewport as any)
    .resolveDirectorModelProjectionUrl;
  expect(resolveProjection).toBeTypeOf("function");

  const authorizedProjection =
    "http://127.0.0.1:4319/api/v1/projects/project-1/assets/asset-model/content?capability=read";
  expect(
    resolveProjection("asset-model", {
      "asset-model": authorizedProjection,
    }),
  ).toBe(authorizedProjection);
  expect(resolveProjection("asset-model", {})).toBeUndefined();
  expect(resolveProjection("builtin:quaternius:casual-hoodie", {})).toBe(
    (directorUI as any).DIRECTOR_BUILTIN_MODEL_ASSET_URLS[
      "builtin:quaternius:casual-hoodie"
    ],
  );
});

function loadAnnyRig(bodyType = "neutral", sanitizeRuntimeNames = false): Group {
  const assetUrl = new URL(`../assets/anny-mpfb2/${bodyType}.glb`, import.meta.url);
  const bytes = readFileSync(assetUrl);
  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  const nodes = document.nodes.map((node: {
    name?: string;
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }) => {
    const object = new Object3D();
    object.name = node.name ?? "";
    if (node.matrix) {
      new Matrix4().fromArray(node.matrix).decompose(
        object.position,
        object.quaternion,
        object.scale,
      );
    } else {
      if (node.translation) object.position.fromArray(node.translation);
      if (node.rotation) object.quaternion.fromArray(node.rotation);
      if (node.scale) object.scale.fromArray(node.scale);
    }
    return object;
  });
  const childNodeIndexes = new Set<number>();
  document.nodes.forEach((node: { children?: number[] }, nodeIndex: number) => {
    node.children?.forEach((childIndex) => {
      nodes[nodeIndex]?.add(nodes[childIndex]);
      childNodeIndexes.add(childIndex);
    });
  });
  const rig = new Group();
  nodes.forEach((node: Object3D, nodeIndex: number) => {
    if (!childNodeIndexes.has(nodeIndex)) rig.add(node);
  });
  if (sanitizeRuntimeNames) {
    rig.traverse((object) => {
      object.name = object.name.replaceAll(":", "");
    });
  }
  bindDirectorMannequinRig(rig);
  return rig;
}

async function loadRuntimeAnnyRig(bodyType = "neutral") {
  if (typeof globalThis.ProgressEvent === "undefined") {
    globalThis.ProgressEvent = class extends Event {} as unknown as typeof ProgressEvent;
  }
  const bytes = readFileSync(new URL(`../assets/anny-mpfb2/${bodyType}.glb`, import.meta.url));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const gltf = await new Promise<GLTF>((resolve, reject) => {
    new GLTFLoader().parse(buffer, "", resolve, reject);
  });
  const rig = SkeletonUtils.clone(gltf.scene) as Group;
  bindDirectorMannequinRig(rig);
  let mesh: SkinnedMesh | undefined;
  rig.traverse((object) => {
    if (object instanceof SkinnedMesh) mesh = object;
  });
  if (!mesh) throw new Error("Anny runtime asset has no skinned mesh");
  return { rig, mesh };
}

async function loadCasualMotionRig() {
  if (typeof globalThis.ProgressEvent === "undefined") {
    globalThis.ProgressEvent = class extends Event {} as unknown as typeof ProgressEvent;
  }
  const source = readFileSync(
    new URL("../assets/starter-library/models/Casual_Hoodie.gltf", import.meta.url),
    "utf8",
  );
  const gltf = await new Promise<GLTF>((resolve, reject) => {
    new GLTFLoader().parse(source, "", resolve, reject);
  });
  const rig = SkeletonUtils.clone(gltf.scene) as Group;
  return { rig, animations: gltf.animations };
}

async function loadUniversalMotionRig() {
  if (typeof globalThis.ProgressEvent === "undefined") {
    globalThis.ProgressEvent = class extends Event {} as unknown as typeof ProgressEvent;
  }
  const bytes = readFileSync(
    new URL(
      "../assets/starter-library/motions/UAL1_Standard.glb",
      import.meta.url,
    ),
  );
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const gltf = await new Promise<GLTF>((resolve, reject) => {
    new GLTFLoader().parse(buffer, "", resolve, reject);
  });
  return {
    rig: SkeletonUtils.clone(gltf.scene) as Group,
    animations: gltf.animations,
  };
}

function skinnedWidth(rig: Group, mesh: SkinnedMesh): number {
  rig.updateWorldMatrix(true, true);
  mesh.skeleton.update();
  const bounds = new Box3();
  const point = new Vector3();
  const positions = mesh.geometry.getAttribute("position");
  for (let vertexIndex = 0; vertexIndex < positions.count; vertexIndex += 1) {
    point.fromBufferAttribute(positions, vertexIndex);
    mesh.applyBoneTransform(vertexIndex, point);
    bounds.expandByPoint(point);
  }
  return bounds.getSize(new Vector3()).x;
}

describe("Director UI primitives", () => {
  it("ships a real CC0 starter library instead of procedural prop stand-ins", () => {
    const assets = (directorUI as any).DIRECTOR_BUILTIN_MODEL_ASSETS as Array<{
      id: string;
      name: string;
      category: string;
      license: string;
      sourceName: string;
      sourceUrl: string;
      thumbnailUrl: string;
    }>;

    expect(assets).toHaveLength(10);
    expect(new Set(assets.map((asset) => asset.id)).size).toBe(assets.length);
    expect(new Set(assets.map((asset) => asset.category))).toEqual(new Set([
      "Characters",
      "Animals",
      "Furniture",
      "Props",
      "Vehicles",
      "Nature",
    ]));
    for (const asset of assets) {
      expect(asset.license).toBe("CC0-1.0");
      expect(["Poly Haven", "Quaternius"]).toContain(asset.sourceName);
      expect(asset.sourceUrl).toMatch(/\.(?:glb|gltf)$/);
      expect(asset.thumbnailUrl).toMatch(/\.(?:png|webp|jpe?g)$/);
      expect(existsSync(new URL(asset.sourceUrl))).toBe(true);
      expect(existsSync(new URL(asset.thumbnailUrl))).toBe(true);
    }

    const character = assets.find((asset) => asset.id === "builtin:quaternius:casual-hoodie") as any;
    const horse = assets.find((asset) => asset.id === "builtin:quaternius:animated-horse") as any;
    expect(character.rig).toMatchObject({ jointCount: 62 });
    expect(character.rig.clipNames).toHaveLength(24);
    expect(character.rig.actionMap).toMatchObject({
      idle: "Idle_Neutral",
      walk: "Walk",
      run: "Run",
      wave: "Wave",
      interact: "Interact",
    });
    expect(horse.rig).toMatchObject({ jointCount: 50 });
    expect(horse.rig.clipNames).toHaveLength(13);
    expect(horse.rig.actionMap).toMatchObject({ idle: "Idle", walk: "Walk", run: "Gallop" });
    expect(horse.defaultTransform.scale).toEqual([0.5, 0.5, 0.5]);
  });

  it("pins every bundled model to an auditable CC0 source manifest", () => {
    const assets = (directorUI as any).DIRECTOR_BUILTIN_MODEL_ASSETS as Array<{
      id: string;
      sourceUrl: string;
      sourcePageUrl: string;
      license: string;
      licenseUrl?: string;
      sourceSha256?: string;
    }>;

    for (const asset of assets) {
      expect(asset.license).toBe("CC0-1.0");
      expect(asset.licenseUrl).toMatch(/^https:\/\//);
      expect(asset.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      const actualHash = createHash("sha256")
        .update(readFileSync(new URL(asset.sourceUrl)))
        .digest("hex");
      expect(asset.sourceSha256, `${asset.id} source hash drifted`).toBe(actualHash);
    }
  });

  it("maps authored model actions and path locomotion to embedded animation clips", () => {
    const character = (directorUI as any).DIRECTOR_BUILTIN_MODEL_ASSETS.find(
      (asset: any) => asset.id === "builtin:quaternius:casual-hoodie",
    );
    const resolve = (directorUI as any).resolveDirectorEmbeddedModelAnimation;

    expect(resolve({
      rig: character.rig,
      requestedAction: "wave",
      actionLocalTimeSeconds: 1.25,
      actionWeight: 0.6,
      locomotionSpeed: 0,
      timeSeconds: 9,
    })).toEqual({ clipName: "Wave", localTimeSeconds: 1.25, weight: 0.6 });
    expect(resolve({
      rig: character.rig,
      locomotionSpeed: 2,
      locomotionDistance: 7.2,
      timeSeconds: 3.5,
    })).toEqual({ clipName: "Run", localTimeSeconds: 2, weight: 1 });
  });

  it("keeps bundled humanoid and quadruped rigs on separate profiles", () => {
    const assets = (directorUI as any).DIRECTOR_BUILTIN_MODEL_ASSETS as Array<{
      id: string;
      rig?: { profileId?: string };
    }>;
    const character = assets.find((asset) => asset.id === "builtin:quaternius:casual-hoodie");
    const horse = assets.find((asset) => asset.id === "builtin:quaternius:animated-horse");

    expect(character?.rig?.profileId).toBe("clash-humanoid-v1");
    expect(horse?.rig?.profileId).toBe("clash-quadruped-v1");
    expect(character?.rig?.profileId).not.toBe(horse?.rig?.profileId);
  });

  it("keeps a walking mannequin facing its position path even when a rotation track exists", () => {
    const resolveLocomotion = (directorUI as any).resolveDirectorObjectLocomotion;
    expect(resolveLocomotion).toBeTypeOf("function");
    const object = {
      id: "actor-a",
      name: "Actor A",
      kind: "mannequin" as const,
      visible: true,
      transform: {
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, -0.15, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
      mannequin: {
        bodyType: "feminine" as const,
        pose: { preset: "standing", joints: {} },
      },
    };
    const stateAnimation = {
      ...animation,
      tracks: [
        ...animation.tracks,
        {
          id: "actor-rotation",
          targetId: "actor-a",
          property: "rotation" as const,
          keyframes: [
            { id: "turn-start", time: 0, value: [0, -0.15, 0] as [number, number, number], interpolation: "linear" as const },
            { id: "turn-end", time: 5, value: [0, 0.12, 0] as [number, number, number], interpolation: "linear" as const },
          ],
        },
      ],
    };

    const locomotion = resolveLocomotion({
      object,
      animation: stateAnimation,
      timeSeconds: 2.5,
      hasRiggedModel: false,
    });

    expect(locomotion.speed).toBeGreaterThan(0.1);
    expect(locomotion.distance).toBeCloseTo(1, 6);
    expect(locomotion.yaw).toBeCloseTo(Math.PI / 2, 4);
  });

  it("retargets the real CC0 Wave clip onto Anny as in-place quaternion motion", async () => {
    const retargetClip = (directorUI as any).retargetDirectorHumanoidClip;
    expect(retargetClip).toBeTypeOf("function");
    const [{ rig: anny }, { rig: source, animations }] = await Promise.all([
      loadRuntimeAnnyRig(),
      loadCasualMotionRig(),
    ]);
    const sourceWave = animations.find((clip) => clip.name === "Wave");
    expect(sourceWave).toBeDefined();

    const clip = retargetClip({
      target: anny,
      source,
      clip: sourceWave!,
      inPlace: true,
    });

    expect(clip.name).toBe("Wave");
    expect(clip.duration).toBeGreaterThan(0.5);
    expect(clip.tracks.some((track: { name: string }) => /RightArm.*quaternion/.test(track.name))).toBe(true);
    expect(clip.tracks.some((track: { name: string }) => /RightForeArm.*quaternion/.test(track.name))).toBe(true);
    expect(clip.tracks.every((track: { name: string }) => !track.name.endsWith(".position"))).toBe(true);

    const rightArm = anny.getObjectByName("mixamorigRightArm");
    const leftShoulder = anny.getObjectByName("mixamorigLeftShoulder");
    expect(rightArm).toBeDefined();
    expect(leftShoulder).toBeDefined();
    const before = rightArm!.quaternion.clone();
    const shoulderBefore = leftShoulder!.quaternion.clone();
    const mixer = new AnimationMixer(anny);
    const action = mixer.clipAction(clip).play();
    action.time = Math.min(1, clip.duration * 0.45);
    mixer.update(0);
    anny.updateWorldMatrix(true, true);
    expect(before.angleTo(rightArm!.quaternion)).toBeGreaterThan(0.25);
    expect(shoulderBefore.angleTo(leftShoulder!.quaternion)).toBeLessThan(1.4);

    const head = anny.getObjectByName("mixamorigHead")!;
    const leftArm = anny.getObjectByName("mixamorigLeftArm")!;
    const leftForeArm = anny.getObjectByName("mixamorigLeftForeArm")!;
    const leftHand = anny.getObjectByName("mixamorigLeftHand")!;
    const rightHand = anny.getObjectByName("mixamorigRightHand")!;
    const headPosition = head.getWorldPosition(new Vector3());
    const leftArmPosition = leftArm.getWorldPosition(new Vector3());
    const leftForeArmPosition = leftForeArm.getWorldPosition(new Vector3());
    const leftHandPosition = leftHand.getWorldPosition(new Vector3());
    const rightHandPosition = rightHand.getWorldPosition(new Vector3());
    const wavingElbowDrop = leftForeArmPosition.y - leftArmPosition.y;
    expect(wavingElbowDrop).toBeLessThan(-0.075);
    expect(wavingElbowDrop).toBeGreaterThan(-0.16);
    expect(leftHandPosition.y).toBeGreaterThan(headPosition.y - 0.05);
    expect(rightHandPosition.y).toBeLessThan(headPosition.y - 0.2);
  });

  it("keeps both Walk elbows and hands outside Anny's torso centerline", async () => {
    const createLibrary = (directorUI as any).createDirectorAnnyMotionClipLibrary;
    const [{ rig: anny }, { rig: source, animations }] = await Promise.all([
      loadRuntimeAnnyRig(),
      loadCasualMotionRig(),
    ]);
    const walk = createLibrary({ target: anny, source, animations }).clips.Walk;
    const mixer = new AnimationMixer(anny);
    const action = mixer.clipAction(walk).play();
    action.time = 2.2 % walk.duration;
    mixer.update(0);
    anny.updateWorldMatrix(true, true);

    const torso = anny.getObjectByName("mixamorigSpine2")!;
    const torsoX = torso.getWorldPosition(new Vector3()).x;
    for (const sideName of ["Left", "Right"] as const) {
      const upperArm = anny.getObjectByName(`mixamorig${sideName}Arm`)!;
      const elbow = anny.getObjectByName(`mixamorig${sideName}ForeArm`)!;
      const hand = anny.getObjectByName(`mixamorig${sideName}Hand`)!;
      const shoulderSide = Math.sign(upperArm.getWorldPosition(new Vector3()).x - torsoX);
      const elbowOffset = (
        elbow.getWorldPosition(new Vector3()).x - torsoX
      ) * shoulderSide;
      const handOffset = (
        hand.getWorldPosition(new Vector3()).x - torsoX
      ) * shoulderSide;

      expect(shoulderSide).not.toBe(0);
      expect(elbowOffset, `${sideName} elbow entered the torso`).toBeGreaterThan(0.12);
      expect(handOffset, `${sideName} hand crossed the torso centerline`).toBeGreaterThan(0.12);
    }
  });

  it("layers a real upper-body Wave clip over path-driven Walk playback", () => {
    const resolvePlayback = (directorUI as any).resolveDirectorAnnyMotionPlayback;
    expect(resolvePlayback).toBeTypeOf("function");
    const playback = resolvePlayback({
      posePreset: "standing",
      activeActions: [{
        clip: {
          id: "wave-a",
          targetId: "actor-a",
          action: "wave",
          layer: "upper-body",
          startTime: 0,
          durationSeconds: 3,
          blendInSeconds: 0.2,
          blendOutSeconds: 0.2,
          playbackRate: 1,
        },
        localTimeSeconds: 1.25,
        weight: 0.8,
      }],
      locomotionSpeed: 0.6,
      timeSeconds: 2.5,
    });

    expect(playback).toEqual({
      base: {
        clipName: "Walk",
        localTimeSeconds: 1,
        playbackRate: 0.4,
        weight: 1,
      },
      upperBody: { clipName: "Wave", localTimeSeconds: 1.25, weight: 0.8 },
    });
  });

  it("drives path locomotion phase from cumulative distance instead of instantaneous speed", () => {
    const resolvePlayback = (directorUI as any).resolveDirectorAnnyMotionPlayback;
    expect(resolvePlayback({
      posePreset: "standing",
      activeActions: [],
      locomotionSpeed: 0.2,
      locomotionDistance: 3,
      locomotionSpeeds: { Walk: 1.5, Run: 3.6 },
      timeSeconds: 8,
    })).toEqual({
      base: {
        clipName: "Walk",
        localTimeSeconds: 2,
        playbackRate: 0.133333,
        weight: 1,
      },
    });
  });

  it("keeps authored non-clip poses on the procedural fallback", () => {
    const resolvePlayback = (directorUI as any).resolveDirectorAnnyMotionPlayback;
    expect(resolvePlayback({
      posePreset: "riding",
      activeActions: [],
      locomotionSpeed: 1,
      timeSeconds: 2,
    })).toBeUndefined();
    expect(resolvePlayback({
      posePreset: "standing",
      activeActions: [{
        clip: {
          id: "think-a",
          targetId: "actor-a",
          action: "think",
          layer: "upper-body",
          startTime: 0,
          durationSeconds: 2,
          blendInSeconds: 0,
          blendOutSeconds: 0,
          playbackRate: 1,
        },
        localTimeSeconds: 1,
        weight: 1,
      }],
      locomotionSpeed: 0,
      timeSeconds: 1,
    })).toBeUndefined();
  });

  it("plays the curated full-body Interact clip through the authored action track", () => {
    const resolvePlayback = (directorUI as any).resolveDirectorAnnyMotionPlayback;
    expect(resolvePlayback({
      posePreset: "standing",
      activeActions: [{
        clip: {
          id: "interact-a",
          targetId: "actor-a",
          action: "interact",
          layer: "full-body",
          startTime: 1,
          durationSeconds: 2,
          blendInSeconds: 0.15,
          blendOutSeconds: 0.15,
          playbackRate: 1,
        },
        localTimeSeconds: 0.65,
        weight: 0.9,
      }],
      locomotionSpeed: 0,
      timeSeconds: 2,
    })).toEqual({
      base: {
        clipName: "Interact",
        localTimeSeconds: 0.65,
        weight: 0.9,
      },
    });
  });

  it("partitions Walk and Wave into non-overlapping normal bone layers", async () => {
    const createLibrary = (directorUI as any).createDirectorAnnyMotionClipLibrary;
    const [{ rig: anny }, { rig: source, animations }] = await Promise.all([
      loadRuntimeAnnyRig(),
      loadCasualMotionRig(),
    ]);
    const library = createLibrary({ target: anny, source, animations });
    const lowerBodyWalk = library.lowerBodyClips.Walk;
    const upperBodyWave = library.upperBodyClips.Wave;
    const trackBone = (name: string) => name.split(".")[0];
    const lowerBones = new Set(lowerBodyWalk.tracks.map((track: { name: string }) => trackBone(track.name)));
    const upperBones = new Set(upperBodyWave.tracks.map((track: { name: string }) => trackBone(track.name)));

    expect(lowerBodyWalk.blendMode).toBe((await import("three")).NormalAnimationBlendMode);
    expect(upperBodyWave.blendMode).toBe((await import("three")).NormalAnimationBlendMode);
    expect(lowerBodyWalk.tracks.some((track: { name: string }) => /(Hips|UpLeg|Leg|Foot)/.test(track.name))).toBe(true);
    expect(lowerBodyWalk.tracks.some((track: { name: string }) => /RightArm/.test(track.name))).toBe(true);
    expect(lowerBodyWalk.tracks.every((track: { name: string }) => !/Left(?:Shoulder|Arm|ForeArm|Hand)/.test(track.name))).toBe(true);
    expect(upperBodyWave.tracks.some((track: { name: string }) => /LeftArm/.test(track.name))).toBe(true);
    expect(upperBodyWave.tracks.every((track: { name: string }) => !/Right(?:Shoulder|Arm|ForeArm|Hand)/.test(track.name))).toBe(true);
    expect(upperBodyWave.tracks.every((track: { name: string }) => !/(Hips|UpLeg|Leg|Foot)/.test(track.name))).toBe(true);
    expect([...upperBones].filter((bone) => lowerBones.has(bone))).toEqual([]);
  });

  it("declares a checksummed CC0 source for grounded posture actions", () => {
    const sources = (directorUI as any).CLASH_HUMANOID_MOTION_SOURCES;
    const manifest = (directorUI as any).CLASH_HUMANOID_ACTION_LIBRARY_V1;
    const supplementalSource = sources?.find(
      (source: { id: string }) => source.id === "quaternius-universal-animation-standard",
    );

    expect(supplementalSource).toMatchObject({
      id: "quaternius-universal-animation-standard",
      sourcePageUrl: "https://quaternius.com/packs/universalanimationlibrary.html",
      sourceUrl: expect.stringMatching(/UAL1_Standard\.glb$/),
      license: "CC0-1.0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      sourceSha256: "69591853d817488edaa8fd9bf8fc1d821eaeaf789f8627b3cd23b41c4ed67997",
    });
    const sourceBytes = readFileSync(new URL(supplementalSource.sourceUrl));
    expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(
      supplementalSource.sourceSha256,
    );
    expect(manifest.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "sit",
        sourceId: "quaternius-universal-animation-standard",
        sourceClip: "Sitting_Idle_Loop",
        layer: "full-body",
      }),
      expect.objectContaining({
        id: "crouch",
        sourceId: "quaternius-universal-animation-standard",
        sourceClip: "Crouch_Idle_Loop",
        layer: "full-body",
      }),
      expect.objectContaining({
        id: "kneel",
        sourceId: "quaternius-universal-animation-standard",
        sourceClip: "Fixing_Kneeling",
        layer: "full-body",
      }),
    ]));
  });

  it("catalogs every bundled UAL1 clip and exposes useful prop-free actions", async () => {
    const catalog = (directorUI as any).CLASH_HUMANOID_MOTION_CATALOG_V1;
    const source = (directorUI as any).CLASH_HUMANOID_MOTION_SOURCES.find(
      (entry: { id: string }) => entry.id === "quaternius-universal-animation-standard",
    );
    const bytes = readFileSync(new URL(source.sourceUrl));
    const data = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const gltf = await new Promise<GLTF>((resolve, reject) => {
      new GLTFLoader().parse(data, "", resolve, reject);
    });

    expect(catalog.sourceId).toBe("quaternius-universal-animation-standard");
    expect(catalog.clips.map((clip: { sourceClip: string }) => clip.sourceClip).sort())
      .toEqual(gltf.animations.map((clip) => clip.name).sort());
    expect(catalog.clips).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dance", sourceClip: "Dance_Loop" }),
      expect.objectContaining({ id: "jump", sourceClip: "Jump_Loop" }),
      expect.objectContaining({ id: "push", sourceClip: "Push_Loop" }),
      expect.objectContaining({ sourceClip: "Sword_Attack", prop: "sword" }),
      expect.objectContaining({ sourceClip: "Pistol_Shoot", prop: "pistol" }),
    ]));
    expect(["dance", "jump", "push"].map((id) =>
      catalog.clips.find((clip: { id: string }) => clip.id === id)?.prop
    )).toEqual([undefined, undefined, undefined]);

    const resolvePlayback = (directorUI as any).resolveDirectorAnnyMotionPlayback;
    expect(resolvePlayback({
      posePreset: "standing",
      activeActions: [{
        clip: {
          id: "dance-a",
          targetId: "actor-a",
          action: "dance",
          layer: "full-body",
          startTime: 0,
          durationSeconds: 3,
          blendInSeconds: 0.2,
          blendOutSeconds: 0.2,
          playbackRate: 1,
        },
        localTimeSeconds: 1.2,
        weight: 0.85,
      }],
      locomotionSpeed: 0,
      availableClipNames: ["Dance_Loop"],
      timeSeconds: 1.2,
    })).toEqual({
      base: {
        clipName: "Dance_Loop",
        localTimeSeconds: 1.2,
        weight: 0.85,
      },
    });
  });

  it("builds a reusable real-motion library for Anny", async () => {
    const createLibrary = (directorUI as any).createDirectorAnnyMotionClipLibrary;
    expect(createLibrary).toBeTypeOf("function");
    const [{ rig: anny }, { rig: source, animations }] = await Promise.all([
      loadRuntimeAnnyRig(),
      loadCasualMotionRig(),
    ]);
    const library = createLibrary({ target: anny, source, animations });
    const manifest = (directorUI as any).CLASH_HUMANOID_ACTION_LIBRARY_V1;

    expect(manifest).toMatchObject({
      id: "clash-humanoid-actions-v1",
      version: 1,
      profileId: "clash-humanoid-v1",
      sourceAssetId: "builtin:quaternius:casual-hoodie",
      sourceLicense: "CC0-1.0",
    });
    expect(manifest.actions.map((action: { id: string }) => action.id)).toEqual([
      "idle",
      "walk",
      "run",
      "sit",
      "crouch",
      "kneel",
      "wave",
      "interact",
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
    ]);
    expect(Object.keys(library.clips).sort()).toEqual([
      "Idle_Neutral",
      "Interact",
      "Run",
      "Walk",
      "Wave",
    ]);
    expect(Object.keys(library.lowerBodyClips).sort()).toEqual([
      "Idle_Neutral",
      "Interact",
      "Run",
      "Walk",
      "Wave",
    ]);
    expect(library.locomotionSpeeds.Walk).toBeGreaterThan(1);
    expect(library.locomotionSpeeds.Walk).toBeLessThan(2);
    expect(library.locomotionSpeeds.Run).toBeGreaterThan(library.locomotionSpeeds.Walk);
    expect(library.clips.Walk.tracks.length).toBeGreaterThan(10);
    expect(library.clips.Walk.tracks.every((track: { name: string }) => !/Hand\.quaternion$/.test(track.name))).toBe(true);
    expect(library.clips.Run.tracks.every((track: { name: string }) => !/Hand\.quaternion$/.test(track.name))).toBe(true);
    expect(library.clips.Wave.tracks.some((track: { name: string }) => /Hand\.quaternion$/.test(track.name))).toBe(true);
    expect(library.clips.Wave.tracks.every((track: { name: string }) => !/Right(?:Shoulder|Arm|ForeArm|Hand)/.test(track.name))).toBe(true);
    expect(library.clips.Interact.tracks.some((track: { name: string }) => /Arm\.quaternion$/.test(track.name))).toBe(true);
    expect(library.qaReports.Wave.issues).toEqual([]);
    expect(library.releaseReadyClipNames.sort()).toEqual([
      "Idle_Neutral",
      "Interact",
      "Walk",
      "Wave",
    ]);
    expect(library.qaReports.Walk.issues).toEqual([]);
    expect(library.qaReports.Interact.issues).toEqual([]);
    expect(library.qaReports.Run.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "foot-slide" }),
    ]));
  });

  it("retargets Sit, Crouch, and Kneel from the supplemental CC0 source", async () => {
    const createLibrary = (directorUI as any).createDirectorAnnyMotionClipLibrary;
    const [{ rig: anny }, primary, supplemental] = await Promise.all([
      loadRuntimeAnnyRig(),
      loadCasualMotionRig(),
      loadUniversalMotionRig(),
    ]);

    const library = createLibrary({
      target: anny,
      source: primary.rig,
      animations: primary.animations,
      supplementalSources: [{
        id: "quaternius-universal-animation-standard",
        source: supplemental.rig,
        animations: supplemental.animations,
      }],
    });
    expect(Object.keys(library.clips)).toEqual(expect.arrayContaining([
      "Sit",
      "Crouch",
      "Kneel",
      "Dance_Loop",
      "Jump_Loop",
      "Push_Loop",
      "Punch_Cross",
      "Driving_Loop",
    ]));
    for (const clipName of ["Sit", "Crouch", "Kneel"]) {
      const clip = library.clips[clipName];
      expect(clip.name).toBe(clipName);
      expect(clip.duration).toBeGreaterThan(0.8);
      expect(clip.tracks.some((track: { name: string }) => (
        /Hips\.quaternion$/.test(track.name)
      ))).toBe(true);
      expect(clip.tracks.every((track: { name: string }) => (
        !track.name.endsWith(".position")
      ))).toBe(true);
    }
    expect(Object.fromEntries(
      ["Sit", "Crouch", "Kneel"].map((clipName) => [
        clipName,
        library.qaReports[clipName].issues,
      ]),
    )).toEqual({
      Sit: [],
      Crouch: [],
      Kneel: [],
    });
    expect(library.releaseReadyClipNames).toEqual(expect.arrayContaining([
      "Sit",
      "Crouch",
      "Kneel",
      "Dance_Loop",
      "Jump_Loop",
      "Push_Loop",
      "Punch_Cross",
      "Driving_Loop",
    ]));
  });

  it("quarantines only the body-specific grounded posture combinations that fail QA", async () => {
    const createLibrary = (directorUI as any).createDirectorAnnyMotionClipLibrary;
    const [primary, supplemental] = await Promise.all([
      loadCasualMotionRig(),
      loadUniversalMotionRig(),
    ]);
    const failures: Array<{
      bodyType: string;
      clipName: string;
      issues: unknown[];
    }> = [];

    for (const bodyType of [
      "neutral",
      "masculine",
      "feminine",
      "broad",
      "athletic",
      "slender",
      "youth",
      "child",
      "chibi",
    ]) {
      const { rig: anny } = await loadRuntimeAnnyRig(bodyType);
      const library = createLibrary({
        target: anny,
        source: primary.rig,
        animations: primary.animations,
        supplementalSources: [{
          id: "quaternius-universal-animation-standard",
          source: supplemental.rig,
          animations: supplemental.animations,
        }],
      });

      for (const clipName of ["Sit", "Crouch", "Kneel"]) {
        const issues = library.qaReports[clipName].issues;
        if (issues.length > 0) failures.push({ bodyType, clipName, issues });
      }
    }
    expect(failures.map(({ bodyType, clipName, issues }) => ({
      bodyType,
      clipName,
      issueCodes: issues.map((issue: any) => `${issue.code}:${issue.region ?? ""}`),
    }))).toEqual([
      {
        bodyType: "masculine",
        clipName: "Sit",
        issueCodes: ["self-intersection:upper-leg"],
      },
      {
        bodyType: "athletic",
        clipName: "Kneel",
        issueCodes: ["self-intersection:torso"],
      },
      {
        bodyType: "slender",
        clipName: "Crouch",
        issueCodes: ["self-intersection:upper-leg"],
      },
      {
        bodyType: "slender",
        clipName: "Kneel",
        issueCodes: ["self-intersection:torso"],
      },
      {
        bodyType: "chibi",
        clipName: "Kneel",
        issueCodes: ["self-intersection:torso"],
      },
    ]);
  });

  it("keeps a QA-rejected Run clip out of automatic path locomotion", () => {
    const resolvePlayback = (directorUI as any).resolveDirectorAnnyMotionPlayback;
    expect(resolvePlayback({
      posePreset: "standing",
      activeActions: [],
      locomotionSpeed: 2,
      locomotionSpeeds: { Walk: 1.5, Run: 2.8 },
      availableClipNames: ["Idle_Neutral", "Interact", "Walk", "Wave"],
      timeSeconds: 1,
    })).toEqual({
      base: {
        clipName: "Walk",
        localTimeSeconds: 1.333333,
        playbackRate: 1.333333,
        weight: 1,
      },
    });
  });

  it("admits the real Anny GLB through the Clash Humanoid Rig v1 contract", async () => {
    const inspectHumanoidRig = (directorUI as any).inspectDirectorHumanoidRig;
    expect(inspectHumanoidRig).toBeTypeOf("function");
    const { rig: anny } = await loadRuntimeAnnyRig();

    const report = inspectHumanoidRig(anny);

    expect(report.profileId).toBe("clash-humanoid-v1");
    expect(report.compatible).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.boneMap).toMatchObject({
      hips: "mixamorigHips",
      spine: "mixamorigSpine",
      chest: "mixamorigSpine2",
      neck: "mixamorigNeck",
      head: "mixamorigHead",
      leftUpperArm: "mixamorigLeftArm",
      leftLowerArm: "mixamorigLeftForeArm",
      leftHand: "mixamorigLeftHand",
      rightUpperArm: "mixamorigRightArm",
      rightLowerArm: "mixamorigRightForeArm",
      rightHand: "mixamorigRightHand",
      leftUpperLeg: "mixamorigLeftUpLeg",
      leftLowerLeg: "mixamorigLeftLeg",
      leftFoot: "mixamorigLeftFoot",
      rightUpperLeg: "mixamorigRightUpLeg",
      rightLowerLeg: "mixamorigRightLeg",
      rightFoot: "mixamorigRightFoot",
    });
  });

  it("admits the CC0 Universal Animation GLB as a supplemental humanoid source", async () => {
    const prepareSource = (directorUI as any).prepareDirectorHumanoidSource;
    const bytes = readFileSync(
      new URL(
        "../assets/starter-library/motions/UAL1_Standard.glb",
        import.meta.url,
      ),
    );
    const data = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    const prepared = await prepareSource({
      fileName: "UAL1_Standard.glb",
      data,
      coordinates: {
        unitMeters: 1,
        upAxis: "+Y",
        forwardAxis: "+Z",
        handedness: "right",
      },
      requireAnimations: true,
    });

    expect(prepared.admitted).toBe(true);
    expect(prepared.issues).toEqual([]);
    expect(prepared.rig.boneMap).toMatchObject({
      hips: "pelvis",
      spine: "spine_01",
      chest: "spine_03",
      neck: "neck_01",
      leftLowerLeg: "calf_l",
      rightLowerLeg: "calf_r",
    });
    expect(prepared.animations.map((clip: { name: string }) => clip.name)).toEqual(
      expect.arrayContaining([
        "Sitting_Idle_Loop",
        "Crouch_Idle_Loop",
        "Fixing_Kneeling",
      ]),
    );
  });

  it("normalizes source units and axes into the Clash meter/Y-up/+Z-forward contract", () => {
    const normalizeSource = (directorUI as any).normalizeDirectorHumanoidSource;
    expect(normalizeSource).toBeTypeOf("function");
    const sourceRoot = new Group();
    const upMarker = new Object3D();
    upMarker.name = "up-marker";
    upMarker.position.set(0, 0, 100);
    const forwardMarker = new Object3D();
    forwardMarker.name = "forward-marker";
    forwardMarker.position.set(0, 100, 0);
    sourceRoot.add(upMarker, forwardMarker);

    const normalized = normalizeSource({
      root: sourceRoot,
      animations: [],
      coordinates: {
        unitMeters: 0.01,
        upAxis: "+Z",
        forwardAxis: "+Y",
        handedness: "right",
      },
    });
    normalized.root.updateWorldMatrix(true, true);

    expect(normalized.coordinates).toEqual({
      unitMeters: 1,
      upAxis: "+Y",
      forwardAxis: "+Z",
      handedness: "right",
    });
    expect(
      normalized.root.getObjectByName("up-marker")!.getWorldPosition(new Vector3()).toArray(),
    ).toEqual(expect.arrayContaining([
      expect.closeTo(0, 6),
      expect.closeTo(1, 6),
      expect.closeTo(0, 6),
    ]));
    expect(
      normalized.root.getObjectByName("forward-marker")!.getWorldPosition(new Vector3()).toArray(),
    ).toEqual(expect.arrayContaining([
      expect.closeTo(0, 6),
      expect.closeTo(0, 6),
      expect.closeTo(1, 6),
    ]));
  });

  it("parses real GLB plus ASCII FBX and BVH source formats through one offline boundary", async () => {
    const parseSource = (directorUI as any).parseDirectorHumanoidSource;
    expect(parseSource).toBeTypeOf("function");
    const glbBytes = readFileSync(new URL("../assets/anny-mpfb2/neutral.glb", import.meta.url));
    const glb = await parseSource({
      fileName: "neutral.glb",
      data: glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength),
    });
    expect(glb.format).toBe("glb");
    expect((directorUI as any).inspectDirectorHumanoidRig(glb.root).compatible).toBe(true);

    const fbxText = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
}
Objects:  {
\tModel: 1, "Model::Root", "Null" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t}
\t\tShading: T
\t\tCulling: "CullingOff"
\t}
}
Connections:  {
\tC: "OO",1,0
}
`;
    const fbx = await parseSource({
      fileName: "empty-test-rig.fbx",
      data: new TextEncoder().encode(fbxText).buffer,
    });
    expect(fbx.format).toBe("fbx");
    expect(fbx.root).toBeInstanceOf(Group);

    const bvhText = `HIERARCHY
ROOT Hips
{
 OFFSET 0 0 0
 CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
 JOINT Spine
 {
  OFFSET 0 10 0
  CHANNELS 3 Zrotation Xrotation Yrotation
  End Site
  {
   OFFSET 0 10 0
  }
 }
}
MOTION
Frames: 2
Frame Time: 0.0333333
0 0 0 0 0 0 0 0 0
0 0 0 0 0 0 0 0 0
`;
    const bvh = await parseSource({
      fileName: "walk-test.bvh",
      data: bvhText,
    });
    expect(bvh.format).toBe("bvh");
    expect(bvh.animations).toHaveLength(1);
    expect(bvh.root.getObjectByName("Hips")).toBeDefined();
    expect(bvh.root.getObjectByName("Spine")).toBeDefined();
  });

  it("admits and bone-maps the real CC0 motion source after offline normalization", async () => {
    const prepareSource = (directorUI as any).prepareDirectorHumanoidSource;
    expect(prepareSource).toBeTypeOf("function");
    const source = readFileSync(
      new URL("../assets/starter-library/models/Casual_Hoodie.gltf", import.meta.url),
      "utf8",
    );

    const prepared = await prepareSource({
      fileName: "Casual_Hoodie.gltf",
      data: source,
      coordinates: {
        unitMeters: 1,
        upAxis: "+Y",
        forwardAxis: "+Z",
        handedness: "right",
      },
      requireAnimations: true,
    });

    expect(prepared.admitted).toBe(true);
    expect(prepared.issues).toEqual([]);
    expect(prepared.rig.compatible).toBe(true);
    expect(prepared.rig.boneMap).toMatchObject({
      hips: "Hips",
      spine: "Abdomen",
      chest: "Chest",
      leftUpperArm: "UpperArmL",
      rightUpperArm: "UpperArmR",
      leftFoot: "FootL",
      rightFoot: "FootR",
    });
    expect(prepared.animations.map((clip: { name: string }) => clip.name)).toContain("Walk");
  });

  it("audits Walk arm-to-torso clearance across supported adult body shapes", async () => {
    const auditPose = (directorUI as any).auditDirectorHumanoidPose;
    const auditMotion = (directorUI as any).auditDirectorHumanoidMotion;
    const createLibrary = (directorUI as any).createDirectorAnnyMotionClipLibrary;
    expect(auditPose).toBeTypeOf("function");
    expect(auditMotion).toBeTypeOf("function");
    const { rig: source, animations } = await loadCasualMotionRig();

    for (const bodyType of [
      "neutral",
      "masculine",
      "feminine",
      "broad",
      "athletic",
      "slender",
    ]) {
      const { rig: anny } = await loadRuntimeAnnyRig(bodyType);
      const motionLibrary = createLibrary({ target: anny, source, animations });
      const walk = motionLibrary.clips.Walk;
      const mixer = new AnimationMixer(anny);
      const action = mixer.clipAction(walk).play();
      action.time = 2.2 % walk.duration;
      mixer.update(0);
      anny.updateWorldMatrix(true, true);

      const audit = auditPose(anny, { minimumArmClearanceRatio: 0.95 });
      expect(
        audit.issues,
        `${bodyType} failed humanoid pose QA`,
      ).toEqual([]);

      const motionAudit = auditMotion({
        root: anny,
        clip: walk,
        actorSpeedMetersPerSecond: motionLibrary.locomotionSpeeds.Walk,
        playbackRate: 1,
        sampleRate: 30,
        maximumMeanFootSlideMetersPerSecond: 0.25,
      });
      expect(motionAudit.sampleCount).toBeGreaterThanOrEqual(40);
      expect(motionAudit.metrics.leftFoot.plantedFrames).toBeGreaterThanOrEqual(5);
      expect(motionAudit.metrics.rightFoot.plantedFrames).toBeGreaterThanOrEqual(5);
      expect(motionAudit.metrics.leftFoot.meanSlideMetersPerSecond).toBeLessThan(0.25);
      expect(motionAudit.metrics.rightFoot.meanSlideMetersPerSecond).toBeLessThan(0.25);
      expect(motionAudit.metrics.contactHeightDeltaMeters).toBeLessThan(0.02);
      expect(
        motionAudit.issues,
        `${bodyType} failed humanoid motion QA`,
      ).toEqual([]);
    }
  });

  it("flags a hand that enters the same-side upper-leg envelope", async () => {
    const auditPose = (directorUI as any).auditDirectorHumanoidPose;
    const { rig: anny } = await loadRuntimeAnnyRig();
    const rightHand = anny.getObjectByName("mixamorigRightHand")!;
    const rightUpperLeg = anny.getObjectByName("mixamorigRightUpLeg")!;
    const rightLowerLeg = anny.getObjectByName("mixamorigRightLeg")!;
    anny.updateWorldMatrix(true, true);

    const thighCenter = rightUpperLeg
      .getWorldPosition(new Vector3())
      .lerp(rightLowerLeg.getWorldPosition(new Vector3()), 0.45);
    rightHand.position.copy(rightHand.parent!.worldToLocal(thighCenter));
    anny.updateWorldMatrix(true, true);

    expect(auditPose(anny).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "hand-lower-body-clearance",
        severity: "error",
        side: "right",
        joint: "hand",
        region: "upper-leg",
      }),
    ]));
  });

  it("rejects a Walk cycle whose actor speed would visibly slide planted feet", async () => {
    const auditMotion = (directorUI as any).auditDirectorHumanoidMotion;
    const createLibrary = (directorUI as any).createDirectorAnnyMotionClipLibrary;
    const [{ rig: anny }, { rig: source, animations }] = await Promise.all([
      loadRuntimeAnnyRig(),
      loadCasualMotionRig(),
    ]);
    const walk = createLibrary({ target: anny, source, animations }).clips.Walk;

    const audit = auditMotion({
      root: anny,
      clip: walk,
      actorSpeedMetersPerSecond: 0.4,
      playbackRate: 1,
      sampleRate: 30,
      maximumMeanFootSlideMetersPerSecond: 0.25,
    });

    expect(audit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "foot-slide",
        severity: "error",
      }),
    ]));
  });

  it("plays the real-motion library on Anny through AnimationMixer", () => {
    const source = readFileSync(new URL("./DirectorViewport.tsx", import.meta.url), "utf8");
    expect(source).toContain("createDirectorAnnyMotionClipLibrary");
    expect(source).toContain("resolveDirectorAnnyMotionPlayback");
    expect(source).toContain("new THREE.AnimationMixer(character)");
    expect(source).toContain("playback.upperBody");
    expect(source).toContain("motionLibrary.lowerBodyClips[playback.base.clipName]");
  });

  it("loads the supplemental CC0 action source in the real Anny viewport", () => {
    const source = readFileSync(new URL("./DirectorViewport.tsx", import.meta.url), "utf8");
    expect(source).toContain("assets/starter-library/motions/UAL1_Standard.glb");
    expect(source).toContain("supplementalSources");
    expect(source).toContain("quaternius-universal-animation-standard");
  });

  it("infers common action mappings from an uploaded rig's embedded clip names", () => {
    const inferRig = (directorUI as any).inferDirectorModelRig;
    expect(inferRig).toBeTypeOf("function");
    expect(inferRig({
      jointCount: 65,
      clipNames: ["mixamo.com", "Idle_Neutral", "Walking", "Running", "Wave_Hand", "Sitting"],
    })).toEqual({
      jointCount: 65,
      clipNames: ["mixamo.com", "Idle_Neutral", "Walking", "Running", "Wave_Hand", "Sitting"],
      actionMap: {
        idle: "Idle_Neutral",
        walk: "Walking",
        run: "Running",
        sit: "Sitting",
        wave: "Wave_Hand",
      },
    });
  });

  it("exports the shared panorama reference and calibration primitives", () => {
    expect((directorUI as any).renderDirectorPanoramaReference).toBeTypeOf("function");
    expect((directorUI as any).directorPanoramaCalibrationCamera).toBeTypeOf("function");
    expect((directorUI as any).directorPanoramaEnvironmentRotation).toBeTypeOf("function");
  });

  it("ships nine distinct Anny MPFB2 skinned body meshes", () => {
    const bodyTypes = [
      "neutral",
      "masculine",
      "feminine",
      "broad",
      "athletic",
      "slender",
      "youth",
      "child",
      "chibi",
    ];
    const assetUrls = bodyTypes.map((bodyType) =>
      new URL(`../assets/anny-mpfb2/${bodyType}.glb`, import.meta.url)
    );
    expect(assetUrls.filter((url) => !existsSync(url))).toEqual([]);
    if (assetUrls.some((url) => !existsSync(url))) return;

    const hashes = new Set<string>();
    for (const [assetIndex, assetUrl] of assetUrls.entries()) {
      const bytes = readFileSync(assetUrl);
      hashes.add(createHash("sha256").update(bytes).digest("hex"));
      const jsonLength = bytes.readUInt32LE(12);
      const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
      expect(document.asset.generator).toContain("Clash Anny MPFB2");
      expect(document.extras).toMatchObject({
        source: "https://github.com/naver/anny",
        sourceVersion: "0.5",
        sourceTopology: "MPFB2 CC0",
        rig: "mixamo",
      });
      expect(document.skins?.[0]?.joints).toHaveLength(52);
      expect(document.meshes?.[0]?.primitives?.[0]?.attributes).toHaveProperty("JOINTS_0");
      expect(document.meshes?.[0]?.primitives?.[0]?.attributes).toHaveProperty("WEIGHTS_0");
      expect(document.meshes?.[0]?.primitives?.[0]?.targets).toHaveLength(2);
      expect(document.meshes?.[0]?.extras?.targetNames).toEqual(["Thin", "Full"]);
      for (const target of document.meshes[0].primitives[0].targets) {
        expect(document.accessors[target.POSITION].min).toHaveLength(3);
        expect(document.accessors[target.POSITION].max).toHaveLength(3);
      }
      expect(document.extras.bodyShapeRange).toMatchObject({
        min: -1,
        natural: 0,
        max: 1,
      });
      expect(document.extras.bodyShapeRange.thinWeight).toBeGreaterThanOrEqual(0.15);
      expect(document.extras.bodyShapeRange.fullWeight).toBeLessThanOrEqual(0.95);
      if (bodyTypes[assetIndex] === "broad") {
        expect(document.extras.phenotype.weight).toBeGreaterThan(0.5);
        expect(document.extras.phenotype.weight).toBeLessThan(1);
      }

      const binaryStart = 20 + jsonLength + 8;
      const inverseAccessor = document.accessors[document.skins[0].inverseBindMatrices];
      const inverseView = document.bufferViews[inverseAccessor.bufferView];
      const inverseStart = binaryStart + (inverseView.byteOffset ?? 0) + (inverseAccessor.byteOffset ?? 0);
      const parentByNode = new Map<number, number>();
      document.nodes.forEach((node: { children?: number[] }, parent: number) => {
        node.children?.forEach((child) => parentByNode.set(child, parent));
      });
      const globals = new Map<number, Matrix4>();
      const globalMatrix = (nodeIndex: number): Matrix4 => {
        const cached = globals.get(nodeIndex);
        if (cached) return cached;
        const local = new Matrix4().fromArray(document.nodes[nodeIndex].matrix);
        const parent = parentByNode.get(nodeIndex);
        const global = parent === undefined
          ? local
          : globalMatrix(parent).clone().multiply(local);
        globals.set(nodeIndex, global);
        return global;
      };
      document.skins[0].joints.forEach((nodeIndex: number, jointIndex: number) => {
        const values = Array.from({ length: 16 }, (_, component) =>
          bytes.readFloatLE(inverseStart + (jointIndex * 16 + component) * 4)
        );
        const bindIdentity = globalMatrix(nodeIndex)
          .clone()
          .multiply(new Matrix4().fromArray(values));
        const maxError = Math.max(
          ...bindIdentity.elements.map((value, index) =>
            Math.abs(value - (index % 5 === 0 ? 1 : 0))
          ),
        );
        expect(maxError).toBeLessThan(1e-4);
      });
    }
    expect(hashes).toHaveLength(bodyTypes.length);
  });

  it("applies semantic pose presets to the real Anny rig", () => {
    const rig = loadAnnyRig();

    applyDirectorMannequinPose(rig, DIRECTOR_MANNEQUIN_POSE_PRESETS.standing);
    const standing = readDirectorMannequinSkeleton(rig);
    expect(standing.leftHand.y).toBeLessThan(standing.leftArm.y - 0.35);
    expect(standing.rightHand.y).toBeLessThan(standing.rightArm.y - 0.35);

    applyDirectorMannequinPose(rig, DIRECTOR_MANNEQUIN_POSE_PRESETS["t-pose"]);
    const tPose = readDirectorMannequinSkeleton(rig);
    expect(Math.abs(tPose.leftHand.y - tPose.leftArm.y)).toBeLessThan(0.08);
    expect(Math.abs(tPose.rightHand.y - tPose.rightArm.y)).toBeLessThan(0.08);
    expect(tPose.leftHand.x - tPose.leftArm.x).toBeGreaterThan(0.4);
    expect(tPose.rightArm.x - tPose.rightHand.x).toBeGreaterThan(0.4);

    applyDirectorMannequinPose(rig, DIRECTOR_MANNEQUIN_POSE_PRESETS.waving);
    const waving = readDirectorMannequinSkeleton(rig);
    expect(waving.rightHand.y).toBeGreaterThan(waving.rightArm.y + 0.25);
  });

  it("reads a complete bound skeleton for the viewport overlay", () => {
    const skeleton = readDirectorMannequinSkeleton(loadAnnyRig());
    expect(Object.keys(skeleton)).toEqual(expect.arrayContaining([
      "head",
      "neck",
      "torso",
      "pelvis",
      "leftShoulder",
      "leftArm",
      "leftForearm",
      "leftHand",
      "rightShoulder",
      "rightArm",
      "rightForearm",
      "rightHand",
      "leftLeg",
      "leftCalf",
      "leftFoot",
      "rightLeg",
      "rightCalf",
      "rightFoot",
    ]));
    expect(Object.values(skeleton).every((point) => Number.isFinite(point.length()))).toBe(true);
  });

  it("keeps its bound bone index when the renderer owns the rig children", () => {
    const rig = loadAnnyRig();
    const rendererOwnedRoots = [...rig.children];
    rendererOwnedRoots.forEach((root) => rig.remove(root));
    rig.userData = {};

    applyDirectorMannequinPose(rig, DIRECTOR_MANNEQUIN_POSE_PRESETS["t-pose"]);
    const skeleton = readDirectorMannequinSkeleton(rig);
    expect(skeleton.leftHand.x - skeleton.leftArm.x).toBeGreaterThan(0.4);
    expect(skeleton.rightArm.x - skeleton.rightHand.x).toBeGreaterThan(0.4);
  });

  it("binds the bone names sanitized by Three GLTFLoader", () => {
    const rig = loadAnnyRig("neutral", true);
    applyDirectorMannequinPose(rig, DIRECTOR_MANNEQUIN_POSE_PRESETS["t-pose"]);
    const skeleton = readDirectorMannequinSkeleton(rig);
    expect(skeleton.leftHand.x - skeleton.leftArm.x).toBeGreaterThan(0.4);
    expect(skeleton.rightArm.x - skeleton.rightHand.x).toBeGreaterThan(0.4);
  });

  it("deforms the real Anny skin together with a T-pose", async () => {
    const { rig, mesh } = await loadRuntimeAnnyRig();
    applyDirectorMannequinPose(rig, DIRECTOR_MANNEQUIN_POSE_PRESETS.standing);
    const standingWidth = skinnedWidth(rig, mesh);
    applyDirectorMannequinPose(rig, DIRECTOR_MANNEQUIN_POSE_PRESETS["t-pose"]);
    const tPoseWidth = skinnedWidth(rig, mesh);
    expect(tPoseWidth).toBeGreaterThan(standingWidth * 1.2);
  });

  it("turns a moving standing mannequin into a reversible walk cycle", () => {
    const pose = { preset: "standing", joints: {} };
    const firstStep = animateDirectorMannequinWalkCycle(pose, 0.25, 1);
    const secondStep = animateDirectorMannequinWalkCycle(pose, 0.5, 1);
    expect(firstStep.joints.leftLeg?.[0]).toBeLessThan(0);
    expect(firstStep.joints.rightLeg?.[0]).toBeGreaterThan(0);
    expect(secondStep.joints.leftLeg?.[0]).toBeGreaterThan(0);
    expect(secondStep.joints.rightLeg?.[0]).toBeLessThan(0);
  });

  it("keeps the procedural walk phase attached to traveled distance", () => {
    const pose = { preset: "standing", joints: {} };
    const beforeSeek = animateDirectorMannequinWalkCycle(pose, 0.1, 1.2, 1.3);
    const afterSeek = animateDirectorMannequinWalkCycle(pose, 7.4, 1.2, 1.3);
    expect(afterSeek).toEqual(beforeSeek);
  });

  it("does not override a manual mannequin pose with automatic locomotion", () => {
    const pose = {
      preset: "custom",
      joints: { rightArm: [0.2, 0.1, -0.4] as [number, number, number] },
    };
    expect(animateDirectorMannequinWalkCycle(pose, 0.25, 1)).toBe(pose);
    expect(animateDirectorMannequinWalkCycle({ preset: "standing", joints: {} }, 0.25, 0)).toEqual({
      preset: "standing",
      joints: {},
    });
  });

  it("layers an upper-body action over path-driven walking", () => {
    const evaluateActionPose = (directorUI as any).evaluateDirectorMannequinActionPose;
    expect(evaluateActionPose).toBeTypeOf("function");
    const basePose = { preset: "standing", joints: {} };
    const walking = animateDirectorMannequinWalkCycle(basePose, 0.25, 1);
    const performed = evaluateActionPose({
      basePose,
      timeSeconds: 0.25,
      locomotionSpeed: 1,
      activeActions: [{
        clip: {
          id: "wave-a",
          targetId: "actor-a",
          action: "wave",
          layer: "upper-body",
          startTime: 0,
          durationSeconds: 2,
          blendInSeconds: 0,
          blendOutSeconds: 0,
          playbackRate: 1,
        },
        localTimeSeconds: 0.25,
        weight: 1,
      }],
    });

    expect(performed.joints.leftLeg).toEqual(walking.joints.leftLeg);
    expect(performed.joints.rightLeg).toEqual(walking.joints.rightLeg);
    expect(Math.abs(performed.joints.rightArm?.[2] ?? 0)).toBeGreaterThan(1.2);
    expect(Math.abs(performed.joints.rightArm?.[2] ?? 0)).toBeLessThan(2.05);
  });

  it("articulates a relaxed wave through the torso, shoulder, elbow, and wrist", () => {
    const evaluateActionPose = (directorUI as any).evaluateDirectorMannequinActionPose;
    const activeActionsAt = (localTimeSeconds: number) => [{
      clip: {
        id: "wave-a",
        targetId: "actor-a",
        action: "wave" as const,
        layer: "upper-body" as const,
        startTime: 0,
        durationSeconds: 3,
        blendInSeconds: 0,
        blendOutSeconds: 0,
        playbackRate: 1,
      },
      localTimeSeconds,
      weight: 1,
    }];
    const poseAt = (localTimeSeconds: number) => evaluateActionPose({
      basePose: { preset: "standing", joints: {} },
      timeSeconds: localTimeSeconds,
      locomotionSpeed: 0,
      activeActions: activeActionsAt(localTimeSeconds),
    });

    const leftBeat = poseAt(0.18);
    const rightBeat = poseAt(0.54);
    const shoulderLift = leftBeat.joints.rightArm?.[2] ?? 0;
    expect(shoulderLift).toBeGreaterThan(-2.05);
    expect(shoulderLift).toBeLessThan(-1.2);
    expect(Math.abs(
      shoulderLift - (rightBeat.joints.rightArm?.[2] ?? 0),
    )).toBeGreaterThan(0.04);
    expect(Math.abs(leftBeat.joints.torso?.[1] ?? 0)).toBeGreaterThan(0.01);
    expect(Math.abs(leftBeat.joints.head?.[1] ?? 0)).toBeGreaterThan(0.01);
    expect(Math.abs(
      (leftBeat.joints.rightForearm?.[1] ?? 0)
        - (rightBeat.joints.rightForearm?.[1] ?? 0),
    )).toBeGreaterThan(0.2);
  });

  it("keeps the Anny wave identity while driving its shoulder and hand bones", () => {
    const evaluateActionPose = (directorUI as any).evaluateDirectorMannequinActionPose;
    const pose = evaluateActionPose({
      basePose: { preset: "standing", joints: {} },
      timeSeconds: 1.3,
      locomotionSpeed: 0,
      activeActions: [{
        clip: {
          id: "wave-a",
          targetId: "actor-a",
          action: "wave",
          layer: "upper-body",
          startTime: 0,
          durationSeconds: 3,
          blendInSeconds: 0,
          blendOutSeconds: 0,
          playbackRate: 1,
        },
        localTimeSeconds: 1.3,
        weight: 1,
      }],
    });

    expect(pose.preset).toBe("custom");
    expect(pose.joints.rightShoulder).toBeDefined();
    expect(pose.joints.rightHand).toBeDefined();
  });

  it("keeps the clavicle settled while the upper arm performs the Anny wave", () => {
    const evaluateActionPose = (directorUI as any).evaluateDirectorMannequinActionPose;
    const rig = loadAnnyRig();
    const shoulder = rig.getObjectByName("mixamorig:RightShoulder");
    const upperArm = rig.getObjectByName("mixamorig:RightArm");
    expect(shoulder).toBeDefined();
    expect(upperArm).toBeDefined();

    applyDirectorMannequinPose(rig, DIRECTOR_MANNEQUIN_POSE_PRESETS.standing);
    const settledShoulder = shoulder!.quaternion.clone();
    const settledArm = upperArm!.quaternion.clone();
    const pose = evaluateActionPose({
      basePose: { preset: "standing", joints: {} },
      timeSeconds: 1.3,
      locomotionSpeed: 0,
      activeActions: [{
        clip: {
          id: "wave-a",
          targetId: "actor-a",
          action: "wave",
          layer: "upper-body",
          startTime: 0,
          durationSeconds: 3,
          blendInSeconds: 0,
          blendOutSeconds: 0,
          playbackRate: 1,
        },
        localTimeSeconds: 1.3,
        weight: 1,
      }],
    });
    applyDirectorMannequinPose(rig, pose);

    expect(settledShoulder.angleTo(shoulder!.quaternion)).toBeLessThan(0.025);
    expect(settledArm.angleTo(upperArm!.quaternion)).toBeGreaterThan(0.6);
  });

  it("renders the Anny wave with a visibly bent elbow and raised wrist", () => {
    const evaluateActionPose = (directorUI as any).evaluateDirectorMannequinActionPose;
    const pose = evaluateActionPose({
      basePose: { preset: "standing", joints: {} },
      timeSeconds: 1.3,
      locomotionSpeed: 0,
      activeActions: [{
        clip: {
          id: "wave-a",
          targetId: "actor-a",
          action: "wave",
          layer: "upper-body",
          startTime: 0,
          durationSeconds: 3,
          blendInSeconds: 0,
          blendOutSeconds: 0,
          playbackRate: 1,
        },
        localTimeSeconds: 1.3,
        weight: 1,
      }],
    });
    const rig = loadAnnyRig();
    applyDirectorMannequinPose(rig, pose);
    const skeleton = readDirectorMannequinSkeleton(rig);
    const elbowToShoulder = skeleton.rightArm.clone().sub(skeleton.rightForearm);
    const elbowToWrist = skeleton.rightHand.clone().sub(skeleton.rightForearm);
    const elbowBend = elbowToShoulder.angleTo(elbowToWrist);

    expect(elbowBend).toBeGreaterThan(1.05);
    expect(elbowBend).toBeLessThan(2.35);
    expect(skeleton.rightHand.y).toBeGreaterThan(skeleton.rightForearm.y + 0.12);
  });

  it("distributes the Anny wave through the neck instead of hinging at the head", () => {
    const evaluateActionPose = (directorUI as any).evaluateDirectorMannequinActionPose;
    const pose = evaluateActionPose({
      basePose: { preset: "standing", joints: {} },
      timeSeconds: 1.3,
      locomotionSpeed: 0,
      activeActions: [{
        clip: {
          id: "wave-a",
          targetId: "actor-a",
          action: "wave",
          layer: "upper-body",
          startTime: 0,
          durationSeconds: 3,
          blendInSeconds: 0,
          blendOutSeconds: 0,
          playbackRate: 1,
        },
        localTimeSeconds: 1.3,
        weight: 1,
      }],
    });
    const rig = loadAnnyRig();
    applyDirectorMannequinPose(rig, DIRECTOR_MANNEQUIN_POSE_PRESETS.standing);
    const neck = rig.getObjectByName("mixamorig:Neck");
    const head = rig.getObjectByName("mixamorig:Head");
    expect(neck).toBeDefined();
    expect(head).toBeDefined();
    const standingNeck = neck!.quaternion.clone();
    const standingHead = head!.quaternion.clone();

    applyDirectorMannequinPose(rig, pose);
    const neckTurn = standingNeck.angleTo(neck!.quaternion);
    const headTurn = standingHead.angleTo(head!.quaternion);

    expect(pose.joints.neck).toBeDefined();
    expect(neckTurn).toBeGreaterThan(0.015);
    expect(headTurn).toBeGreaterThan(0.005);
    expect(neckTurn + headTurn).toBeLessThan(0.15);
    expect(Math.abs(neckTurn - headTurn)).toBeLessThan(0.05);
  });

  it("blends a full-body action over automatic locomotion", () => {
    const evaluateActionPose = (directorUI as any).evaluateDirectorMannequinActionPose;
    expect(evaluateActionPose).toBeTypeOf("function");
    const basePose = { preset: "standing", joints: {} };
    const walking = animateDirectorMannequinWalkCycle(basePose, 0.25, 1);
    const performed = evaluateActionPose({
      basePose,
      timeSeconds: 0.25,
      locomotionSpeed: 1,
      activeActions: [{
        clip: {
          id: "sit-a",
          targetId: "actor-a",
          action: "sit",
          layer: "full-body",
          startTime: 0,
          durationSeconds: 2,
          blendInSeconds: 0.5,
          blendOutSeconds: 0,
          playbackRate: 1,
        },
        localTimeSeconds: 0.25,
        weight: 0.5,
      }],
    });

    expect(performed.joints.leftLeg?.[0]).toBeCloseTo(
      ((walking.joints.leftLeg?.[0] ?? 0) - Math.PI / 2) / 2,
    );
    expect(performed.joints.rightLeg?.[0]).toBeCloseTo(
      ((walking.joints.rightLeg?.[0] ?? 0) - Math.PI / 2) / 2,
    );
  });

  it("resolves persisted action clips into the mannequin runtime pose", () => {
    const resolveRuntimePose = (directorUI as any).resolveDirectorMannequinRuntimePose;
    expect(resolveRuntimePose).toBeTypeOf("function");
    const actor = {
      id: "actor-a",
      name: "Actor A",
      kind: "mannequin" as const,
      visible: true,
      transform: {
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
      mannequin: {
        bodyType: "neutral" as const,
        pose: { preset: "standing", joints: {} },
      },
    };
    const pose = resolveRuntimePose({
      object: actor,
      animation: {
        ...animation,
        actionClips: [{
          id: "wave-a",
          targetId: actor.id,
          action: "wave",
          layer: "upper-body",
          startTime: 0,
          durationSeconds: 4,
          blendInSeconds: 0,
          blendOutSeconds: 0,
          playbackRate: 1,
        }],
      },
      timeSeconds: 0.25,
      locomotionSpeed: 1,
    });

    expect(pose.joints.leftLeg?.[0]).not.toBe(0);
    expect(Math.abs(pose.joints.rightArm?.[2] ?? 0)).toBeGreaterThan(1.2);
    expect(Math.abs(pose.joints.rightArm?.[2] ?? 0)).toBeLessThan(2.05);
  });

  it("maps the documented Director Stage shortcuts without browser key ambiguity", () => {
    expect(directorShortcut({ key: "v" })).toEqual({ type: "mode", mode: "translate" });
    expect(directorShortcut({ key: "R" })).toEqual({ type: "mode", mode: "rotate" });
    expect(directorShortcut({ key: "s" })).toEqual({ type: "mode", mode: "scale" });
    expect(directorShortcut({ key: "x" })).toEqual({ type: "toggle-snap" });
    expect(directorShortcut({ key: "t" })).toEqual({ type: "view", view: "top" });
    expect(directorShortcut({ key: "y" })).toEqual({ type: "view", view: "front" });
    expect(directorShortcut({ key: "q" })).toEqual({ type: "view", view: "reset" });
    expect(directorShortcut({ key: "Delete" })).toEqual({ type: "delete" });
    expect(directorShortcut({ key: "g", ctrlKey: true })).toEqual({ type: "group" });
    expect(directorShortcut({ key: "g", metaKey: true, shiftKey: true })).toEqual({ type: "ungroup" });
    expect(directorShortcut({ key: "z", metaKey: true })).toEqual({ type: "undo" });
  });

  it("preserves the drawing buffer only for headless frame capture", () => {
    expect(DIRECTOR_RENDERER_OPTIONS).toMatchObject({
      antialias: true,
      preserveDrawingBuffer: false,
      alpha: false,
    });
    expect(DIRECTOR_CAPTURE_RENDERER_OPTIONS).toEqual({
      ...DIRECTOR_RENDERER_OPTIONS,
      preserveDrawingBuffer: true,
    });
  });

  it("prefers a real WebM codec supported by the browser recorder", () => {
    expect(preferredDirectorVideoMimeType((type) => type.includes("vp9"))).toBe(
      "video/webm;codecs=vp9",
    );
    expect(preferredDirectorVideoMimeType((type) => type === "video/webm")).toBe(
      "video/webm",
    );
  });

  it("reuses Timeline's ruler and timing geometry with Director semantic tokens", () => {
    const html = renderToStaticMarkup(
      <DirectorKeyframeTimeline
        animation={animation}
        playheadSeconds={2}
        zoom={1}
        viewportWidth={900}
        targetLabels={{ "actor-a": "Actor A" }}
        onSeek={() => undefined}
      />,
    );

    expect(html).toContain('data-director-keyframe-timeline=""');
    expect(html).toContain('data-timeline-ruler=""');
    expect(html).toContain("var(--clash-director-timeline-surface)");
    expect(html).toContain("Actor A");
    expect(html).not.toContain(">actor-a<");
    expect(html).toContain('data-director-keyframe="start"');
  });

  it("clamps action clip move and trim edits to the timeline", () => {
    const editTiming = (directorUI as any).editDirectorActionClipTiming;
    expect(editTiming).toBeTypeOf("function");
    const clip = {
      id: "wave-a",
      targetId: "actor-a",
      action: "wave",
      layer: "upper-body",
      startTime: 2,
      durationSeconds: 3,
      blendInSeconds: 0.2,
      blendOutSeconds: 0.2,
      playbackRate: 1,
    };

    expect(editTiming({
      clip,
      mode: "move",
      deltaSeconds: 8,
      timelineDurationSeconds: 10,
      fps: 30,
    })).toEqual({ startTime: 7, durationSeconds: 3 });
    expect(editTiming({
      clip,
      mode: "trim-start",
      deltaSeconds: 1,
      timelineDurationSeconds: 10,
      fps: 30,
    })).toEqual({ startTime: 3, durationSeconds: 2 });
    expect(editTiming({
      clip,
      mode: "trim-end",
      deltaSeconds: -5,
      timelineDurationSeconds: 10,
      fps: 30,
    }).durationSeconds).toBeCloseTo(1 / 30);
  });

  it("snaps dragged keyframes to frames and clamps them to the shot duration", () => {
    const editKeyframeTime = (directorUI as any).editDirectorKeyframeTime;
    expect(editKeyframeTime).toBeTypeOf("function");
    expect(editKeyframeTime({
      originalTime: 1,
      deltaSeconds: 0.049,
      timelineDurationSeconds: 5,
      fps: 30,
    })).toBeCloseTo(1 + 1 / 30);
    expect(editKeyframeTime({
      originalTime: 4.9,
      deltaSeconds: 3,
      timelineDurationSeconds: 5,
      fps: 30,
    })).toBe(5);
  });

  it("renders user-authored action clips as selectable timeline blocks with trim handles", () => {
    const html = renderToStaticMarkup(
      <DirectorKeyframeTimeline
        animation={{
          ...animation,
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
          }, {
            id: "walk-a",
            targetId: "actor-a",
            action: "walk",
            layer: "full-body",
            startTime: 1,
            durationSeconds: 5,
            blendInSeconds: 0.2,
            blendOutSeconds: 0.2,
            playbackRate: 1,
          }],
        }}
        playheadSeconds={2}
        zoom={1}
        viewportWidth={900}
        targetLabels={{ "actor-a": "Actor A" }}
        selectedActionClipId="wave-a"
        onSeek={() => undefined}
      />,
    );

    expect(html).toContain('data-director-action-track="actor-a"');
    expect(html).toContain('data-director-action-lane="actor-a:full-body"');
    expect(html).toContain('data-director-action-lane="actor-a:upper-body"');
    expect(html).toContain('data-director-action-clip="wave-a"');
    expect(html).toContain('data-action-trim="start"');
    expect(html).toContain('data-action-trim="end"');
    expect(html).toContain("Wave");
    expect(html).toContain("Upper body");
  });

  it("renders story beats and camera cues as first-class timeline lanes", () => {
    const html = renderToStaticMarkup(
      <DirectorKeyframeTimeline
        animation={storyAnimation}
        playheadSeconds={1}
        zoom={1}
        viewportWidth={900}
        targetLabels={{ "actor-a": "Actor A", "camera-a": "Camera A" }}
        onSeek={() => undefined}
      />,
    );

    expect(html).toContain('data-director-story-beat="beat-arrival"');
    expect(html).toContain("I brought the letter.");
    expect(html).toContain('data-director-camera-cue="cue-opening"');
    expect(html).toContain("Opening push");
    expect(html).toContain(">Shots<");
    expect(html).toContain("camera cuts");
  });

  it("renders editable sequence shots as the canonical shot lane", () => {
    const editShotTiming = (directorUI as any).editDirectorSequenceShotTiming;
    expect(editShotTiming).toBeTypeOf("function");
    expect(editShotTiming({
      shot: {
        id: "shot-opening",
        name: "Opening push",
        cameraId: "camera-a",
        startTime: 1,
        durationSeconds: 4,
        aspectRatio: "16:9",
        transition: "cut",
      },
      mode: "trim-end",
      deltaSeconds: 1.04,
      timelineDurationSeconds: 10,
      fps: 30,
    })).toEqual({ startTime: 1, durationSeconds: 5.033333333333333 });

    const html = renderToStaticMarkup(
      <DirectorKeyframeTimeline
        animation={storyAnimation}
        shots={[{
          id: "shot-opening",
          name: "Opening push",
          cameraId: "camera-a",
          startTime: 0,
          durationSeconds: 4,
          aspectRatio: "16:9",
          transition: "dissolve",
        }]}
        playheadSeconds={1}
        zoom={1}
        viewportWidth={900}
        targetLabels={{ "camera-a": "Camera A" }}
        selectedShotId="shot-opening"
        onSeek={() => undefined}
      />,
    );

    expect(html).toContain('data-director-sequence-shot="shot-opening"');
    expect(html).toContain('data-shot-trim="start"');
    expect(html).toContain('data-shot-trim="end"');
    expect(html).toContain("Opening push");
    expect(html).toContain("Camera A");
    expect(html).toContain("Dissolve");
    expect(html).not.toContain('data-director-camera-cue="cue-opening"');
  });

  it("selects one, toggles, and range-selects ordered shots", () => {
    const updateSelection = (directorUI as any).updateDirectorShotSelection;
    expect(updateSelection).toBeTypeOf("function");

    const plain = updateSelection({
      orderedShotIds: ["shot-a", "shot-b", "shot-c", "shot-d"],
      selectedShotIds: [],
      clickedShotId: "shot-b",
    });
    expect(plain).toEqual({
      selectedShotIds: ["shot-b"],
      primaryShotId: "shot-b",
      anchorShotId: "shot-b",
    });

    const toggled = updateSelection({
      orderedShotIds: ["shot-a", "shot-b", "shot-c", "shot-d"],
      selectedShotIds: plain.selectedShotIds,
      clickedShotId: "shot-d",
      toggle: true,
      anchorShotId: plain.anchorShotId,
    });
    expect(toggled.selectedShotIds).toEqual(["shot-b", "shot-d"]);

    const range = updateSelection({
      orderedShotIds: ["shot-a", "shot-b", "shot-c", "shot-d"],
      selectedShotIds: toggled.selectedShotIds,
      clickedShotId: "shot-c",
      range: true,
      anchorShotId: "shot-a",
    });
    expect(range).toEqual({
      selectedShotIds: ["shot-a", "shot-b", "shot-c"],
      primaryShotId: "shot-c",
      anchorShotId: "shot-a",
    });
  });

  it("renders every selected shot while keeping one primary shot", () => {
    const html = renderToStaticMarkup(
      <DirectorKeyframeTimeline {...({
        animation: storyAnimation,
        shots: [{
          id: "shot-opening",
          name: "Opening push",
          cameraId: "camera-a",
          startTime: 0,
          durationSeconds: 2,
          aspectRatio: "16:9",
          transition: "cut",
        }, {
          id: "shot-reverse",
          name: "Reverse",
          cameraId: "camera-b",
          startTime: 2,
          durationSeconds: 2,
          aspectRatio: "16:9",
          transition: "cut",
        }],
        playheadSeconds: 1,
        zoom: 1,
        viewportWidth: 900,
        selectedShotIds: ["shot-opening", "shot-reverse"],
        primaryShotId: "shot-reverse",
        onSeek: () => undefined,
      } as any)} />,
    );

    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html).toContain('data-director-primary-shot="true"');
  });

  it("publishes action editing through the package type surface", () => {
    const publicTypes = readFileSync(new URL("./public-api.d.ts", import.meta.url), "utf8");
    for (const contract of [
      "selectedActionClipId?: string",
      "onSelectActionClip?",
      "onChangeActionClip?",
      "editDirectorActionClipTiming",
      "selectedShotId?: string",
      "onSelectShot?",
      "onChangeShot?",
      "editDirectorSequenceShotTiming",
      "resolveDirectorMannequinRuntimePose",
      "evaluateDirectorMannequinActionPose",
    ]) {
      expect(publicTypes).toContain(contract);
    }
  });

  it("uses the mature Three renderer primitives for controls, grids, models, and cameras", () => {
    const source = readFileSync(new URL("./DirectorViewport.tsx", import.meta.url), "utf8");
    const mannequinSource = readFileSync(new URL("./mannequin.ts", import.meta.url), "utf8");
    expect(source).toMatch(/from ["']@react-three\/fiber["']/);
    for (const primitive of [
      "TransformControls",
      "OrbitControls",
      "Grid",
      "GizmoHelper",
      "Gltf",
      "Line",
      "PerspectiveCamera",
    ]) {
      expect(source).toContain(primitive);
    }
    expect(source).toContain("preserveDrawingBuffer");
    expect(source).toContain("shadows={{ type: THREE.PCFShadowMap }}");
    expect(source).toContain("captureStream");
    expect(source).toContain("MediaRecorder");
    expect(source).toContain("recordCanvasVideo");
    expect(source).toContain("startTimeSeconds?: number");
    expect(source).toContain("startTimeSeconds + elapsed");
    expect(source).toContain("cameraPose");
    expect(source).toContain("DirectorRenderPalette");
    expect(source).toContain("resolveDirectorRenderPalette");
    expect(source).toContain("DirectorMotionPaths");
    expect(source).toContain("selectedCameraId");
    expect(source).toContain("directorCameraFocusPoint(camera, objects)");
    expect(source).toContain("shotCamera.lookAt");
    expect(source).toContain("ANNY_CHARACTER_ASSETS");
    for (const bodyType of [
      "neutral",
      "masculine",
      "feminine",
      "broad",
      "athletic",
      "slender",
      "youth",
      "child",
      "chibi",
    ]) {
      expect(source).toContain(`anny-mpfb2/${bodyType}.glb`);
    }
    expect(source).not.toContain("mannequinBodyScale");
    expect(source).not.toContain("QUATERNIUS_CHARACTER_ASSETS");
    expect(source).not.toContain("QUATERNIUS_OUTFIT_ASSETS");
    expect(source).not.toContain("quaternius-modular-character-outfits");
    expect(source).not.toContain("createHeadOnlyGeometry");
    expect(source).toContain("SkeletonUtils.clone");
    expect(source).toContain("material.map = null");
    expect(source).toContain("palette.mannequin");
    expect(source).toContain("DirectorSkeletonOverlay");
    expect(source).toContain("showSelectedSkeleton");
    expect(source).toContain("useGLTF");
    expect(source).toContain("useGLTF.preload");
    expect(source).toContain("useGLTF(ANNY_CHARACTER_ASSET_URLS)");
    expect(source).toContain("<AnnyAssetsReady>");
    expect(source).toContain("morphTargetInfluences");
    expect(source).toContain("object.mannequin.bodyShape");
    expect(source).not.toContain("ProceduralMannequinMesh");
    expect(source).toContain("useTexture");
    expect(source).toContain("EquirectangularReflectionMapping");
    expect(source).toContain("showEnvironmentBackground");
    expect(source).toContain("if (background) scene.background = texture");
    expect(source).toContain("scene.environment = texture");
    expect(source).toContain("scene.backgroundRotation.copy(rotation)");
    expect(source).toContain("scene.environmentRotation.copy(rotation)");
    expect(source).toContain("BoundedPanoramaProjection");
    expect(source).toContain("<boxGeometry");
    expect(source).toContain("THREE.BackSide");
    expect(source).toContain("panoramaTexture");
    expect(source).toContain("vWorldPosition - capturePosition");
    expect(source).toContain("directorPanoramaWorkingVolume");
    expect(source).toContain("finiteGridSize");
    expect(source).toContain("infiniteGrid={!workingVolume}");
    expect(source).toContain("workingVolume ? (");
    expect(source).toContain("if (!workingVolume)");
    expect(source).toContain("maxDistance={navigationMaxDistance}");
    expect(source).toContain("calibrationCamera");
    expect(source).toContain("position={calibrationCamera?.position ?? [8, 6, 10]}");
    expect(source).toContain("rotation={calibrationCamera?.rotation}");
    expect(source).toContain('enabled={viewMode === "director" && !calibrationCamera}');
    expect(source).not.toContain("<Environment files=");
    expect(mannequinSource).toContain("mixamorig:LeftArm");
    expect(mannequinSource).toContain("mixamorig:RightArm");
    expect(source).toContain("cellThickness={0.65}");
    expect(source).toContain("sectionThickness={1.2}");
    expect(source).not.toContain("cellColor={directorTokens.gridMinor}");
    expect(source).not.toContain('axisColors={["#ef4444", "#22c55e", "#3b82f6"]}');
  });

  it("keeps editor-only guides out of the camera render and captured shot", () => {
    const source = readFileSync(new URL("./DirectorViewport.tsx", import.meta.url), "utf8");
    expect(source).toContain('viewMode === "director" && (\n        <DirectorMotionPaths');
    expect(source).toContain('viewMode === "director" && state.scene.grid.visible');
    expect(source).toContain('viewMode === "director" && (\n        <GizmoHelper');
  });

  it("renders a procedural horse with gait motion and a semantic saddle socket", () => {
    const source = readFileSync(new URL("./DirectorViewport.tsx", import.meta.url), "utf8");
    expect(source).toContain("HorseMesh");
    expect(source).toContain("directorHorseGaitPose");
    expect(source).toContain('object.creature.species === "horse"');
    expect(source).toContain('directorSocket: "saddle"');
    expect(source).toContain("attachment.offset");
  });

  it("renders props, set pieces, vehicles, and practical lights as selectable scene objects", () => {
    const source = readFileSync(new URL("./DirectorViewport.tsx", import.meta.url), "utf8");
    for (const renderer of ["PropMesh", "SetPieceMesh", "VehicleMesh", "LightObject"]) {
      expect(source).toContain(renderer);
    }
    for (const light of ["<pointLight", "<spotLight", "<directionalLight"]) {
      expect(source).toContain(light);
    }
    expect(source).toContain('case "prop"');
    expect(source).toContain('case "set"');
    expect(source).toContain('case "vehicle"');
    expect(source).toContain('case "light"');
  });

  it("uses a riding base pose for saddle-mounted mannequins", () => {
    const runtimePose = (directorUI as any).resolveDirectorMannequinRuntimePose;
    expect(DIRECTOR_MANNEQUIN_POSE_PRESETS).toHaveProperty("riding");
    const pose = runtimePose({
      object: {
        id: "rider-a",
        name: "Rider A",
        kind: "mannequin",
        visible: true,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        attachment: {
          parentId: "horse-a",
          socket: "saddle",
          offset: { position: [0, 1.62, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
        mannequin: { bodyType: "neutral", pose: { preset: "standing", joints: {} } },
      },
      animation: undefined,
      timeSeconds: 0,
      locomotionSpeed: 0,
    });
    expect(pose.joints.leftLeg[0]).toBeLessThan(-1);
    expect(pose.joints.rightLeg[0]).toBeLessThan(-1);
  });
});
