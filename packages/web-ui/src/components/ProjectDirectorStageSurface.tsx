import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useDirectorCodeSources } from "../lib/useDirectorCodeSources";
import {
  ArrowCounterClockwise,
  ArrowsClockwise,
  ArrowsOutCardinal,
  BezierCurve,
  Camera,
  CheckCircle,
  Cube,
  Eye,
  EyeSlash,
  GridFour,
  MagnifyingGlass,
  Pause,
  Play,
  Plus,
  Sparkle,
  Trash,
  UploadSimple,
  User,
  UsersThree,
  VideoCamera,
} from "@phosphor-icons/react";
import { CanvasIcon } from "./ProjectSurfaceIcon";
import {
  DIRECTOR_CAMERA_LENS_PRESETS,
  DIRECTOR_BUILTIN_MODEL_ASSETS,
  CLASH_HUMANOID_ACTION_LIBRARY_V1,
  CLASH_HUMANOID_COORDINATE_SYSTEM,
  DIRECTOR_MANNEQUIN_POSE_JOINTS,
  DIRECTOR_MANNEQUIN_POSE_PRESETS,
  DIRECTOR_PANORAMA_WORKING_VOLUME_PRESETS,
  DirectorKeyframeTimeline,
  DirectorViewport,
  auditDirectorShotComposition,
  cameraFocalLengthFromFov,
  cameraFovFromFocalLength,
  createDirectorPanoramaCalibration,
  directorDefaultFocusOffset,
  directorObjectFocusPoint,
  directorPanoramaCalibrationCamera,
  directorPanoramaEnvironmentRotation,
  directorPanoramaWorkingVolume,
  directorShortcut,
  evaluateDirectorStage,
  updateDirectorShotSelection,
  type DirectorCameraPose,
  type DirectorBuiltinModelAsset,
  type DirectorBuiltinModelRig,
  type DirectorTransformMode,
  type DirectorViewPreset,
  type DirectorViewportHandle,
} from "@clash/director-ui";
import {
  applyDirectorStageCommand,
  type DirectorStageActionClip,
  type DirectorStageActionLayer,
  type DirectorStageActionName,
  type DirectorStageCameraRig,
  type DirectorStageCommand,
  type DirectorStageEnvironmentCalibration,
  type AgentAnnotationObjectRef,
  type DirectorStageObject,
  type DirectorStageMotionAsset,
  type DirectorStageSequenceShot,
  type DirectorStageState,
  type DirectorStageTransform,
  type DirectorStageVector3,
  type DirectorStageWorkingVolume,
  type ProjectCanvas,
  type ProjectDirectorStage,
} from "@clash/shared-types";
import { Button } from "./ui/button";
import { ControlContextProvider } from "./ui/control-context";
import { Dialog } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { Input } from "./ui/input";
import { SelectMenu } from "./ui/select";
import { Slider, SliderRange, SliderThumb, SliderTrack } from "./ui/slider";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { Tooltip } from "./ui/tooltip";
import { Tab, TabList, TabProvider } from "./ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type DirectorAspectRatio = DirectorStageState["shots"][number]["aspectRatio"];
type DirectorAnimation = NonNullable<DirectorStageState["animation"]>;
type DirectorAnimationTrack = DirectorAnimation["tracks"][number];
type DirectorAnimationKeyframe = DirectorAnimationTrack["keyframes"][number];
type DirectorKeyframeInterpolation = DirectorAnimationKeyframe["interpolation"];
type DirectorCamera = DirectorStageState["cameras"][number];
export type DirectorCameraMovePreset =
  | "lead"
  | "side-track"
  | "follow"
  | "push-in"
  | "pull-out"
  | "orbit"
  | "crane-up"
  | "reveal"
  | "arc-push";

export const DIRECTOR_CAMERA_MOVE_PRESETS: Array<{
  value: DirectorCameraMovePreset;
  label: string;
  detail: string;
}> = [
  {
    value: "lead",
    label: "Lead · front three-quarter",
    detail: "Camera leads the subject, then lets them approach for a clear change in scale.",
  },
  {
    value: "side-track",
    label: "Track · side arc",
    detail: "Travels beside the subject while gradually changing the viewing angle.",
  },
  {
    value: "follow",
    label: "Follow · rear three-quarter",
    detail: "Follows from behind and opens toward the subject's side.",
  },
  {
    value: "push-in",
    label: "Push in",
    detail: "Moves from a wide side view into a tighter portrait.",
  },
  {
    value: "pull-out",
    label: "Pull out",
    detail: "Starts close and reveals more of the scene as the subject moves.",
  },
  {
    value: "orbit",
    label: "Arc around",
    detail: "Sweeps from rear three-quarter through profile to front three-quarter.",
  },
  {
    value: "crane-up",
    label: "Crane up · reveal space",
    detail: "Rises from character height into a high-angle environmental reveal.",
  },
  {
    value: "reveal",
    label: "Reveal · lateral parallax",
    detail: "Slides across the subject to uncover the scene with strong foreground parallax.",
  },
  {
    value: "arc-push",
    label: "Arc push · tightening orbit",
    detail: "Curves around the subject while moving into a tighter dramatic frame.",
  },
];

export interface DirectorStageUploadedPanorama {
  assetId: string;
  label: string;
  url: string;
  calibration?: DirectorStageEnvironmentCalibration;
}

export interface DirectorStagePanoramaGenerationInput {
  prompt: string;
  calibration: DirectorStageEnvironmentCalibration;
  referenceAssetId?: string;
  calibrationGrid?: boolean;
}

export interface DirectorStageUploadedModel {
  assetId: string;
  name: string;
  sourceUrl: string;
  provider?: string;
  modelEndpoint?: string;
  requestId?: string;
  thumbnailUrl?: string;
  animation?: DirectorBuiltinModelRig;
}

export interface DirectorStageModelGenerationInput {
  prompt: string;
  quality: "normal" | "low-poly" | "geometry";
  pbr: boolean;
  faceCount: number;
}

export interface DirectorStageCaptureInput {
  stageId: string;
  state: DirectorStageState;
  cameraId: string;
  aspectRatio: DirectorAspectRatio;
  timeSeconds: number;
  blob: Blob;
}

export type DirectorStageVideoExportMode =
  | "sequence-preview"
  | "selected-shots";

export interface DirectorStageVideoExportPlanItem {
  scope: "sequence" | "shot";
  shotId?: string;
  shotIds: string[];
  name: string;
  cameraId: string;
  aspectRatio: DirectorAspectRatio;
  startTime: number;
  durationSeconds: number;
}

export interface DirectorStageVideoExportRender
  extends DirectorStageVideoExportPlanItem {
  blob: Blob;
  referenceFrames: DirectorStageReferenceFrameCapture[];
}

export interface DirectorStageVideoExportInput {
  stageId: string;
  state: DirectorStageState;
  mode: DirectorStageVideoExportMode;
  fps: number;
  renders: DirectorStageVideoExportRender[];
}

export interface DirectorStageReferenceFrameRequest {
  shotId: string;
  name: string;
  cameraId: string;
  aspectRatio: DirectorAspectRatio;
  timeSeconds: number;
}

export interface DirectorStageReferenceFrameCapture
  extends DirectorStageReferenceFrameRequest {
  blob: Blob;
}

export interface ProjectDirectorStageSurfaceProps {
  projectId?: string;
  stage: ProjectDirectorStage;
  canvases: ProjectCanvas[];
  rightInset?: number;
  headerEndInset?: number;
  panoramaOptions?: DirectorStageUploadedPanorama[];
  modelAssetUrls?: Record<string, string>;
  onSave: (stageId: string, state: DirectorStageState) => boolean;
  onOpenCanvas: (canvasId: string) => void;
  onOpenAsset?: (assetId: string) => void;
  onUndo?: () => void;
  onAnnotationTargetContextMenu?: (target: AgentAnnotationObjectRef) => void;
  onCaptureShot: (input: DirectorStageCaptureInput) => Promise<void>;
  onExportVideo?: (input: DirectorStageVideoExportInput) => Promise<void>;
  onUploadModel?: (file: File) => Promise<DirectorStageUploadedModel>;
  onGenerateModel?: (
    input: DirectorStageModelGenerationInput,
  ) => Promise<DirectorStageUploadedModel>;
  onUploadPanorama?: (file: File) => Promise<DirectorStageUploadedPanorama>;
  onGeneratePanorama?: (
    input: DirectorStagePanoramaGenerationInput,
  ) => Promise<DirectorStageUploadedPanorama>;
}

export function buildDirectorPanoramaPrompt(
  brief: string,
  options: {
    calibrationGrid?: boolean;
    workingVolume?: DirectorStageWorkingVolume;
  } = {},
): string {
  const volume = options.workingVolume;
  return [
    brief.trim(),
    "Create a 360-degree equirectangular panorama for a 3D scene environment.",
    "Compose for an exact 2:1 panorama with a level horizon, full floor-to-sky coverage, and seamless left and right edges.",
    volume
      ? `Compose around a 1.6 m high capture origin for a bounded ${volume.size[0]} m wide × ${volume.size[2]} m deep × ${volume.size[1]} m high working space. Keep believable human-scale distances near the capture origin.`
      : "",
    options.calibrationGrid
      ? "Keep a level, unobstructed floor around the panorama capture origin. Do not draw any floor grid, ruler, axis, chroma line, origin marker, or other calibration geometry; Clash adds the metric calibration layer programmatically from projection metadata."
      : "",
    "Keep spatial scale and lighting coherent in every direction; no text, no frame, no watermark, and no visible camera rig.",
  ].filter(Boolean).join("\n\n");
}

export interface DirectorPanoramaGenerationSetup {
  mode: "background-sphere" | "bounded-box";
  modeLabel: string;
  detail: string;
  actionLabel: string;
  generatingLabel: string;
  receiptLabel: string;
  receiptDetail: string;
}

export function describeDirectorPanoramaGenerationSetup(
  workingVolume?: DirectorStageWorkingVolume,
): DirectorPanoramaGenerationSetup {
  const receiptDetail = "2:1 · 2048×1024 · calibration saved";
  if (!workingVolume) {
    return {
      mode: "background-sphere",
      modeLabel: "Background sphere",
      detail: "No physical size · camera rotation only · no translation parallax",
      actionLabel: "Generate background panorama",
      generatingLabel: "Generating background panorama…",
      receiptLabel: "Generated as Background sphere",
      receiptDetail,
    };
  }

  const preset = DIRECTOR_PANORAMA_WORKING_VOLUME_PRESETS.find(
    (candidate) => candidate.id === workingVolume.preset,
  );
  const modeLabel = preset?.label ?? "Custom space";
  const [width, height, depth] = workingVolume.size;
  const targetLabel = width === depth
    ? `${width} m stage`
    : `${width} × ${depth} m space`;
  return {
    mode: "bounded-box",
    modeLabel,
    detail: `${width} × ${depth} × ${height} m · 1.6 m capture origin · finite proxy projection`,
    actionLabel: `Generate for ${targetLabel}`,
    generatingLabel: `Generating for ${targetLabel}…`,
    receiptLabel: `Generated for ${modeLabel}`,
    receiptDetail,
  };
}

const PANORAMA_ENVIRONMENT_OPTIONS = [
  {
    value: "background-sphere",
    label: "Background sphere · no spatial size",
  },
  ...DIRECTOR_PANORAMA_WORKING_VOLUME_PRESETS.map((preset) => ({
    value: preset.id,
    label: `${preset.label} · ${preset.size[0]}×${preset.size[2]}×${preset.size[1]} m`,
  })),
  { value: "custom", label: "Custom space" },
];

export function prepareDirectorCaptureState(input: {
  state: DirectorStageState;
  viewMode: "director" | "camera";
  cameraPose: DirectorCameraPose;
  cameraId: string;
  cameraName: string;
}): { state: DirectorStageState; cameraId: string } {
  if (input.viewMode === "camera") {
    const activeCamera = input.state.cameras.find(
      (camera) => camera.id === input.state.activeCameraId,
    ) ?? input.state.cameras[0];
    if (!activeCamera) throw new Error("Add a camera before using Camera view");
    return { state: input.state, cameraId: activeCamera.id };
  }
  const result = applyDirectorStageCommand(input.state, {
    op: "camera.add",
    camera: {
      id: input.cameraId,
      name: input.cameraName,
      position: input.cameraPose.position,
      rotation: input.cameraPose.rotation,
      fov: input.cameraPose.fov,
      optics: createDirectorCameraOptics(input.cameraPose.fov),
    },
  });
  if (!result.ok) throw new Error(result.error);
  return {
    state: { ...result.state, activeCameraId: input.cameraId },
    cameraId: input.cameraId,
  };
}

function createDirectorCameraOptics(
  fov: number,
  previous?: DirectorCamera["optics"],
): NonNullable<DirectorCamera["optics"]> {
  return {
    projection: previous?.projection ?? "perspective",
    focalLengthMm: cameraFocalLengthFromFov(fov),
    sensorWidthMm: previous?.sensorWidthMm ?? 36,
    sensorHeightMm: previous?.sensorHeightMm ?? 24,
    focusDistanceM: previous?.focusDistanceM ?? 5,
    fStop: previous?.fStop ?? 2.8,
    shutterAngleDegrees: previous?.shutterAngleDegrees ?? 180,
    iso: previous?.iso ?? 400,
    nearClipM: previous?.nearClipM ?? 0.1,
    farClipM: previous?.farClipM ?? 1_000,
  };
}

function withDirectorCameraOptics(camera: DirectorCamera): DirectorCamera {
  return {
    ...camera,
    optics: createDirectorCameraOptics(camera.fov, camera.optics),
  };
}

function createId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${suffix}`;
}

function identityTransform(): DirectorStageTransform {
  return {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

export function directorUniformScale(value: number): DirectorStageVector3 {
  const normalized = Number.isFinite(value) ? Math.min(2, Math.max(0.5, value)) : 1;
  return [normalized, normalized, normalized];
}

export function directorReferenceFrameRequests(
  state: DirectorStageState,
  aspectRatio: DirectorAspectRatio,
  selectedShotIds?: string[],
): DirectorStageReferenceFrameRequest[] {
  const durationSeconds = state.animation?.durationSeconds ?? 10;
  const fps = state.animation?.fps ?? 30;
  const frameSeconds = 1 / Math.max(1, fps);
  const selected = selectedShotIds ? new Set(selectedShotIds) : undefined;
  const shots = [...(state.shotSequence ?? [])]
    .filter((shot) => !selected || selected.has(shot.id))
    .sort(
      (left, right) => left.startTime - right.startTime || left.id.localeCompare(right.id),
    );
  if (shots.length === 0) {
    const cameraId = state.activeCameraId ?? state.cameras[0]?.id;
    if (!cameraId) return [];
    const requests: DirectorStageReferenceFrameRequest[] = [{
      shotId: "reference-start",
      name: "Reference · Start",
      cameraId,
      aspectRatio,
      timeSeconds: 0,
    }];
    const endTime = Math.max(0, durationSeconds - frameSeconds);
    if (endTime > 0) {
      requests.push({
        shotId: "reference-end",
        name: "Reference · End",
        cameraId,
        aspectRatio,
        timeSeconds: endTime,
      });
    }
    return requests;
  }

  const requests = shots.map((shot) => ({
    shotId: shot.id,
    name: `${shot.name} · Start`,
    cameraId: shot.cameraId,
    aspectRatio,
    timeSeconds: shot.startTime,
  }));
  const finalShot = shots.at(-1)!;
  const finalTime = Math.max(
    finalShot.startTime,
    Math.min(
      durationSeconds,
      finalShot.startTime + finalShot.durationSeconds,
    ) - frameSeconds,
  );
  if (!requests.some(
    (request) =>
      request.cameraId === finalShot.cameraId
      && Math.abs(request.timeSeconds - finalTime) < frameSeconds / 2,
  )) {
    requests.push({
      shotId: finalShot.id,
      name: `${finalShot.name} · End`,
      cameraId: finalShot.cameraId,
      aspectRatio,
      timeSeconds: finalTime,
    });
  }
  return requests;
}

export function createDirectorVideoExportPlan(input: {
  state: DirectorStageState;
  aspectRatio: DirectorAspectRatio;
  mode: DirectorStageVideoExportMode;
  selectedShotIds?: string[];
}): DirectorStageVideoExportPlanItem[] {
  const shots = [...(input.state.shotSequence ?? [])].sort(
    (left, right) =>
      left.startTime - right.startTime || left.id.localeCompare(right.id),
  );
  if (input.mode === "sequence-preview") {
    const cameraId = shots[0]?.cameraId
      ?? input.state.activeCameraId
      ?? input.state.cameras[0]?.id;
    if (!cameraId) return [];
    return [{
      scope: "sequence",
      shotIds: shots.map((shot) => shot.id),
      name: "Sequence preview",
      cameraId,
      aspectRatio: input.aspectRatio,
      startTime: 0,
      durationSeconds: input.state.animation?.durationSeconds
        ?? (
          Math.max(0, ...shots.map((shot) => shot.startTime + shot.durationSeconds))
          || 10
        ),
    }];
  }

  const selected = new Set(input.selectedShotIds ?? []);
  return shots
    .filter((shot) => selected.has(shot.id))
    .map((shot) => ({
      scope: "shot" as const,
      shotId: shot.id,
      shotIds: [shot.id],
      name: shot.name,
      cameraId: shot.cameraId,
      aspectRatio: shot.aspectRatio,
      startTime: shot.startTime,
      durationSeconds: shot.durationSeconds,
    }));
}

type PoseJoint = typeof DIRECTOR_MANNEQUIN_POSE_JOINTS[number]["value"];

const jointAxes = [
  { index: 0, label: "Pitch", ariaLabel: "Joint pitch" },
  { index: 1, label: "Yaw", ariaLabel: "Joint yaw" },
  { index: 2, label: "Roll", ariaLabel: "Joint roll" },
] as const;

const THREE_DEGREES_TO_RADIANS = Math.PI / 180;
const THREE_RADIANS_TO_DEGREES = 180 / Math.PI;
const PANORAMA_CALIBRATION_PALETTE = {
  gridMinor: "#00ff66",
  gridMajor: "#00ff66",
  axisX: "#ff00ff",
  axisY: "#00ff66",
  axisZ: "#00d9ff",
} as const;

type DirectorMannequin = Extract<DirectorStageObject, { kind: "mannequin" }>;
type DirectorMannequinBodyType = DirectorMannequin["mannequin"]["bodyType"];

export const DIRECTOR_MANNEQUIN_BODY_TYPES = [
  { value: "neutral", label: "Neutral", color: "#e8ebef", token: "var(--clash-director-mannequin-neutral)" },
  { value: "masculine", label: "Masculine", color: "#7fa8d8", token: "var(--clash-director-mannequin-masculine)" },
  { value: "feminine", label: "Feminine", color: "#e4a7b0", token: "var(--clash-director-mannequin-feminine)" },
  { value: "broad", label: "Broad", color: "#d98a6d", token: "var(--clash-director-mannequin-broad)" },
  { value: "athletic", label: "Athletic", color: "#70b89a", token: "var(--clash-director-mannequin-athletic)" },
  { value: "slender", label: "Slender", color: "#b4a7d6", token: "var(--clash-director-mannequin-slender)" },
  { value: "youth", label: "Youth", color: "#e2b85e", token: "var(--clash-director-mannequin-youth)" },
  { value: "child", label: "Child", color: "#84bdd0", token: "var(--clash-director-mannequin-child)" },
  { value: "chibi", label: "Chibi", color: "#d99bc0", token: "var(--clash-director-mannequin-chibi)" },
] as const satisfies ReadonlyArray<{
  value: DirectorMannequinBodyType;
  label: string;
  color: string;
  token: string;
}>;

export function createDirectorMannequin(input: {
  id: string;
  index: number;
  bodyType?: DirectorMannequinBodyType;
}): DirectorMannequin {
  const body = DIRECTOR_MANNEQUIN_BODY_TYPES.find(
    (candidate) => candidate.value === (input.bodyType ?? "neutral"),
  ) ?? DIRECTOR_MANNEQUIN_BODY_TYPES[0];
  return {
    id: input.id,
    name: `Actor ${input.index + 1}`,
    kind: "mannequin",
    visible: true,
    color: body.color,
    transform: identityTransform(),
    mannequin: { bodyType: body.value, bodyShape: 0, pose: { preset: "standing", joints: {} } },
  };
}

function storyActor(
  id: string,
  name: string,
  bodyType: DirectorMannequinBodyType,
  position: DirectorStageVector3,
  rotation: DirectorStageVector3,
  index: number,
): DirectorMannequin {
  return {
    ...createDirectorMannequin({ id, index, bodyType }),
    name,
    transform: {
      position,
      rotation,
      scale: [1, 1, 1],
    },
  };
}

/**
 * Build a complete playable dialogue scene: blocking, acting beats, seven
 * camera setups, animated camera moves, and a persisted cut sequence.
 */
export function createDirectorThreeActorStory(
  state: DirectorStageState,
): DirectorStageState {
  const actorA = storyActor(
    "story-actor-a",
    "信使",
    "athletic",
    [-5, 0, 0.5],
    [0, Math.PI / 2, 0],
    0,
  );
  const actorB = storyActor(
    "story-actor-b",
    "等候者",
    "feminine",
    [1.2, 0, 0.8],
    [0, -Math.PI / 2, 0],
    1,
  );
  const actorC = storyActor(
    "story-actor-c",
    "观察者",
    "slender",
    [3.2, 0, -2.2],
    [0, -0.7, 0],
    2,
  );
  const cameras: DirectorStageState["cameras"] = ([
    {
      id: "story-camera-establish",
      name: "Establishing",
      position: [5.8, 3.2, 9],
      rotation: [0, 0, 0],
      fov: 44,
      targetObjectIds: [actorA.id, actorB.id, actorC.id],
      targetOffset: [0, 1.05, 0],
    },
    {
      id: "story-camera-lead",
      name: "Lead arrival",
      position: [-0.8, 1.65, 4.3],
      rotation: [0, 0, 0],
      fov: 46,
      targetObjectId: actorA.id,
      targetOffset: [0, 1.2, 0],
    },
    {
      id: "story-camera-ots",
      name: "Waiting reaction",
      position: [2.2, 1.7, 4.5],
      rotation: [0, 0, 0],
      fov: 45,
      targetObjectId: actorB.id,
      targetOffset: [0, 1.25, 0],
    },
    {
      id: "story-camera-reverse",
      name: "Reverse close-up",
      position: [1.6, 1.7, 3.5],
      rotation: [0, 0, 0],
      fov: 42,
      targetObjectId: actorA.id,
      targetOffset: [0, 1.3, 0],
    },
    {
      id: "story-camera-intervention",
      name: "Intervention pan",
      position: [3.8, 1.8, 5.5],
      rotation: [0, 0, 0],
      fov: 46,
      targetObjectId: actorC.id,
      targetOffset: [0, 1.1, 0],
    },
    {
      id: "story-camera-arc",
      name: "Three-shot arc",
      position: [0.8, 2.1, 7],
      rotation: [0, 0, 0],
      fov: 40,
      targetObjectIds: [actorA.id, actorB.id, actorC.id],
      targetOffset: [0, 1.1, 0],
    },
    {
      id: "story-camera-closing",
      name: "Closing pull-out",
      position: [0.8, 2.2, 6.4],
      rotation: [0, 0, 0],
      fov: 44,
      targetObjectIds: [actorA.id, actorB.id, actorC.id],
      targetOffset: [0, 1.05, 0],
    },
  ] satisfies DirectorStageState["cameras"]).map(withDirectorCameraOptics);
  const shotSequence: DirectorStageSequenceShot[] = [
    {
      id: "story-shot-establish",
      name: "Establishing push",
      cameraId: "story-camera-establish",
      startTime: 0,
      durationSeconds: 4,
      aspectRatio: "16:9",
      transition: "cut",
      storyBeatIds: ["story-beat-wait"],
      cameraMove: {
        preset: "push-in",
        easing: "linear",
        rig: {
          kind: "dolly",
          settleInSeconds: 0.45,
          settleOutSeconds: 0.45,
          path: {
            interpolation: "catmull-rom",
            points: [
              [5.8, 3.2, 9],
              [5.45, 3, 8.4],
              [5.1, 2.8, 7.8],
            ],
          },
          orientation: {
            mode: "fixed-target",
            target: [0, 1.15, 0],
          },
          lens: {
            mode: "locked",
            focalLengthMm: cameraFocalLengthFromFov(44),
          },
          maxAngularVelocityDegPerSecond: 28,
          maxAngularAccelerationDegPerSecondSquared: 56,
        },
      },
      composition: {
        primarySubjectId: actorB.id,
        secondarySubjectIds: [actorA.id, actorC.id],
        headroomRatio: 0.08,
        leadRoomRatio: 0.14,
        minimumCameraDistanceM: 2.5,
        minimumSubjectSeparationM: 0.65,
      },
    },
    {
      id: "story-shot-lead",
      name: "Lead arrival",
      cameraId: "story-camera-lead",
      startTime: 4,
      durationSeconds: 5,
      aspectRatio: "16:9",
      transition: "cut",
      storyBeatIds: ["story-beat-arrival"],
      cameraMove: {
        preset: "side-track",
        easing: "linear",
        rig: {
          kind: "truck",
          settleInSeconds: 0.45,
          settleOutSeconds: 0.45,
          path: {
            interpolation: "catmull-rom",
            points: [
              [-0.8, 1.65, 4.3],
              [1.1, 1.65, 4.2],
              [2.8, 1.65, 4],
            ],
          },
          orientation: {
            mode: "target-object",
            objectId: actorA.id,
            offset: [0, 1.2, 0],
            sampling: "live",
          },
          lens: {
            mode: "locked",
            focalLengthMm: cameraFocalLengthFromFov(46),
          },
          maxAngularVelocityDegPerSecond: 32,
          maxAngularAccelerationDegPerSecondSquared: 64,
        },
      },
      composition: {
        primarySubjectId: actorA.id,
        secondarySubjectIds: [actorB.id, actorC.id],
        headroomRatio: 0.09,
        leadRoomRatio: 0.18,
        minimumCameraDistanceM: 2.5,
        minimumSubjectSeparationM: 0.65,
      },
    },
    {
      id: "story-shot-ots",
      name: "Waiting reaction",
      cameraId: "story-camera-ots",
      startTime: 9,
      durationSeconds: 4,
      aspectRatio: "16:9",
      transition: "cut",
      storyBeatIds: ["story-beat-handover"],
      composition: {
        primarySubjectId: actorB.id,
        secondarySubjectIds: [actorA.id],
        headroomRatio: 0.08,
        leadRoomRatio: 0.14,
        minimumCameraDistanceM: 1.5,
        minimumSubjectSeparationM: 0.65,
        axis: {
          fromObjectId: actorA.id,
          toObjectId: actorB.id,
          cameraSide: "left",
        },
      },
    },
    {
      id: "story-shot-reverse",
      name: "Reverse close-up",
      cameraId: "story-camera-reverse",
      startTime: 13,
      durationSeconds: 4,
      aspectRatio: "16:9",
      transition: "cut",
      storyBeatIds: ["story-beat-interrupt"],
      composition: {
        primarySubjectId: actorA.id,
        secondarySubjectIds: [actorB.id],
        headroomRatio: 0.08,
        leadRoomRatio: 0.14,
        minimumCameraDistanceM: 1.5,
        minimumSubjectSeparationM: 0.65,
        axis: {
          fromObjectId: actorA.id,
          toObjectId: actorB.id,
          cameraSide: "left",
        },
      },
    },
    {
      id: "story-shot-intervention",
      name: "Intervention pan",
      cameraId: "story-camera-intervention",
      startTime: 17,
      durationSeconds: 5,
      aspectRatio: "16:9",
      transition: "cut",
      storyBeatIds: ["story-beat-confrontation"],
      cameraMove: {
        preset: "pan",
        easing: "linear",
        rig: {
          kind: "pan",
          settleInSeconds: 0.45,
          settleOutSeconds: 0.45,
          path: {
            interpolation: "linear",
            points: [
              [3.8, 1.8, 5.5],
              [3.8, 1.8, 5.5],
            ],
          },
          orientation: {
            mode: "target-object",
            objectId: actorC.id,
            offset: [0, 1.15, 0],
            sampling: "live",
          },
          lens: {
            mode: "locked",
            focalLengthMm: cameraFocalLengthFromFov(46),
          },
          maxAngularVelocityDegPerSecond: 26,
          maxAngularAccelerationDegPerSecondSquared: 52,
        },
      },
      composition: {
        primarySubjectId: actorC.id,
        secondarySubjectIds: [actorA.id, actorB.id],
        headroomRatio: 0.08,
        leadRoomRatio: 0.16,
        minimumCameraDistanceM: 2,
        minimumSubjectSeparationM: 0.65,
      },
    },
    {
      id: "story-shot-arc",
      name: "Three-shot arc",
      cameraId: "story-camera-arc",
      startTime: 22,
      durationSeconds: 5,
      aspectRatio: "16:9",
      transition: "dissolve",
      storyBeatIds: ["story-beat-triangle"],
      composition: {
        primarySubjectId: actorB.id,
        secondarySubjectIds: [actorA.id, actorC.id],
        headroomRatio: 0.08,
        leadRoomRatio: 0.14,
        minimumCameraDistanceM: 2.5,
        minimumSubjectSeparationM: 0.65,
      },
    },
    {
      id: "story-shot-closing",
      name: "Closing pull-out",
      cameraId: "story-camera-closing",
      startTime: 27,
      durationSeconds: 5,
      aspectRatio: "16:9",
      transition: "cut",
      storyBeatIds: ["story-beat-aftermath"],
      cameraMove: {
        preset: "crane-up",
        easing: "linear",
        rig: {
          kind: "crane",
          settleInSeconds: 0.45,
          settleOutSeconds: 0.45,
          path: {
            interpolation: "catmull-rom",
            points: [
              [0.8, 2.2, 6.4],
              [0.9, 2.55, 7.3],
              [1, 3, 8.5],
            ],
          },
          orientation: {
            mode: "fixed-target",
            target: [0.3, 1.1, 0.1],
          },
          lens: {
            mode: "locked",
            focalLengthMm: cameraFocalLengthFromFov(44),
          },
          maxAngularVelocityDegPerSecond: 24,
          maxAngularAccelerationDegPerSecondSquared: 48,
        },
      },
      composition: {
        primarySubjectId: actorB.id,
        secondarySubjectIds: [actorA.id, actorC.id],
        headroomRatio: 0.08,
        leadRoomRatio: 0.14,
        minimumCameraDistanceM: 2.5,
        minimumSubjectSeparationM: 0.65,
      },
    },
  ];
  const positionTrack = (
    targetId: string,
    keys: Array<{
      id: string;
      time: number;
      value: DirectorStageVector3;
      interpolation: DirectorKeyframeInterpolation;
    }>,
  ): DirectorAnimationTrack => ({
    id: `${targetId}-position`,
    targetId,
    property: "position",
    keyframes: keys,
  });

  return {
    ...state,
    scene: {
      ...state.scene,
      backgroundColor: "#111410",
      grid: { ...state.scene.grid, visible: true },
    },
    objects: [
      actorA,
      actorB,
      actorC,
      {
        id: "story-table",
        name: "Letter table",
        kind: "model",
        visible: true,
        transform: {
          position: [0.4, 0, 1.6],
          rotation: [0, 0, 0],
          scale: [1.1, 1.1, 1.1],
        },
        model: { assetId: "builtin:polyhaven:wooden-table-02" },
      },
      {
        id: "story-chair",
        name: "Waiting chair",
        kind: "model",
        visible: true,
        transform: {
          position: [1.2, 0, 0.8],
          rotation: [0, -Math.PI / 2, 0],
          scale: [1, 1, 1],
        },
        model: { assetId: "builtin:polyhaven:arm-chair-01" },
      },
      {
        id: "story-letter",
        name: "The letter",
        kind: "primitive",
        visible: true,
        color: "#d6cfb8",
        transform: {
          position: [0.4, 0.96, 1.6],
          rotation: [0, 0.15, 0],
          scale: [0.34, 0.025, 0.22],
        },
        primitive: { shape: "box" },
      },
      {
        id: "story-doorway",
        name: "Doorway",
        kind: "set",
        visible: true,
        color: "#34383a",
        transform: {
          position: [-6.2, 0, 0.5],
          rotation: [0, Math.PI / 2, 0],
          scale: [1.2, 1.2, 1.2],
        },
        set: { type: "doorway" },
      },
      {
        id: "story-window",
        name: "Window",
        kind: "set",
        visible: true,
        color: "#42525c",
        transform: {
          position: [4.3, 0, -2.8],
          rotation: [0, -0.7, 0],
          scale: [1.4, 1.3, 1],
        },
        set: { type: "window" },
      },
    ],
    cameras,
    activeCameraId: cameras[0]!.id,
    shotSequence,
    motionAssets: createDirectorBuiltinMotionAssets(),
    animation: {
      durationSeconds: 32,
      fps: 30,
      tracks: [
        positionTrack(actorA.id, [
          {
            id: "story-actor-a-hold",
            time: 0,
            value: [-5, 0, 0.5],
            interpolation: "hold",
          },
          {
            id: "story-actor-a-enter",
            time: 4,
            value: [-5, 0, 0.5],
            interpolation: "linear",
          },
          {
            id: "story-actor-a-arrive",
            time: 9,
            value: [-1, 0, 0.5],
            interpolation: "hold",
          },
          {
            id: "story-actor-a-end",
            time: 32,
            value: [-1, 0, 0.5],
            interpolation: "linear",
          },
        ]),
        positionTrack(actorC.id, [
          {
            id: "story-actor-c-hold",
            time: 0,
            value: [3.2, 0, -2.2],
            interpolation: "hold",
          },
          {
            id: "story-actor-c-step",
            time: 17,
            value: [3.2, 0, -2.2],
            interpolation: "linear",
          },
          {
            id: "story-actor-c-arrive",
            time: 22,
            value: [0.8, 0, -0.8],
            interpolation: "hold",
          },
          {
            id: "story-actor-c-end",
            time: 32,
            value: [0.8, 0, -0.8],
            interpolation: "linear",
          },
        ]),
      ],
      actionClips: [
        {
          id: "story-actor-b-sit",
          targetId: actorB.id,
          action: "sit",
          layer: "full-body",
          startTime: 0,
          durationSeconds: 32,
          blendInSeconds: 0.4,
          blendOutSeconds: 0.4,
          playbackRate: 1,
          motionAssetId: "motion:quaternius-universal-animation-standard:sit",
          loopMode: "repeat",
          rootMotionMode: "in-place",
          retargeting: {
            mode: "humanoid",
            targetRigProfileId: "clash-humanoid-v1",
          },
        },
        {
          id: "story-actor-a-interact",
          targetId: actorA.id,
          action: "interact",
          layer: "full-body",
          startTime: 9,
          durationSeconds: 4,
          blendInSeconds: 0.25,
          blendOutSeconds: 0.25,
          playbackRate: 1,
          motionAssetId: "motion:quaternius-casual-hoodie:interact",
          loopMode: "once",
          rootMotionMode: "in-place",
          retargeting: {
            mode: "humanoid",
            targetRigProfileId: "clash-humanoid-v1",
          },
        },
      ],
      storyBeats: [
        {
          id: "story-beat-wait",
          title: "等待",
          startTime: 0,
          durationSeconds: 4,
          participantIds: [actorB.id, actorC.id],
          dialogue: { speakerId: actorB.id, text: "他不会来了。" },
        },
        {
          id: "story-beat-arrival",
          title: "来信",
          startTime: 4,
          durationSeconds: 5,
          participantIds: [actorA.id, actorB.id, actorC.id],
          dialogue: { speakerId: actorA.id, text: "我只带来这个。" },
        },
        {
          id: "story-beat-handover",
          title: "交付",
          startTime: 9,
          durationSeconds: 4,
          participantIds: [actorA.id, actorB.id],
          dialogue: { speakerId: actorB.id, text: "你看过里面的内容？" },
        },
        {
          id: "story-beat-interrupt",
          title: "阻止",
          startTime: 13,
          durationSeconds: 4,
          participantIds: [actorA.id, actorB.id, actorC.id],
          dialogue: { speakerId: actorC.id, text: "先别拆。" },
        },
        {
          id: "story-beat-confrontation",
          title: "对峙",
          startTime: 17,
          durationSeconds: 5,
          participantIds: [actorA.id, actorB.id, actorC.id],
          dialogue: { speakerId: actorA.id, text: "现在已经太晚了。" },
        },
        {
          id: "story-beat-triangle",
          title: "三人关系",
          startTime: 22,
          durationSeconds: 5,
          participantIds: [actorA.id, actorB.id, actorC.id],
        },
        {
          id: "story-beat-aftermath",
          title: "余波",
          startTime: 27,
          durationSeconds: 5,
          participantIds: [actorA.id, actorB.id, actorC.id],
        },
      ],
      cameraCues: [
        {
          id: "story-cue-establish",
          name: "Establishing push",
          cameraId: "story-camera-establish",
          startTime: 0,
          durationSeconds: 4,
        },
        {
          id: "story-cue-lead",
          name: "Lead arrival",
          cameraId: "story-camera-lead",
          startTime: 4,
          durationSeconds: 5,
        },
        {
          id: "story-cue-ots",
          name: "Waiting reaction",
          cameraId: "story-camera-ots",
          startTime: 9,
          durationSeconds: 4,
        },
        {
          id: "story-cue-reverse",
          name: "Reverse close-up",
          cameraId: "story-camera-reverse",
          startTime: 13,
          durationSeconds: 4,
        },
        {
          id: "story-cue-intervention",
          name: "Intervention pan",
          cameraId: "story-camera-intervention",
          startTime: 17,
          durationSeconds: 5,
        },
        {
          id: "story-cue-arc",
          name: "Three-shot arc",
          cameraId: "story-camera-arc",
          startTime: 22,
          durationSeconds: 5,
        },
        {
          id: "story-cue-closing",
          name: "Closing pull-out",
          cameraId: "story-camera-closing",
          startTime: 27,
          durationSeconds: 5,
        },
      ],
    },
  };
}

export function createDirectorHorseRiderComposition(input: {
  horseId: string;
  riderId: string;
  index: number;
}): [Extract<DirectorStageObject, { kind: "creature" }>, DirectorMannequin] {
  const horse: Extract<DirectorStageObject, { kind: "creature" }> = {
    id: input.horseId,
    name: `Horse ${input.index + 1}`,
    kind: "creature",
    visible: true,
    color: "#7a5137",
    transform: identityTransform(),
    creature: { species: "horse", build: "warmblood", gait: "auto" },
  };
  const rider: DirectorMannequin = {
    ...createDirectorMannequin({ id: input.riderId, index: input.index }),
    name: `Rider ${input.index + 1}`,
    attachment: {
      parentId: input.horseId,
      socket: "saddle",
      offset: {
        position: [0, 1.62, -0.08],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    },
    mannequin: {
      bodyType: "neutral",
      bodyShape: 0,
      pose: { preset: "riding", joints: {} },
    },
  };
  return [horse, rider];
}

export const DIRECTOR_ACTION_OPTIONS: ReadonlyArray<{
  value: DirectorStageActionName;
  label: string;
}> = [
  { value: "idle", label: "Idle" },
  { value: "walk", label: "Walk" },
  { value: "run", label: "Run" },
  { value: "wave", label: "Wave" },
  { value: "sit", label: "Sit · Experimental" },
  { value: "crouch", label: "Crouch · Experimental" },
  { value: "kneel", label: "Kneel · Experimental" },
  { value: "point", label: "Point" },
  { value: "think", label: "Think" },
  { value: "hands-up", label: "Hands up" },
  { value: "interact", label: "Interact" },
  { value: "ride", label: "Ride" },
  { value: "dance", label: "Dance" },
  { value: "jump", label: "Jump" },
  { value: "push", label: "Push" },
  { value: "punch", label: "Punch" },
  { value: "drive", label: "Drive · Vehicle" },
];

export function createDirectorBuiltinMotionAssets(): DirectorStageMotionAsset[] {
  return CLASH_HUMANOID_ACTION_LIBRARY_V1.actions.map((action) => ({
    id: `motion:${action.sourceId}:${action.id}`,
    name: `${action.id[0]?.toUpperCase()}${action.id.slice(1)}`,
    assetId: action.sourceId === "quaternius-casual-hoodie"
      ? "builtin:quaternius:casual-hoodie"
      : "builtin:quaternius:universal-animation-standard",
    sourceFormat: action.sourceId === "quaternius-casual-hoodie" ? "gltf" : "glb",
    clipName: action.sourceClip,
    sourceRig: {
      profileId: CLASH_HUMANOID_ACTION_LIBRARY_V1.profileId,
      skeletonType: "biped",
      restPose: "t-pose",
      upAxis: CLASH_HUMANOID_COORDINATE_SYSTEM.upAxis,
      forwardAxis: CLASH_HUMANOID_COORDINATE_SYSTEM.forwardAxis,
      metersPerUnit: CLASH_HUMANOID_COORDINATE_SYSTEM.unitMeters,
      rootBone: "root",
      hipsBone: "pelvis",
    },
    tags: [
      action.id,
      action.layer,
      action.loop ? "loop" : "one-shot",
      "CC0-1.0",
    ],
  }));
}

export function directorActionDefaultLayer(
  action: DirectorStageActionName,
): DirectorStageActionLayer {
  return ["wave", "point", "think", "hands-up"].includes(action)
    ? "upper-body"
    : "full-body";
}

export function createDirectorActionClip(input: {
  id: string;
  targetId: string;
  action: DirectorStageActionName;
  layer: DirectorStageActionLayer;
  startTime: number;
  durationSeconds: number;
  blendSeconds: number;
  timelineDurationSeconds: number;
  fps: number;
}): DirectorStageActionClip {
  const frameSeconds = 1 / Math.max(1, input.fps);
  const startTime = Math.min(
    Math.max(0, input.timelineDurationSeconds - frameSeconds),
    Math.max(0, input.startTime),
  );
  const durationSeconds = Math.max(
    frameSeconds,
    Math.min(input.durationSeconds, input.timelineDurationSeconds - startTime),
  );
  const blendSeconds = Math.min(
    durationSeconds / 2,
    Math.max(0, input.blendSeconds),
  );
  return {
    id: input.id,
    targetId: input.targetId,
    action: input.action,
    layer: input.layer,
    startTime,
    durationSeconds,
    blendInSeconds: blendSeconds,
    blendOutSeconds: blendSeconds,
    playbackRate: 1,
  };
}

function directorAddCameraOffset(
  origin: DirectorStageVector3,
  forward: DirectorStageVector3,
  forwardMeters: number,
  right: DirectorStageVector3,
  rightMeters: number,
  heightMeters: number,
): DirectorStageVector3 {
  return [
    origin[0] + forward[0] * forwardMeters + right[0] * rightMeters,
    origin[1] + heightMeters,
    origin[2] + forward[2] * forwardMeters + right[2] * rightMeters,
  ];
}

function directorCameraPathPoint(
  from: DirectorStageVector3,
  to: DirectorStageVector3,
  progress: number,
): DirectorStageVector3 {
  return from.map((component, index) => (
    component + (to[index]! - component) * progress
  )) as DirectorStageVector3;
}

export function buildDirectorCameraMoveCommands({
  state,
  cameraId,
  targetObjectId,
  preset,
  shotId,
}: {
  state: DirectorStageState;
  cameraId: string;
  targetObjectId: string;
  preset: DirectorCameraMovePreset;
  shotId?: string;
}): DirectorStageCommand[] {
  const animation = state.animation;
  const camera = state.cameras.find((candidate) => candidate.id === cameraId);
  const shot = state.shotSequence?.find((candidate) => (
    candidate.id === shotId
  )) ?? state.shotSequence?.find((candidate) => candidate.cameraId === cameraId);
  if (!animation || !camera || !shot || shot.cameraId !== cameraId) return [];
  const sampleTimes = [
    shot.startTime,
    shot.startTime + shot.durationSeconds / 2,
    shot.startTime + shot.durationSeconds,
  ];
  const targets = sampleTimes.map((time) => (
    evaluateDirectorStage(state, time).objects.find(
      (candidate) => candidate.id === targetObjectId,
    )
  ));
  const firstTarget = targets[0];
  const middleTarget = targets[1];
  const lastTarget = targets[2];
  if (!firstTarget || !middleTarget || !lastTarget) return [];
  const firstPosition = firstTarget.transform.position;
  const middlePosition = middleTarget.transform.position;
  const lastPosition = lastTarget.transform.position;
  const travel: DirectorStageVector3 = [
    lastPosition[0] - firstPosition[0],
    0,
    lastPosition[2] - firstPosition[2],
  ];
  const travelLength = Math.hypot(travel[0], travel[2]);
  const forward: DirectorStageVector3 = travelLength > 0.05
    ? [travel[0] / travelLength, 0, travel[2] / travelLength]
    : [
        Math.sin(firstTarget.transform.rotation[1]),
        0,
        Math.cos(firstTarget.transform.rotation[1]),
      ];
  const right: DirectorStageVector3 = [
    forward[2],
    0,
    -forward[0],
  ];
  const targetOffset: DirectorStageVector3 =
    firstTarget.kind === "mannequin" || firstTarget.kind === "crowd"
      ? [0, 1.2, 0]
      : directorDefaultFocusOffset(firstTarget);
  const fixedTarget: DirectorStageVector3 = [
    middlePosition[0] + targetOffset[0],
    middlePosition[1] + targetOffset[1],
    middlePosition[2] + targetOffset[2],
  ];
  const evaluatedCamera = evaluateDirectorStage(state, shot.startTime).cameras.find(
    (candidate) => candidate.id === cameraId,
  ) ?? camera;
  const startCamera = [...evaluatedCamera.position] as DirectorStageVector3;
  const focalLengthMm = camera.optics?.focalLengthMm
    ?? cameraFocalLengthFromFov(camera.fov);
  const settleSeconds = Math.min(0.45, shot.durationSeconds * 0.12);
  const trackedOrientation: DirectorStageCameraRig["orientation"] = {
    mode: "target-object",
    objectId: targetObjectId,
    offset: targetOffset,
    sampling: "live",
  };
  const lockedOrientation: DirectorStageCameraRig["orientation"] = {
    mode: "fixed-target",
    target: fixedTarget,
  };
  const pathFromOffsets = (
    forwardMeters: readonly [number, number, number],
    rightMeters: readonly [number, number, number],
    heights: readonly [number, number, number],
  ): DirectorStageVector3[] => (
    [firstPosition, middlePosition, lastPosition].map((position, index) => (
      directorAddCameraOffset(
        position,
        forward,
        forwardMeters[index]!,
        right,
        rightMeters[index]!,
        heights[index]!,
      )
    ))
  );
  const radial: DirectorStageVector3 = [
    startCamera[0] - fixedTarget[0],
    0,
    startCamera[2] - fixedTarget[2],
  ];
  const radialLength = Math.max(2.6, Math.hypot(radial[0], radial[2]));
  const radialDirection: DirectorStageVector3 = Math.hypot(radial[0], radial[2]) > 0.05
    ? [radial[0] / Math.hypot(radial[0], radial[2]), 0, radial[2] / Math.hypot(radial[0], radial[2])]
    : [0, 0, 1];
  const radialPoint = (distance: number, height = startCamera[1]): DirectorStageVector3 => [
    fixedTarget[0] + radialDirection[0] * distance,
    height,
    fixedTarget[2] + radialDirection[2] * distance,
  ];
  let rig: DirectorStageCameraRig;
  if (preset === "orbit") {
    const startAngleDegrees = Math.atan2(radial[0], radial[2]) * 180 / Math.PI;
    rig = {
      kind: "orbit",
      settleInSeconds: settleSeconds,
      settleOutSeconds: settleSeconds,
      orbit: {
        pivot: fixedTarget,
        radius: radialLength,
        height: startCamera[1],
        startAngleDegrees,
        endAngleDegrees: startAngleDegrees + 42,
      },
      orientation: lockedOrientation,
      lens: { mode: "locked", focalLengthMm },
      maxAngularVelocityDegPerSecond: 35,
      maxAngularAccelerationDegPerSecondSquared: 70,
    };
  } else {
    let kind: DirectorStageCameraRig["kind"] = "dolly";
    let path: DirectorStageVector3[];
    let orientation: DirectorStageCameraRig["orientation"] = lockedOrientation;
    if (preset === "lead") {
      path = pathFromOffsets([4.2, 4, 3.8], [1.8, 1.6, 1.4], [1.65, 1.65, 1.65]);
      orientation = trackedOrientation;
    } else if (preset === "follow") {
      path = pathFromOffsets([-4.4, -4.2, -4], [1.4, 1.25, 1.1], [1.65, 1.65, 1.65]);
      orientation = trackedOrientation;
    } else if (preset === "side-track") {
      kind = "truck";
      path = pathFromOffsets([-0.5, 0, 0.5], [3.8, 3.6, 3.4], [1.6, 1.6, 1.6]);
      orientation = trackedOrientation;
    } else if (preset === "crane-up") {
      kind = "crane";
      path = [
        startCamera,
        directorAddCameraOffset(startCamera, forward, -0.8, right, 0.3, 1.9),
        directorAddCameraOffset(startCamera, forward, -1.8, right, 0.7, 3.8),
      ];
    } else if (preset === "reveal") {
      kind = "truck";
      path = [
        directorAddCameraOffset(startCamera, forward, 0, right, -2.4, 0),
        startCamera,
        directorAddCameraOffset(startCamera, forward, 0, right, 2.4, 0),
      ];
    } else if (preset === "arc-push") {
      path = [
        directorAddCameraOffset(radialPoint(radialLength), forward, 0, right, -1.6, 0),
        directorAddCameraOffset(radialPoint(radialLength * 0.88), forward, 0, right, 0, 0.15),
        directorAddCameraOffset(radialPoint(radialLength * 0.72), forward, 0, right, 1.2, 0.2),
      ];
    } else if (preset === "pull-out") {
      path = [
        radialPoint(Math.max(2.6, radialLength - 1.2)),
        radialPoint(radialLength + 0.5),
        radialPoint(radialLength + 2.2),
      ];
    } else {
      path = [
        radialPoint(radialLength + 1.8),
        radialPoint(radialLength),
        radialPoint(Math.max(2.6, radialLength - 1.6)),
      ];
    }
    rig = {
      kind,
      settleInSeconds: settleSeconds,
      settleOutSeconds: settleSeconds,
      path: {
        interpolation: "catmull-rom",
        points: path,
      },
      orientation,
      lens: { mode: "locked", focalLengthMm },
      maxAngularVelocityDegPerSecond: 35,
      maxAngularAccelerationDegPerSecondSquared: 70,
    };
  }

  return [{
    op: "sequence-shot.upsert",
    durationSeconds: animation.durationSeconds,
    fps: animation.fps,
    shot: {
      ...shot,
      cameraMove: {
        preset,
        easing: "linear",
        rig,
      },
      composition: {
        primarySubjectId: targetObjectId,
        secondarySubjectIds: shot.composition?.secondarySubjectIds,
        headroomRatio: shot.composition?.headroomRatio ?? 0.08,
        leadRoomRatio: shot.composition?.leadRoomRatio ?? 0.16,
        minimumCameraDistanceM: shot.composition?.minimumCameraDistanceM ?? 1.5,
        minimumSubjectSeparationM:
          shot.composition?.minimumSubjectSeparationM ?? 0.65,
        axis: shot.composition?.axis,
      },
    },
  }];
}

const labelClass =
  "mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--clash-director-panel-muted)]";
const fieldClass =
  "h-8 min-w-0 rounded-md border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2 text-[11px] text-[var(--clash-director-panel-text)] shadow-none";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );
}

function DirectorSelectedKeyframeEditor({
  track,
  keyframe,
  durationSeconds,
  fps,
  onChange,
  onUpdateFromCurrent,
  onRemove,
}: {
  track: DirectorAnimationTrack;
  keyframe: DirectorAnimationKeyframe;
  durationSeconds: number;
  fps: number;
  onChange: (patch: Partial<DirectorAnimationKeyframe>) => void;
  onUpdateFromCurrent?: () => void;
  onRemove: () => void;
}) {
  return (
    <section
      data-director-keyframe-inspector={keyframe.id}
      className="space-y-2 border-t border-[var(--clash-director-panel-divider)] pt-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className={labelClass}>Selected keyframe</span>
          <strong className="block truncate text-xs capitalize text-[var(--clash-director-panel-text)]">
            {track.property} · {keyframe.time.toFixed(2)}s
          </strong>
        </div>
        <Button
          variant={null}
          size="sm"
          shape="rounded"
          leftIcon={<Trash className="h-3.5 w-3.5" />}
          onClick={onRemove}
          className="h-7 min-h-7 bg-transparent px-2 text-[10px] text-[var(--clash-director-danger)] shadow-none hover:bg-[var(--clash-director-danger-soft)]"
        >
          Remove keyframe
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Time · seconds">
          <Input
            aria-label="Selected keyframe time"
            type="number"
            min="0"
            max={durationSeconds}
            step={1 / fps}
            value={Number(keyframe.time.toFixed(3))}
            onChange={(event) => onChange({
              time: Math.min(durationSeconds, Math.max(0, Number(event.target.value))),
            })}
            className={fieldClass}
          />
        </Field>
        <Field label="Interpolation">
          <SelectMenu
            ariaLabel="Selected keyframe interpolation"
            value={keyframe.interpolation}
            options={[
              { value: "bezier", label: "Smooth" },
              { value: "linear", label: "Linear" },
              { value: "hold", label: "Hold" },
            ]}
            onValueChange={(value) => onChange({
              interpolation: value as DirectorKeyframeInterpolation,
            })}
            variant="field"
          />
        </Field>
      </div>
      {onUpdateFromCurrent ? (
        <Button
          variant={null}
          size="sm"
          shape="rounded"
          onClick={onUpdateFromCurrent}
          className="h-8 min-h-8 w-full border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2 text-[10px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
        >
          Update key from current value
        </Button>
      ) : null}
      <p className="text-[9px] text-[var(--clash-director-panel-muted)]">
        Drag the diamond to retime. Arrow keys nudge one frame; Shift nudges ten.
      </p>
    </section>
  );
}

function VectorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: [number, number, number];
  onChange: (value: [number, number, number]) => void;
}) {
  return (
    <Field label={label}>
      <div className="grid grid-cols-3 gap-1">
        {value.map((component, index) => (
          <Input
            key={index}
            aria-label={`${label} ${["X", "Y", "Z"][index]}`}
            type="number"
            step="0.1"
            value={component}
            onChange={(event) => {
              const next = [...value] as [number, number, number];
              next[index] = Number(event.target.value);
              onChange(next);
            }}
            className={fieldClass}
          />
        ))}
      </div>
    </Field>
  );
}

function CameraAngleField({
  value,
  disabled = false,
  onChange,
}: {
  value: DirectorStageVector3;
  disabled?: boolean;
  onChange: (value: DirectorStageVector3) => void;
}) {
  const axes = [
    { index: 0, label: "Pitch", ariaLabel: "Camera pitch" },
    { index: 1, label: "Yaw", ariaLabel: "Camera yaw" },
    { index: 2, label: "Roll", ariaLabel: "Camera roll" },
  ] as const;
  return (
    <Field label="Angle · degrees">
      <div className="grid grid-cols-3 gap-1">
        {axes.map((axis) => (
          <label key={axis.label} className="min-w-0">
            <span className="mb-1 block text-[9px] text-[var(--clash-director-panel-muted)]">{axis.label}</span>
            <Input
              aria-label={axis.ariaLabel}
              type="number"
              step="1"
              disabled={disabled}
              value={Number((value[axis.index] * THREE_RADIANS_TO_DEGREES).toFixed(1))}
              onChange={(event) => {
                const next = [...value] as DirectorStageVector3;
                next[axis.index] = Number(event.target.value) * THREE_DEGREES_TO_RADIANS;
                onChange(next);
              }}
              className={fieldClass}
            />
          </label>
        ))}
      </div>
    </Field>
  );
}

function SceneRow({
  label,
  icon,
  active,
  visible,
  onClick,
  onContextMenu,
  onToggleVisible,
  annotationTarget,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  visible?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: () => void;
  onToggleVisible?: () => void;
  annotationTarget?: AgentAnnotationObjectRef;
}) {
  return (
    <div className="group flex items-center gap-0.5">
      <button
        type="button"
        aria-pressed={active}
        data-agent-annotation-object-id={annotationTarget?.objectId}
        data-agent-annotation-object-type={annotationTarget?.objectType}
        data-agent-annotation-object-label={annotationTarget?.objectLabel}
        data-agent-annotation-parent-id={annotationTarget?.parentId}
        onClick={onClick}
        onContextMenu={onContextMenu}
        className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs ${
          active
            ? "bg-[var(--clash-director-panel-active)] font-semibold text-[var(--clash-director-panel-text)]"
            : "text-[var(--clash-director-panel-secondary)] hover:bg-[var(--clash-director-panel-hover)]"
        }`}
      >
        <span className={active ? "text-[var(--clash-director-selection)]" : "text-[var(--clash-director-panel-muted)]"}>
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </button>
      {onToggleVisible ? (
        <IconButton
          label={`${visible ? "Hide" : "Show"} ${label}`}
          icon={visible ? <Eye className="h-3.5 w-3.5" /> : <EyeSlash className="h-3.5 w-3.5" />}
          size="sm"
          shape="rounded"
          onClick={onToggleVisible}
          className="h-7 min-h-7 w-7 min-w-7 bg-transparent text-[var(--clash-director-panel-muted)] opacity-0 shadow-none hover:bg-[var(--clash-director-panel-hover)] group-hover:opacity-100 focus-visible:opacity-100"
        />
      ) : null}
    </div>
  );
}

function DirectorModelLibrary({
  open,
  query,
  onQueryChange,
  onClose,
  onAdd,
  onUpload,
}: {
  open: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onAdd: (asset: DirectorBuiltinModelAsset) => void;
  onUpload?: () => void;
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const assets = DIRECTOR_BUILTIN_MODEL_ASSETS.filter((asset) =>
    `${asset.name} ${asset.category} ${asset.description} ${asset.sourceName}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Production assets"
      description="Authored GLB/glTF models with real geometry and PBR materials. Included starter assets are CC0."
      size="xl"
      contentClassName="h-[min(720px,85vh)] overflow-hidden p-0"
    >
      <div className="flex h-full min-h-0 flex-col pt-16">
        <div className="flex items-center gap-2 border-y border-warm-border px-5 py-3">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            <Input
              aria-label="Search production assets"
              placeholder="Search characters, animals, furniture, props…"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              className="h-10 pl-9"
            />
          </div>
          <Button
            type="button"
            variant="default"
            disabled={!onUpload}
            onClick={onUpload}
            className="h-10 shrink-0"
          >
            <UploadSimple className="h-4 w-4" />
            Import GLB/glTF
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {assets.length ? (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              {assets.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => onAdd(asset)}
                  className="group overflow-hidden rounded-xl border border-warm-border bg-warm-surface text-left transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="aspect-[4/3] overflow-hidden bg-stone-100 dark:bg-slate-950">
                    <img
                      src={asset.thumbnailUrl}
                      alt=""
                      className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                    />
                  </div>
                  <div className="space-y-1.5 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <strong className="text-sm text-slate-900 dark:text-slate-50">{asset.name}</strong>
                      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold text-stone-600 dark:bg-slate-800 dark:text-slate-300">{asset.category}</span>
                    </div>
                    <p className="line-clamp-2 text-xs leading-5 text-stone-600 dark:text-slate-400">{asset.description}</p>
                    <div className="flex items-center gap-1.5 text-[10px] font-medium text-stone-500 dark:text-slate-500">
                      <span>{asset.sourceName}</span>
                      <span aria-hidden="true">·</span>
                      <span>CC0</span>
                      {asset.rig ? <><span aria-hidden="true">·</span><span>Rigged · {asset.rig.clipNames.length} clips</span></> : null}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex h-48 items-center justify-center text-sm text-stone-500">No matching assets</div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function ProjectDirectorStageSurface({
  projectId,
  stage,
  canvases,
  rightInset = 0,
  headerEndInset = 0,
  panoramaOptions = [],
  modelAssetUrls = {},
  onSave,
  onOpenCanvas,
  onOpenAsset,
  onUndo,
  onAnnotationTargetContextMenu,
  onCaptureShot,
  onExportVideo,
  onUploadModel,
  onGenerateModel,
  onUploadPanorama,
  onGeneratePanorama,
}: ProjectDirectorStageSurfaceProps) {
  const code = useDirectorCodeSources(projectId, stage.state.codeComponents);
  const viewportRef = useRef<DirectorViewportHandle>(null);
  const [viewportReady, setViewportReady] = useState(false);
  useEffect(() => { if (!code.ready) setViewportReady(false); }, [code.ready]);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const panoramaInputRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLElement>(null);
  const [timelineWidth, setTimelineWidth] = useState(1200);
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>();
  const [transformMode, setTransformMode] = useState<DirectorTransformMode>("translate");
  const [viewMode, setViewMode] = useState<"director" | "camera">("director");
  const [viewPreset, setViewPreset] = useState<DirectorViewPreset>("reset");
  const [aspectRatio, setAspectRatio] = useState<DirectorAspectRatio>("16:9");
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [search, setSearch] = useState("");
  const [modelLibraryOpen, setModelLibraryOpen] = useState(false);
  const [modelLibraryQuery, setModelLibraryQuery] = useState("");
  const [captureStatus, setCaptureStatus] = useState<"idle" | "capturing" | "error">("idle");
  const [videoExportStatus, setVideoExportStatus] = useState<"idle" | "exporting" | "error">("idle");
  const [uploadedPanoramas, setUploadedPanoramas] = useState<DirectorStageUploadedPanorama[]>([]);
  const [showPanoramaBackground, setShowPanoramaBackground] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [selectedPoseJoint, setSelectedPoseJoint] = useState<PoseJoint>("torso");
  const [objectInspectorTab, setObjectInspectorTab] = useState<"properties" | "pose" | "motion">("properties");
  const [selectedActionClipId, setSelectedActionClipId] = useState<string>();
  const [selectedSequenceShotIds, setSelectedSequenceShotIds] = useState<string[]>([]);
  const [primarySequenceShotId, setPrimarySequenceShotId] = useState<string>();
  const [shotSelectionAnchorId, setShotSelectionAnchorId] = useState<string>();
  const setSelectedSequenceShotId = useCallback((shotId?: string) => {
    setSelectedSequenceShotIds(shotId ? [shotId] : []);
    setPrimarySequenceShotId(shotId);
    setShotSelectionAnchorId(shotId);
  }, []);
  const selectedSequenceShotId = primarySequenceShotId;
  const [selectedKeyframeRef, setSelectedKeyframeRef] = useState<{
    trackId: string;
    keyframeId: string;
  }>();
  const [newKeyInterpolation, setNewKeyInterpolation] = useState<DirectorKeyframeInterpolation>("linear");
  const [cameraMovePreset, setCameraMovePreset] = useState<DirectorCameraMovePreset>("lead");
  const [actionName, setActionName] = useState<DirectorStageActionName>("walk");
  const [actionLayer, setActionLayer] = useState<DirectorStageActionLayer>("full-body");
  const [actionDuration, setActionDuration] = useState(2);
  const [actionTransition, setActionTransition] = useState(0.2);
  const [panoramaPrompt, setPanoramaPrompt] = useState("");
  const [panoramaReferenceAssetId, setPanoramaReferenceAssetId] = useState("none");
  const [panoramaCalibrationGrid, setPanoramaCalibrationGrid] = useState(false);
  const [panoramaCalibrationLocked, setPanoramaCalibrationLocked] = useState(false);
  const [panoramaGenerationStatus, setPanoramaGenerationStatus] = useState<
    "idle" | "generating" | "error"
  >("idle");
  const [panoramaGenerationError, setPanoramaGenerationError] = useState("");
  const [panoramaGenerationReceipt, setPanoramaGenerationReceipt] = useState<
    DirectorPanoramaGenerationSetup
  >();
  const [modelPrompt, setModelPrompt] = useState("");
  const [modelQuality, setModelQuality] = useState<DirectorStageModelGenerationInput["quality"]>("normal");
  const [modelPbr, setModelPbr] = useState(true);
  const [modelFaceCount, setModelFaceCount] = useState(500_000);
  const [modelGenerationStatus, setModelGenerationStatus] = useState<
    "idle" | "generating" | "error"
  >("idle");
  const [modelGenerationError, setModelGenerationError] = useState("");
  const [modelGenerationReceipt, setModelGenerationReceipt] = useState<DirectorStageUploadedModel>();
  const [mountHorseId, setMountHorseId] = useState("");

  const state = stage.state;
  const selectedObjectId = selectedObjectIds.at(-1);
  const selectedObject = state.objects.find((object) => object.id === selectedObjectId);
  const selectedBuiltinModelAsset = selectedObject?.kind === "model"
    ? DIRECTOR_BUILTIN_MODEL_ASSETS.find(
        (asset) => asset.id === selectedObject.model.assetId,
      )
    : undefined;
  const selectedModelRig = selectedObject?.kind === "model"
    ? selectedObject.model.animation ?? selectedBuiltinModelAsset?.rig
    : undefined;
  const hasObjectMotionInspector = selectedObject?.kind === "mannequin" || Boolean(selectedModelRig);
  const availableActionOptions = selectedModelRig
    ? DIRECTOR_ACTION_OPTIONS.filter((option) => selectedModelRig.actionMap[option.value])
    : DIRECTOR_ACTION_OPTIONS;
  const horses = state.objects.filter(
    (object): object is Extract<DirectorStageObject, { kind: "creature" }> =>
      object.kind === "creature" && object.creature.species === "horse",
  );
  const selectedCamera = state.cameras.find((camera) => camera.id === selectedCameraId);
  const selectedSequenceShot = state.shotSequence?.find(
    (shot) => shot.id === selectedSequenceShotId,
  );
  const selectedShotCompositionIssues = useMemo(() => {
    if (!selectedSequenceShot?.composition) return [];
    const issues = auditDirectorShotComposition(state, selectedSequenceShot.id);
    const unique = new Map<string, (typeof issues)[number]>();
    for (const issue of issues) {
      unique.set(`${issue.code}:${issue.objectId ?? ""}`, issue);
    }
    return [...unique.values()];
  }, [selectedSequenceShot, state]);
  const inspectorMode = selectedObject ? "object" : selectedCamera ? "camera" : "scene";
  const parentCanvasId = stage.owner.kind === "canvas-action"
    ? stage.owner.canvasId
    : undefined;
  const parentCanvas = parentCanvasId
    ? canvases.find((canvas) => canvas.id === parentCanvasId)
    : undefined;
  const allPanoramas = useMemo(() => {
    const byId = new Map<string, DirectorStageUploadedPanorama>();
    for (const item of [...panoramaOptions, ...uploadedPanoramas]) byId.set(item.assetId, item);
    return [...byId.values()];
  }, [panoramaOptions, uploadedPanoramas]);
  const environmentUrl = allPanoramas.find(
    (item) => item.assetId === state.scene.environmentAssetId,
  )?.url;
  const activePanoramaCalibration = state.scene.environmentCalibration
    ?? createDirectorPanoramaCalibration();
  const activePanoramaVolume = directorPanoramaWorkingVolume(activePanoramaCalibration);
  const panoramaGenerationSetup = describeDirectorPanoramaGenerationSetup(
    activePanoramaVolume,
  );
  const environmentRotation = state.scene.environmentRotation ?? [0, 0, 0];
  const panoramaCalibrationCamera = panoramaCalibrationLocked && state.scene.environmentCalibration
    ? directorPanoramaCalibrationCamera(state.scene.environmentCalibration)
    : undefined;
  const panoramaCalibrationPalette = panoramaCalibrationLocked
    ? PANORAMA_CALIBRATION_PALETTE
    : undefined;
  const environmentHorizonDegrees = Math.round(environmentRotation[0] / THREE_DEGREES_TO_RADIANS);
  const environmentYawDegrees = Math.round(environmentRotation[1] / THREE_DEGREES_TO_RADIANS);
  const timelineTargetLabels = useMemo(() => Object.fromEntries([
    ...state.objects.map((object) => [object.id, object.name]),
    ...state.cameras.map((camera) => [camera.id, camera.name]),
  ]), [state.cameras, state.objects]);
  const evaluatedStage = useMemo(
    () => evaluateDirectorStage(state, playheadSeconds),
    [playheadSeconds, state],
  );

  useEffect(() => {
    if (!selectedActionClipId) return;
    const clip = state.animation?.actionClips?.find(
      (candidate) => candidate.id === selectedActionClipId,
    );
    if (!clip || clip.targetId !== selectedObjectId) {
      setSelectedActionClipId(undefined);
      return;
    }
    setActionName(clip.action);
    setActionLayer(clip.layer);
    setActionDuration(clip.durationSeconds);
    setActionTransition(Math.max(clip.blendInSeconds, clip.blendOutSeconds));
  }, [selectedActionClipId, selectedObjectId, state.animation?.actionClips]);

  useEffect(() => {
    const available = new Set((state.shotSequence ?? []).map((shot) => shot.id));
    setSelectedSequenceShotIds((current) => {
      const next = current.filter((shotId) => available.has(shotId));
      return next.length === current.length ? current : next;
    });
    if (primarySequenceShotId && !available.has(primarySequenceShotId)) {
      setPrimarySequenceShotId(undefined);
    }
    if (shotSelectionAnchorId && !available.has(shotSelectionAnchorId)) {
      setShotSelectionAnchorId(undefined);
    }
  }, [primarySequenceShotId, shotSelectionAnchorId, state.shotSequence]);

  useEffect(() => {
    if (selectedObject?.kind === "mannequin") return;
    if (objectInspectorTab === "pose" || (objectInspectorTab === "motion" && !selectedModelRig)) {
      setObjectInspectorTab("properties");
    }
    if (!selectedModelRig) return;
    setActionLayer("full-body");
    if (!selectedModelRig.actionMap[actionName]) {
      setActionName(selectedModelRig.actionMap.walk ? "walk" : "idle");
    }
  }, [actionName, objectInspectorTab, selectedModelRig, selectedObject?.kind]);

  useEffect(() => {
    if (mountHorseId && horses.some((horse) => horse.id === mountHorseId)) return;
    setMountHorseId(horses[0]?.id ?? "");
  }, [horses, mountHorseId]);

  const save = useCallback((next: DirectorStageState) => onSave(stage.id, next), [onSave, stage.id]);
  const stageThreeActorStory = useCallback(() => {
    if (state.objects.length > 0 || state.cameras.length > 0) return;
    if (!save(createDirectorThreeActorStory(state))) return;
    setSelectedObjectIds([]);
    setSelectedCameraId("story-camera-establish");
    setViewMode("camera");
    setPlayheadSeconds(0);
    setPlaying(false);
  }, [save, state]);
  const apply = useCallback((command: DirectorStageCommand): boolean => {
    const result = applyDirectorStageCommand(state, command);
    if (!result.ok) {
      console.warn(`[Director Stage] ${result.error}`);
      return false;
    }
    return save(result.state);
  }, [save, state]);
  const applyPanoramaVolume = useCallback((workingVolume: DirectorStageWorkingVolume) => {
    apply({
      op: "scene.update",
      patch: {
        environmentCalibration: {
          ...activePanoramaCalibration,
          workingVolume,
        },
      },
    });
  }, [activePanoramaCalibration, apply]);
  const applyPanoramaSphere = useCallback(() => {
    const {
      workingVolume: _workingVolume,
      ...sphericalCalibration
    } = activePanoramaCalibration;
    apply({
      op: "scene.update",
      patch: { environmentCalibration: sphericalCalibration },
    });
  }, [activePanoramaCalibration, apply]);
  const selectPanoramaEnvironmentMode = useCallback((presetId: string) => {
    if (presetId === "background-sphere") {
      applyPanoramaSphere();
      return;
    }
    if (presetId === "custom") {
      const volume = activePanoramaVolume
        ?? directorPanoramaWorkingVolume(
          createDirectorPanoramaCalibration("standard"),
        );
      if (volume) applyPanoramaVolume({ ...volume, preset: "custom" });
      return;
    }
    const calibration = createDirectorPanoramaCalibration(
      presetId as "compact" | "standard" | "large",
    );
    const volume = directorPanoramaWorkingVolume(calibration);
    if (volume) applyPanoramaVolume(volume);
  }, [activePanoramaVolume, applyPanoramaSphere, applyPanoramaVolume]);
  const updatePanoramaDimension = useCallback((
    axis: 0 | 1 | 2,
    value: number,
  ) => {
    if (!Number.isFinite(value)) return;
    const volume = activePanoramaVolume
      ?? directorPanoramaWorkingVolume(createDirectorPanoramaCalibration("standard"));
    if (!volume) return;
    const size = [...volume.size] as DirectorStageVector3;
    size[axis] = Math.min(axis === 1 ? 100 : 500, Math.max(0.5, value));
    applyPanoramaVolume({
      ...volume,
      preset: "custom",
      size,
    });
  }, [activePanoramaVolume, applyPanoramaVolume]);

  const addObject = useCallback((object: DirectorStageObject) => {
    if (!apply({ op: "object.add", object })) return;
    setSelectedObjectIds([object.id]);
    setSelectedCameraId(undefined);
    setSelectedSequenceShotId(undefined);
  }, [apply]);
  const addMannequin = useCallback((bodyType: DirectorMannequinBodyType = "neutral") => {
    const id = createId("actor");
    addObject(createDirectorMannequin({
      id,
      index: state.objects.filter((object) => object.kind === "mannequin").length,
      bodyType,
    }));
  }, [addObject, state.objects]);
  const addPrimitive = useCallback((shape: Extract<DirectorStageObject, { kind: "primitive" }>["primitive"]["shape"] = "box") => {
    const id = createId("shape");
    addObject({
      id,
      name: `${shape[0]?.toUpperCase()}${shape.slice(1)} ${state.objects.filter((object) => object.kind === "primitive").length + 1}`,
      kind: "primitive",
      visible: true,
      transform: identityTransform(),
      primitive: { shape },
    });
  }, [addObject, state.objects]);
  const addCrowd = useCallback(() => {
    const id = createId("crowd");
    addObject({
      id,
      name: `Crowd ${state.objects.filter((object) => object.kind === "crowd").length + 1}`,
      kind: "crowd",
      visible: true,
      transform: identityTransform(),
      crowd: { rows: 3, columns: 3, spacing: 1.25, bodyType: "neutral" },
    });
  }, [addObject, state.objects]);
  const addBuiltinModel = useCallback((asset: DirectorBuiltinModelAsset) => {
    const instanceNumber = state.objects.filter(
      (object) => object.kind === "model" && object.model.assetId === asset.id,
    ).length + 1;
    addObject({
      id: createId("model"),
      name: instanceNumber === 1 ? asset.name : `${asset.name} ${instanceNumber}`,
      kind: "model",
      visible: true,
      transform: {
        position: [...asset.defaultTransform.position],
        rotation: [...asset.defaultTransform.rotation],
        scale: [...asset.defaultTransform.scale],
      },
      model: asset.rig ? {
        assetId: asset.id,
        animation: {
          jointCount: asset.rig.jointCount,
          clipNames: [...asset.rig.clipNames],
          actionMap: Object.fromEntries(
            Object.entries(asset.rig.actionMap).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
        },
      } : { assetId: asset.id },
    });
    setModelLibraryOpen(false);
  }, [addObject, state.objects]);
  const addLight = useCallback((type: Extract<DirectorStageObject, { kind: "light" }>["light"]["type"]) => {
    const id = createId("light");
    addObject({
      id,
      name: `${type.replace(/^./, (value) => value.toUpperCase())} light ${state.objects.filter((object) => object.kind === "light").length + 1}`,
      kind: "light",
      visible: true,
      color: "#ffd58a",
      transform: {
        ...identityTransform(),
        position: [3, 4, 3],
        rotation: [-0.65, 0.65, 0],
      },
      light: { type, intensity: type === "directional" ? 1.5 : 4, range: 20, angle: 0.65 },
    });
  }, [addObject, state.objects]);

  useEffect(() => {
    const element = timelineRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setTimelineWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || !state.animation) return;
    let request = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = (now - previous) / 1000;
      previous = now;
      setPlayheadSeconds((current) => (current + delta) % state.animation!.durationSeconds);
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing, state.animation]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const action = directorShortcut(event);
      if (!action) return;
      event.preventDefault();
      if (action.type === "mode") setTransformMode(action.mode);
      if (action.type === "toggle-snap") {
        apply({ op: "scene.update", patch: { grid: { snap: !state.scene.grid.snap } } });
      }
      if (action.type === "view") setViewPreset(action.view);
      if (action.type === "undo") onUndo?.();
      if (action.type === "delete" && selectedActionClipId) {
        apply({ op: "action.remove", clipId: selectedActionClipId });
        setSelectedActionClipId(undefined);
        return;
      }
      if (action.type === "delete" && selectedSequenceShotId) {
        apply({ op: "sequence-shot.remove", shotId: selectedSequenceShotId });
        setSelectedSequenceShotId(undefined);
        return;
      }
      if (action.type === "delete" && selectedObjectId) {
        apply({ op: "object.remove", objectId: selectedObjectId });
        setSelectedObjectIds([]);
      }
      if (action.type === "delete" && !selectedObjectId && selectedCameraId) {
        apply({ op: "camera.remove", cameraId: selectedCameraId });
        setSelectedCameraId(undefined);
      }
      if (action.type === "group" && selectedObjectIds.length > 1) {
        apply({ op: "object.group", objectIds: selectedObjectIds, groupId: createId("group") });
      }
      if (action.type === "ungroup" && selectedObject?.groupId) {
        apply({ op: "object.ungroup", groupId: selectedObject.groupId });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [apply, onUndo, selectedActionClipId, selectedCameraId, selectedObject, selectedObjectId, selectedObjectIds, selectedSequenceShotId, state.scene.grid.snap]);

  const selectObject = (objectId: string, extend = false) => {
    setSelectedCameraId(undefined);
    setSelectedSequenceShotId(undefined);
    setSelectedObjectIds((current) => {
      if (!extend) return [objectId];
      return current.includes(objectId)
        ? current.filter((id) => id !== objectId)
        : [...current, objectId];
    });
  };

  const addCameraFromCurrentView = () => {
    const pose = viewportRef.current?.cameraPose();
    if (!pose) return;
    const id = createId("camera");
    const result = applyDirectorStageCommand(state, {
      op: "camera.add",
      camera: {
        id,
        name: `Camera ${state.cameras.length + 1}`,
        ...pose,
        optics: createDirectorCameraOptics(pose.fov),
      },
    });
    if (!result.ok) return;
    if (save({ ...result.state, activeCameraId: id })) {
      setSelectedCameraId(id);
      setSelectedObjectIds([]);
    }
  };

  const captureShot = async () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setCaptureStatus("capturing");
    try {
      const prepared = prepareDirectorCaptureState({
        state,
        viewMode,
        cameraPose: viewport.cameraPose(),
        cameraId: createId("camera"),
        cameraName: `Camera ${state.cameras.length + 1}`,
      });
      const blob = await viewport.capture({ aspectRatio, longEdge: 1920 });
      await onCaptureShot({
        stageId: stage.id,
        state: prepared.state,
        cameraId: prepared.cameraId,
        aspectRatio,
        timeSeconds: playheadSeconds,
        blob,
      });
      setCaptureStatus("idle");
    } catch (error) {
      console.error("[Director Stage] capture failed", error);
      setCaptureStatus("error");
    }
  };

  const exportDirectorVideo = async (mode: DirectorStageVideoExportMode) => {
    const viewport = viewportRef.current;
    if (!viewportReady || !viewport || !onExportVideo || videoExportStatus === "exporting") return;
    const exportPlan = createDirectorVideoExportPlan({
      state,
      aspectRatio,
      mode,
      selectedShotIds: selectedSequenceShotIds,
    });
    const firstRender = exportPlan[0];
    if (!firstRender) {
      setVideoExportStatus("error");
      return;
    }
    const camera = state.cameras.find(
      (candidate) => candidate.id === firstRender.cameraId,
    );
    if (!camera) {
      setVideoExportStatus("error");
      return;
    }
    const fps = state.animation?.fps ?? 30;
    const exportState = state.activeCameraId === camera.id
      ? state
      : { ...state, activeCameraId: camera.id };
    if (exportState !== state && !save(exportState)) {
      setVideoExportStatus("error");
      return;
    }

    setVideoExportStatus("exporting");
    setPlaying(false);
    setSelectedObjectIds([]);
    setSelectedCameraId(camera.id);
    setViewMode("camera");
    setPlayheadSeconds(firstRender.startTime);
    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const renders: DirectorStageVideoExportRender[] = [];
      for (const render of exportPlan) {
        const referenceFrames: DirectorStageReferenceFrameCapture[] = [];
        for (const request of directorReferenceFrameRequests(
          exportState,
          render.aspectRatio,
          render.shotIds,
        )) {
          setPlayheadSeconds(request.timeSeconds);
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
          referenceFrames.push({
            ...request,
            blob: await viewport.capture({
              aspectRatio: request.aspectRatio,
              longEdge: 1920,
            }),
          });
        }
        setPlayheadSeconds(render.startTime);
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const blob = await viewport.record({
          aspectRatio: render.aspectRatio,
          durationSeconds: render.durationSeconds,
          startTimeSeconds: render.startTime,
          fps,
          longEdge: 1920,
          onTimeUpdate: setPlayheadSeconds,
        });
        renders.push({ ...render, blob, referenceFrames });
      }
      await onExportVideo({
        stageId: stage.id,
        state: exportState,
        mode,
        fps,
        renders,
      });
      setPlayheadSeconds(firstRender.startTime);
      setVideoExportStatus("idle");
    } catch (error) {
      console.error("[Director Stage] camera video export failed", error);
      setVideoExportStatus("error");
    }
  };

  const handleModelFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || !onUploadModel) return;
    const uploaded = await onUploadModel(file);
    addObject({
      id: createId("model"),
      name: uploaded.name,
      kind: "model",
      visible: true,
      transform: identityTransform(),
      model: {
        assetId: uploaded.assetId,
        animation: uploaded.animation ? {
          jointCount: uploaded.animation.jointCount,
          clipNames: [...uploaded.animation.clipNames],
          actionMap: { ...uploaded.animation.actionMap },
        } : undefined,
      },
    });
  };
  const generateModel = async () => {
    const prompt = modelPrompt.trim();
    if (!prompt || !onGenerateModel || modelGenerationStatus === "generating") return;
    setModelGenerationStatus("generating");
    setModelGenerationError("");
    setModelGenerationReceipt(undefined);
    try {
      const uploaded = await onGenerateModel({
        prompt,
        quality: modelQuality,
        pbr: modelPbr,
        faceCount: modelFaceCount,
      });
      addObject({
        id: createId("model"),
        name: uploaded.name,
        kind: "model",
        visible: true,
        transform: identityTransform(),
        model: { assetId: uploaded.assetId },
      });
      setModelGenerationReceipt(uploaded);
      setModelGenerationStatus("idle");
    } catch (error) {
      setModelGenerationError(
        error instanceof Error ? error.message : "3D model generation failed",
      );
      setModelGenerationStatus("error");
    }
  };
  const handlePanoramaFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || !onUploadPanorama) return;
    const uploaded = await onUploadPanorama(file);
    setUploadedPanoramas((current) => [
      uploaded,
      ...current.filter((item) => item.assetId !== uploaded.assetId),
    ]);
    const calibration = uploaded.calibration ?? activePanoramaCalibration;
    apply({
      op: "scene.update",
      patch: {
        environmentAssetId: uploaded.assetId,
        environmentCalibration: calibration,
        environmentRotation: directorPanoramaEnvironmentRotation(calibration),
      },
    });
    setShowPanoramaBackground(true);
  };
  const generatePanorama = async () => {
    const typedBrief = panoramaPrompt.trim();
    const hasReference = panoramaReferenceAssetId !== "none";
    if ((!typedBrief && !hasReference) || !onGeneratePanorama || panoramaGenerationStatus === "generating") return;
    const brief = typedBrief || "Extend the reference scene into a spatially coherent view in every direction.";
    const generationSetup = panoramaGenerationSetup;
    setPanoramaGenerationStatus("generating");
    setPanoramaGenerationError("");
    setPanoramaGenerationReceipt(undefined);
    try {
      const uploaded = await onGeneratePanorama({
        prompt: buildDirectorPanoramaPrompt(brief, {
          calibrationGrid: panoramaCalibrationGrid,
          workingVolume: activePanoramaVolume,
        }),
        calibration: activePanoramaCalibration,
        calibrationGrid: panoramaCalibrationGrid,
        ...(panoramaReferenceAssetId !== "none"
          ? { referenceAssetId: panoramaReferenceAssetId }
          : {}),
      });
      setUploadedPanoramas((current) => [
        uploaded,
        ...current.filter((item) => item.assetId !== uploaded.assetId),
      ]);
      const calibration = uploaded.calibration ?? activePanoramaCalibration;
      apply({
        op: "scene.update",
        patch: {
          environmentAssetId: uploaded.assetId,
          environmentCalibration: calibration,
          environmentRotation: directorPanoramaEnvironmentRotation(calibration),
          ...(panoramaCalibrationGrid
            ? { grid: { visible: true, size: 1 } }
            : {}),
        },
      });
      setShowPanoramaBackground(true);
      if (uploaded.calibration) {
        setPanoramaCalibrationLocked(true);
        setViewMode("director");
      }
      setPanoramaGenerationReceipt(generationSetup);
      setPanoramaGenerationStatus("idle");
    } catch (error) {
      setPanoramaGenerationError(
        error instanceof Error ? error.message : "AI panorama generation failed",
      );
      setPanoramaGenerationStatus("error");
    }
  };
  const addPropertyKeyframe = (
    targetId: string,
    property: DirectorAnimationTrack["property"],
    value: DirectorAnimationKeyframe["value"],
  ) => {
    const trackId = `${targetId}-${property}`;
    const timeKey = Math.round(playheadSeconds * 1000);
    const keyframeId = `${trackId}-${timeKey}`;
    if (apply({
      op: "keyframe.upsert",
      durationSeconds: state.animation?.durationSeconds ?? 10,
      fps: state.animation?.fps ?? 30,
      track: { id: trackId, targetId, property },
      keyframe: {
        id: keyframeId,
        time: playheadSeconds,
        value: Array.isArray(value) ? [...value] : value,
        interpolation: newKeyInterpolation,
      },
    })) {
      setSelectedKeyframeRef({ trackId, keyframeId });
      setSelectedActionClipId(undefined);
    }
  };
  const addPositionKeyframe = (
    targetId: string,
    position: DirectorStageVector3,
  ) => addPropertyKeyframe(targetId, "position", position);
  const addRotationKeyframe = (
    targetId: string,
    rotation: DirectorStageVector3,
  ) => addPropertyKeyframe(targetId, "rotation", rotation);
  const addFocalLengthKeyframe = (targetId: string, focalLengthMm: number) =>
    addPropertyKeyframe(targetId, "focalLengthMm", focalLengthMm);
  const updateKeyframe = (
    trackId: string,
    keyframeId: string,
    patch: Partial<DirectorAnimationKeyframe>,
  ) => {
    const track = state.animation?.tracks.find((candidate) => candidate.id === trackId);
    const keyframe = track?.keyframes.find((candidate) => candidate.id === keyframeId);
    if (!track || !keyframe) return;
    apply({
      op: "keyframe.upsert",
      durationSeconds: state.animation?.durationSeconds ?? 10,
      fps: state.animation?.fps ?? 30,
      track: { id: track.id, targetId: track.targetId, property: track.property },
      keyframe: { ...keyframe, ...patch },
    });
  };
  const removeKeyframe = (trackId: string, keyframeId: string) => {
    if (apply({ op: "keyframe.remove", trackId, keyframeId })) {
      setSelectedKeyframeRef(undefined);
    }
  };
  const upsertActionClip = (clip: DirectorStageActionClip): boolean => apply({
    op: "action.upsert",
    durationSeconds: state.animation?.durationSeconds ?? 10,
    fps: state.animation?.fps ?? 30,
    clip,
  });
  const addActionClip = (targetId: string) => {
    const durationSeconds = state.animation?.durationSeconds ?? 10;
    const fps = state.animation?.fps ?? 30;
    const target = state.objects.find((object) => object.id === targetId);
    const clip = createDirectorActionClip({
      id: createId(`${targetId}-action`),
      targetId,
      action: actionName,
      layer: target?.kind === "model" ? "full-body" : actionLayer,
      startTime: playheadSeconds,
      durationSeconds: actionDuration,
      blendSeconds: actionTransition,
      timelineDurationSeconds: durationSeconds,
      fps,
    });
    const motionAsset = target?.kind === "mannequin"
      ? state.motionAssets?.find((asset) => asset.tags?.includes(actionName))
      : undefined;
    const enrichedClip: DirectorStageActionClip = motionAsset
      ? {
          ...clip,
          motionAssetId: motionAsset.id,
          loopMode: motionAsset.tags?.includes("loop") ? "repeat" : "once",
          rootMotionMode: "in-place",
          retargeting: {
            mode: "humanoid",
            targetRigProfileId: "clash-humanoid-v1",
          },
        }
      : clip;
    if (upsertActionClip(enrichedClip)) setSelectedActionClipId(enrichedClip.id);
  };
  const updateActionClip = (
    clipId: string,
    patch: Partial<Omit<DirectorStageActionClip, "id" | "targetId">>,
  ) => {
    const clip = state.animation?.actionClips?.find((candidate) => candidate.id === clipId);
    if (!clip) return;
    upsertActionClip({ ...clip, ...patch });
  };
  const removeActionClip = (clipId: string) => {
    if (apply({ op: "action.remove", clipId })) setSelectedActionClipId(undefined);
  };
  const installBuiltinMotionLibrary = () => {
    let next = state;
    for (const motion of createDirectorBuiltinMotionAssets()) {
      const result = applyDirectorStageCommand(next, {
        op: "motion.upsert",
        motion,
      });
      if (!result.ok) {
        console.warn(`[Director Stage] ${result.error}`);
        return;
      }
      next = result.state;
    }
    save(next);
  };
  const upsertSequenceShot = (shot: DirectorStageSequenceShot): boolean => apply({
    op: "sequence-shot.upsert",
    durationSeconds: state.animation?.durationSeconds ?? 10,
    fps: state.animation?.fps ?? 30,
    shot,
  });
  const addSequenceShot = () => {
    const camera = state.cameras.find((candidate) => candidate.id === selectedCameraId)
      ?? state.cameras.find((candidate) => candidate.id === state.activeCameraId)
      ?? state.cameras[0];
    if (!camera) return;
    const durationSeconds = state.animation?.durationSeconds ?? 10;
    const frameSeconds = 1 / (state.animation?.fps ?? 30);
    const startTime = Math.min(
      Math.max(0, durationSeconds - frameSeconds),
      playheadSeconds,
    );
    const shot: DirectorStageSequenceShot = {
      id: createId("shot"),
      name: `Shot ${(state.shotSequence?.length ?? 0) + 1}`,
      cameraId: camera.id,
      startTime,
      durationSeconds: Math.max(
        frameSeconds,
        Math.min(3, durationSeconds - startTime),
      ),
      aspectRatio,
      transition: "cut",
    };
    if (!upsertSequenceShot(shot)) return;
    setSelectedSequenceShotId(shot.id);
    setSelectedObjectIds([]);
    setSelectedCameraId(camera.id);
  };
  const updateSequenceShot = (
    shotId: string,
    patch: Partial<Omit<DirectorStageSequenceShot, "id">>,
  ) => {
    const shot = state.shotSequence?.find((candidate) => candidate.id === shotId);
    if (!shot) return;
    upsertSequenceShot({ ...shot, ...patch });
  };
  const removeSequenceShot = (shotId: string) => {
    if (apply({ op: "sequence-shot.remove", shotId })) {
      setSelectedSequenceShotId(undefined);
    }
  };

  const query = search.trim().toLocaleLowerCase();
  const filteredObjects = state.objects.filter((object) =>
    `${object.name} ${object.kind}`.toLocaleLowerCase().includes(query),
  );
  const selectedPositionTrack = state.animation?.tracks.find(
    (track) => track.targetId === selectedObjectId && track.property === "position",
  );
  const selectedObjectActionClips = (state.animation?.actionClips ?? [])
    .filter((clip) => clip.targetId === selectedObjectId)
    .sort((left, right) => left.startTime - right.startTime || left.id.localeCompare(right.id));
  const selectedActionClip = selectedObjectActionClips.find(
    (clip) => clip.id === selectedActionClipId,
  );
  const selectedKeyframeTrack = state.animation?.tracks.find(
    (track) => track.id === selectedKeyframeRef?.trackId,
  );
  const selectedKeyframe = selectedKeyframeTrack?.keyframes.find(
    (keyframe) => keyframe.id === selectedKeyframeRef?.keyframeId,
  );
  const selectedKeyframeCurrentValue = (() => {
    if (!selectedKeyframeTrack) return undefined;
    const object = state.objects.find(
      (candidate) => candidate.id === selectedKeyframeTrack.targetId,
    );
    if (
      object
      && (
        selectedKeyframeTrack.property === "position"
        || selectedKeyframeTrack.property === "rotation"
        || selectedKeyframeTrack.property === "scale"
      )
    ) {
      return object.transform[selectedKeyframeTrack.property];
    }
    const camera = state.cameras.find(
      (candidate) => candidate.id === selectedKeyframeTrack.targetId,
    );
    if (!camera) return undefined;
    if (selectedKeyframeTrack.property === "fov") return camera.fov;
    if (selectedKeyframeTrack.property === "focalLengthMm") {
      return camera.optics?.focalLengthMm;
    }
    if (selectedKeyframeTrack.property === "focusDistanceM") {
      return camera.optics?.focusDistanceM;
    }
    if (selectedKeyframeTrack.property === "fStop") {
      return camera.optics?.fStop;
    }
    if (selectedKeyframeTrack.property === "position") return camera.position;
    if (selectedKeyframeTrack.property === "rotation") return camera.rotation;
    return undefined;
  })();
  const selectedKeyframeEditor = selectedKeyframeTrack && selectedKeyframe ? (
    <DirectorSelectedKeyframeEditor
      track={selectedKeyframeTrack}
      keyframe={selectedKeyframe}
      durationSeconds={state.animation?.durationSeconds ?? 10}
      fps={state.animation?.fps ?? 30}
      onChange={(patch) => updateKeyframe(
        selectedKeyframeTrack.id,
        selectedKeyframe.id,
        patch,
      )}
      onUpdateFromCurrent={selectedKeyframeCurrentValue === undefined
        ? undefined
        : () => updateKeyframe(selectedKeyframeTrack.id, selectedKeyframe.id, {
          value: Array.isArray(selectedKeyframeCurrentValue)
            ? [...selectedKeyframeCurrentValue]
            : selectedKeyframeCurrentValue,
        })}
      onRemove={() => removeKeyframe(selectedKeyframeTrack.id, selectedKeyframe.id)}
    />
  ) : null;
  const selectedJointRotation: DirectorStageVector3 = selectedObject?.kind === "mannequin"
    ? selectedObject.mannequin.pose.joints[selectedPoseJoint] ?? [0, 0, 0]
    : [0, 0, 0];
  const selectedBodyShape = selectedObject?.kind === "mannequin"
    ? selectedObject.mannequin.bodyShape ?? 0
    : 0;
  const bodyShapeLabel = selectedBodyShape <= -0.34
    ? "Thin"
    : selectedBodyShape >= 0.34
      ? "Full"
      : "Natural";
  const selectedEvaluatedCamera = evaluatedStage.cameras.find(
    (camera) => camera.id === selectedCamera?.id,
  );
  const selectedFocusTarget = selectedCamera?.targetObjectId
    ? state.objects.find((object) => object.id === selectedCamera.targetObjectId)
    : undefined;
  const selectedEvaluatedFocusTarget = selectedCamera?.targetObjectId
    ? evaluatedStage.objects.find((object) => object.id === selectedCamera.targetObjectId)
    : undefined;
  const selectedFocusOffset = selectedCamera?.targetOffset
    ?? (selectedFocusTarget ? directorDefaultFocusOffset(selectedFocusTarget) : [0, 1.1, 0]);
  const selectedFocalLength = selectedCamera
    ? selectedCamera.optics?.focalLengthMm ?? cameraFocalLengthFromFov(selectedCamera.fov)
    : 50;
  const selectedFocusDistance = selectedEvaluatedCamera && selectedEvaluatedFocusTarget
    ? Math.hypot(
      ...directorObjectFocusPoint(
        selectedEvaluatedFocusTarget,
        selectedCamera?.targetOffset,
      ).map((component, index) => component - selectedEvaluatedCamera.position[index]!),
    )
    : undefined;
  const updateCameraFocusTarget = (objectId: string) => {
    if (!selectedCamera) return;
    if (objectId === "none") {
      apply({
        op: "camera.update",
        cameraId: selectedCamera.id,
        patch: {
          targetObjectId: undefined,
          targetOffset: undefined,
          rotation: selectedEvaluatedCamera?.rotation ?? selectedCamera.rotation,
        },
      });
      return;
    }
    const target = state.objects.find((object) => object.id === objectId);
    if (!target) return;
    apply({
      op: "camera.update",
      cameraId: selectedCamera.id,
      patch: {
        targetObjectId: objectId,
        targetOffset: directorDefaultFocusOffset(target),
      },
    });
  };
  const cameraMoveShot = selectedCamera
    ? (
        selectedSequenceShot?.cameraId === selectedCamera.id
          ? selectedSequenceShot
          : state.shotSequence?.find((shot) => (
              shot.cameraId === selectedCamera.id
              && playheadSeconds >= shot.startTime
              && playheadSeconds <= shot.startTime + shot.durationSeconds
            ))
      )
    : undefined;
  const buildSelectedCameraMove = () => {
    if (!selectedCamera?.targetObjectId || !cameraMoveShot) return;
    const commands = buildDirectorCameraMoveCommands({
      state,
      cameraId: selectedCamera.id,
      targetObjectId: selectedCamera.targetObjectId,
      preset: cameraMovePreset,
      shotId: cameraMoveShot.id,
    });
    if (commands.length === 0) return;
    let nextState = state;
    for (const command of commands) {
      const result = applyDirectorStageCommand(nextState, command);
      if (!result.ok) {
        console.warn(`[Director Stage] ${result.error}`);
        return;
      }
      nextState = result.state;
    }
    save(nextState);
  };
  const updateSelectedJoint = (axis: 0 | 1 | 2, degrees: number) => {
    if (selectedObject?.kind !== "mannequin") return;
    const rotation = [...selectedJointRotation] as DirectorStageVector3;
    rotation[axis] = THREE_DEGREES_TO_RADIANS * degrees;
    apply({
      op: "object.update",
      objectId: selectedObject.id,
      patch: {
        pose: {
          preset: "custom",
          joints: {
            ...selectedObject.mannequin.pose.joints,
            [selectedPoseJoint]: rotation,
          },
        },
      },
    });
  };
  const resetSelectedJoint = () => {
    if (selectedObject?.kind !== "mannequin") return;
    const joints = { ...selectedObject.mannequin.pose.joints };
    delete joints[selectedPoseJoint];
    apply({
      op: "object.update",
      objectId: selectedObject.id,
      patch: { pose: { preset: "custom", joints } },
    });
  };
  const attachSelectedRider = () => {
    if (selectedObject?.kind !== "mannequin" || !mountHorseId) return;
    const posed = applyDirectorStageCommand(state, {
      op: "object.update",
      objectId: selectedObject.id,
      patch: { pose: { preset: "riding", joints: {} } },
    });
    if (!posed.ok) return;
    const attached = applyDirectorStageCommand(posed.state, {
      op: "object.attach",
      objectId: selectedObject.id,
      parentId: mountHorseId,
      socket: "saddle",
    });
    if (!attached.ok) return;
    save(attached.state);
  };

  const inspector = selectedObject ? (
    <div className="min-h-full">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--clash-director-panel-divider)] px-3 py-2.5">
        <div className="min-w-0">
          <span className={labelClass}>{selectedObject.kind}</span>
          <strong className="block truncate text-sm text-[var(--clash-director-panel-text)]">{selectedObject.name}</strong>
        </div>
        <IconButton
          label={`Delete ${selectedObject.name}`}
          icon={<Trash className="h-4 w-4" />}
          onClick={() => {
            apply({ op: "object.remove", objectId: selectedObject.id });
            setSelectedObjectIds([]);
          }}
          size="sm"
          shape="rounded"
          className="h-8 min-h-8 w-8 min-w-8 bg-transparent text-[var(--clash-director-panel-muted)] shadow-none hover:bg-[var(--clash-director-danger-soft)] hover:text-[var(--clash-director-danger)]"
        />
      </div>

      {hasObjectMotionInspector ? (
        <TabProvider
          selectedId={objectInspectorTab}
          setSelectedId={(tab) => {
            if (tab === "properties" || tab === "pose" || tab === "motion") setObjectInspectorTab(tab);
          }}
        >
          <TabList
            aria-label={selectedObject.kind === "mannequin" ? "Mannequin inspector sections" : "Rigged model inspector sections"}
            className={`grid ${selectedObject.kind === "mannequin" ? "grid-cols-3" : "grid-cols-2"} border-b border-[var(--clash-director-panel-divider)] px-2 pt-1`}
          >
            <Tab id="properties" className={`relative h-8 text-[11px] font-medium outline-none ${objectInspectorTab === "properties" ? "text-[var(--clash-director-panel-text)]" : "text-[var(--clash-director-panel-muted)] hover:text-[var(--clash-director-panel-secondary)]"}`}>
              Properties
              {objectInspectorTab === "properties" ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[var(--clash-director-selection)]" /> : null}
            </Tab>
            {selectedObject.kind === "mannequin" ? (
              <Tab id="pose" className={`relative h-8 text-[11px] font-medium outline-none ${objectInspectorTab === "pose" ? "text-[var(--clash-director-panel-text)]" : "text-[var(--clash-director-panel-muted)] hover:text-[var(--clash-director-panel-secondary)]"}`}>
                Pose
                {objectInspectorTab === "pose" ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[var(--clash-director-selection)]" /> : null}
              </Tab>
            ) : null}
            <Tab id="motion" className={`relative h-8 text-[11px] font-medium outline-none ${objectInspectorTab === "motion" ? "text-[var(--clash-director-panel-text)]" : "text-[var(--clash-director-panel-muted)] hover:text-[var(--clash-director-panel-secondary)]"}`}>
              Motion
              {objectInspectorTab === "motion" ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[var(--clash-director-selection)]" /> : null}
            </Tab>
          </TabList>
        </TabProvider>
      ) : null}

      <div className="space-y-4 p-3">
        {!hasObjectMotionInspector || objectInspectorTab === "properties" ? (
          <>
            <Field label="Name">
              <Input
                value={selectedObject.name}
                onChange={(event) => apply({ op: "object.update", objectId: selectedObject.id, patch: { name: event.target.value } })}
                className={fieldClass}
              />
            </Field>
            {selectedModelRig ? (
              <div className="rounded-lg border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] p-2.5">
                <span className={`${labelClass} mb-0`}>Rigged model</span>
                <p className="mt-1 text-[10px] leading-relaxed text-[var(--clash-director-panel-secondary)]">
                  {selectedModelRig.jointCount} joints · {selectedModelRig.clipNames.length} embedded clips
                </p>
                <p className="mt-1 text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]">
                  Use Motion to place supported authored actions on the timeline.
                </p>
              </div>
            ) : null}
            {selectedObject.kind === "mannequin" ? (
              <Field label="Character profile">
                <SelectMenu
                  ariaLabel="Character profile"
                  value={selectedObject.mannequin.bodyType}
                  options={DIRECTOR_MANNEQUIN_BODY_TYPES.map((body) => ({ value: body.value, label: body.label }))}
                  onValueChange={(bodyType) => apply({
                    op: "object.update",
                    objectId: selectedObject.id,
                    patch: { bodyType: bodyType as DirectorMannequinBodyType },
                  })}
                  variant="field"
                />
              </Field>
            ) : null}
            {selectedObject.kind === "creature" ? (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Horse build">
                  <SelectMenu
                    ariaLabel="Horse build"
                    value={selectedObject.creature.build}
                    options={[
                      { value: "warmblood", label: "Warmblood" },
                      { value: "draft", label: "Draft" },
                      { value: "pony", label: "Pony" },
                    ]}
                    onValueChange={(creatureBuild) => apply({
                      op: "object.update",
                      objectId: selectedObject.id,
                      patch: { creatureBuild: creatureBuild as typeof selectedObject.creature.build },
                    })}
                    variant="field"
                  />
                </Field>
                <Field label="Gait">
                  <SelectMenu
                    ariaLabel="Horse gait"
                    value={selectedObject.creature.gait}
                    options={[
                      { value: "auto", label: "Auto" },
                      { value: "idle", label: "Idle" },
                      { value: "walk", label: "Walk" },
                      { value: "trot", label: "Trot" },
                      { value: "gallop", label: "Gallop" },
                    ]}
                    onValueChange={(creatureGait) => apply({
                      op: "object.update",
                      objectId: selectedObject.id,
                      patch: { creatureGait: creatureGait as typeof selectedObject.creature.gait },
                    })}
                    variant="field"
                  />
                </Field>
              </div>
            ) : null}
            {selectedObject.kind === "prop" ? (
              <Field label="Prop type">
                <SelectMenu
                  ariaLabel="Prop type"
                  value={selectedObject.prop.type}
                  options={[
                    { value: "chair", label: "Chair" },
                    { value: "table", label: "Table" },
                    { value: "sofa", label: "Sofa" },
                    { value: "crate", label: "Crate" },
                    { value: "barrel", label: "Barrel" },
                    { value: "floor-lamp", label: "Floor lamp" },
                  ]}
                  onValueChange={(propType) => apply({ op: "object.update", objectId: selectedObject.id, patch: { propType: propType as typeof selectedObject.prop.type } })}
                  variant="field"
                />
              </Field>
            ) : null}
            {selectedObject.kind === "set" ? (
              <Field label="Set piece type">
                <SelectMenu
                  ariaLabel="Set piece type"
                  value={selectedObject.set.type}
                  options={[
                    { value: "wall", label: "Wall" },
                    { value: "doorway", label: "Doorway" },
                    { value: "window", label: "Window" },
                    { value: "platform", label: "Platform" },
                    { value: "cyclorama", label: "Cyclorama" },
                    { value: "tree", label: "Tree" },
                    { value: "rock", label: "Rock" },
                  ]}
                  onValueChange={(setType) => apply({ op: "object.update", objectId: selectedObject.id, patch: { setType: setType as typeof selectedObject.set.type } })}
                  variant="field"
                />
              </Field>
            ) : null}
            {selectedObject.kind === "vehicle" ? (
              <Field label="Vehicle type">
                <SelectMenu
                  ariaLabel="Vehicle type"
                  value={selectedObject.vehicle.type}
                  options={[
                    { value: "car", label: "Car" },
                    { value: "van", label: "Van" },
                    { value: "motorcycle", label: "Motorcycle" },
                    { value: "bicycle", label: "Bicycle" },
                    { value: "boat", label: "Boat" },
                  ]}
                  onValueChange={(vehicleType) => apply({ op: "object.update", objectId: selectedObject.id, patch: { vehicleType: vehicleType as typeof selectedObject.vehicle.type } })}
                  variant="field"
                />
              </Field>
            ) : null}
            {selectedObject.kind === "light" ? (
              <div className="space-y-2">
                <Field label="Light type">
                  <SelectMenu
                    ariaLabel="Light type"
                    value={selectedObject.light.type}
                    options={[
                      { value: "point", label: "Point" },
                      { value: "spot", label: "Spot" },
                      { value: "directional", label: "Directional" },
                    ]}
                    onValueChange={(lightType) => apply({ op: "object.update", objectId: selectedObject.id, patch: { lightType: lightType as typeof selectedObject.light.type } })}
                    variant="field"
                  />
                </Field>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Intensity">
                    <Input aria-label="Light intensity" type="number" min="0" max="100" step="0.1" value={selectedObject.light.intensity} onChange={(event) => apply({ op: "object.update", objectId: selectedObject.id, patch: { lightIntensity: Number(event.target.value) } })} className={fieldClass} />
                  </Field>
                  <Field label="Range">
                    <Input aria-label="Light range" type="number" min="0.1" max="1000" step="0.5" value={selectedObject.light.range} onChange={(event) => apply({ op: "object.update", objectId: selectedObject.id, patch: { lightRange: Number(event.target.value) } })} className={fieldClass} />
                  </Field>
                  <Field label="Cone">
                    <Input aria-label="Light cone angle" type="number" min="0.05" max="1.57" step="0.05" value={selectedObject.light.angle} onChange={(event) => apply({ op: "object.update", objectId: selectedObject.id, patch: { lightAngle: Number(event.target.value) } })} className={fieldClass} />
                  </Field>
                </div>
              </div>
            ) : null}
            {selectedObject.kind === "mannequin" ? (
              <div className="space-y-2 rounded-lg border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] p-2.5">
                <div>
                  <span className={`${labelClass} mb-0`}>Mount</span>
                  <p className="mt-1 text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]">
                    {selectedObject.attachment
                      ? `Attached to ${state.objects.find((object) => object.id === selectedObject.attachment?.parentId)?.name ?? selectedObject.attachment.parentId}`
                      : "Bind this actor to a horse saddle so movement and rotation stay inherited."}
                  </p>
                </div>
                {selectedObject.attachment ? (
                  <Button
                    variant={null}
                    size="sm"
                    shape="rounded"
                    onClick={() => apply({ op: "object.detach", objectId: selectedObject.id })}
                    className="h-8 min-h-8 w-full justify-start border border-[var(--clash-director-field-border)] bg-[var(--clash-director-panel)] px-2 text-[11px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
                  >
                    Detach from parent
                  </Button>
                ) : (
                  <>
                    <SelectMenu
                      ariaLabel="Horse mount"
                      value={mountHorseId}
                      options={horses.map((horse) => ({ value: horse.id, label: horse.name }))}
                      onValueChange={setMountHorseId}
                      variant="field"
                    />
                    <Button
                      variant={null}
                      size="sm"
                      shape="rounded"
                      disabled={!mountHorseId}
                      onClick={attachSelectedRider}
                      className="h-8 min-h-8 w-full justify-start border border-[var(--clash-director-selection)] bg-[var(--clash-director-selection-soft)] px-2 text-[11px] font-semibold text-[var(--clash-director-panel-text)] shadow-none hover:bg-[var(--clash-director-panel-active)]"
                    >
                      Attach to saddle
                    </Button>
                  </>
                )}
              </div>
            ) : null}
            {selectedObject.kind === "mannequin" ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className={`${labelClass} mb-0`}>Body shape · {bodyShapeLabel}</span>
                  <button
                    type="button"
                    aria-label="Reset body shape"
                    onClick={() => apply({
                      op: "object.update",
                      objectId: selectedObject.id,
                      patch: { bodyShape: 0 },
                    })}
                    className="rounded px-1.5 py-0.5 text-[10px] text-[var(--clash-director-panel-muted)] transition-colors hover:bg-[var(--clash-director-panel-hover)] hover:text-[var(--clash-director-panel-text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--clash-director-selection)]"
                  >
                    Natural
                  </button>
                </div>
                <div className="grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-2">
                  <span className="text-[9px] text-[var(--clash-director-panel-muted)]">Thin</span>
                  <Slider
                    value={[Math.round(selectedBodyShape * 100)]}
                    min={-100}
                    max={100}
                    step={1}
                    onValueChange={([bodyShape]) => bodyShape !== undefined && apply({
                      op: "object.update",
                      objectId: selectedObject.id,
                      patch: { bodyShape: bodyShape / 100 },
                    })}
                    className="h-8"
                  >
                    <SliderTrack className="h-1.5 rounded-full bg-[var(--clash-director-field-border)]">
                      <span className="absolute left-1/2 top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-[var(--clash-director-panel-muted)]" />
                    </SliderTrack>
                    <SliderThumb
                      aria-label="Body shape"
                      className="h-4 w-4 rounded-full border border-[var(--clash-director-selection)] bg-[var(--clash-director-control)] shadow-sm"
                    />
                  </Slider>
                  <span className="text-right text-[9px] text-[var(--clash-director-panel-muted)]">Full</span>
                </div>
              </div>
            ) : null}
            {selectedObject.kind === "mannequin" ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className={`${labelClass} mb-0`}>Character size</span>
                  <output className="font-mono text-[10px] tabular-nums text-[var(--clash-director-panel-secondary)]">
                    {selectedObject.transform.scale[1].toFixed(2)}×
                  </output>
                </div>
                <Slider
                  value={[Math.round(selectedObject.transform.scale[1] * 100)]}
                  min={50}
                  max={200}
                  step={1}
                  onValueChange={([scale]) => scale !== undefined && apply({
                    op: "object.update",
                    objectId: selectedObject.id,
                    patch: { transform: { scale: directorUniformScale(scale / 100) } },
                  })}
                  className="h-8"
                >
                  <SliderTrack className="h-1.5 rounded-full bg-[var(--clash-director-field-border)]">
                    <SliderRange className="h-full bg-[var(--clash-director-selection)]" />
                  </SliderTrack>
                  <SliderThumb
                    aria-label="Character scale"
                    className="h-4 w-4 rounded-full border border-[var(--clash-director-selection)] bg-[var(--clash-director-control)] shadow-sm"
                  />
                </Slider>
                <div className="flex justify-between text-[9px] text-[var(--clash-director-panel-muted)]">
                  <span>0.50×</span>
                  <span>2.00×</span>
                </div>
              </div>
            ) : null}
            <Field label="Color palette">
              <div className="flex items-center gap-1.5">
                <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                  {DIRECTOR_MANNEQUIN_BODY_TYPES.map((body) => (
                    <button
                      key={body.value}
                      type="button"
                      aria-label={`Set color ${body.label}`}
                      aria-pressed={selectedObject.color?.toLowerCase() === body.color}
                      onClick={() => apply({ op: "object.update", objectId: selectedObject.id, patch: { color: body.color } })}
                      className={`h-6 w-6 rounded-full border-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.45)] transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--clash-director-selection)] ${selectedObject.color?.toLowerCase() === body.color ? "border-[var(--clash-director-selection)]" : "border-[var(--clash-director-panel)]"}`}
                      style={{ backgroundColor: body.token }}
                    />
                  ))}
                </div>
                <label className="relative h-7 w-8 shrink-0 overflow-hidden rounded-md border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)]">
                  <span className="sr-only">Custom object color</span>
                  <input
                    aria-label="Object color"
                    type="color"
                    value={selectedObject.color ?? DIRECTOR_MANNEQUIN_BODY_TYPES[0].color}
                    onChange={(event) => apply({ op: "object.update", objectId: selectedObject.id, patch: { color: event.target.value } })}
                    className="absolute -inset-2 h-11 w-12 cursor-pointer border-0 bg-transparent p-0"
                  />
                </label>
              </div>
            </Field>
            <div className="h-px bg-[var(--clash-director-panel-divider)]" />
            <div>
              <span className={labelClass}>Transform</span>
              <div className="space-y-3">
                <VectorField
                  label="Position"
                  value={selectedObject.transform.position}
                  onChange={(position) => apply({ op: "object.update", objectId: selectedObject.id, patch: { transform: { position } } })}
                />
                <VectorField
                  label="Rotation"
                  value={selectedObject.transform.rotation}
                  onChange={(rotation) => apply({ op: "object.update", objectId: selectedObject.id, patch: { transform: { rotation } } })}
                />
                <VectorField
                  label="Scale"
                  value={selectedObject.transform.scale}
                  onChange={(scale) => apply({ op: "object.update", objectId: selectedObject.id, patch: { transform: { scale } } })}
                />
              </div>
            </div>
            {selectedObject.kind !== "mannequin" ? (
              <Button
                variant={null}
                size="sm"
                shape="rounded"
                leftIcon={<BezierCurve className="h-4 w-4" />}
                onClick={() => addPositionKeyframe(selectedObject.id, selectedObject.transform.position)}
                className="h-8 min-h-8 w-full justify-start border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2 text-[11px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
              >
                Add position keyframe · {playheadSeconds.toFixed(2)}s
              </Button>
            ) : null}
          </>
        ) : null}

        {selectedObject.kind === "mannequin" && objectInspectorTab === "pose" ? (
          <>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2.5 py-2">
              <div className="min-w-0">
                <span className={labelClass}>Skeleton overlay</span>
                <p className="text-[10px] leading-snug text-[var(--clash-director-panel-muted)]">Joint handles follow the bound rig.</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-[10px] font-medium text-[var(--clash-director-panel-secondary)]">
                  {showSkeleton ? "Visible" : "Hidden"}
                </span>
                <Switch
                  aria-label="Show skeleton"
                  checked={showSkeleton}
                  onCheckedChange={setShowSkeleton}
                  className="border-[var(--clash-director-field-border)] bg-[var(--clash-director-panel)] data-[state=checked]:border-[var(--clash-director-selection)] data-[state=checked]:bg-[var(--clash-director-selection)] [&>span]:bg-[var(--clash-director-control)]"
                />
              </div>
            </div>
            <div>
              <span className={labelClass}>Pose preset</span>
              <div className="grid grid-cols-3 gap-1.5">
                {Object.entries(DIRECTOR_MANNEQUIN_POSE_PRESETS).filter(([key]) => key !== "custom").map(([key, preset]) => {
                  const active = selectedObject.mannequin.pose.preset === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => apply({
                        op: "object.update",
                        objectId: selectedObject.id,
                        patch: { pose: { preset: key, joints: preset.joints } },
                      })}
                      className={`min-h-9 rounded-md border px-1.5 py-1 text-[10px] leading-tight transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--clash-director-selection)] ${active ? "border-[var(--clash-director-selection)] bg-[var(--clash-director-panel-active)] font-semibold text-[var(--clash-director-panel-text)]" : "border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] text-[var(--clash-director-panel-secondary)] hover:bg-[var(--clash-director-panel-hover)]"}`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="h-px bg-[var(--clash-director-panel-divider)]" />
            <Field label="Joint controls">
              <SelectMenu
                ariaLabel="Joint controls"
                value={selectedPoseJoint}
                options={DIRECTOR_MANNEQUIN_POSE_JOINTS.map((joint) => ({ value: joint.value, label: joint.label }))}
                onValueChange={(joint) => setSelectedPoseJoint(joint as PoseJoint)}
                variant="field"
              />
            </Field>
            <div className="space-y-3">
              {jointAxes.map((axis) => {
                const degrees = Math.round(selectedJointRotation[axis.index] / THREE_DEGREES_TO_RADIANS);
                return (
                  <label key={axis.label} className="block">
                    <span className="mb-1 flex items-center justify-between text-[10px] text-[var(--clash-director-panel-muted)]">
                      <span>{axis.label}</span>
                      <output className="font-mono tabular-nums text-[var(--clash-director-panel-secondary)]">{degrees}°</output>
                    </span>
                    <input
                      aria-label={axis.ariaLabel}
                      type="range"
                      min="-180"
                      max="180"
                      step="1"
                      value={degrees}
                      onChange={(event) => updateSelectedJoint(axis.index, Number(event.target.value))}
                      className="h-4 w-full accent-[var(--clash-director-selection)]"
                    />
                  </label>
                );
              })}
            </div>
            <Button
              variant={null}
              size="sm"
              shape="rounded"
              onClick={resetSelectedJoint}
              className="h-8 min-h-8 w-full border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2 text-[11px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
            >
              Reset joint
            </Button>
          </>
        ) : null}

        {hasObjectMotionInspector && objectInspectorTab === "motion" ? (
          <>
            <div className="flex items-end justify-between border-b border-[var(--clash-director-panel-divider)] pb-3">
              <div>
                <span className={labelClass}>Position track</span>
                <strong className="text-lg font-semibold tabular-nums text-[var(--clash-director-panel-text)]">{selectedPositionTrack?.keyframes.length ?? 0}</strong>
                <span className="ml-1 text-[10px] text-[var(--clash-director-panel-muted)]">keyframes</span>
              </div>
              <span className="font-mono text-[10px] tabular-nums text-[var(--clash-director-panel-secondary)]">{playheadSeconds.toFixed(2)}s</span>
            </div>
            <Field label="New key interpolation">
              <SelectMenu
                ariaLabel="New key interpolation"
                value={newKeyInterpolation}
                options={[
                  { value: "bezier", label: "Smooth" },
                  { value: "linear", label: "Linear" },
                  { value: "hold", label: "Hold" },
                ]}
                onValueChange={(value) => setNewKeyInterpolation(value as DirectorKeyframeInterpolation)}
                variant="field"
              />
            </Field>
            <Button
              variant={null}
              size="sm"
              shape="rounded"
              leftIcon={<BezierCurve className="h-4 w-4" />}
              onClick={() => addPositionKeyframe(selectedObject.id, selectedObject.transform.position)}
              className="h-8 min-h-8 w-full justify-start border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2.5 text-[11px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
            >
              Add position keyframe · {playheadSeconds.toFixed(2)}s
            </Button>
            <p className="text-[10px] leading-relaxed text-[var(--clash-director-panel-muted)]">
              The 3D path and Timeline read from this same position track.
            </p>
            <div className="h-px bg-[var(--clash-director-panel-divider)]" />
            <div className="flex items-end justify-between">
              <div>
                <span className={labelClass}>Action track</span>
                <strong className="text-lg font-semibold tabular-nums text-[var(--clash-director-panel-text)]">
                  {selectedObjectActionClips.length}
                </strong>
                <span className="ml-1 text-[10px] text-[var(--clash-director-panel-muted)]">clips</span>
              </div>
              <span className="text-[9px] text-[var(--clash-director-panel-muted)]">
                {selectedActionClip ? "Editing selection" : "New clip"}
              </span>
            </div>
            {selectedObject.kind === "mannequin" && (state.motionAssets?.length ?? 0) === 0 ? (
              <Button
                variant={null}
                size="sm"
                shape="rounded"
                leftIcon={<Plus className="h-3.5 w-3.5" weight="bold" />}
                onClick={installBuiltinMotionLibrary}
                className="h-9 min-h-9 w-full justify-start border border-[var(--clash-director-selection)] bg-[var(--clash-director-selection-soft)] px-2.5 text-[10px] font-semibold text-[var(--clash-director-panel-text)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
              >
                Install CC0 action library
              </Button>
            ) : null}
            <div className={`grid ${selectedModelRig ? "grid-cols-1" : "grid-cols-2"} gap-2`}>
              <Field label="Action">
                <SelectMenu
                  ariaLabel="Action"
                  value={actionName}
                  options={[...availableActionOptions]}
                  onValueChange={(value) => {
                    const nextAction = value as DirectorStageActionName;
                    const nextLayer = selectedModelRig
                      ? "full-body"
                      : directorActionDefaultLayer(nextAction);
                    setActionName(nextAction);
                    setActionLayer(nextLayer);
                    if (selectedActionClip) {
                      const motionAsset = selectedObject.kind === "mannequin"
                        ? state.motionAssets?.find((asset) => asset.tags?.includes(nextAction))
                        : undefined;
                      updateActionClip(selectedActionClip.id, {
                        action: nextAction,
                        layer: nextLayer,
                        motionAssetId: motionAsset?.id,
                        loopMode: motionAsset
                          ? motionAsset.tags?.includes("loop") ? "repeat" : "once"
                          : undefined,
                        rootMotionMode: motionAsset ? "in-place" : undefined,
                        retargeting: motionAsset ? {
                          mode: "humanoid",
                          targetRigProfileId: "clash-humanoid-v1",
                        } : undefined,
                      });
                    }
                  }}
                  variant="field"
                />
              </Field>
              {!selectedModelRig ? (
                <Field label="Layer">
                  <SelectMenu
                    ariaLabel="Action layer"
                    value={actionLayer}
                    options={[
                      { value: "full-body", label: "Full body" },
                      { value: "upper-body", label: "Upper body" },
                    ]}
                    onValueChange={(value) => {
                      const layer = value as DirectorStageActionLayer;
                      setActionLayer(layer);
                      if (selectedActionClip) updateActionClip(selectedActionClip.id, { layer });
                    }}
                    variant="field"
                  />
                </Field>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Duration · seconds">
                <Input
                  aria-label="Action duration"
                  type="number"
                  min={1 / (state.animation?.fps ?? 30)}
                  max={state.animation?.durationSeconds ?? 10}
                  step={1 / (state.animation?.fps ?? 30)}
                  value={Number(actionDuration.toFixed(3))}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    const fps = state.animation?.fps ?? 30;
                    const maxDuration = (state.animation?.durationSeconds ?? 10) - (selectedActionClip?.startTime ?? playheadSeconds);
                    const durationSeconds = Math.max(1 / fps, Math.min(maxDuration, value));
                    setActionDuration(durationSeconds);
                    if (selectedActionClip) updateActionClip(selectedActionClip.id, { durationSeconds });
                  }}
                  className={fieldClass}
                />
              </Field>
              <Field label="Transition · seconds">
                <Input
                  aria-label="Action transition"
                  type="number"
                  min="0"
                  step="0.05"
                  value={Number(actionTransition.toFixed(3))}
                  onChange={(event) => {
                    const limit = (selectedActionClip?.durationSeconds ?? actionDuration) / 2;
                    const blendSeconds = Math.max(0, Math.min(limit, Number(event.target.value)));
                    setActionTransition(blendSeconds);
                    if (selectedActionClip) {
                      updateActionClip(selectedActionClip.id, {
                        blendInSeconds: blendSeconds,
                        blendOutSeconds: blendSeconds,
                      });
                    }
                  }}
                  className={fieldClass}
                />
              </Field>
            </div>
            <Button
              variant={null}
              size="sm"
              shape="rounded"
              leftIcon={<Plus className="h-3.5 w-3.5" weight="bold" />}
              onClick={() => addActionClip(selectedObject.id)}
              className="h-9 min-h-9 w-full justify-start bg-[var(--clash-director-selection)] px-2.5 text-[11px] font-semibold text-[var(--clash-director-selection-foreground)] shadow-none hover:opacity-90"
            >
              Add action at {playheadSeconds.toFixed(2)}s
            </Button>
            <p className="text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]">
              {selectedModelRig
                ? "Only actions backed by this model's embedded clips are offered."
                : "Full-body clips replace locomotion. Upper-body clips layer over Walk or Run."}
            </p>
            {selectedActionClip ? (
              <section
                data-director-action-inspector={selectedActionClip.id}
                className="space-y-2 border-t border-[var(--clash-director-panel-divider)] pt-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className={labelClass}>Selected clip</span>
                    <strong className="block truncate text-xs text-[var(--clash-director-panel-text)]">
                      {DIRECTOR_ACTION_OPTIONS.find((option) => option.value === selectedActionClip.action)?.label}
                    </strong>
                  </div>
                  <Button
                    variant={null}
                    size="sm"
                    shape="rounded"
                    leftIcon={<Trash className="h-3.5 w-3.5" />}
                    onClick={() => removeActionClip(selectedActionClip.id)}
                    className="h-7 min-h-7 bg-transparent px-2 text-[10px] text-[var(--clash-director-danger)] shadow-none hover:bg-[var(--clash-director-danger-soft)]"
                  >
                    Remove action clip
                  </Button>
                </div>
                {selectedObject.kind === "mannequin" ? (
                  <Field label="Motion source">
                    <SelectMenu
                      ariaLabel="Motion source"
                      value={selectedActionClip.motionAssetId ?? "procedural"}
                      options={[
                        { value: "procedural", label: "Procedural fallback" },
                        ...(state.motionAssets ?? [])
                          .filter((asset) => asset.tags?.includes(selectedActionClip.action))
                          .map((asset) => ({
                            value: asset.id,
                            label: `${asset.name} · ${asset.clipName}`,
                          })),
                      ]}
                      onValueChange={(motionAssetId) => {
                        const motionAsset = state.motionAssets?.find(
                          (asset) => asset.id === motionAssetId,
                        );
                        updateActionClip(selectedActionClip.id, {
                          motionAssetId: motionAsset?.id,
                          loopMode: motionAsset
                            ? motionAsset.tags?.includes("loop") ? "repeat" : "once"
                            : undefined,
                          rootMotionMode: motionAsset ? "in-place" : undefined,
                          retargeting: motionAsset ? {
                            mode: "humanoid",
                            targetRigProfileId: "clash-humanoid-v1",
                          } : undefined,
                        });
                      }}
                      variant="field"
                    />
                  </Field>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Start · seconds">
                    <Input
                      aria-label="Selected action start"
                      type="number"
                      min="0"
                      max={(state.animation?.durationSeconds ?? 10) - selectedActionClip.durationSeconds}
                      step={1 / (state.animation?.fps ?? 30)}
                      value={Number(selectedActionClip.startTime.toFixed(3))}
                      onChange={(event) => updateActionClip(selectedActionClip.id, {
                        startTime: Math.max(
                          0,
                          Math.min(
                            (state.animation?.durationSeconds ?? 10) - selectedActionClip.durationSeconds,
                            Number(event.target.value),
                          ),
                        ),
                      })}
                      className={fieldClass}
                    />
                  </Field>
                  <Field label="Speed">
                    <Input
                      aria-label="Action playback rate"
                      type="number"
                      min="0.1"
                      max="4"
                      step="0.05"
                      value={selectedActionClip.playbackRate}
                      onChange={(event) => updateActionClip(selectedActionClip.id, {
                        playbackRate: Math.max(0.1, Math.min(4, Number(event.target.value))),
                      })}
                      className={fieldClass}
                    />
                  </Field>
                </div>
                <p className="text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]">
                  Drag the block to move it. Drag either edge to trim. Arrow keys nudge one frame; Shift nudges ten.
                </p>
              </section>
            ) : null}
            {selectedKeyframeTrack?.targetId === selectedObject.id
              ? selectedKeyframeEditor
              : null}
          </>
        ) : null}
      </div>
    </div>
  ) : selectedCamera ? (
    <div className="space-y-4 p-3">
      <div className="border-b border-[var(--clash-director-panel-divider)] pb-3">
        <span className={labelClass}>Camera</span>
        <strong className="block truncate text-sm text-[var(--clash-director-panel-text)]">{selectedCamera.name}</strong>
      </div>
      {selectedSequenceShot ? (
        <section
          data-director-shot-inspector={selectedSequenceShot.id}
          className="space-y-3 rounded-lg border border-[var(--clash-director-selection)] bg-[var(--clash-director-selection-soft)] p-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <div>
              <span className={labelClass}>Selected shot</span>
              <strong className="block text-xs text-[var(--clash-director-panel-text)]">
                {selectedSequenceShot.name}
              </strong>
            </div>
            <Button
              variant={null}
              size="sm"
              shape="rounded"
              leftIcon={<Trash className="h-3.5 w-3.5" />}
              onClick={() => removeSequenceShot(selectedSequenceShot.id)}
              className="h-7 min-h-7 bg-transparent px-2 text-[10px] text-[var(--clash-director-danger)] shadow-none hover:bg-[var(--clash-director-danger-soft)]"
            >
              Remove shot
            </Button>
          </div>
          <Field label="Shot name">
            <Input
              aria-label="Shot name"
              value={selectedSequenceShot.name}
              onChange={(event) => updateSequenceShot(selectedSequenceShot.id, {
                name: event.target.value || selectedSequenceShot.name,
              })}
              className={fieldClass}
            />
          </Field>
          <Field label="Shot camera">
            <SelectMenu
              ariaLabel="Shot camera"
              value={selectedSequenceShot.cameraId}
              options={state.cameras.map((camera) => ({
                value: camera.id,
                label: camera.name,
              }))}
              onValueChange={(cameraId) => {
                updateSequenceShot(selectedSequenceShot.id, { cameraId });
                setSelectedCameraId(cameraId);
              }}
              variant="field"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Start · seconds">
              <Input
                aria-label="Shot start"
                type="number"
                min="0"
                max={(state.animation?.durationSeconds ?? 10) - selectedSequenceShot.durationSeconds}
                step={1 / (state.animation?.fps ?? 30)}
                value={Number(selectedSequenceShot.startTime.toFixed(3))}
                onChange={(event) => updateSequenceShot(selectedSequenceShot.id, {
                  startTime: Math.max(0, Math.min(
                    (state.animation?.durationSeconds ?? 10) - selectedSequenceShot.durationSeconds,
                    Number(event.target.value),
                  )),
                })}
                className={fieldClass}
              />
            </Field>
            <Field label="Duration · seconds">
              <Input
                aria-label="Shot duration"
                type="number"
                min={1 / (state.animation?.fps ?? 30)}
                max={(state.animation?.durationSeconds ?? 10) - selectedSequenceShot.startTime}
                step={1 / (state.animation?.fps ?? 30)}
                value={Number(selectedSequenceShot.durationSeconds.toFixed(3))}
                onChange={(event) => updateSequenceShot(selectedSequenceShot.id, {
                  durationSeconds: Math.max(
                    1 / (state.animation?.fps ?? 30),
                    Math.min(
                      (state.animation?.durationSeconds ?? 10) - selectedSequenceShot.startTime,
                      Number(event.target.value),
                    ),
                  ),
                })}
                className={fieldClass}
              />
            </Field>
          </div>
          <Field label="Transition">
            <SelectMenu
              ariaLabel="Shot transition"
              value={selectedSequenceShot.transition}
              options={[
                { value: "cut", label: "Cut" },
                { value: "dissolve", label: "Dissolve" },
              ]}
              onValueChange={(transition) => updateSequenceShot(selectedSequenceShot.id, {
                transition: transition as DirectorStageSequenceShot["transition"],
              })}
              variant="field"
            />
          </Field>
          <div
            data-director-composition-checks={selectedSequenceShot.id}
            className="rounded-md border border-[var(--clash-director-panel-divider)] bg-[var(--clash-director-field)] p-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className={labelClass}>Composition checks</span>
              <span className={`text-[9px] font-semibold ${
                selectedShotCompositionIssues.length === 0
                  ? "text-emerald-400"
                  : "text-amber-400"
              }`}>
                {selectedShotCompositionIssues.length === 0
                  ? "Pass"
                  : `${selectedShotCompositionIssues.length} issue${selectedShotCompositionIssues.length === 1 ? "" : "s"}`}
              </span>
            </div>
            {selectedShotCompositionIssues.length > 0 ? (
              <ul className="mt-1 space-y-1">
                {selectedShotCompositionIssues.map((issue) => (
                  <li
                    key={`${issue.code}:${issue.objectId ?? ""}`}
                    className="text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]"
                  >
                    <span className="font-semibold text-[var(--clash-director-panel-secondary)]">
                      {issue.code.replaceAll("-", " ")}
                    </span>
                    {" · "}
                    {issue.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]">
                Axis, headroom, lead room, camera distance, subject spacing, and occlusion are safe at sampled frames.
              </p>
            )}
          </div>
        </section>
      ) : null}
      <Field label="Name">
        <Input
          value={selectedCamera.name}
          onChange={(event) => apply({ op: "camera.update", cameraId: selectedCamera.id, patch: { name: event.target.value } })}
          className={fieldClass}
        />
      </Field>
      <section className="space-y-3 border-b border-[var(--clash-director-panel-divider)] pb-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <span className={labelClass}>Lens</span>
            <strong className="text-lg font-semibold tabular-nums text-[var(--clash-director-panel-text)]">
              {selectedFocalLength.toFixed(1)}<span className="ml-1 text-[10px] font-medium text-[var(--clash-director-panel-muted)]">mm</span>
            </strong>
          </div>
          <span className="text-[10px] tabular-nums text-[var(--clash-director-panel-secondary)]">{selectedCamera.fov.toFixed(1)}° vertical</span>
        </div>
        <div>
          <span className={labelClass}>Lens presets</span>
          <div className="grid grid-cols-3 gap-1">
            {DIRECTOR_CAMERA_LENS_PRESETS.map((preset) => {
              const presetFov = cameraFovFromFocalLength(preset.focalLengthMm);
              const active = Math.abs(selectedCamera.fov - presetFov) < 0.25;
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={active}
                  aria-label={`${preset.label} ${preset.focalLengthMm}mm lens`}
                  onClick={() => apply({
                    op: "camera.update",
                    cameraId: selectedCamera.id,
                    patch: {
                      fov: presetFov,
                      optics: createDirectorCameraOptics(presetFov, selectedCamera.optics),
                    },
                  })}
                  className={`min-h-11 rounded-md border px-1.5 py-1 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--clash-director-selection)] ${active ? "border-[var(--clash-director-selection)] bg-[var(--clash-director-panel-active)] text-[var(--clash-director-panel-text)]" : "border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] text-[var(--clash-director-panel-secondary)] hover:bg-[var(--clash-director-panel-hover)]"}`}
                >
                  <span className="block text-[11px] font-semibold tabular-nums">{preset.focalLengthMm}mm</span>
                  <span className="block truncate text-[9px] text-[var(--clash-director-panel-muted)]">{preset.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <Field label="Focal length · full frame">
          <div className="relative">
            <Input
              aria-label="Camera focal length"
              type="number"
              min="8"
              max="300"
              step="1"
              value={Number(selectedFocalLength.toFixed(1))}
              onChange={(event) => {
                const focalLengthMm = Math.min(300, Math.max(8, Number(event.target.value)));
                apply({
                  op: "camera.update",
                  cameraId: selectedCamera.id,
                  patch: {
                    fov: cameraFovFromFocalLength(focalLengthMm),
                    optics: {
                      ...createDirectorCameraOptics(
                        cameraFovFromFocalLength(focalLengthMm),
                        selectedCamera.optics,
                      ),
                      focalLengthMm,
                    },
                  },
                });
              }}
              className={`${fieldClass} pr-9`}
            />
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-[var(--clash-director-panel-muted)]">mm</span>
          </div>
        </Field>
        <Field label={`Vertical FOV · ${selectedCamera.fov.toFixed(1)}°`}>
          <Slider
            value={[selectedCamera.fov]}
            min={8}
            max={120}
            step={0.5}
            onValueChange={([fov]) => fov !== undefined && apply({
              op: "camera.update",
              cameraId: selectedCamera.id,
              patch: {
                fov,
                optics: createDirectorCameraOptics(fov, selectedCamera.optics),
              },
            })}
            className="h-8"
          >
            <SliderTrack className="h-1 rounded-full bg-[var(--clash-director-field-border)]">
              <SliderRange className="h-full bg-[var(--clash-director-selection)]" />
            </SliderTrack>
            <SliderThumb aria-label="Vertical FOV" className="h-3.5 w-3.5 rounded-full border border-[var(--clash-director-selection)] bg-[var(--clash-director-control)] shadow-sm" />
          </Slider>
        </Field>
      </section>
      <section className="space-y-3 border-b border-[var(--clash-director-panel-divider)] pb-4">
        <div className="flex items-center justify-between gap-2">
          <span className={labelClass}>Focus</span>
          <span className="text-[10px] tabular-nums text-[var(--clash-director-panel-secondary)]">
            {selectedFocusDistance === undefined ? "Manual angle" : `${selectedFocusDistance.toFixed(2)} m`}
          </span>
        </div>
        <Field label="Focus target">
          <SelectMenu
            ariaLabel="Camera focus target"
            value={selectedCamera.targetObjectId ?? "none"}
            options={[
              { value: "none", label: "None · manual angle" },
              ...state.objects.map((object) => ({ value: object.id, label: object.name })),
            ]}
            onValueChange={updateCameraFocusTarget}
            variant="field"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Focus distance · meters">
            <Input
              aria-label="Camera focus distance"
              type="number"
              min="0.1"
              max="10000"
              step="0.1"
              value={Number((
                selectedCamera.optics?.focusDistanceM
                ?? selectedFocusDistance
                ?? 5
              ).toFixed(2))}
              onChange={(event) => apply({
                op: "camera.update",
                cameraId: selectedCamera.id,
                patch: {
                  optics: {
                    ...createDirectorCameraOptics(selectedCamera.fov, selectedCamera.optics),
                    focusDistanceM: Math.max(0.1, Number(event.target.value)),
                  },
                },
              })}
              className={fieldClass}
            />
          </Field>
          <Field label="Aperture · f-stop">
            <Input
              aria-label="Camera aperture"
              type="number"
              min="0.7"
              max="64"
              step="0.1"
              value={selectedCamera.optics?.fStop ?? 2.8}
              onChange={(event) => apply({
                op: "camera.update",
                cameraId: selectedCamera.id,
                patch: {
                  optics: {
                    ...createDirectorCameraOptics(selectedCamera.fov, selectedCamera.optics),
                    fStop: Math.max(0.7, Math.min(64, Number(event.target.value))),
                  },
                },
              })}
              className={fieldClass}
            />
          </Field>
        </div>
        {selectedFocusTarget ? (
          <VectorField
            label="Focus offset"
            value={selectedFocusOffset as DirectorStageVector3}
            onChange={(targetOffset) => apply({
              op: "camera.update",
              cameraId: selectedCamera.id,
              patch: { targetOffset },
            })}
          />
        ) : null}
        <p className="text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]">
          A bound target drives pitch and yaw while the camera or subject moves. Remove the target to freeze the current angle.
        </p>
        <Field label="Camera move">
          <SelectMenu
            ariaLabel="Camera move preset"
            value={cameraMovePreset}
            options={DIRECTOR_CAMERA_MOVE_PRESETS}
            onValueChange={(value) => setCameraMovePreset(value as DirectorCameraMovePreset)}
            variant="field"
          />
        </Field>
        <Button
          variant={null}
          size="sm"
          shape="rounded"
          disabled={!selectedFocusTarget || !cameraMoveShot}
          leftIcon={<VideoCamera className="h-4 w-4" />}
          onClick={buildSelectedCameraMove}
          className="h-9 min-h-9 w-full justify-start border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2 text-[10px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
        >
          Apply camera move
        </Button>
        <p className="text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]">
          {DIRECTOR_CAMERA_MOVE_PRESETS.find(
            (preset) => preset.value === cameraMovePreset,
          )?.detail} The move is stored on the selected Shot with settle windows, a locked lens, and an independent orientation track.
        </p>
      </section>
      <section className="space-y-3">
        <VectorField
          label="Position"
          value={selectedCamera.position}
          onChange={(position) => apply({ op: "camera.update", cameraId: selectedCamera.id, patch: { position } })}
        />
        <CameraAngleField
          value={selectedCamera.rotation}
          disabled={Boolean(selectedCamera.targetObjectId)}
          onChange={(rotation) => apply({ op: "camera.update", cameraId: selectedCamera.id, patch: { rotation } })}
        />
        <Field label="New key interpolation">
          <SelectMenu
            ariaLabel="New key interpolation"
            value={newKeyInterpolation}
            options={[
              { value: "bezier", label: "Smooth" },
              { value: "linear", label: "Linear" },
              { value: "hold", label: "Hold" },
            ]}
            onValueChange={(value) => setNewKeyInterpolation(value as DirectorKeyframeInterpolation)}
            variant="field"
          />
        </Field>
        <Field label="Motion paths">
          <div className="grid grid-cols-3 gap-1">
            <Button
              variant={null}
              size="sm"
              shape="rounded"
              leftIcon={<BezierCurve className="h-4 w-4" />}
              onClick={() => addPositionKeyframe(selectedCamera.id, selectedCamera.position)}
              className="h-9 min-h-9 justify-start border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2 text-[10px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
            >
              Add position keyframe · {playheadSeconds.toFixed(2)}s
            </Button>
            <Button
              variant={null}
              size="sm"
              shape="rounded"
              disabled={Boolean(selectedCamera.targetObjectId)}
              leftIcon={<ArrowsClockwise className="h-4 w-4" />}
              onClick={() => addRotationKeyframe(selectedCamera.id, selectedCamera.rotation)}
              className="h-9 min-h-9 justify-start border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2 text-[10px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
            >
              Add angle keyframe · {playheadSeconds.toFixed(2)}s
            </Button>
            <Button
              variant={null}
              size="sm"
              shape="rounded"
              leftIcon={<Camera className="h-4 w-4" />}
              onClick={() => addFocalLengthKeyframe(selectedCamera.id, selectedFocalLength)}
              className="h-9 min-h-9 justify-start border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2 text-[10px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
            >
              Add focal length keyframe · {playheadSeconds.toFixed(2)}s
            </Button>
          </div>
          <span className="mt-1 block text-[9px] tabular-nums text-[var(--clash-director-panel-muted)]">Playhead · {playheadSeconds.toFixed(2)}s</span>
        </Field>
        {selectedKeyframeTrack?.targetId === selectedCamera.id
          ? selectedKeyframeEditor
          : null}
      </section>
    </div>
  ) : (
    <div className="space-y-4 p-3">
      <div>
        <span className={labelClass}>3D scene</span>
        <strong className="block text-sm text-[var(--clash-director-panel-text)]">Scene properties</strong>
      </div>
      <section
        data-director-story-template=""
        className="rounded-lg border border-[var(--clash-director-selection)] bg-[var(--clash-director-selection-soft)] p-2.5"
      >
        <div className="flex items-start gap-2">
          <UsersThree
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--clash-director-selection)]"
            weight="fill"
          />
          <div className="min-w-0">
            <strong className="block text-[11px] text-[var(--clash-director-panel-text)]">
              多角色剧本 · 迟到的信
            </strong>
            <p className="mt-1 text-[9px] leading-relaxed text-[var(--clash-director-panel-secondary)]">
              1 scene · 7 shots · 7 story beats · 3 actors with blocking, dialogue and camera moves.
            </p>
          </div>
        </div>
        <Button
          variant={null}
          size="sm"
          shape="rounded"
          disabled={state.objects.length > 0 || state.cameras.length > 0}
          onClick={stageThreeActorStory}
          leftIcon={<Play className="h-3.5 w-3.5" weight="fill" />}
          className="mt-2 h-8 min-h-8 w-full justify-start bg-[var(--clash-director-selection)] px-2 text-[11px] font-semibold text-[var(--clash-director-selection-foreground)] shadow-none hover:opacity-90"
        >
          Stage three-actor story
        </Button>
        {state.objects.length > 0 || state.cameras.length > 0 ? (
          <p className="mt-1.5 text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]">
            Available on an empty stage so existing blocking and camera work are never replaced.
          </p>
        ) : null}
      </section>
      <Field label="Background">
        <input
          aria-label="Scene background"
          type="color"
          value={state.scene.backgroundColor}
          onChange={(event) => apply({ op: "scene.update", patch: { backgroundColor: event.target.value } })}
          className="h-8 w-full cursor-pointer rounded-md border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] p-1"
        />
      </Field>
      <Field label="Panorama">
        <SelectMenu
          ariaLabel="Scene panorama"
          value={state.scene.environmentAssetId ?? "none"}
          options={[
            { value: "none", label: "None" },
            ...allPanoramas.map((item) => ({ value: item.assetId, label: item.label })),
          ]}
          onValueChange={(assetId) => {
            if (assetId === "none") {
              const { environmentAssetId: _environmentAssetId, ...scene } = state.scene;
              save({ ...state, scene });
            } else {
              const selectedPanorama = allPanoramas.find(
                (item) => item.assetId === assetId,
              );
              const calibration =
                selectedPanorama?.calibration ?? activePanoramaCalibration;
              apply({
                op: "scene.update",
                patch: {
                  environmentAssetId: assetId,
                  environmentCalibration: calibration,
                  environmentRotation:
                    directorPanoramaEnvironmentRotation(calibration),
                },
              });
            }
          }}
          variant="field"
        />
      </Field>
      <Field label="Environment mode">
        <SelectMenu
          ariaLabel="Environment mode"
          value={activePanoramaVolume?.preset ?? "background-sphere"}
          options={PANORAMA_ENVIRONMENT_OPTIONS}
          onValueChange={selectPanoramaEnvironmentMode}
          variant="field"
        />
      </Field>
      {activePanoramaVolume?.preset === "custom" ? (
        <div className="grid grid-cols-3 gap-1">
          {([
            { axis: 0, label: "Width", ariaLabel: "Panorama space width", value: activePanoramaVolume.size[0] },
            { axis: 2, label: "Depth", ariaLabel: "Panorama space depth", value: activePanoramaVolume.size[2] },
            { axis: 1, label: "Height", ariaLabel: "Panorama space height", value: activePanoramaVolume.size[1] },
          ] as const).map((dimension) => (
            <label key={dimension.label} className="min-w-0">
              <span className="mb-1 block text-[9px] text-[var(--clash-director-panel-muted)]">
                {dimension.label} · m
              </span>
              <Input
                aria-label={dimension.ariaLabel}
                type="number"
                min="0.5"
                max={dimension.axis === 1 ? 100 : 500}
                step="0.5"
                value={dimension.value}
                onChange={(event) => updatePanoramaDimension(
                  dimension.axis,
                  Number(event.target.value),
                )}
                className={fieldClass}
              />
            </label>
          ))}
        </div>
      ) : !activePanoramaVolume ? (
        <p className="text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]">
          Distant backdrop · valid for camera rotation, with no translation parallax or inferred room size.
        </p>
      ) : (
        <p className="text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]">
          {activePanoramaVolume.size[0]} m wide × {activePanoramaVolume.size[2]} m deep × {activePanoramaVolume.size[1]} m high · switch to Custom space to edit.
        </p>
      )}
      <Button
        variant={null}
        size="sm"
        shape="rounded"
        aria-pressed={showPanoramaBackground}
        disabled={!environmentUrl}
        onClick={() => setShowPanoramaBackground((value) => !value)}
        className="h-8 min-h-8 w-full justify-between border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2 text-[11px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
      >
        Preview panorama in viewport
        <span className={showPanoramaBackground ? "text-[var(--clash-director-selection)]" : "text-[var(--clash-director-panel-muted)]"}>
          {showPanoramaBackground ? "On" : "Off"}
        </span>
      </Button>
      {environmentUrl ? (
        <div className="space-y-3 rounded-lg border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className={`${labelClass} mb-0`}>Panorama alignment</span>
            <button
              type="button"
              onClick={() => apply({ op: "scene.update", patch: { environmentRotation: [0, 0, 0] } })}
              className="rounded px-1.5 py-0.5 text-[10px] text-[var(--clash-director-panel-muted)] hover:bg-[var(--clash-director-panel-hover)] hover:text-[var(--clash-director-panel-text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--clash-director-selection)]"
            >
              Reset
            </button>
          </div>
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-[10px] text-[var(--clash-director-panel-muted)]">
              <span>Horizon</span>
              <output className="font-mono tabular-nums text-[var(--clash-director-panel-secondary)]">{environmentHorizonDegrees}°</output>
            </span>
            <input
              aria-label="Panorama horizon"
              type="range"
              min="-30"
              max="30"
              step="1"
              value={environmentHorizonDegrees}
              onChange={(event) => apply({
                op: "scene.update",
                patch: {
                  environmentRotation: [
                    Number(event.target.value) * THREE_DEGREES_TO_RADIANS,
                    environmentRotation[1],
                    environmentRotation[2],
                  ],
                },
              })}
              className="h-4 w-full accent-[var(--clash-director-selection)]"
            />
          </label>
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-[10px] text-[var(--clash-director-panel-muted)]">
              <span>Yaw</span>
              <output className="font-mono tabular-nums text-[var(--clash-director-panel-secondary)]">{environmentYawDegrees}°</output>
            </span>
            <input
              aria-label="Panorama yaw"
              type="range"
              min="-180"
              max="180"
              step="1"
              value={environmentYawDegrees}
              onChange={(event) => apply({
                op: "scene.update",
                patch: {
                  environmentRotation: [
                    environmentRotation[0],
                    Number(event.target.value) * THREE_DEGREES_TO_RADIANS,
                    environmentRotation[2],
                  ],
                },
              })}
              className="h-4 w-full accent-[var(--clash-director-selection)]"
            />
          </label>
          <p className="text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]">
            {activePanoramaVolume
              ? "Match the horizon and facing direction to the finite 3D floor. The selected space size controls wall projection, grid extent, and camera navigation."
              : "Match the horizon and facing direction. Background sphere is a distant visual backdrop and does not define metric floor depth."}
          </p>
          <Button
            variant={null}
            size="sm"
            shape="rounded"
            aria-label="Lock panorama calibration camera"
            aria-pressed={panoramaCalibrationLocked}
            disabled={!state.scene.environmentCalibration}
            onClick={() => {
              const calibration = state.scene.environmentCalibration;
              if (!calibration) return;
              const nextLocked = !panoramaCalibrationLocked;
              setPanoramaCalibrationLocked(nextLocked);
              if (!nextLocked) return;
              setViewMode("director");
              setShowPanoramaBackground(true);
              apply({
                op: "scene.update",
                patch: {
                  environmentRotation: directorPanoramaEnvironmentRotation(calibration),
                },
              });
            }}
            className="h-8 min-h-8 w-full justify-between border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2 text-[11px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
          >
            Lock calibration camera
            <span className={panoramaCalibrationLocked ? "text-[var(--clash-director-selection)]" : "text-[var(--clash-director-panel-muted)]"}>
              {panoramaCalibrationLocked ? "On" : "Off"}
            </span>
          </Button>
        </div>
      ) : null}
      <Button
        variant={null}
        size="sm"
        shape="rounded"
        disabled={!onUploadPanorama}
        onClick={() => panoramaInputRef.current?.click()}
        leftIcon={<UploadSimple className="h-4 w-4" />}
        className="h-8 min-h-8 w-full justify-start border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2 text-[11px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
      >
        Upload panorama · 2:1
      </Button>
      <div
        data-director-panorama-generator=""
        className="rounded-lg border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] p-2.5"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-[var(--clash-director-panel-text)]">AI panorama</span>
          <span className="font-mono text-[9px] text-[var(--clash-director-panel-muted)]">WebP · 2:1</span>
        </div>
        <div className="space-y-2">
          <Field label="Generation setup">
            <SelectMenu
              ariaLabel="AI panorama environment mode"
              value={activePanoramaVolume?.preset ?? "background-sphere"}
              options={PANORAMA_ENVIRONMENT_OPTIONS}
              onValueChange={selectPanoramaEnvironmentMode}
              variant="field"
            />
          </Field>
          <div
            data-director-panorama-generation-setup={panoramaGenerationSetup.mode}
            className="border-y border-[var(--clash-director-panel-divider)] py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold text-[var(--clash-director-panel-text)]">
                {panoramaGenerationSetup.modeLabel}
              </span>
              <span className="text-[9px] font-medium uppercase tracking-[0.08em] text-[var(--clash-director-selection)]">
                {panoramaGenerationSetup.mode === "background-sphere" ? "Background" : "Finite"}
              </span>
            </div>
            <p className="mt-1 text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]">
              {panoramaGenerationSetup.detail}
            </p>
          </div>
          <Field label="Reference scene">
            <SelectMenu
              ariaLabel="Panorama reference scene"
              value={panoramaReferenceAssetId}
              options={[
                { value: "none", label: "None" },
                ...allPanoramas.map((item) => ({ value: item.assetId, label: item.label })),
              ]}
              onValueChange={setPanoramaReferenceAssetId}
              variant="field"
            />
          </Field>
          <Field label="Scene brief">
            <Textarea
              aria-label="AI panorama prompt"
              value={panoramaPrompt}
              rows={3}
              placeholder="雨夜上海街角，霓虹反射，写实电影灯光…"
              onChange={(event) => setPanoramaPrompt(event.target.value)}
              className="min-h-[72px] w-full resize-y rounded-md border border-[var(--clash-director-field-border)] bg-[var(--clash-director-panel)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--clash-director-panel-text)] placeholder:text-[var(--clash-director-panel-muted)]"
            />
          </Field>
          <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--clash-director-field-border)] bg-[var(--clash-director-panel)] px-2.5 py-2">
            <div className="min-w-0">
              <span className="text-[10px] font-semibold text-[var(--clash-director-panel-text)]">Calibration pass</span>
              <p className="text-[9px] leading-snug text-[var(--clash-director-panel-muted)]">
                Use an exact-size 2:1 reference image; Clash owns the 1 m grid and capture geometry.
              </p>
            </div>
            <Switch
              aria-label="Generate panorama calibration grid"
              checked={panoramaCalibrationGrid}
              onCheckedChange={setPanoramaCalibrationGrid}
              className="shrink-0 border-[var(--clash-director-field-border)] bg-[var(--clash-director-panel)] data-[state=checked]:border-[var(--clash-director-selection)] data-[state=checked]:bg-[var(--clash-director-selection)] [&>span]:bg-[var(--clash-director-control)]"
            />
          </div>
          <Button
            variant={null}
            size="sm"
            shape="rounded"
            disabled={!onGeneratePanorama || (!panoramaPrompt.trim() && panoramaReferenceAssetId === "none") || panoramaGenerationStatus === "generating"}
            onClick={() => void generatePanorama()}
            leftIcon={<Sparkle className="h-4 w-4" weight="fill" />}
            className="h-8 min-h-8 w-full justify-start border border-[var(--clash-director-selection)] bg-[var(--clash-director-selection-soft)] px-2 text-[11px] font-semibold text-[var(--clash-director-panel-text)] shadow-none hover:bg-[var(--clash-director-panel-active)] disabled:border-[var(--clash-director-field-border)]"
          >
            {panoramaGenerationStatus === "generating"
              ? panoramaGenerationSetup.generatingLabel
              : panoramaGenerationSetup.actionLabel}
          </Button>
          <p className="text-[9px] leading-relaxed text-[var(--clash-director-panel-muted)]">
            Reference image · exact 2048×1024 equirectangular WebP
          </p>
          {panoramaGenerationReceipt ? (
            <div
              data-director-panorama-generation-receipt={panoramaGenerationReceipt.mode}
              role="status"
              className="flex items-start gap-2 rounded-md border border-[var(--clash-director-selection)] bg-[var(--clash-director-selection-soft)] px-2.5 py-2"
            >
              <CheckCircle
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--clash-director-selection)]"
                weight="fill"
              />
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold text-[var(--clash-director-panel-text)]">
                    {panoramaGenerationReceipt.receiptLabel}
                  </span>
                  <span className="shrink-0 text-[8px] font-medium uppercase tracking-[0.08em] text-[var(--clash-director-panel-muted)]">
                    Last output
                  </span>
                </div>
                <p className="mt-0.5 text-[9px] leading-relaxed text-[var(--clash-director-panel-secondary)]">
                  {panoramaGenerationReceipt.receiptDetail}
                </p>
              </div>
            </div>
          ) : null}
          {panoramaGenerationError ? (
            <p data-director-panorama-error="" role="alert" className="text-[10px] leading-relaxed text-[var(--clash-director-danger)]">
              {panoramaGenerationError}
            </p>
          ) : null}
          {!onGeneratePanorama ? (
            <p className="text-[10px] leading-relaxed text-[var(--clash-director-panel-muted)]">
              Configure an image model to enable generation.
            </p>
          ) : null}
        </div>
      </div>
      <div
        data-director-model-generator=""
        className="rounded-lg border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] p-2.5"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-[var(--clash-director-panel-text)]">AI 3D model</span>
          <span className="font-mono text-[9px] text-[var(--clash-director-panel-muted)]">Hunyuan3D V3 · fal.ai</span>
        </div>
        <div className="space-y-2">
          <Field label="Object brief">
            <Textarea
              aria-label="3D model prompt"
              value={modelPrompt}
              rows={3}
              placeholder="A cinematic medieval war saddle with worn leather and brass fittings…"
              onChange={(event) => setModelPrompt(event.target.value)}
              className="min-h-[72px] w-full resize-y rounded-md border border-[var(--clash-director-field-border)] bg-[var(--clash-director-panel)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--clash-director-panel-text)] placeholder:text-[var(--clash-director-panel-muted)]"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Mesh type">
              <SelectMenu
                ariaLabel="3D model quality"
                value={modelQuality}
                options={[
                  { value: "normal", label: "Normal" },
                  { value: "low-poly", label: "Low poly" },
                  { value: "geometry", label: "Geometry only" },
                ]}
                onValueChange={(quality) => setModelQuality(
                  quality as DirectorStageModelGenerationInput["quality"],
                )}
                variant="field"
              />
            </Field>
            <Field label="Face budget">
              <Input
                aria-label="3D model face count"
                type="number"
                min="40000"
                max="1500000"
                step="10000"
                value={modelFaceCount}
                onChange={(event) => setModelFaceCount(
                  Math.min(1_500_000, Math.max(40_000, Number(event.target.value))),
                )}
                className={fieldClass}
              />
            </Field>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--clash-director-field-border)] bg-[var(--clash-director-panel)] px-2.5 py-2">
            <div className="min-w-0">
              <span className="text-[10px] font-semibold text-[var(--clash-director-panel-text)]">PBR materials</span>
              <p className="text-[9px] leading-snug text-[var(--clash-director-panel-muted)]">Generate textures and physically based material maps.</p>
            </div>
            <Switch
              aria-label="Generate PBR materials"
              checked={modelPbr}
              onCheckedChange={setModelPbr}
              className="shrink-0 border-[var(--clash-director-field-border)] bg-[var(--clash-director-panel)] data-[state=checked]:border-[var(--clash-director-selection)] data-[state=checked]:bg-[var(--clash-director-selection)] [&>span]:bg-[var(--clash-director-control)]"
            />
          </div>
          <Button
            variant={null}
            size="sm"
            shape="rounded"
            disabled={!onGenerateModel || !modelPrompt.trim() || modelGenerationStatus === "generating"}
            onClick={() => void generateModel()}
            leftIcon={<Sparkle className="h-4 w-4" weight="fill" />}
            className="h-8 min-h-8 w-full justify-start border border-[var(--clash-director-selection)] bg-[var(--clash-director-selection-soft)] px-2 text-[11px] font-semibold text-[var(--clash-director-panel-text)] shadow-none hover:bg-[var(--clash-director-panel-active)] disabled:border-[var(--clash-director-field-border)]"
          >
            {modelGenerationStatus === "generating" ? "Generating 3D model…" : "Generate 3D model"}
          </Button>
          {modelGenerationReceipt ? (
            <div role="status" className="flex items-start gap-2 rounded-md border border-[var(--clash-director-selection)] bg-[var(--clash-director-selection-soft)] px-2.5 py-2">
              <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--clash-director-selection)]" weight="fill" />
              <div className="min-w-0">
                <span className="block truncate text-[10px] font-semibold text-[var(--clash-director-panel-text)]">{modelGenerationReceipt.name}</span>
                <p className="mt-0.5 text-[9px] text-[var(--clash-director-panel-secondary)]">GLB saved to project assets and added to the stage.</p>
              </div>
            </div>
          ) : null}
          {modelGenerationError ? (
            <p data-director-model-error="" role="alert" className="text-[10px] leading-relaxed text-[var(--clash-director-danger)]">
              {modelGenerationError}
            </p>
          ) : null}
          {!onGenerateModel ? (
            <p className="text-[10px] leading-relaxed text-[var(--clash-director-panel-muted)]">Configure a fal.ai provider account to enable real 3D generation.</p>
          ) : null}
        </div>
      </div>
      <Field label="Grid size">
        <Input
          type="number"
          min="0.1"
          step="0.1"
          value={state.scene.grid.size}
          onChange={(event) => apply({ op: "scene.update", patch: { grid: { size: Number(event.target.value) } } })}
          className={fieldClass}
        />
      </Field>
      <Button
        variant={null}
        size="sm"
        shape="rounded"
        onClick={() => apply({ op: "scene.update", patch: { grid: { snap: !state.scene.grid.snap } } })}
        className="h-8 min-h-8 w-full justify-between border border-[var(--clash-director-field-border)] bg-[var(--clash-director-field)] px-2 text-[11px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
      >
        Grid snap (X)
        <span className={state.scene.grid.snap ? "text-[var(--clash-director-selection)]" : "text-[var(--clash-director-panel-muted)]"}>
          {state.scene.grid.snap ? "On" : "Off"}
        </span>
      </Button>
      {state.shots.length > 0 ? (
        <div>
          <span className={labelClass}>Shots</span>
          <div className="space-y-1">
            {state.shots.map((shot) => (
              <button
                key={shot.id}
                type="button"
                onClick={() => onOpenAsset?.(shot.assetId)}
                className="flex h-9 w-full items-center justify-between rounded-md bg-[var(--clash-director-field)] px-2 text-left text-[11px] text-[var(--clash-director-panel-secondary)] hover:bg-[var(--clash-director-panel-hover)]"
              >
                <span className="truncate">{shot.name}</span>
                <span className="text-[var(--clash-director-panel-muted)]">{shot.aspectRatio}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <ControlContextProvider value="director">
      <main
      data-testid="project-director-stage-editor"
      data-director-active-camera={evaluatedStage.activeCameraId}
      data-director-viewport-ready={viewportReady}
      aria-label={`${stage.name} Director Stage`}
      className="absolute inset-0 z-10 min-h-0 overflow-hidden bg-warm-page"
    >
      <div
        className="absolute inset-y-0 left-0 min-w-0 overflow-hidden motion-reduce:transition-none"
        style={{ right: rightInset, transition: "right 240ms cubic-bezier(0.22, 1, 0.36, 1)" }}
      >
        <div className="clash-director-stage-shell grid h-full min-h-0 [--clash-director-panel-width:clamp(220px,16vw,260px)] [--clash-director-inspector-width:clamp(288px,20vw,336px)] [--clash-director-timeline-height:clamp(170px,27vh,260px)] [grid-template-columns:minmax(min(220px,28%),var(--clash-director-panel-width))_minmax(min(320px,40%),1fr)_minmax(min(288px,32%),var(--clash-director-inspector-width))] [grid-template-rows:2.75rem_minmax(0,1fr)_var(--clash-director-timeline-height)]">
          <header className="col-span-3 flex min-w-0 items-center justify-between border-b border-[var(--clash-director-panel-divider)] bg-[var(--clash-director-panel)] px-2 text-[var(--clash-director-panel-text)]">
            <div className="flex min-w-0 items-center gap-1.5">
              {parentCanvas ? (
                <Tooltip label={`Open parent Canvas ${parentCanvas.name}`}>
                  <IconButton
                    label={`Open parent Canvas ${parentCanvas.name}`}
                    icon={<CanvasIcon className="h-4 w-4" />}
                    onClick={() => onOpenCanvas(parentCanvas.id)}
                    size="sm"
                    shape="rounded"
                    className="h-8 min-h-8 w-8 min-w-8 bg-transparent text-[var(--clash-director-panel-muted)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
                  />
                </Tooltip>
              ) : null}
              <Cube className="h-4 w-4 text-[var(--clash-director-selection)]" weight="fill" />
              <strong className="truncate text-xs">{stage.name}</strong>
            </div>
            <div className="flex items-center rounded-md border border-[var(--clash-director-control-border)] bg-[var(--clash-director-control)] p-0.5">
              {(["director", "camera"] as const).map((mode) => (
                <Button
                  key={mode}
                  variant={null}
                  size="sm"
                  shape="rounded"
                  disabled={mode === "camera" && state.cameras.length === 0}
                  onClick={() => setViewMode(mode)}
                  className={`h-7 min-h-7 px-3 text-[11px] shadow-none ${viewMode === mode ? "bg-[var(--clash-director-control-active)] text-[var(--clash-director-panel-text)]" : "bg-transparent text-[var(--clash-director-panel-secondary)] hover:bg-[var(--clash-director-control-hover)]"}`}
                >
                  {mode === "director" ? "Director view" : "Camera view"}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-1.5" style={{ paddingRight: headerEndInset }}>
              <SelectMenu
                ariaLabel="Shot aspect ratio"
                value={aspectRatio}
                options={(["16:9", "9:16", "4:3", "3:4", "1:1"] as DirectorAspectRatio[]).map((ratio) => ({ value: ratio, label: ratio }))}
                onValueChange={setAspectRatio}
                variant="pill"
                size="sm"
                triggerClassName="h-8 min-h-8 rounded-md border-[var(--clash-director-control-border)] bg-[var(--clash-director-control)] px-2 text-[11px] text-[var(--clash-director-panel-secondary)] shadow-none"
              />
              <Button
                variant={null}
                size="sm"
                shape="rounded"
                onClick={() => void captureShot()}
                disabled={!viewportReady || captureStatus === "capturing"}
                leftIcon={<Camera className="h-4 w-4" />}
                className="h-8 min-h-8 bg-[var(--clash-director-selection)] px-3 text-[11px] text-[var(--clash-director-selection-foreground)] shadow-sm hover:opacity-90"
              >
                {captureStatus === "capturing" ? "Capturing…" : captureStatus === "error" ? "Retry capture" : "Capture shot"}
              </Button>
              <Button
                variant={null}
                size="sm"
                shape="rounded"
                leftIcon={<VideoCamera className="h-4 w-4" />}
                onClick={() => void exportDirectorVideo("sequence-preview")}
                disabled={!viewportReady || !onExportVideo || state.cameras.length === 0 || videoExportStatus === "exporting"}
                className="h-8 min-h-8 border border-[var(--clash-director-control-border)] bg-[var(--clash-director-control)] px-2.5 text-[11px] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-control-hover)]"
                data-director-video-export-status={videoExportStatus}
              >
                {videoExportStatus === "exporting" ? "Exporting…" : "Preview sequence"}
              </Button>
            </div>
          </header>

          <aside className="min-h-0 overflow-hidden border-r border-[var(--clash-director-panel-divider)] bg-[var(--clash-director-panel)] text-[var(--clash-director-panel-text)]">
            <div className="flex h-10 items-center gap-1 border-b border-[var(--clash-director-panel-divider)] px-2">
              <div className="relative min-w-0 flex-1">
                <MagnifyingGlass className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--clash-director-panel-muted)]" />
                <Input
                  aria-label="Search scene"
                  placeholder="Search scene"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className={`${fieldClass} h-7 pl-7`}
                />
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    label="Add scene element"
                    icon={<Plus className="h-3.5 w-3.5" />}
                    size="sm"
                    shape="rounded"
                    className="h-7 min-h-7 w-7 min-w-7 bg-[var(--clash-director-field)] text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-panel-hover)]"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-[min(540px,calc(100vh-7rem))] min-w-60 overflow-y-auto rounded-lg bg-warm-surface">
                  <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-stone-400">Editable actors</div>
                  {DIRECTOR_MANNEQUIN_BODY_TYPES.map((body, index) => (
                    <DropdownMenuItem key={body.value} onSelect={() => addMannequin(body.value)}>
                      <span className="h-3.5 w-3.5 rounded-full border border-black/10" style={{ backgroundColor: body.token }} />
                      {index === 0 ? "Add editable actor" : `${body.label} actor`}
                    </DropdownMenuItem>
                  ))}
                  <div className="mx-2 my-1 h-px bg-warm-border" />
                  <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-stone-400">Production assets</div>
                  <DropdownMenuItem onSelect={() => setModelLibraryOpen(true)}>
                    <Cube className="h-4 w-4" />
                    Browse real 3D assets
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!onUploadModel} onSelect={() => modelInputRef.current?.click()}>
                    <UploadSimple className="h-4 w-4" />
                    Import GLB/glTF
                  </DropdownMenuItem>
                  <div className="mx-2 my-1 h-px bg-warm-border" />
                  <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-stone-400">Blockout only</div>
                  <DropdownMenuItem onSelect={() => addPrimitive()}><Cube className="h-4 w-4" /> Box proxy</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => addPrimitive("capsule")}><Cube className="h-4 w-4" /> Capsule proxy</DropdownMenuItem>
                  <DropdownMenuItem onSelect={addCrowd}><UsersThree className="h-4 w-4" /> Crowd proxy 3×3</DropdownMenuItem>
                  <div className="mx-2 my-1 h-px bg-warm-border" />
                  <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-stone-400">Cameras</div>
                  <DropdownMenuItem onSelect={addCameraFromCurrentView}><Camera className="h-4 w-4" /> Add camera</DropdownMenuItem>
                  <div className="mx-2 my-1 h-px bg-warm-border" />
                  <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-stone-400">Lights</div>
                  <DropdownMenuItem onSelect={() => addLight("point")}><Sparkle className="h-4 w-4" /> Add point light</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => addLight("spot")}><Sparkle className="h-4 w-4" /> Add spot light</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => addLight("directional")}><Sparkle className="h-4 w-4" /> Add directional light</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="h-[calc(100%-2.5rem)] overflow-y-auto p-2">
              <SceneRow
                active={inspectorMode === "scene"}
                icon={<GridFour className="h-3.5 w-3.5" />}
                label="3D Scene"
                annotationTarget={{
                  objectId: "scene",
                  objectType: "director-scene",
                  objectLabel: "3D Scene",
                }}
                onClick={() => {
                  setSelectedObjectIds([]);
                  setSelectedCameraId(undefined);
                  setSelectedSequenceShotId(undefined);
                }}
                onContextMenu={() => onAnnotationTargetContextMenu?.({
                  objectId: "scene",
                  objectType: "director-scene",
                  objectLabel: "3D Scene",
                })}
              />
              <div className="mt-2 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--clash-director-panel-muted)]">Objects</div>
              <div className="mt-1 space-y-0.5">
                {filteredObjects.map((object) => (
                  <SceneRow
                    key={object.id}
                    active={selectedObjectIds.includes(object.id)}
                    icon={object.kind === "mannequin" ? <User className="h-3.5 w-3.5" /> : object.kind === "crowd" ? <UsersThree className="h-3.5 w-3.5" /> : <Cube className="h-3.5 w-3.5" />}
                    label={object.name}
                    annotationTarget={{
                      objectId: object.id,
                      objectType: `director-${object.kind}`,
                      objectLabel: object.name,
                    }}
                    visible={object.visible}
                    onClick={(event) => selectObject(object.id, event.metaKey || event.ctrlKey || event.shiftKey)}
                    onContextMenu={() => {
                      selectObject(object.id);
                      onAnnotationTargetContextMenu?.({
                        objectId: object.id,
                        objectType: `director-${object.kind}`,
                        objectLabel: object.name,
                      });
                    }}
                    onToggleVisible={() => apply({ op: "object.update", objectId: object.id, patch: { visible: !object.visible } })}
                  />
                ))}
              </div>
              <div className="mt-3 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--clash-director-panel-muted)]">Cameras</div>
              <div className="mt-1 space-y-0.5">
                {state.cameras.map((camera) => (
                  <SceneRow
                    key={camera.id}
                    active={selectedCamera?.id === camera.id}
                    icon={<Camera className="h-3.5 w-3.5" />}
                    label={camera.name}
                    annotationTarget={{
                      objectId: camera.id,
                      objectType: "director-camera",
                      objectLabel: camera.name,
                    }}
                    onClick={() => {
                      setSelectedObjectIds([]);
                      setSelectedSequenceShotId(undefined);
                      setSelectedCameraId(camera.id);
                      save({ ...state, activeCameraId: camera.id });
                    }}
                    onContextMenu={() => {
                      setSelectedObjectIds([]);
                      setSelectedSequenceShotId(undefined);
                      setSelectedCameraId(camera.id);
                      onAnnotationTargetContextMenu?.({
                        objectId: camera.id,
                        objectType: "director-camera",
                        objectLabel: camera.name,
                      });
                    }}
                  />
                ))}
              </div>
            </div>
          </aside>

          <section className="relative min-h-0 min-w-0 overflow-hidden bg-[var(--clash-director-viewport)]">
            {!code.ready && <div role={code.error ? "alert" : "status"}>{code.error ?? "Loading Director source…"}</div>}
            {code.ready && <DirectorViewport
              ref={viewportRef}
              state={state}
              selectedObjectId={selectedObjectId}
              selectedCameraId={selectedCameraId}
              transformMode={transformMode}
              viewMode={viewMode}
              viewPreset={viewPreset}
              calibrationCamera={panoramaCalibrationCamera}
              gridSnap={state.scene.grid.snap}
              timeSeconds={playheadSeconds}
              environmentUrl={environmentUrl}
              showEnvironmentBackground={showPanoramaBackground}
              showSelectedSkeleton={showSkeleton}
              assetUrls={modelAssetUrls}
              codeSources={code.sources}
              renderPalette={panoramaCalibrationPalette}
              onReady={() => setViewportReady(true)}
              onError={() => setViewportReady(false)}
              onSelectionChange={(objectId) => objectId ? selectObject(objectId) : setSelectedObjectIds([])}
              onObjectContextMenu={(objectId) => {
                const object = state.objects.find((candidate) => candidate.id === objectId);
                if (!object) return;
                onAnnotationTargetContextMenu?.({
                  objectId: object.id,
                  objectType: `director-${object.kind}`,
                  objectLabel: object.name,
                });
              }}
              onTransformCommit={(objectId, transform) => apply({ op: "object.update", objectId, patch: { transform } })}
            />}
            <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-[var(--clash-director-control-border)] bg-[var(--clash-director-control)] p-1 shadow-lg backdrop-blur">
              {([
                ["translate", <ArrowsOutCardinal className="h-4 w-4" />, "Move (V)"],
                ["rotate", <ArrowsClockwise className="h-4 w-4" />, "Rotate (R)"],
                ["scale", <Cube className="h-4 w-4" />, "Scale (S)"],
              ] as const).map(([mode, icon, label]) => (
                <IconButton
                  key={mode}
                  label={label}
                  icon={icon}
                  size="sm"
                  shape="rounded"
                  aria-pressed={transformMode === mode}
                  onClick={() => setTransformMode(mode)}
                  className={`h-8 min-h-8 w-8 min-w-8 rounded-md shadow-none ${transformMode === mode ? "bg-[var(--clash-director-control-active)] text-[var(--clash-director-panel-text)]" : "bg-transparent text-[var(--clash-director-panel-secondary)] hover:bg-[var(--clash-director-control-hover)]"}`}
                />
              ))}
              <span className="mx-1 h-5 w-px bg-[var(--clash-director-control-border)]" />
              <Tooltip label="Top view (T)"><IconButton label="Top view" icon={<span className="text-[10px] font-bold">T</span>} onClick={() => setViewPreset("top")} size="sm" shape="rounded" className="h-8 min-h-8 w-8 min-w-8 bg-transparent text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-control-hover)]" /></Tooltip>
              <Tooltip label="Front view (Y)"><IconButton label="Front view" icon={<span className="text-[10px] font-bold">Y</span>} onClick={() => setViewPreset("front")} size="sm" shape="rounded" className="h-8 min-h-8 w-8 min-w-8 bg-transparent text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-control-hover)]" /></Tooltip>
              <Tooltip label="Reset view (Q)"><IconButton label="Reset view" icon={<ArrowCounterClockwise className="h-4 w-4" />} onClick={() => setViewPreset("reset")} size="sm" shape="rounded" className="h-8 min-h-8 w-8 min-w-8 bg-transparent text-[var(--clash-director-panel-secondary)] shadow-none hover:bg-[var(--clash-director-control-hover)]" /></Tooltip>
            </div>
          </section>

          <aside className="min-h-0 overflow-y-auto border-l border-[var(--clash-director-panel-divider)] bg-[var(--clash-director-panel)]">
            {inspector}
          </aside>

          <section ref={timelineRef} className="col-span-3 min-h-0 overflow-hidden border-t border-[var(--clash-director-timeline-divider)] bg-[var(--clash-director-timeline-surface)]">
            <div className="flex h-9 items-center gap-1 border-b border-[var(--clash-director-timeline-divider)] px-2">
              <IconButton
                label={playing ? "Pause animation" : "Play animation"}
                icon={playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                onClick={() => setPlaying((value) => !value)}
                size="sm"
                shape="rounded"
                className="h-7 min-h-7 w-7 min-w-7 bg-transparent text-[var(--clash-director-timeline-label)] shadow-none hover:bg-[var(--clash-director-control-hover)]"
              />
              <span className="w-16 text-center font-mono text-[10px] tabular-nums text-[var(--clash-director-timeline-muted)]">{playheadSeconds.toFixed(2)}s</span>
              <span className="mx-1 h-4 w-px bg-[var(--clash-director-timeline-divider)]" />
              <Button
                variant={null}
                size="sm"
                shape="rounded"
                disabled={state.cameras.length === 0}
                leftIcon={<Plus className="h-3.5 w-3.5" weight="bold" />}
                onClick={addSequenceShot}
                className="h-7 min-h-7 border border-[var(--clash-director-timeline-divider)] bg-transparent px-2 text-[10px] text-[var(--clash-director-timeline-label)] shadow-none hover:bg-[var(--clash-director-control-hover)]"
              >
                Add shot
              </Button>
              <Button
                variant={null}
                size="sm"
                shape="rounded"
                disabled={
                  !viewportReady
                  || !onExportVideo
                  || selectedSequenceShotIds.length === 0
                  || videoExportStatus === "exporting"
                }
                leftIcon={<Sparkle className="h-3.5 w-3.5" weight="bold" />}
                onClick={() => void exportDirectorVideo("selected-shots")}
                className="h-7 min-h-7 border border-[var(--clash-director-selection)] bg-[var(--clash-director-selection-soft)] px-2 text-[10px] font-semibold text-[var(--clash-director-timeline-label)] shadow-none hover:bg-[var(--clash-director-control-hover)] disabled:opacity-45"
              >
                {selectedSequenceShotIds.length > 0
                  ? `Generate ${selectedSequenceShotIds.length} selected shots`
                  : "Generate selected shots"}
              </Button>
              <span className="mx-1 h-4 w-px bg-[var(--clash-director-timeline-divider)]" />
              <label className="flex items-center gap-2 text-[10px] text-[var(--clash-director-timeline-muted)]">
                Zoom
                <input aria-label="Timeline zoom" type="range" min="0.25" max="4" step="0.25" value={timelineZoom} onChange={(event) => setTimelineZoom(Number(event.target.value))} className="w-24 accent-[var(--clash-director-selection)]" />
              </label>
            </div>
            {state.animation ? (
              <DirectorKeyframeTimeline
                animation={state.animation}
                shots={state.shotSequence}
                playheadSeconds={playheadSeconds}
                zoom={timelineZoom}
                viewportWidth={timelineWidth}
                targetLabels={timelineTargetLabels}
                onSeek={setPlayheadSeconds}
                selectedKeyframeId={selectedKeyframeRef?.keyframeId}
                onSelectKeyframe={(trackId, keyframeId) => {
                  const track = state.animation?.tracks.find((candidate) => candidate.id === trackId);
                  if (!track) return;
                  setSelectedKeyframeRef({ trackId, keyframeId });
                  setSelectedActionClipId(undefined);
                  setSelectedSequenceShotId(undefined);
                  const camera = state.cameras.find((candidate) => candidate.id === track.targetId);
                  if (camera) {
                    setSelectedObjectIds([]);
                    setSelectedCameraId(camera.id);
                    return;
                  }
                  const object = state.objects.find((candidate) => candidate.id === track.targetId);
                  if (object) {
                    setSelectedObjectIds([object.id]);
                    setSelectedCameraId(undefined);
                    if (object.kind === "mannequin" || object.kind === "model") {
                      setObjectInspectorTab("motion");
                    }
                  }
                }}
                onChangeKeyframe={(trackId, keyframeId, time) =>
                  updateKeyframe(trackId, keyframeId, { time })}
                selectedActionClipId={selectedActionClipId}
                onSelectActionClip={(clipId) => {
                  const clip = state.animation?.actionClips?.find((candidate) => candidate.id === clipId);
                  if (!clip) return;
                  setSelectedActionClipId(clip.id);
                  setSelectedKeyframeRef(undefined);
                  setSelectedSequenceShotId(undefined);
                  setSelectedObjectIds([clip.targetId]);
                  setSelectedCameraId(undefined);
                  setObjectInspectorTab("motion");
                }}
                onChangeActionClip={(clipId, timing) => updateActionClip(clipId, timing)}
                selectedShotIds={selectedSequenceShotIds}
                primaryShotId={primarySequenceShotId}
                onSelectShot={(shotId, gesture) => {
                  const shot = state.shotSequence?.find((candidate) => candidate.id === shotId);
                  if (!shot) return;
                  const selection = updateDirectorShotSelection({
                    orderedShotIds: [...(state.shotSequence ?? [])]
                      .sort((left, right) =>
                        left.startTime - right.startTime || left.id.localeCompare(right.id))
                      .map((candidate) => candidate.id),
                    selectedShotIds: selectedSequenceShotIds,
                    clickedShotId: shot.id,
                    toggle: gesture.toggle,
                    range: gesture.range,
                    anchorShotId: shotSelectionAnchorId,
                  });
                  setSelectedSequenceShotIds(selection.selectedShotIds);
                  setPrimarySequenceShotId(selection.primaryShotId);
                  setShotSelectionAnchorId(selection.anchorShotId);
                  setSelectedActionClipId(undefined);
                  setSelectedKeyframeRef(undefined);
                  setSelectedObjectIds([]);
                  const primaryShot = state.shotSequence?.find(
                    (candidate) => candidate.id === selection.primaryShotId,
                  );
                  setSelectedCameraId(primaryShot?.cameraId);
                  if (primaryShot) {
                    save({ ...state, activeCameraId: primaryShot.cameraId });
                  }
                }}
                onChangeShot={(shotId, timing) => updateSequenceShot(shotId, timing)}
              />
            ) : (
              <div className="flex h-24 items-center justify-center text-xs text-[var(--clash-director-timeline-muted)]">No animation tracks</div>
            )}
          </section>
        </div>
      </div>
      <input ref={modelInputRef} type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" hidden onChange={(event) => void handleModelFile(event)} />
      <input ref={panoramaInputRef} aria-label="Panorama file" type="file" accept="image/*" hidden onChange={(event) => void handlePanoramaFile(event)} />
      <DirectorModelLibrary
        open={modelLibraryOpen}
        query={modelLibraryQuery}
        onQueryChange={setModelLibraryQuery}
        onClose={() => setModelLibraryOpen(false)}
        onAdd={addBuiltinModel}
        onUpload={onUploadModel
          ? () => {
              setModelLibraryOpen(false);
              modelInputRef.current?.click();
            }
          : undefined}
      />
      </main>
    </ControlContextProvider>
  );
}
