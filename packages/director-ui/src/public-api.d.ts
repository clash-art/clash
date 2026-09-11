import type React from "react";

export function compileDirectorCodeComponent(source: string): React.ComponentType<{
  parameters: Record<string, unknown>;
  timeSeconds: number;
}>;
import type { AnimationClip, Group, Matrix4, Object3D, Vector3 } from "three";
import type {
  DirectorStageActionClip,
  DirectorStageActionName,
  DirectorStageEnvironmentCalibration,
  DirectorStageObject,
  DirectorStageState,
  DirectorStageTransform,
  DirectorStageVector3,
  DirectorStageWorkingVolume,
} from "@clash/shared-types";

export type DirectorTransformMode = "translate" | "rotate" | "scale";
export type DirectorViewPreset = "top" | "front" | "reset";
export type DirectorShortcutAction =
  | { type: "mode"; mode: DirectorTransformMode }
  | { type: "toggle-snap" }
  | { type: "view"; view: DirectorViewPreset }
  | { type: "delete" }
  | { type: "group" }
  | { type: "ungroup" }
  | { type: "undo" };

export function directorShortcut(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): DirectorShortcutAction | null;

export interface DirectorCameraPose {
  position: DirectorStageVector3;
  rotation: DirectorStageVector3;
  fov: number;
}

export interface DirectorRenderedFrame {
  timeSeconds: number;
  canvas: HTMLCanvasElement;
}

export interface DirectorWebGlRendererLike {
  render(scene: unknown, camera: unknown): void;
}

export function createDirectorFramePublicationGate(requiredStableFrames?: number): {
  tick(resourcesActive: boolean): boolean;
  reset(): void;
};

export function renderDirectorFrameNow(input: {
  renderer: DirectorWebGlRendererLike;
  scene: unknown;
  camera: unknown;
  timeSeconds: number;
  canvas: HTMLCanvasElement;
  publish: (frame: DirectorRenderedFrame) => void;
}): void;

export type DirectorBuiltinModelCategory =
  | "Characters"
  | "Animals"
  | "Furniture"
  | "Props"
  | "Vehicles"
  | "Nature";

export interface DirectorBuiltinModelRig {
  profileId?: "clash-humanoid-v1" | "clash-quadruped-v1";
  jointCount: number;
  clipNames: readonly string[];
  actionMap: Readonly<Partial<Record<DirectorStageActionName, string>>>;
}

export interface DirectorBuiltinModelAsset {
  id: string;
  name: string;
  category: DirectorBuiltinModelCategory;
  description: string;
  sourceName: "Poly Haven" | "Quaternius";
  sourcePageUrl: string;
  license: "CC0-1.0";
  licenseUrl: string;
  sourceSha256: string;
  animated: boolean;
  rig?: DirectorBuiltinModelRig;
  sourceUrl: string;
  thumbnailUrl: string;
  defaultTransform: DirectorStageTransform;
}

export const DIRECTOR_BUILTIN_MODEL_ASSETS: readonly DirectorBuiltinModelAsset[];
export const DIRECTOR_BUILTIN_MODEL_ASSET_URLS: Readonly<Record<string, string>>;

export interface DirectorEmbeddedModelAnimation {
  clipName: string;
  localTimeSeconds: number;
  weight: number;
}
export function inferDirectorModelRig(input: {
  jointCount: number;
  clipNames: readonly string[];
}): DirectorBuiltinModelRig;
export function inspectDirectorModelFile(
  file: Pick<File, "name" | "arrayBuffer" | "text">,
): Promise<DirectorBuiltinModelRig | undefined>;
export function resolveDirectorEmbeddedModelAnimation(input: {
  rig: DirectorBuiltinModelRig;
  requestedAction?: DirectorStageActionName;
  actionLocalTimeSeconds?: number;
  actionWeight?: number;
  locomotionSpeed: number;
  timeSeconds: number;
}): DirectorEmbeddedModelAnimation | undefined;

export interface DirectorRenderPalette {
  selection: string;
  mannequin: string;
  skeleton: string;
  gridMajor: string;
  gridMinor: string;
  camera: string;
  axisX: string;
  axisY: string;
  axisZ: string;
  axisLabel: string;
}

export interface DirectorViewportHandle {
  capture: (options: {
    aspectRatio: DirectorStageState["shots"][number]["aspectRatio"];
    longEdge?: number;
    mimeType?: "image/png" | "image/jpeg";
  }) => Promise<Blob>;
  record: (options: {
    aspectRatio: DirectorStageState["shots"][number]["aspectRatio"];
    durationSeconds: number;
    startTimeSeconds?: number;
    fps?: number;
    longEdge?: number;
    videoBitsPerSecond?: number;
    onTimeUpdate?: (timeSeconds: number) => void;
  }) => Promise<Blob>;
  canvas: () => HTMLCanvasElement | null;
  cameraPose: () => DirectorCameraPose;
}

export interface DirectorViewportProps {
  codeSources?: Record<string, string>;
  onError?: (error: Error) => void;
  state: DirectorStageState;
  selectedObjectId?: string;
  selectedCameraId?: string;
  transformMode: DirectorTransformMode;
  viewMode: "director" | "camera";
  viewPreset?: DirectorViewPreset;
  calibrationCamera?: DirectorCameraPose;
  gridSnap?: boolean;
  timeSeconds?: number;
  environmentUrl?: string;
  showEnvironmentBackground?: boolean;
  showSelectedSkeleton?: boolean;
  assetUrls?: Record<string, string>;
  onSelectionChange?: (objectId?: string) => void;
  onObjectContextMenu?: (objectId: string) => void;
  onTransformCommit?: (objectId: string, transform: DirectorStageTransform) => void;
  onReady?: (canvas: HTMLCanvasElement) => void;
  onFrameRendered?: (frame: DirectorRenderedFrame) => void;
  renderPalette?: Partial<DirectorRenderPalette>;
  fallback?: React.ReactNode;
  className?: string;
}

export const DirectorViewport: React.ForwardRefExoticComponent<
  DirectorViewportProps & React.RefAttributes<DirectorViewportHandle>
>;

export function preferredDirectorVideoMimeType(
  isTypeSupported?: (type: string) => boolean,
): string;

export function recordCanvasVideo(
  source: HTMLCanvasElement,
  options: {
    aspectRatio: DirectorStageState["shots"][number]["aspectRatio"];
    durationSeconds: number;
    startTimeSeconds?: number;
    fps?: number;
    longEdge?: number;
    videoBitsPerSecond?: number;
    onTimeUpdate?: (timeSeconds: number) => void;
  },
): Promise<Blob>;

export function directorPanoramaCalibrationCamera(
  calibration: DirectorStageEnvironmentCalibration,
): DirectorCameraPose;

export function directorPanoramaEnvironmentRotation(
  calibration: DirectorStageEnvironmentCalibration,
): DirectorStageVector3;

export type DirectorPanoramaWorkingVolumePresetId = "compact" | "standard" | "large";
export const DIRECTOR_PANORAMA_WORKING_VOLUME_PRESETS: ReadonlyArray<{
  id: DirectorPanoramaWorkingVolumePresetId;
  label: string;
  description: string;
  size: DirectorStageVector3;
}>;
export function createDirectorPanoramaCalibration(
  presetId?: DirectorPanoramaWorkingVolumePresetId,
): DirectorStageEnvironmentCalibration;
export function directorPanoramaWorkingVolume(
  calibration?: Pick<DirectorStageEnvironmentCalibration, "workingVolume">,
): DirectorStageWorkingVolume | undefined;

export function renderDirectorPanoramaReference(options?: {
  width?: number;
  height?: number;
  calibration?: DirectorStageEnvironmentCalibration;
}): {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  calibration: DirectorStageEnvironmentCalibration;
};

export interface DirectorKeyframeTimelineProps {
  animation: NonNullable<DirectorStageState["animation"]>;
  shots?: DirectorStageSequenceShot[];
  playheadSeconds: number;
  zoom: number;
  viewportWidth: number;
  targetLabels?: Record<string, string>;
  onSeek: (timeSeconds: number) => void;
  selectedKeyframeId?: string;
  onSelectKeyframe?: (trackId: string, keyframeId: string) => void;
  onChangeKeyframe?: (trackId: string, keyframeId: string, timeSeconds: number) => void;
  selectedActionClipId?: string;
  onSelectActionClip?: (clipId: string) => void;
  onChangeActionClip?: (
    clipId: string,
    timing: Pick<DirectorStageActionClip, "startTime" | "durationSeconds">,
  ) => void;
  selectedShotId?: string;
  selectedShotIds?: string[];
  primaryShotId?: string;
  onSelectShot?: (
    shotId: string,
    gesture: { toggle: boolean; range: boolean },
  ) => void;
  onChangeShot?: (
    shotId: string,
    timing: Pick<DirectorStageSequenceShot, "startTime" | "durationSeconds">,
  ) => void;
}

export type DirectorActionClipEditMode = "move" | "trim-start" | "trim-end";
export type DirectorSequenceShotEditMode = DirectorActionClipEditMode;
export interface DirectorShotSelection {
  selectedShotIds: string[];
  primaryShotId?: string;
  anchorShotId?: string;
}
export function updateDirectorShotSelection(input: {
  orderedShotIds: string[];
  selectedShotIds: string[];
  clickedShotId: string;
  toggle?: boolean;
  range?: boolean;
  anchorShotId?: string;
}): DirectorShotSelection;
export function editDirectorKeyframeTime(options: {
  originalTime: number;
  deltaSeconds: number;
  timelineDurationSeconds: number;
  fps: number;
}): number;
export function editDirectorActionClipTiming(options: {
  clip: DirectorStageActionClip;
  mode: DirectorActionClipEditMode;
  deltaSeconds: number;
  timelineDurationSeconds: number;
  fps: number;
}): Pick<DirectorStageActionClip, "startTime" | "durationSeconds">;
export function editDirectorSequenceShotTiming(options: {
  shot: DirectorStageSequenceShot;
  mode: DirectorSequenceShotEditMode;
  deltaSeconds: number;
  timelineDurationSeconds: number;
  fps: number;
}): Pick<DirectorStageSequenceShot, "startTime" | "durationSeconds">;

export function DirectorKeyframeTimeline(
  props: DirectorKeyframeTimelineProps,
): React.ReactElement;

export const DIRECTOR_RENDERER_OPTIONS: {
  antialias: boolean;
  preserveDrawingBuffer: boolean;
  alpha: boolean;
  powerPreference: "high-performance";
};

export const directorTokens: Record<string, string>;
export const directorRenderPaletteFallback: DirectorRenderPalette;
export function resolveDirectorRenderPalette(element?: Element | null): DirectorRenderPalette;

export type DirectorMannequinPosePreset = {
  label: string;
  joints: Record<string, DirectorStageVector3>;
};

export type DirectorMannequinPose = {
  preset?: string;
  joints: Record<string, DirectorStageVector3>;
};

export type DirectorMannequinSkeleton = Record<string, Vector3>;

export const DIRECTOR_MANNEQUIN_POSE_PRESETS: Record<string, DirectorMannequinPosePreset>;
export const DIRECTOR_MANNEQUIN_POSE_JOINTS: readonly {
  readonly value: string;
  readonly label: string;
}[];
export const DIRECTOR_MANNEQUIN_POSE_BONES: Readonly<Record<string, string>>;
export const DIRECTOR_MANNEQUIN_SKELETON_BONES: Readonly<Record<string, string>>;
export const DIRECTOR_MANNEQUIN_SKELETON_CONNECTIONS: readonly (readonly [string, string])[];

export function bindDirectorMannequinRig(character: Object3D): void;
export function applyDirectorMannequinPose(
  character: Object3D,
  pose: DirectorMannequinPose,
): void;
export function animateDirectorMannequinWalkCycle(
  pose: DirectorMannequinPose,
  timeSeconds: number,
  speed: number,
  distanceMeters?: number,
): DirectorMannequinPose;
export interface EvaluatedDirectorActionClip {
  clip: DirectorStageActionClip;
  localTimeSeconds: number;
  weight: number;
}
export function evaluateDirectorMannequinActionPose(options: {
  basePose: DirectorMannequinPose;
  timeSeconds: number;
  locomotionSpeed: number;
  locomotionDistance?: number;
  activeActions: EvaluatedDirectorActionClip[];
}): DirectorMannequinPose;
export function resolveDirectorMannequinRuntimePose(options: {
  object: Extract<DirectorStageObject, { kind: "mannequin" }>;
  animation: DirectorStageState["animation"];
  timeSeconds: number;
  locomotionSpeed: number;
  locomotionDistance?: number;
}): DirectorMannequinPose;
export function resolveDirectorObjectLocomotion(options: {
  object: DirectorStageObject;
  animation: DirectorStageState["animation"];
  timeSeconds: number;
  hasRiggedModel?: boolean;
}): { speed: number; yaw?: number };
export function retargetDirectorHumanoidClip(options: {
  target: Object3D;
  source: Object3D;
  clip: AnimationClip;
  inPlace?: boolean;
}): AnimationClip;
export type DirectorHumanoidBone =
  | "hips"
  | "spine"
  | "chest"
  | "neck"
  | "head"
  | "leftUpperArm"
  | "leftLowerArm"
  | "leftHand"
  | "rightUpperArm"
  | "rightLowerArm"
  | "rightHand"
  | "leftUpperLeg"
  | "leftLowerLeg"
  | "leftFoot"
  | "rightUpperLeg"
  | "rightLowerLeg"
  | "rightFoot";
export const CLASH_HUMANOID_RIG_V1: {
  readonly id: "clash-humanoid-v1";
  readonly version: 1;
  readonly topology: "humanoid";
  readonly requiredBones: readonly DirectorHumanoidBone[];
};
export interface DirectorHumanoidRigIssue {
  code: "missing-bone";
  severity: "error";
  bone: DirectorHumanoidBone;
  message: string;
}
export interface DirectorHumanoidRigReport {
  profileId: "clash-humanoid-v1";
  compatible: boolean;
  boneMap: Partial<Record<DirectorHumanoidBone, string>>;
  issues: DirectorHumanoidRigIssue[];
}
export function inspectDirectorHumanoidRig(root: Object3D): DirectorHumanoidRigReport;
export type DirectorHumanoidSourceFormat = "gltf" | "glb" | "fbx" | "bvh";
export type DirectorSignedAxis = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";
export interface DirectorCoordinateSystem {
  unitMeters: number;
  upAxis: DirectorSignedAxis;
  forwardAxis: DirectorSignedAxis;
  handedness: "left" | "right";
}
export const CLASH_HUMANOID_COORDINATE_SYSTEM: Readonly<{
  unitMeters: 1;
  upAxis: "+Y";
  forwardAxis: "+Z";
  handedness: "right";
}>;
export interface ParsedDirectorHumanoidSource {
  format: DirectorHumanoidSourceFormat;
  root: Group;
  animations: AnimationClip[];
}
export interface NormalizedDirectorHumanoidSource {
  root: Group;
  animations: AnimationClip[];
  coordinates: typeof CLASH_HUMANOID_COORDINATE_SYSTEM;
  sourceCoordinates: DirectorCoordinateSystem;
  sourceToClashMatrix: Matrix4;
}
export type DirectorHumanoidSourceIssue =
  | { code: "incompatible-rig"; severity: "error"; message: string }
  | { code: "missing-animation"; severity: "error"; message: string };
export interface PreparedDirectorHumanoidSource
  extends NormalizedDirectorHumanoidSource {
  format: DirectorHumanoidSourceFormat;
  rig: DirectorHumanoidRigReport;
  admitted: boolean;
  issues: DirectorHumanoidSourceIssue[];
}
export function parseDirectorHumanoidSource(options: {
  fileName: string;
  data: string | ArrayBuffer;
  resourcePath?: string;
}): Promise<ParsedDirectorHumanoidSource>;
export function directorSourceToClashMatrix(
  coordinates: DirectorCoordinateSystem,
): Matrix4;
export function normalizeDirectorHumanoidSource(options: {
  root: Object3D;
  animations: readonly AnimationClip[];
  coordinates: DirectorCoordinateSystem;
}): NormalizedDirectorHumanoidSource;
export function prepareDirectorHumanoidSource(options: {
  fileName: string;
  data: string | ArrayBuffer;
  coordinates: DirectorCoordinateSystem;
  resourcePath?: string;
  requireAnimations?: boolean;
}): Promise<PreparedDirectorHumanoidSource>;
export type DirectorHumanoidPoseIssue =
  | {
    code: "arm-torso-clearance";
    severity: "error";
    side: "left" | "right";
    joint: "elbow" | "hand";
    clearanceRatio: number;
    minimumRatio: number;
    message: string;
  }
  | {
    code: "hand-lower-body-clearance";
    severity: "error";
    side: "left" | "right";
    joint: "hand";
    region: "upper-leg";
    clearanceRatio: number;
    minimumRatio: number;
    message: string;
  };
export interface DirectorHumanoidPoseAudit {
  profileId: "clash-humanoid-v1";
  issues: DirectorHumanoidPoseIssue[];
}
export function auditDirectorHumanoidPose(
  root: Object3D,
  options?: {
    minimumArmClearanceRatio?: number;
    minimumHandToUpperLegClearanceRatio?: number;
  },
): DirectorHumanoidPoseAudit;
export interface DirectorHumanoidFootMotionMetrics {
  plantedFrames: number;
  meanSlideMetersPerSecond: number;
  minimumHeightMeters: number;
}
export interface DirectorHumanoidMotionAudit {
  profileId: "clash-humanoid-v1";
  sampleCount: number;
  metrics: {
    leftFoot: DirectorHumanoidFootMotionMetrics;
    rightFoot: DirectorHumanoidFootMotionMetrics;
    contactHeightDeltaMeters: number;
    recommendedActorSpeedMetersPerSecond: number;
    maximumJointExcursionDegrees: Partial<Record<DirectorHumanoidBone, number>>;
  };
  issues: DirectorHumanoidMotionIssue[];
}
export type DirectorHumanoidMotionIssue =
  | { code: "incompatible-rig"; severity: "error"; message: string }
  | {
    code: "foot-slide";
    severity: "error";
    side: "left" | "right";
    meanSlideMetersPerSecond: number;
    maximumMetersPerSecond: number;
    message: string;
  }
  | {
    code: "ground-contact-asymmetry";
    severity: "error";
    contactHeightDeltaMeters: number;
    maximumMeters: number;
    message: string;
  }
  | {
    code: "joint-limit";
    severity: "error";
    bone: DirectorHumanoidBone;
    excursionDegrees: number;
    maximumDegrees: number;
    message: string;
  }
  | {
    code: "self-intersection";
    severity: "error";
    side: "left" | "right";
    joint: "elbow" | "hand";
    region: "torso" | "upper-leg";
    message: string;
  };
export function auditDirectorHumanoidMotion(options: {
  root: Object3D;
  clip: AnimationClip;
  actorSpeedMetersPerSecond: number;
  playbackRate?: number;
  sampleRate?: number;
  maximumMeanFootSlideMetersPerSecond?: number;
  maximumContactHeightDeltaMeters?: number;
  minimumArmClearanceRatio?: number;
  minimumHandToUpperLegClearanceRatio?: number;
}): DirectorHumanoidMotionAudit;
export interface DirectorAnnyMotionPlayback {
  base: {
    clipName: string;
    localTimeSeconds: number;
    playbackRate?: number;
    weight: number;
  };
  upperBody?: { clipName: string; localTimeSeconds: number; weight: number };
}
export const CLASH_HUMANOID_MOTION_SOURCES: readonly Readonly<{
  id:
    | "quaternius-casual-hoodie"
    | "quaternius-universal-animation-standard";
  sourcePageUrl: string;
  sourceUrl: string;
  license: "CC0-1.0";
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/";
  sourceSha256: string;
}>[];
export const CLASH_HUMANOID_MOTION_CATALOG_V1: Readonly<{
  id: "quaternius-ual1-standard-v1";
  sourceId: "quaternius-universal-animation-standard";
  clips: readonly Readonly<{
    id: string;
    sourceClip: string;
    category:
      | "utility"
      | "locomotion"
      | "posture"
      | "performance"
      | "interaction"
      | "combat"
      | "idle"
      | "prop";
    loop: boolean;
    prop?: "torch" | "pistol" | "sword";
  }>[];
}>;
export const CLASH_HUMANOID_ACTION_LIBRARY_V1: Readonly<{
  id: "clash-humanoid-actions-v1";
  version: 1;
  profileId: "clash-humanoid-v1";
  sourceAssetId: "builtin:quaternius:casual-hoodie";
  sourceLicense: "CC0-1.0";
  actions: readonly {
    id:
      | "idle"
      | "walk"
      | "run"
      | "sit"
      | "crouch"
      | "kneel"
      | "wave"
      | "interact"
      | "talk"
      | "dance"
      | "jump"
      | "roll"
      | "pickup"
      | "push"
      | "punch"
      | "swim"
      | "drive"
      | "death";
    sourceId:
      | "quaternius-casual-hoodie"
      | "quaternius-universal-animation-standard";
    sourceClip:
      | "Idle_Neutral"
      | "Walk"
      | "Run"
      | "Sitting_Idle_Loop"
      | "Crouch_Idle_Loop"
      | "Fixing_Kneeling"
      | "Wave"
      | "Interact"
      | "Idle_Talking_Loop"
      | "Dance_Loop"
      | "Jump_Loop"
      | "Roll"
      | "PickUp_Table"
      | "Push_Loop"
      | "Punch_Cross"
      | "Swim_Fwd_Loop"
      | "Driving_Loop"
      | "Death01";
    layer: "full-body" | "upper-body";
    loop: boolean;
  }[];
}>;
export function resolveDirectorAnnyMotionPlayback(options: {
  posePreset?: string;
  activeActions: EvaluatedDirectorActionClip[];
  locomotionSpeed: number;
  locomotionSpeeds?: Partial<Record<"Walk" | "Run", number>>;
  availableClipNames?: readonly string[];
  timeSeconds: number;
}): DirectorAnnyMotionPlayback | undefined;
export interface DirectorAnnyMotionClipLibrary {
  clips: Record<string, AnimationClip>;
  lowerBodyClips: Record<string, AnimationClip>;
  upperBodyClips: Record<string, AnimationClip>;
  locomotionSpeeds: Record<"Walk" | "Run", number>;
  qaReports: Record<string, DirectorHumanoidMotionAudit>;
  releaseReadyClipNames: string[];
}
export interface DirectorHumanoidMotionSource {
  id: string;
  source: Object3D;
  animations: readonly AnimationClip[];
}
export function createDirectorAnnyMotionClipLibrary(options: {
  target: Object3D;
  source: Object3D;
  animations: readonly AnimationClip[];
  supplementalSources?: readonly DirectorHumanoidMotionSource[];
}): DirectorAnnyMotionClipLibrary;
export function readDirectorMannequinSkeleton(
  character: Object3D,
): DirectorMannequinSkeleton | null;

export const DIRECTOR_CAMERA_SENSOR_HEIGHT_MM: number;
export const DIRECTOR_CAMERA_LENS_PRESETS: readonly {
  readonly id: string;
  readonly label: string;
  readonly focalLengthMm: number;
}[];
export function cameraFovFromFocalLength(
  focalLengthMm: number,
  sensorHeightMm?: number,
): number;
export function cameraFocalLengthFromFov(
  fovDegrees: number,
  sensorHeightMm?: number,
): number;
export function cameraLookAtRotation(
  position: DirectorStageVector3,
  target: DirectorStageVector3,
): DirectorStageVector3;
export function directorDefaultFocusOffset(
  object: DirectorStageObject,
): DirectorStageVector3;
export function directorObjectFocusPoint(
  object: DirectorStageObject,
  offset?: DirectorStageVector3,
): DirectorStageVector3;
export function composeDirectorTransforms(
  parent: DirectorStageTransform,
  child: DirectorStageTransform,
): DirectorStageTransform;
export function directorObjectWorldTransform(
  objects: DirectorStageObject[],
  objectId: string,
): DirectorStageTransform | undefined;
export function evaluateDirectorStage(
  state: DirectorStageState,
  timeSeconds: number,
): DirectorStageState;
export type DirectorShotCompositionIssueCode =
  | "axis-crossed"
  | "camera-too-close"
  | "subjects-too-close"
  | "subject-occluded"
  | "headroom"
  | "lead-room";
export interface DirectorShotCompositionIssue {
  code: DirectorShotCompositionIssueCode;
  severity: "warning" | "error";
  shotId: string;
  timeSeconds: number;
  objectId?: string;
  message: string;
}
export function auditDirectorShotComposition(
  state: DirectorStageState,
  shotId: string,
  sampleTimes?: readonly number[],
): DirectorShotCompositionIssue[];

export type DirectorHorseGait = "auto" | "idle" | "walk" | "trot" | "gallop";
export interface DirectorHorseGaitPose {
  gait: Exclude<DirectorHorseGait, "auto">;
  bodyBob: number;
  bodyPitch: number;
  neckPitch: number;
  frontLeft: number;
  frontRight: number;
  rearLeft: number;
  rearRight: number;
}
export function directorHorseGaitPose(options: {
  gait: DirectorHorseGait;
  speed: number;
  timeSeconds: number;
}): DirectorHorseGaitPose;
