import { LoroMap, type LoroDoc } from "loro-crdt";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ExecutablePluginJsonValueSchema } from "./plugin-json-value.js";
import { directorCodeRegistryError, DirectorCodeComponentRegistrySchema } from "./director-code.js";
import { agentReadToken } from "./agent-read-proof.js";
import { Canvas } from "./canvas-ops.js";
import { commitProjectMutation } from "./project-mutation.js";
import {
  replaceDraftActionAssetInputBindings,
  type DraftActionAssetInput,
} from "./action-asset-bindings.js";
export {
  DirectorReferencePacketSchema,
  DirectorReferenceShotSchema,
  DirectorReferenceStillSchema,
  DirectorReferenceVideoSchema,
  createDirectorReferencePacket,
  type CreateDirectorReferencePacketInput,
  type DirectorReferencePacket,
  type DirectorReferenceShot,
  type DirectorReferenceStill,
  type DirectorReferenceVideo,
} from "./director-reference.js";
import { DEFAULT_CANVAS_ID, ensureProjectCanvas } from "./project-workspace.js";

export const DirectorStageVector3Schema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);

export const DirectorStageTransformSchema = z.object({
  position: DirectorStageVector3Schema,
  rotation: DirectorStageVector3Schema,
  scale: DirectorStageVector3Schema,
});

export const DirectorStagePoseSchema = z.object({
  preset: z.string().min(1),
  joints: z.record(DirectorStageVector3Schema),
});

export const DirectorStageAttachmentSocketSchema = z.enum([
  "origin",
  "seat",
  "saddle",
]);

export const DirectorStageAttachmentSchema = z.object({
  parentId: z.string().min(1),
  socket: DirectorStageAttachmentSocketSchema,
  offset: DirectorStageTransformSchema,
});

const DirectorStageObjectBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  visible: z.boolean(),
  color: z.string().min(1).optional(),
  groupId: z.string().min(1).optional(),
  attachment: DirectorStageAttachmentSchema.optional(),
  transform: DirectorStageTransformSchema,
});

export const DirectorStagePropTypeSchema = z.enum([
  "chair",
  "table",
  "sofa",
  "crate",
  "barrel",
  "floor-lamp",
]);

export const DirectorStageSetTypeSchema = z.enum([
  "wall",
  "doorway",
  "window",
  "platform",
  "cyclorama",
  "tree",
  "rock",
]);

export const DirectorStageVehicleTypeSchema = z.enum([
  "car",
  "van",
  "motorcycle",
  "bicycle",
  "boat",
]);

export const DirectorStageLightTypeSchema = z.enum([
  "point",
  "spot",
  "directional",
]);

export const DirectorStageObjectSchema = z.discriminatedUnion("kind", [
  DirectorStageObjectBaseSchema.extend({
    kind: z.literal("code"),
    code: z.object({
      componentId: z.string().trim().min(1),
      parameters: z.record(ExecutablePluginJsonValueSchema),
    }).strict(),
  }),
  DirectorStageObjectBaseSchema.extend({
    kind: z.literal("mannequin"),
    mannequin: z.object({
      bodyType: z.enum([
        "neutral",
        "masculine",
        "feminine",
        "broad",
        "athletic",
        "slender",
        "youth",
        "child",
        "chibi",
      ]),
      bodyShape: z.number().finite().min(-1).max(1).optional(),
      pose: DirectorStagePoseSchema,
    }),
  }),
  DirectorStageObjectBaseSchema.extend({
    kind: z.literal("primitive"),
    primitive: z.object({
      shape: z.enum(["box", "sphere", "cylinder", "cone", "plane", "capsule", "torus", "stair", "arch"]),
    }),
  }),
  DirectorStageObjectBaseSchema.extend({
    kind: z.literal("creature"),
    creature: z.object({
      species: z.literal("horse"),
      build: z.enum(["warmblood", "draft", "pony"]),
      gait: z.enum(["auto", "idle", "walk", "trot", "gallop"]),
    }),
  }),
  DirectorStageObjectBaseSchema.extend({
    kind: z.literal("prop"),
    prop: z.object({ type: DirectorStagePropTypeSchema }),
  }),
  DirectorStageObjectBaseSchema.extend({
    kind: z.literal("set"),
    set: z.object({ type: DirectorStageSetTypeSchema }),
  }),
  DirectorStageObjectBaseSchema.extend({
    kind: z.literal("vehicle"),
    vehicle: z.object({ type: DirectorStageVehicleTypeSchema }),
  }),
  DirectorStageObjectBaseSchema.extend({
    kind: z.literal("light"),
    light: z.object({
      type: DirectorStageLightTypeSchema,
      intensity: z.number().finite().min(0).max(100),
      range: z.number().finite().positive().max(1000),
      angle: z.number().finite().min(0.05).max(Math.PI / 2),
    }),
  }),
  DirectorStageObjectBaseSchema.extend({
    kind: z.literal("crowd"),
    crowd: z.object({
      rows: z.number().int().min(1).max(50),
      columns: z.number().int().min(1).max(50),
      spacing: z.number().positive(),
      bodyType: z.enum(["neutral", "masculine", "feminine", "broad", "athletic", "slender"]),
    }),
  }),
  DirectorStageObjectBaseSchema.extend({
    kind: z.literal("model"),
    model: z.object({
      assetId: z.string().min(1),
      animation: z.object({
        jointCount: z.number().int().positive(),
        clipNames: z.array(z.string().min(1)).min(1),
        actionMap: z.record(z.string().min(1), z.string().min(1)),
      }).optional(),
    }),
  }),
]);

export const DirectorStageCameraSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: DirectorStageVector3Schema,
  rotation: DirectorStageVector3Schema,
  fov: z.number().min(1).max(179),
  targetObjectId: z.string().min(1).optional(),
  targetObjectIds: z.array(z.string().min(1)).min(1).optional(),
  targetOffset: DirectorStageVector3Schema.optional(),
  optics: z.object({
    projection: z.enum(["perspective", "orthographic"]),
    focalLengthMm: z.number().positive().max(1_000),
    sensorWidthMm: z.number().positive().max(1_000),
    sensorHeightMm: z.number().positive().max(1_000),
    focusDistanceM: z.number().nonnegative(),
    fStop: z.number().positive().max(128),
    shutterAngleDegrees: z.number().positive().max(360),
    iso: z.number().positive().max(1_000_000),
    nearClipM: z.number().positive(),
    farClipM: z.number().positive(),
  }).refine(
    (optics) => optics.farClipM > optics.nearClipM,
    { message: "Camera far clip must be greater than near clip" },
  ).optional(),
});

export const DirectorStageAspectRatioSchema = z.enum([
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "1:1",
]);

export const DirectorStageShotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cameraId: z.string().min(1),
  sequenceShotId: z.string().min(1).optional(),
  assetId: z.string().min(1),
  aspectRatio: DirectorStageAspectRatioSchema,
  stageRevisionId: z.string().min(1),
  createdAt: z.string().datetime(),
  timeSeconds: z.number().nonnegative().optional(),
});

export const DirectorStageCameraRigPathSchema = z.object({
  interpolation: z.enum(["linear", "catmull-rom"]),
  points: z.array(DirectorStageVector3Schema).min(2),
});

export const DirectorStageCameraRigOrientationSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("fixed-target"),
    target: DirectorStageVector3Schema,
  }),
  z.object({
    mode: z.literal("target-object"),
    objectId: z.string().min(1),
    offset: DirectorStageVector3Schema.optional(),
    sampling: z.enum(["shot-start", "live"]).default("shot-start"),
  }),
  z.object({
    mode: z.literal("keyed"),
    startRotation: DirectorStageVector3Schema,
    endRotation: DirectorStageVector3Schema,
  }),
]);

export const DirectorStageCameraRigLensSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("locked"),
    focalLengthMm: z.number().positive().max(1_000),
  }),
  z.object({
    mode: z.literal("animated"),
    startFocalLengthMm: z.number().positive().max(1_000),
    endFocalLengthMm: z.number().positive().max(1_000),
  }),
]);

export const DirectorStageCameraRigSchema = z.object({
  kind: z.enum(["dolly", "truck", "pedestal", "pan", "tilt", "orbit", "crane"]),
  settleInSeconds: z.number().nonnegative(),
  settleOutSeconds: z.number().nonnegative(),
  path: DirectorStageCameraRigPathSchema.optional(),
  orbit: z.object({
    pivot: DirectorStageVector3Schema,
    radius: z.number().positive(),
    height: z.number().finite(),
    startAngleDegrees: z.number().finite(),
    endAngleDegrees: z.number().finite(),
  }).optional(),
  orientation: DirectorStageCameraRigOrientationSchema,
  lens: DirectorStageCameraRigLensSchema,
  maxAngularVelocityDegPerSecond: z.number().positive().optional(),
  maxAngularAccelerationDegPerSecondSquared: z.number().positive().optional(),
}).superRefine((rig, context) => {
  if (rig.kind === "orbit" && !rig.orbit) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["orbit"],
      message: "Orbit camera rigs require physical orbit parameters",
    });
  } else if (rig.kind !== "orbit" && !rig.path) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["path"],
      message: "Non-orbit camera rigs require a camera path",
    });
  }
});

export const DirectorStageShotCompositionSchema = z.object({
  primarySubjectId: z.string().min(1),
  secondarySubjectIds: z.array(z.string().min(1)).optional(),
  headroomRatio: z.number().min(0).max(0.5),
  leadRoomRatio: z.number().min(0).max(0.5),
  minimumCameraDistanceM: z.number().positive(),
  minimumSubjectSeparationM: z.number().nonnegative(),
  axis: z.object({
    fromObjectId: z.string().min(1),
    toObjectId: z.string().min(1),
    cameraSide: z.enum(["left", "right"]),
  }).optional(),
});

export const DirectorStageSequenceShotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cameraId: z.string().min(1),
  startTime: z.number().nonnegative(),
  durationSeconds: z.number().positive(),
  aspectRatio: DirectorStageAspectRatioSchema,
  transition: z.enum(["cut", "dissolve"]).default("cut"),
  storyBeatIds: z.array(z.string().min(1)).optional(),
  actionClipIds: z.array(z.string().min(1)).optional(),
  cameraMove: z.object({
    preset: z.string().min(1),
    easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]),
    rig: DirectorStageCameraRigSchema.optional(),
  }).optional(),
  composition: DirectorStageShotCompositionSchema.optional(),
});

export const DirectorStageSignedAxisSchema = z.enum([
  "+X",
  "-X",
  "+Y",
  "-Y",
  "+Z",
  "-Z",
]);

export const DirectorStageMotionAssetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  assetId: z.string().min(1),
  sourceFormat: z.enum(["gltf", "glb", "fbx", "bvh"]),
  clipName: z.string().min(1),
  durationSeconds: z.number().positive().optional(),
  sourceRig: z.object({
    profileId: z.string().min(1),
    skeletonType: z.enum(["biped", "quadruped", "other"]),
    restPose: z.enum(["t-pose", "a-pose", "unknown"]),
    upAxis: DirectorStageSignedAxisSchema,
    forwardAxis: DirectorStageSignedAxisSchema,
    metersPerUnit: z.number().positive(),
    rootBone: z.string().min(1),
    hipsBone: z.string().min(1).optional(),
    boneMap: z.record(z.string().min(1), z.string().min(1)).optional(),
  }),
  tags: z.array(z.string().min(1)).optional(),
});

export const DirectorStageAnimationKeyframeSchema = z.object({
  id: z.string().min(1),
  time: z.number().nonnegative(),
  value: z.union([z.number(), DirectorStageVector3Schema]),
  interpolation: z.enum(["hold", "linear", "bezier"]).default("linear"),
});

export const DirectorStageAnimationTrackSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  property: z.enum([
    "position",
    "rotation",
    "scale",
    "fov",
    "focalLengthMm",
    "focusDistanceM",
    "fStop",
  ]),
  keyframes: z.array(DirectorStageAnimationKeyframeSchema),
});

export const DirectorStageActionNameSchema = z.enum([
  "idle",
  "walk",
  "run",
  "sit",
  "crouch",
  "kneel",
  "wave",
  "point",
  "think",
  "hands-up",
  "interact",
  "ride",
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

export const DirectorStageActionLayerSchema = z.enum([
  "full-body",
  "upper-body",
]);

export const DirectorStageActionClipSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  action: DirectorStageActionNameSchema,
  layer: DirectorStageActionLayerSchema.default("full-body"),
  startTime: z.number().nonnegative(),
  durationSeconds: z.number().positive(),
  blendInSeconds: z.number().nonnegative().default(0.2),
  blendOutSeconds: z.number().nonnegative().default(0.2),
  playbackRate: z.number().positive().default(1),
  motionAssetId: z.string().min(1).optional(),
  sourceStartSeconds: z.number().nonnegative().optional(),
  sourceDurationSeconds: z.number().positive().optional(),
  loopMode: z.enum(["once", "repeat", "hold"]).optional(),
  rootMotionMode: z.enum(["apply", "in-place", "extract"]).optional(),
  retargeting: z.object({
    mode: z.enum(["direct", "humanoid"]),
    targetRigProfileId: z.string().min(1),
  }).optional(),
});

export const DirectorStageStoryBeatSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  startTime: z.number().nonnegative(),
  durationSeconds: z.number().positive(),
  participantIds: z.array(z.string().min(1)).min(1),
  dialogue: z.object({
    speakerId: z.string().min(1),
    text: z.string().min(1),
  }).optional(),
});

export const DirectorStageCameraCueSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cameraId: z.string().min(1),
  startTime: z.number().nonnegative(),
  durationSeconds: z.number().positive(),
});

export const DirectorStageWorkingVolumePresetSchema = z.enum([
  "compact",
  "standard",
  "large",
  "custom",
]);

export const DirectorStageWorkingVolumeSchema = z.object({
  mode: z.literal("bounded-box"),
  preset: DirectorStageWorkingVolumePresetSchema,
  // Three uses X/Y/Z, so the stored order is width/height/depth.
  size: z.tuple([
    z.number().finite().positive().max(500),
    z.number().finite().positive().max(100),
    z.number().finite().positive().max(500),
  ]),
  // World-space center of the floor plane. The box center is derived at half height.
  origin: DirectorStageVector3Schema,
});

export const DirectorStageEnvironmentCalibrationSchema = z.object({
  projection: z.literal("equirectangular"),
  capturePosition: DirectorStageVector3Schema,
  captureRotation: DirectorStageVector3Schema,
  horizonV: z.number().min(0).max(1),
  forwardU: z.number().min(0).max(1),
  gridCellMeters: z.number().positive(),
  workingVolume: DirectorStageWorkingVolumeSchema.optional(),
});

export const DirectorStageStateSchema = z.object({
  schemaVersion: z.literal(1),
  scene: z.object({
    backgroundColor: z.string().min(1),
    /** Omission preserves existing scenes; false gives authored lights full control. */
    defaultLighting: z.boolean().optional(),
    environmentAssetId: z.string().min(1).optional(),
    environmentRotation: DirectorStageVector3Schema.optional(),
    environmentCalibration: DirectorStageEnvironmentCalibrationSchema.optional(),
    grid: z.object({
      visible: z.boolean(),
      snap: z.boolean(),
      size: z.number().positive(),
    }),
  }),
  objects: z.array(DirectorStageObjectSchema),
  /** Director-owned registry. Bodies stay in exact text.plain Document revisions. */
  codeComponents: DirectorCodeComponentRegistrySchema.optional(),
  cameras: z.array(DirectorStageCameraSchema),
  shots: z.array(DirectorStageShotSchema),
  shotSequence: z.array(DirectorStageSequenceShotSchema).optional(),
  motionAssets: z.array(DirectorStageMotionAssetSchema).optional(),
  activeCameraId: z.string().min(1).optional(),
  animation: z.object({
    durationSeconds: z.number().positive(),
    fps: z.number().int().positive(),
    tracks: z.array(DirectorStageAnimationTrackSchema),
    actionClips: z.array(DirectorStageActionClipSchema).optional(),
    storyBeats: z.array(DirectorStageStoryBeatSchema).optional(),
    cameraCues: z.array(DirectorStageCameraCueSchema).optional(),
  }).optional(),
});

const DIRECTOR_STAGE_CAPTURE_OUTPUT_ERROR =
  "Director Stage authoring state cannot contain capture outputs; use capture receipts and Project Asset references";

/**
 * Write contract for editable Stage state. `DirectorStageStateSchema` remains
 * the legacy read contract so projects created before capture receipts can be
 * opened and migrated without making Action outputs part of new revisions.
 */
export const DirectorStageAuthoringStateSchema = DirectorStageStateSchema.extend({
  shots: z.array(DirectorStageShotSchema).max(0, DIRECTOR_STAGE_CAPTURE_OUTPUT_ERROR),
});

export type DirectorStageSchemaContract = "state" | "object" | "camera";

const directorStageContractSchemas = {
  state: { schema: DirectorStageAuthoringStateSchema, name: "DirectorStageState" },
  object: { schema: DirectorStageObjectSchema, name: "DirectorStageObject" },
  camera: { schema: DirectorStageCameraSchema, name: "DirectorStageCamera" },
} as const;

const directorStageJsonSchemas = Object.fromEntries(
  Object.entries(directorStageContractSchemas).map(([contract, definition]) => [
    contract,
    zodToJsonSchema(definition.schema, {
      name: definition.name,
      target: "jsonSchema7",
    }),
  ]),
) as Record<DirectorStageSchemaContract, Record<string, unknown>>;

/**
 * Return the machine-readable projection generated beside the authoritative
 * Director Zod contract. MCP and other surfaces consume this instead of
 * maintaining a second schema copy.
 */
export function directorStageJsonSchema(
  contract: DirectorStageSchemaContract,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(directorStageJsonSchemas[contract])) as Record<string, unknown>;
}

export type DirectorStageVector3 = z.infer<typeof DirectorStageVector3Schema>;
export type DirectorStageTransform = z.infer<typeof DirectorStageTransformSchema>;
export type DirectorStageAttachmentSocket = z.infer<typeof DirectorStageAttachmentSocketSchema>;
export type DirectorStageAttachment = z.infer<typeof DirectorStageAttachmentSchema>;
export type DirectorStageObject = z.infer<typeof DirectorStageObjectSchema>;
export type DirectorStageCamera = z.infer<typeof DirectorStageCameraSchema>;
export type DirectorStageShot = z.infer<typeof DirectorStageShotSchema>;
export type DirectorStageSequenceShot = z.infer<typeof DirectorStageSequenceShotSchema>;
export type DirectorStageCameraRig = z.infer<typeof DirectorStageCameraRigSchema>;
export type DirectorStageShotComposition = z.infer<typeof DirectorStageShotCompositionSchema>;
export type DirectorStageMotionAsset = z.infer<typeof DirectorStageMotionAssetSchema>;
export type DirectorStageWorkingVolumePreset = z.infer<
  typeof DirectorStageWorkingVolumePresetSchema
>;
export type DirectorStageWorkingVolume = z.infer<typeof DirectorStageWorkingVolumeSchema>;
export type DirectorStageEnvironmentCalibration = z.infer<
  typeof DirectorStageEnvironmentCalibrationSchema
>;
export type DirectorStageActionName = z.infer<typeof DirectorStageActionNameSchema>;
export type DirectorStageActionLayer = z.infer<typeof DirectorStageActionLayerSchema>;
export type DirectorStageActionClip = z.infer<typeof DirectorStageActionClipSchema>;
export type DirectorStageStoryBeat = z.infer<typeof DirectorStageStoryBeatSchema>;
export type DirectorStageCameraCue = z.infer<typeof DirectorStageCameraCueSchema>;
export type DirectorStageState = z.infer<typeof DirectorStageStateSchema>;

export function createDefaultDirectorStageState(): DirectorStageState {
  return {
    schemaVersion: 1,
    scene: {
      backgroundColor: "#171816",
      grid: { visible: true, snap: false, size: 1 },
    },
    objects: [],
    cameras: [],
    shots: [],
  };
}

export type DirectorStageOwner =
  | { kind: "project" }
  | { kind: "canvas-action"; canvasId: string; actionNodeId: string };

export interface ProjectDirectorStage {
  id: string;
  name: string;
  owner: DirectorStageOwner;
  revisionId: string;
  state: DirectorStageState;
}

interface ProjectDirectorStageRevision {
  state: DirectorStageState;
  revisionId: string;
}

export type ProjectDirectorStageMutationResult =
  | { ok: true; stage: ProjectDirectorStage }
  | { ok: false; error: string };

export type DirectorStageObjectPatch = {
  name?: string;
  visible?: boolean;
  color?: string;
  bodyType?: Extract<DirectorStageObject, { kind: "mannequin" }>["mannequin"]["bodyType"];
  bodyShape?: number;
  groupId?: string;
  transform?: Partial<DirectorStageTransform>;
  pose?: z.infer<typeof DirectorStagePoseSchema>;
  creatureBuild?: Extract<DirectorStageObject, { kind: "creature" }>["creature"]["build"];
  creatureGait?: Extract<DirectorStageObject, { kind: "creature" }>["creature"]["gait"];
  propType?: Extract<DirectorStageObject, { kind: "prop" }>["prop"]["type"];
  setType?: Extract<DirectorStageObject, { kind: "set" }>["set"]["type"];
  vehicleType?: Extract<DirectorStageObject, { kind: "vehicle" }>["vehicle"]["type"];
  lightType?: Extract<DirectorStageObject, { kind: "light" }>["light"]["type"];
  lightIntensity?: number;
  lightRange?: number;
  lightAngle?: number;
};

export function directorDefaultAttachmentOffset(
  socket: DirectorStageAttachmentSocket,
): DirectorStageTransform {
  if (socket === "saddle") {
    return {
      position: [0, 1.62, -0.08],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };
  }
  if (socket === "seat") {
    return {
      position: [0, 0.78, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };
  }
  return {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

export type DirectorStageCameraPatch = Partial<Omit<DirectorStageCamera, "id">>;

export type DirectorStageCommand =
  | { op: "object.add"; object: DirectorStageObject }
  | { op: "object.addMany"; objects: DirectorStageObject[] }
  | { op: "object.update"; objectId: string; patch: DirectorStageObjectPatch }
  | { op: "object.remove"; objectId: string }
  | { op: "object.group"; objectIds: string[]; groupId: string }
  | { op: "object.ungroup"; groupId: string }
  | {
      op: "object.attach";
      objectId: string;
      parentId: string;
      socket: DirectorStageAttachmentSocket;
      offset?: DirectorStageTransform;
    }
  | { op: "object.detach"; objectId: string }
  | { op: "camera.add"; camera: DirectorStageCamera }
  | { op: "camera.update"; cameraId: string; patch: DirectorStageCameraPatch }
  | { op: "camera.remove"; cameraId: string }
  | {
      op: "sequence-shot.upsert";
      durationSeconds: number;
      fps: number;
      shot: z.input<typeof DirectorStageSequenceShotSchema>;
    }
  | { op: "sequence-shot.remove"; shotId: string }
  | { op: "motion.upsert"; motion: z.input<typeof DirectorStageMotionAssetSchema> }
  | { op: "motion.remove"; motionId: string }
  | {
      op: "scene.update";
      patch: {
        backgroundColor?: string;
        environmentAssetId?: string;
        environmentRotation?: DirectorStageVector3;
        environmentCalibration?: DirectorStageEnvironmentCalibration;
        grid?: Partial<DirectorStageState["scene"]["grid"]>;
      };
    }
  | {
      op: "keyframe.upsert";
      durationSeconds: number;
      fps: number;
      track: {
        id: string;
        targetId: string;
        property: z.infer<typeof DirectorStageAnimationTrackSchema>["property"];
      };
      keyframe: z.input<typeof DirectorStageAnimationKeyframeSchema>;
    }
  | { op: "keyframe.remove"; trackId: string; keyframeId: string }
  | {
      op: "action.upsert";
      durationSeconds: number;
      fps: number;
      clip: z.input<typeof DirectorStageActionClipSchema>;
    }
  | { op: "action.remove"; clipId: string };

export type ApplyDirectorStageCommandResult =
  | { ok: true; state: DirectorStageState }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function attachmentGraphError(objects: DirectorStageObject[]): string | undefined {
  const byId = new Map(objects.map((object) => [object.id, object]));
  for (const object of objects) {
    const attachment = object.attachment;
    if (!attachment) continue;
    const parent = byId.get(attachment.parentId);
    if (!parent) return `Attachment parent ${attachment.parentId} not found`;
    if (attachment.socket === "saddle") {
      if (parent.kind !== "creature" || parent.creature.species !== "horse") {
        return "Saddle attachments require a horse parent";
      }
      if (object.kind !== "mannequin") {
        return "Saddle attachments require a mannequin child";
      }
    }

    const visited = new Set([object.id]);
    let cursor: DirectorStageObject | undefined = parent;
    while (cursor) {
      if (visited.has(cursor.id)) return "Attachment would create a cycle";
      visited.add(cursor.id);
      cursor = cursor.attachment ? byId.get(cursor.attachment.parentId) : undefined;
    }
  }
  return undefined;
}

function isLoroMap(value: unknown): value is LoroMap {
  return value instanceof LoroMap || Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { get?: unknown }).get === "function" &&
    typeof (value as { set?: unknown }).set === "function" &&
    typeof (value as { entries?: unknown }).entries === "function",
  );
}

function stageField(raw: unknown, field: string): unknown {
  if (isLoroMap(raw)) return raw.get(field);
  return isRecord(raw) ? raw[field] : undefined;
}

function parseDirectorStage(id: string, raw: unknown): ProjectDirectorStage | null {
  if (!isRecord(raw) && !isLoroMap(raw)) return null;
  const nameValue = stageField(raw, "name");
  const ownerValue = stageField(raw, "owner");
  const ownerRecord = isRecord(ownerValue) ? ownerValue : {};
  const owner: DirectorStageOwner = ownerRecord.kind === "canvas-action" &&
    typeof ownerRecord.canvasId === "string" &&
    typeof ownerRecord.actionNodeId === "string"
      ? {
          kind: "canvas-action",
          canvasId: ownerRecord.canvasId,
          actionNodeId: ownerRecord.actionNodeId,
        }
      : { kind: "project" };
  const revisionValue = stageField(raw, "revision");
  if (!isRecord(revisionValue)) return null;
  const parsedState = DirectorStageStateSchema.safeParse(revisionValue.state);
  if (!parsedState.success) return null;
  const revisionId = typeof revisionValue.revisionId === "string"
    ? revisionValue.revisionId
    : projectDirectorStageRevisionId(id, parsedState.data);
  return {
    id,
    name: typeof nameValue === "string" && nameValue.trim() ? nameValue : "Untitled Director Stage",
    owner,
    revisionId,
    state: parsedState.data,
  };
}

function setDirectorStageFields(fields: LoroMap, stage: ProjectDirectorStage): void {
  fields.set("name", stage.name);
  fields.set("owner", stage.owner);
  fields.set("revision", {
    state: stage.state,
    revisionId: stage.revisionId,
  } satisfies ProjectDirectorStageRevision);
}

export function projectDirectorStageRevisionId(
  stageId: string,
  state: DirectorStageState,
): string {
  return agentReadToken({
    namespace: "director-stage-revision",
    subject: { stageId, state },
  });
}

export function projectDirectorStageReadToken(stage: ProjectDirectorStage): string {
  return agentReadToken({
    namespace: "director-stage",
    subject: {
      id: stage.id,
      name: stage.name,
      owner: stage.owner,
      revisionId: stage.revisionId,
      state: stage.state,
    },
  });
}

export function readProjectDirectorStage(
  doc: LoroDoc,
  stageId: string,
): ProjectDirectorStage | null {
  return parseDirectorStage(stageId, doc.getMap("directorStages").get(stageId));
}

export function listProjectDirectorStages(doc: LoroDoc): ProjectDirectorStage[] {
  const stages: ProjectDirectorStage[] = [];
  for (const [id, raw] of doc.getMap("directorStages").entries()) {
    const stage = parseDirectorStage(id, raw);
    if (stage) stages.push(stage);
  }
  return stages.sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

function projectDirectorActionId(
  stageId: string,
  owner: DirectorStageOwner,
): string {
  return owner.kind === "canvas-action"
    ? `node:${owner.actionNodeId}`
    : `director:${stageId}`;
}

function projectDirectorAssetInputs(
  state: DirectorStageState,
): DraftActionAssetInput[] {
  const inputs: DraftActionAssetInput[] = [];
  if (
    state.scene.environmentAssetId &&
    !state.scene.environmentAssetId.startsWith("builtin:")
  ) {
    inputs.push({
      slot: "director:environment",
      projectAssetId: state.scene.environmentAssetId,
      role: "source",
    });
  }
  for (const object of state.objects) {
    if (
      object.kind !== "model" ||
      object.model.assetId.startsWith("builtin:")
    ) {
      continue;
    }
    inputs.push({
      slot: `director:model:${object.id}`,
      projectAssetId: object.model.assetId,
      role: "source",
    });
  }
  const motionById = new Map(
    (state.motionAssets ?? []).map((motion) => [motion.id, motion]),
  );
  for (const clip of state.animation?.actionClips ?? []) {
    if (!clip.motionAssetId) continue;
    const motion = motionById.get(clip.motionAssetId);
    if (!motion || motion.assetId.startsWith("builtin:")) continue;
    inputs.push({
      slot: `director:action:${clip.id}:motion`,
      projectAssetId: motion.assetId,
      role: "source",
    });
  }
  return inputs;
}

function syncProjectDirectorAssetInputs(
  doc: LoroDoc,
  stage: Pick<ProjectDirectorStage, "id" | "owner" | "state">,
): Extract<ProjectDirectorStageMutationResult, { ok: false }> | undefined {
  const synced = replaceDraftActionAssetInputBindings(
    doc,
    projectDirectorActionId(stage.id, stage.owner),
    projectDirectorAssetInputs(stage.state),
  );
  return synced.ok ? undefined : { ok: false, error: synced.error };
}

function rehomeProjectDirectorAssetInputs(
  doc: LoroDoc,
  previous: Pick<ProjectDirectorStage, "id" | "owner" | "state">,
  next: Pick<ProjectDirectorStage, "id" | "owner" | "state">,
): Extract<ProjectDirectorStageMutationResult, { ok: false }> | undefined {
  const nextError = syncProjectDirectorAssetInputs(doc, next);
  if (nextError) return nextError;
  const previousActionId = projectDirectorActionId(previous.id, previous.owner);
  const nextActionId = projectDirectorActionId(next.id, next.owner);
  if (previousActionId === nextActionId) return undefined;
  const cleared = replaceDraftActionAssetInputBindings(
    doc,
    previousActionId,
    [],
  );
  return cleared.ok ? undefined : { ok: false, error: cleared.error };
}

export function createProjectDirectorStage(
  doc: LoroDoc,
  input: { id: string; name: string; state: unknown },
): ProjectDirectorStageMutationResult {
  const id = input.id.trim();
  const name = input.name.trim();
  if (!id) return { ok: false, error: "Director Stage id is required" };
  if (!name) return { ok: false, error: "Director Stage name is required" };
  const parsedState = DirectorStageAuthoringStateSchema.safeParse(input.state);
  if (!parsedState.success) {
    return { ok: false, error: parsedState.error.issues[0]?.message ?? "Invalid Director Stage state" };
  }
  const stages = doc.getMap("directorStages");
  if (stages.get(id)) return { ok: false, error: `Director Stage ${id} already exists` };
  const stage: ProjectDirectorStage = {
    id,
    name,
    owner: { kind: "project" },
    revisionId: projectDirectorStageRevisionId(id, parsedState.data),
    state: parsedState.data,
  };
  const bindingError = syncProjectDirectorAssetInputs(doc, stage);
  if (bindingError) return bindingError;
  setDirectorStageFields(stages.ensureMergeableMap(id), stage);
  return { ok: true, stage };
}

export function updateProjectDirectorStageState(
  doc: LoroDoc,
  stageId: string,
  state: unknown,
): ProjectDirectorStageMutationResult {
  const stage = readProjectDirectorStage(doc, stageId);
  if (!stage) return { ok: false, error: `Director Stage ${stageId} not found` };
  const parsedState = DirectorStageAuthoringStateSchema.safeParse(state);
  if (!parsedState.success) {
    return { ok: false, error: parsedState.error.issues[0]?.message ?? "Invalid Director Stage state" };
  }
  const next: ProjectDirectorStage = {
    ...stage,
    revisionId: projectDirectorStageRevisionId(stageId, parsedState.data),
    state: parsedState.data,
  };
  const bindingError = syncProjectDirectorAssetInputs(doc, next);
  if (bindingError) return bindingError;
  const fields = doc.getMap("directorStages").get(stageId);
  if (!isLoroMap(fields)) return { ok: false, error: `Director Stage ${stageId} not found` };
  fields.set("revision", {
    state: next.state,
    revisionId: next.revisionId,
  } satisfies ProjectDirectorStageRevision);
  return { ok: true, stage: next };
}

export type CreateDirectorStageOnCanvasInput = {
  id: string;
  name: string;
  state: unknown;
  canvasId: string;
  actionNodeId: string;
  position?: { x: number; y: number };
};

export function createDirectorStageOnCanvas(doc: LoroDoc, input: CreateDirectorStageOnCanvasInput): ProjectDirectorStageMutationResult {
  return commitProjectMutation(doc, (draft) => {
    const created = createProjectDirectorStage(draft, input);
    if (!created.ok) return created;
    return attachDirectorStageInDraft(draft, {
      stageId: input.id,
      canvasId: input.canvasId,
      actionNodeId: input.actionNodeId,
      position: input.position,
    });
  });
}

export function attachDirectorStageToCanvas(
  doc: LoroDoc,
  input: {
    stageId: string;
    canvasId: string;
    actionNodeId: string;
    position?: { x: number; y: number };
  },
): ProjectDirectorStageMutationResult {
  return commitProjectMutation(doc, (draft) => attachDirectorStageInDraft(draft, input));
}

function attachDirectorStageInDraft(
  doc: LoroDoc,
  input: {
    stageId: string;
    canvasId: string;
    actionNodeId: string;
    position?: { x: number; y: number };
  },
): ProjectDirectorStageMutationResult {
  const stage = readProjectDirectorStage(doc, input.stageId);
  if (!stage) return { ok: false, error: `Director Stage ${input.stageId} not found` };
  if (stage.owner.kind !== "project") {
    return {
      ok: false,
      error: `Director Stage ${input.stageId} is already owned by Canvas ${stage.owner.canvasId}`,
    };
  }
  const canvases = doc.getMap("canvases");
  if (input.canvasId === DEFAULT_CANVAS_ID && canvases.size === 0) ensureProjectCanvas(doc);
  if (!canvases.get(input.canvasId)) {
    return { ok: false, error: `Canvas ${input.canvasId} not found` };
  }
  if (doc.getMap("nodes").get(input.actionNodeId)) {
    return { ok: false, error: `Node ${input.actionNodeId} already exists` };
  }
  const fields = doc.getMap("directorStages").get(input.stageId);
  if (!isLoroMap(fields)) return { ok: false, error: `Director Stage ${input.stageId} not found` };
  const next: ProjectDirectorStage = {
    ...stage,
    owner: {
      kind: "canvas-action",
      canvasId: input.canvasId,
      actionNodeId: input.actionNodeId,
    },
  };
  const hostCanvas = new Canvas(doc, () => {}, input.canvasId);
  const view = hostCanvas.createNode(
    input.actionNodeId,
    "director-stage",
    { stageId: input.stageId, label: stage.name },
    input.position,
  );
  if (view.error) return { ok: false, error: view.error };
  const bindingError = rehomeProjectDirectorAssetInputs(doc, stage, next);
  if (bindingError) {
    hostCanvas.deleteNode(input.actionNodeId);
    return bindingError;
  }
  fields.set("owner", next.owner);
  return { ok: true, stage: next };
}

export interface DirectorStageOwnershipReconciliation {
  removedActionNodeIds: string[];
  detachedStageIds: string[];
}

function directorStageActionStageId(raw: unknown): string | undefined {
  if (!isRecord(raw) || raw.type !== "director-stage" || !isRecord(raw.data)) {
    return undefined;
  }
  return typeof raw.data.stageId === "string" ? raw.data.stageId : undefined;
}

function directorStageActionCanvasId(raw: unknown): string {
  return isRecord(raw) && typeof raw.canvasId === "string"
    ? raw.canvasId
    : DEFAULT_CANVAS_ID;
}

export function reconcileProjectDirectorStageOwnership(
  doc: LoroDoc,
): DirectorStageOwnershipReconciliation {
  const stages = new Map(
    listProjectDirectorStages(doc).map((stage) => [stage.id, stage]),
  );
  const nodes = doc.getMap("nodes");
  const removedActionNodeIds: string[] = [];

  for (const [nodeId, raw] of [...nodes.entries()]) {
    const stageId = directorStageActionStageId(raw);
    if (!stageId) continue;
    const stage = stages.get(stageId);
    if (!stage) continue;
    const canvasId = directorStageActionCanvasId(raw);
    const isWinningAction = stage.owner.kind === "canvas-action" &&
      stage.owner.actionNodeId === nodeId &&
      stage.owner.canvasId === canvasId;
    if (isWinningAction) continue;
    if (new Canvas(doc, () => {}, canvasId).deleteNode(nodeId)) {
      removedActionNodeIds.push(nodeId);
    }
  }

  const detachedStageIds: string[] = [];
  for (const stage of stages.values()) {
    if (stage.owner.kind !== "canvas-action") continue;
    const rawOwner = nodes.get(stage.owner.actionNodeId);
    const ownerMatches = directorStageActionStageId(rawOwner) === stage.id &&
      directorStageActionCanvasId(rawOwner) === stage.owner.canvasId;
    if (ownerMatches) continue;
    const fields = doc.getMap("directorStages").get(stage.id);
    if (isLoroMap(fields)) {
      const detached: ProjectDirectorStage = {
        ...stage,
        owner: { kind: "project" },
      };
      const bindingError = rehomeProjectDirectorAssetInputs(
        doc,
        stage,
        detached,
      );
      if (bindingError) throw new Error(bindingError.error);
      fields.set("owner", { kind: "project" });
      detachedStageIds.push(stage.id);
    }
  }

  return {
    removedActionNodeIds: removedActionNodeIds.sort(),
    detachedStageIds: detachedStageIds.sort(),
  };
}

export function applyDirectorStageCommand(
  state: unknown,
  command: DirectorStageCommand,
): ApplyDirectorStageCommandResult {
  if ((command as { op?: unknown }).op === "shot.register") {
    return {
      ok: false,
      error:
        "Director Stage capture outputs are external references and cannot be registered in Stage state",
    };
  }
  const parsedState = DirectorStageStateSchema.safeParse(state);
  if (!parsedState.success) {
    return { ok: false, error: parsedState.error.issues[0]?.message ?? "Invalid Director Stage state" };
  }
  const next = {
    ...structuredClone(parsedState.data),
    shots: [],
  };

  if (command.op === "object.add") {
    const object = DirectorStageObjectSchema.safeParse(command.object);
    if (!object.success) {
      return { ok: false, error: object.error.issues[0]?.message ?? "Invalid Director Stage object" };
    }
    if (next.objects.some((candidate) => candidate.id === object.data.id)) {
      return { ok: false, error: `Object ${object.data.id} already exists` };
    }
    next.objects.push(object.data);
    const attachmentError = attachmentGraphError(next.objects);
    if (attachmentError) return { ok: false, error: attachmentError };
  }

  if (command.op === "object.addMany") {
    if (command.objects.length === 0) return { ok: false, error: "At least one object is required" };
    const parsedObjects: DirectorStageObject[] = [];
    for (const candidate of command.objects) {
      const object = DirectorStageObjectSchema.safeParse(candidate);
      if (!object.success) {
        return { ok: false, error: object.error.issues[0]?.message ?? "Invalid Director Stage object" };
      }
      parsedObjects.push(object.data);
    }
    const ids = new Set(next.objects.map((object) => object.id));
    for (const object of parsedObjects) {
      if (ids.has(object.id)) return { ok: false, error: `Object ${object.id} already exists` };
      ids.add(object.id);
    }
    next.objects.push(...parsedObjects);
    const attachmentError = attachmentGraphError(next.objects);
    if (attachmentError) return { ok: false, error: attachmentError };
  }

  if (command.op === "object.update") {
    const objectIndex = next.objects.findIndex((candidate) => candidate.id === command.objectId);
    if (objectIndex < 0) return { ok: false, error: `Object ${command.objectId} not found` };
    const current = next.objects[objectIndex];
    const patch = command.patch;
    const raw: Record<string, unknown> = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.groupId !== undefined ? { groupId: patch.groupId } : {}),
      transform: {
        ...current.transform,
        ...(patch.transform ?? {}),
      },
    };
    if (patch.pose !== undefined || patch.bodyType !== undefined || patch.bodyShape !== undefined) {
      if (current.kind !== "mannequin") {
        return { ok: false, error: `Object ${command.objectId} does not support mannequin patches` };
      }
      raw.mannequin = {
        ...current.mannequin,
        ...(patch.bodyType !== undefined ? { bodyType: patch.bodyType } : {}),
        ...(patch.bodyShape !== undefined ? { bodyShape: patch.bodyShape } : {}),
        ...(patch.pose !== undefined ? { pose: patch.pose } : {}),
      };
    }
    if (patch.creatureBuild !== undefined || patch.creatureGait !== undefined) {
      if (current.kind !== "creature") {
        return { ok: false, error: `Object ${command.objectId} does not support creature patches` };
      }
      raw.creature = {
        ...current.creature,
        ...(patch.creatureBuild !== undefined ? { build: patch.creatureBuild } : {}),
        ...(patch.creatureGait !== undefined ? { gait: patch.creatureGait } : {}),
      };
    }
    if (patch.propType !== undefined) {
      if (current.kind !== "prop") {
        return { ok: false, error: `Object ${command.objectId} does not support prop patches` };
      }
      raw.prop = { ...current.prop, type: patch.propType };
    }
    if (patch.setType !== undefined) {
      if (current.kind !== "set") {
        return { ok: false, error: `Object ${command.objectId} does not support set patches` };
      }
      raw.set = { ...current.set, type: patch.setType };
    }
    if (patch.vehicleType !== undefined) {
      if (current.kind !== "vehicle") {
        return { ok: false, error: `Object ${command.objectId} does not support vehicle patches` };
      }
      raw.vehicle = { ...current.vehicle, type: patch.vehicleType };
    }
    if (
      patch.lightType !== undefined ||
      patch.lightIntensity !== undefined ||
      patch.lightRange !== undefined ||
      patch.lightAngle !== undefined
    ) {
      if (current.kind !== "light") {
        return { ok: false, error: `Object ${command.objectId} does not support light patches` };
      }
      raw.light = {
        ...current.light,
        ...(patch.lightType !== undefined ? { type: patch.lightType } : {}),
        ...(patch.lightIntensity !== undefined ? { intensity: patch.lightIntensity } : {}),
        ...(patch.lightRange !== undefined ? { range: patch.lightRange } : {}),
        ...(patch.lightAngle !== undefined ? { angle: patch.lightAngle } : {}),
      };
    }
    const updated = DirectorStageObjectSchema.safeParse(raw);
    if (!updated.success) {
      return { ok: false, error: updated.error.issues[0]?.message ?? "Invalid Director Stage object patch" };
    }
    next.objects[objectIndex] = updated.data;
  }

  if (command.op === "object.group") {
    const ids = new Set(command.objectIds);
    const missing = command.objectIds.find((id) => !next.objects.some((object) => object.id === id));
    if (missing) return { ok: false, error: `Object ${missing} not found` };
    if (!command.groupId.trim()) return { ok: false, error: "Group id is required" };
    next.objects = next.objects.map((object) =>
      ids.has(object.id) ? { ...object, groupId: command.groupId } : object,
    );
  }

  if (command.op === "object.ungroup") {
    next.objects = next.objects.map((object) => {
      if (object.groupId !== command.groupId) return object;
      const { groupId: _groupId, ...ungrouped } = object;
      return ungrouped as DirectorStageObject;
    });
  }

  if (command.op === "object.attach") {
    const objectIndex = next.objects.findIndex((object) => object.id === command.objectId);
    if (objectIndex < 0) return { ok: false, error: `Object ${command.objectId} not found` };
    if (!next.objects.some((object) => object.id === command.parentId)) {
      return { ok: false, error: `Object ${command.parentId} not found` };
    }
    const attachment = DirectorStageAttachmentSchema.safeParse({
      parentId: command.parentId,
      socket: command.socket,
      offset: command.offset ?? directorDefaultAttachmentOffset(command.socket),
    });
    if (!attachment.success) {
      return { ok: false, error: attachment.error.issues[0]?.message ?? "Invalid attachment" };
    }
    next.objects[objectIndex] = {
      ...next.objects[objectIndex],
      attachment: attachment.data,
    } as DirectorStageObject;
    const attachmentError = attachmentGraphError(next.objects);
    if (attachmentError) return { ok: false, error: attachmentError };
  }

  if (command.op === "object.detach") {
    const objectIndex = next.objects.findIndex((object) => object.id === command.objectId);
    if (objectIndex < 0) return { ok: false, error: `Object ${command.objectId} not found` };
    const current = next.objects[objectIndex];
    if (!current.attachment) return { ok: false, error: `Object ${command.objectId} is not attached` };
    const { attachment: _attachment, ...detached } = current;
    next.objects[objectIndex] = detached as DirectorStageObject;
  }

  if (command.op === "object.remove") {
    if (!next.objects.some((object) => object.id === command.objectId)) {
      return { ok: false, error: `Object ${command.objectId} not found` };
    }
    next.objects = next.objects
      .filter((object) => object.id !== command.objectId)
      .map((object) => {
        if (object.attachment?.parentId !== command.objectId) return object;
        const { attachment: _attachment, ...detached } = object;
        return detached as DirectorStageObject;
      });
    next.cameras = next.cameras.map((camera) => {
      const remainingTargetObjectIds = camera.targetObjectIds?.filter(
        (targetId) => targetId !== command.objectId,
      );
      if (
        camera.targetObjectId !== command.objectId &&
        remainingTargetObjectIds?.length === camera.targetObjectIds?.length
      ) {
        return camera;
      }
      const {
        targetObjectId: _targetObjectId,
        targetObjectIds: _targetObjectIds,
        targetOffset: _targetOffset,
        ...unbound
      } = camera;
      return {
        ...unbound,
        ...(camera.targetObjectId !== command.objectId
          ? { targetObjectId: camera.targetObjectId }
          : {}),
        ...(remainingTargetObjectIds?.length
          ? { targetObjectIds: remainingTargetObjectIds }
          : {}),
        ...(
          camera.targetObjectId !== command.objectId || remainingTargetObjectIds?.length
            ? { targetOffset: camera.targetOffset }
            : {}
        ),
      };
    });
    if (next.animation) {
      next.animation.tracks = next.animation.tracks.filter(
        (track) => track.targetId !== command.objectId,
      );
      next.animation.actionClips = next.animation.actionClips?.filter(
        (clip) => clip.targetId !== command.objectId,
      );
      next.animation.storyBeats = next.animation.storyBeats
        ?.filter((beat) => beat.dialogue?.speakerId !== command.objectId)
        .map((beat) => ({
          ...beat,
          participantIds: beat.participantIds.filter(
            (participantId) => participantId !== command.objectId,
          ),
        }))
        .filter((beat) => beat.participantIds.length > 0);
    }
  }

  if (command.op === "camera.add") {
    const camera = DirectorStageCameraSchema.safeParse(command.camera);
    if (!camera.success) {
      return { ok: false, error: camera.error.issues[0]?.message ?? "Invalid Director Stage camera" };
    }
    if (next.cameras.some((candidate) => candidate.id === camera.data.id)) {
      return { ok: false, error: `Camera ${camera.data.id} already exists` };
    }
    if (
      camera.data.targetObjectId &&
      !next.objects.some((object) => object.id === camera.data.targetObjectId)
    ) {
      return {
        ok: false,
        error: `Camera ${camera.data.id} targets missing object ${camera.data.targetObjectId}`,
      };
    }
    const missingGroupTarget = camera.data.targetObjectIds?.find(
      (targetId) => !next.objects.some((object) => object.id === targetId),
    );
    if (missingGroupTarget) {
      return {
        ok: false,
        error: `Camera ${camera.data.id} targets missing object ${missingGroupTarget}`,
      };
    }
    next.cameras.push(camera.data);
  }

  if (command.op === "camera.update") {
    const cameraIndex = next.cameras.findIndex((candidate) => candidate.id === command.cameraId);
    if (cameraIndex < 0) return { ok: false, error: `Camera ${command.cameraId} not found` };
    const updated = DirectorStageCameraSchema.safeParse({
      ...next.cameras[cameraIndex],
      ...command.patch,
      id: command.cameraId,
    });
    if (!updated.success) {
      return { ok: false, error: updated.error.issues[0]?.message ?? "Invalid Director Stage camera patch" };
    }
    if (
      updated.data.targetObjectId &&
      !next.objects.some((object) => object.id === updated.data.targetObjectId)
    ) {
      return {
        ok: false,
        error: `Camera ${command.cameraId} targets missing object ${updated.data.targetObjectId}`,
      };
    }
    const missingGroupTarget = updated.data.targetObjectIds?.find(
      (targetId) => !next.objects.some((object) => object.id === targetId),
    );
    if (missingGroupTarget) {
      return {
        ok: false,
        error: `Camera ${command.cameraId} targets missing object ${missingGroupTarget}`,
      };
    }
    next.cameras[cameraIndex] = updated.data;
  }

  if (command.op === "camera.remove") {
    if (!next.cameras.some((camera) => camera.id === command.cameraId)) {
      return { ok: false, error: `Camera ${command.cameraId} not found` };
    }
    if (next.shotSequence?.some((shot) => shot.cameraId === command.cameraId)) {
      return { ok: false, error: `Camera ${command.cameraId} is used by the shot sequence` };
    }
    next.cameras = next.cameras.filter((camera) => camera.id !== command.cameraId);
    if (next.activeCameraId === command.cameraId) delete next.activeCameraId;
    if (next.animation) {
      next.animation.tracks = next.animation.tracks.filter(
        (track) => track.targetId !== command.cameraId,
      );
      next.animation.cameraCues = next.animation.cameraCues?.filter(
        (cue) => cue.cameraId !== command.cameraId,
      );
    }
  }

  if (command.op === "sequence-shot.upsert") {
    const shot = DirectorStageSequenceShotSchema.safeParse(command.shot);
    if (!shot.success) {
      return { ok: false, error: shot.error.issues[0]?.message ?? "Invalid sequence shot" };
    }
    if (!next.cameras.some((camera) => camera.id === shot.data.cameraId)) {
      return { ok: false, error: `Shot ${shot.data.id} uses missing camera ${shot.data.cameraId}` };
    }
    if (shot.data.startTime + shot.data.durationSeconds > command.durationSeconds + Number.EPSILON) {
      return {
        ok: false,
        error: `Shot ${shot.data.id} ends after the ${command.durationSeconds}s sequence`,
      };
    }
    const shots = [...(next.shotSequence ?? [])];
    const existingIndex = shots.findIndex((candidate) => candidate.id === shot.data.id);
    if (existingIndex >= 0) shots[existingIndex] = shot.data;
    else shots.push(shot.data);
    shots.sort((left, right) => left.startTime - right.startTime || left.id.localeCompare(right.id));
    next.shotSequence = shots;
    const animation = next.animation ?? {
      durationSeconds: command.durationSeconds,
      fps: command.fps,
      tracks: [],
    };
    animation.durationSeconds = command.durationSeconds;
    animation.fps = command.fps;
    next.animation = animation;
  }

  if (command.op === "sequence-shot.remove") {
    if (!next.shotSequence?.some((shot) => shot.id === command.shotId)) {
      return { ok: false, error: `Sequence shot ${command.shotId} not found` };
    }
    next.shotSequence = next.shotSequence.filter((shot) => shot.id !== command.shotId);
  }

  if (command.op === "motion.upsert") {
    const motion = DirectorStageMotionAssetSchema.safeParse(command.motion);
    if (!motion.success) {
      return { ok: false, error: motion.error.issues[0]?.message ?? "Invalid motion asset" };
    }
    const motions = [...(next.motionAssets ?? [])];
    const existingIndex = motions.findIndex((candidate) => candidate.id === motion.data.id);
    if (existingIndex >= 0) motions[existingIndex] = motion.data;
    else motions.push(motion.data);
    motions.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    next.motionAssets = motions;
  }

  if (command.op === "motion.remove") {
    if (!next.motionAssets?.some((motion) => motion.id === command.motionId)) {
      return { ok: false, error: `Motion asset ${command.motionId} not found` };
    }
    if (next.animation?.actionClips?.some((clip) => clip.motionAssetId === command.motionId)) {
      return { ok: false, error: `Motion asset ${command.motionId} is used by an action clip` };
    }
    next.motionAssets = next.motionAssets.filter((motion) => motion.id !== command.motionId);
  }

  if (command.op === "scene.update") {
    next.scene = {
      ...next.scene,
      ...(command.patch.backgroundColor !== undefined
        ? { backgroundColor: command.patch.backgroundColor }
        : {}),
      ...(command.patch.environmentAssetId !== undefined
        ? { environmentAssetId: command.patch.environmentAssetId }
        : {}),
      ...(command.patch.environmentRotation !== undefined
        ? { environmentRotation: command.patch.environmentRotation }
        : {}),
      ...(command.patch.environmentCalibration !== undefined
        ? { environmentCalibration: command.patch.environmentCalibration }
        : {}),
      grid: {
        ...next.scene.grid,
        ...(command.patch.grid ?? {}),
      },
    };
  }

  if (command.op === "keyframe.upsert") {
    const targetExists = next.objects.some((object) => object.id === command.track.targetId) ||
      next.cameras.some((camera) => camera.id === command.track.targetId);
    if (!targetExists) {
      return { ok: false, error: `Animation target ${command.track.targetId} not found` };
    }
    const parsedKeyframe = DirectorStageAnimationKeyframeSchema.safeParse(command.keyframe);
    if (!parsedKeyframe.success) {
      return { ok: false, error: parsedKeyframe.error.issues[0]?.message ?? "Invalid keyframe" };
    }
    const animation = next.animation ?? {
      durationSeconds: command.durationSeconds,
      fps: command.fps,
      tracks: [],
    };
    animation.durationSeconds = command.durationSeconds;
    animation.fps = command.fps;
    let track = animation.tracks.find((candidate) => candidate.id === command.track.id);
    if (!track) {
      track = { ...command.track, keyframes: [] };
      animation.tracks.push(track);
    } else if (
      track.targetId !== command.track.targetId ||
      track.property !== command.track.property
    ) {
      return { ok: false, error: `Track ${command.track.id} identity does not match` };
    }
    const existingIndex = track.keyframes.findIndex(
      (keyframe) => keyframe.id === parsedKeyframe.data.id,
    );
    if (existingIndex >= 0) track.keyframes[existingIndex] = parsedKeyframe.data;
    else track.keyframes.push(parsedKeyframe.data);
    track.keyframes.sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));
    animation.tracks.sort((left, right) => left.id.localeCompare(right.id));
    next.animation = animation;
  }

  if (command.op === "keyframe.remove") {
    const animation = next.animation;
    const track = animation?.tracks.find((candidate) => candidate.id === command.trackId);
    if (!animation || !track) {
      return { ok: false, error: `Animation track ${command.trackId} not found` };
    }
    if (!track.keyframes.some((keyframe) => keyframe.id === command.keyframeId)) {
      return { ok: false, error: `Keyframe ${command.keyframeId} not found` };
    }
    track.keyframes = track.keyframes.filter(
      (keyframe) => keyframe.id !== command.keyframeId,
    );
    if (track.keyframes.length === 0) {
      animation.tracks = animation.tracks.filter(
        (candidate) => candidate.id !== command.trackId,
      );
    }
  }

  if (command.op === "action.upsert") {
    const target = next.objects.find((object) => object.id === command.clip.targetId);
    const actionCapable = target?.kind === "mannequin" || (
      target?.kind === "model" && Boolean(target.model.animation)
    );
    if (!actionCapable) {
      return { ok: false, error: `Action target ${command.clip.targetId} must be an action-capable object` };
    }
    const parsedClip = DirectorStageActionClipSchema.safeParse(command.clip);
    if (!parsedClip.success) {
      return { ok: false, error: parsedClip.error.issues[0]?.message ?? "Invalid action clip" };
    }
    if (
      parsedClip.data.motionAssetId &&
      !next.motionAssets?.some((motion) => motion.id === parsedClip.data.motionAssetId)
    ) {
      return {
        ok: false,
        error: `Motion asset ${parsedClip.data.motionAssetId} not found`,
      };
    }
    if (
      parsedClip.data.startTime + parsedClip.data.durationSeconds >
      command.durationSeconds + Number.EPSILON
    ) {
      return {
        ok: false,
        error: `Action clip ${parsedClip.data.id} ends after the ${command.durationSeconds}s animation`,
      };
    }
    const animation = next.animation ?? {
      durationSeconds: command.durationSeconds,
      fps: command.fps,
      tracks: [],
    };
    animation.durationSeconds = command.durationSeconds;
    animation.fps = command.fps;
    const actionClips = [...(animation.actionClips ?? [])];
    const existingIndex = actionClips.findIndex((clip) => clip.id === parsedClip.data.id);
    if (existingIndex >= 0) actionClips[existingIndex] = parsedClip.data;
    else actionClips.push(parsedClip.data);
    actionClips.sort((left, right) => left.startTime - right.startTime || left.id.localeCompare(right.id));
    animation.actionClips = actionClips;
    next.animation = animation;
  }

  if (command.op === "action.remove") {
    if (!next.animation?.actionClips?.some((clip) => clip.id === command.clipId)) {
      return { ok: false, error: `Action clip ${command.clipId} not found` };
    }
    next.animation.actionClips = next.animation.actionClips.filter(
      (clip) => clip.id !== command.clipId,
    );
  }

  const validated = DirectorStageAuthoringStateSchema.safeParse(next);
  if (!validated.success) {
    return { ok: false, error: validated.error.issues[0]?.message ?? "Invalid Director Stage command result" };
  }
  const registryError = directorCodeRegistryError(validated.data);
  if (registryError) return { ok: false, error: registryError };
  return { ok: true, state: validated.data };
}

export function detachDirectorStageFromCanvas(
  doc: LoroDoc,
  stageId: string,
): ProjectDirectorStageMutationResult {
  const stage = readProjectDirectorStage(doc, stageId);
  if (!stage) return { ok: false, error: `Director Stage ${stageId} not found` };
  if (stage.owner.kind !== "canvas-action") {
    return { ok: false, error: `Director Stage ${stageId} is already standalone` };
  }
  const actionNodeId = stage.owner.actionNodeId;
  const canvas = new Canvas(doc, () => {}, stage.owner.canvasId);
  const actionNode = canvas.readNode(actionNodeId);
  if (actionNode?.type === "director-stage" && actionNode.data.stageId === stage.id) {
    canvas.deleteNode(actionNodeId);
  }
  const next: ProjectDirectorStage = { ...stage, owner: { kind: "project" } };
  const bindingError = rehomeProjectDirectorAssetInputs(doc, stage, next);
  if (bindingError) return bindingError;
  const fields = doc.getMap("directorStages").get(stageId);
  if (!isLoroMap(fields)) return { ok: false, error: `Director Stage ${stageId} not found` };
  fields.set("owner", next.owner);
  return { ok: true, stage: next };
}
