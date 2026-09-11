import React, {
  Suspense,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, createPortal, useFrame, useThree } from "@react-three/fiber";
import {
  GizmoHelper,
  GizmoViewport,
  Gltf,
  Grid,
  Instance,
  Instances,
  Line,
  OrbitControls,
  PerspectiveCamera,
  TransformControls,
  useGLTF,
  useProgress,
  useTexture,
} from "@react-three/drei";
import * as THREE from "three";
import { DirectorCodeInstance, DirectorCodeRenderBoundary, DirectorCodeSourcesContext } from "./code-components";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type {
  DirectorStageObject,
  DirectorStageState,
  DirectorStageTransform,
  DirectorStageVector3,
  DirectorStageWorkingVolume,
} from "@clash/shared-types";
import {
  aspectRatioDimensions,
  directorCameraFocusPoint,
  directorPositionPathDistance,
  directorPanoramaWorkingVolume,
  evaluateDirectorActionClips,
  evaluateDirectorStage,
  samplePositionKeyframes,
} from "@clash/director-core";
import type { EvaluatedDirectorActionClip } from "@clash/director-core";
import type { DirectorTransformMode, DirectorViewPreset } from "./shortcuts";
import {
  directorRenderPaletteFallback,
  directorTokens,
  resolveDirectorRenderPalette,
  type DirectorRenderPalette,
} from "./tokens";
import {
  DIRECTOR_MANNEQUIN_POSE_PRESETS,
  DIRECTOR_MANNEQUIN_SKELETON_BONES,
  DIRECTOR_MANNEQUIN_SKELETON_CONNECTIONS,
  applyDirectorMannequinPose,
  bindDirectorMannequinRig,
  evaluateDirectorMannequinActionPose,
  readDirectorMannequinSkeleton,
  type DirectorMannequinPose,
  type DirectorMannequinSkeleton,
} from "./mannequin";
import { directorHorseGaitPose } from "./horse";
import {
  DIRECTOR_BUILTIN_MODEL_ASSETS,
  DIRECTOR_BUILTIN_MODEL_ASSET_URLS,
  type DirectorBuiltinModelRig,
} from "./builtin-model-assets";
import { resolveDirectorEmbeddedModelAnimation } from "./model-animation";
import {
  createDirectorAnnyMotionClipLibrary,
  resolveDirectorAnnyMotionPlayback,
} from "./humanoid-motion";
import {
  createDirectorFramePublicationGate,
  renderDirectorFrameNow,
  type DirectorRenderedFrame,
} from "./headless-render-boundary";

export const DIRECTOR_RENDERER_OPTIONS = {
  antialias: true,
  preserveDrawingBuffer: true,
  alpha: false,
  powerPreference: "high-performance" as const,
};

const ANNY_CHARACTER_ASSETS = {
  neutral: new URL("../assets/anny-mpfb2/neutral.glb", import.meta.url).href,
  masculine: new URL("../assets/anny-mpfb2/masculine.glb", import.meta.url).href,
  feminine: new URL("../assets/anny-mpfb2/feminine.glb", import.meta.url).href,
  broad: new URL("../assets/anny-mpfb2/broad.glb", import.meta.url).href,
  athletic: new URL("../assets/anny-mpfb2/athletic.glb", import.meta.url).href,
  slender: new URL("../assets/anny-mpfb2/slender.glb", import.meta.url).href,
  youth: new URL("../assets/anny-mpfb2/youth.glb", import.meta.url).href,
  child: new URL("../assets/anny-mpfb2/child.glb", import.meta.url).href,
  chibi: new URL("../assets/anny-mpfb2/chibi.glb", import.meta.url).href,
} as const;

const ANNY_CHARACTER_ASSET_URLS = Object.values(ANNY_CHARACTER_ASSETS);
const ANNY_MOTION_SOURCE_ASSET =
  DIRECTOR_BUILTIN_MODEL_ASSET_URLS["builtin:quaternius:casual-hoodie"];
const ANNY_SUPPLEMENTAL_MOTION_SOURCE_ASSET = new URL(
  "../assets/starter-library/motions/UAL1_Standard.glb",
  import.meta.url,
).href;

// Load every body once when Director UI is imported. Body-type changes and
// transform drags must never flash the old procedural mannequin proxy.
ANNY_CHARACTER_ASSET_URLS.forEach((assetUrl) => useGLTF.preload(assetUrl));
useGLTF.preload(ANNY_MOTION_SOURCE_ASSET);
useGLTF.preload(ANNY_SUPPLEMENTAL_MOTION_SOURCE_ASSET);

function AnnyAssetsReady({ children }: { children: React.ReactNode }) {
  useGLTF(ANNY_CHARACTER_ASSET_URLS);
  return children;
}

type DirectorAspectRatio = DirectorStageState["shots"][number]["aspectRatio"];

export interface DirectorViewportHandle {
  capture: (options: {
    aspectRatio: DirectorAspectRatio;
    longEdge?: number;
    mimeType?: "image/png" | "image/jpeg";
  }) => Promise<Blob>;
  record: (options: {
    aspectRatio: DirectorAspectRatio;
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

export interface DirectorCameraPose {
  position: DirectorStageVector3;
  rotation: DirectorStageVector3;
  fov: number;
}

export interface DirectorViewportProps {
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
  /** Resolved exact Document bodies; runtime-only, never persisted in Stage. */
  codeSources?: Record<string, string>;
  onError?: (error: Error) => void;
  onSelectionChange?: (objectId?: string) => void;
  onObjectContextMenu?: (objectId: string) => void;
  onTransformCommit?: (objectId: string, transform: DirectorStageTransform) => void;
  onReady?: (canvas: HTMLCanvasElement) => void;
  onFrameRendered?: (frame: DirectorRenderedFrame) => void;
  renderPalette?: Partial<DirectorRenderPalette>;
  fallback?: React.ReactNode;
  className?: string;
}

/** Resolve runtime model bytes without adding a URL dialect to Director Stage identity. */
export function resolveDirectorModelProjectionUrl(
  assetId: string,
  assetUrls?: Record<string, string>,
): string | undefined {
  return assetUrls?.[assetId] ?? DIRECTOR_BUILTIN_MODEL_ASSET_URLS[assetId];
}

function materialColor(object: DirectorStageObject, palette: DirectorRenderPalette): string {
  if (object.kind === "mannequin") return object.color ?? palette.mannequin;
  if (object.kind === "creature") return object.color ?? "#7a5137";
  if (object.kind === "prop") return object.color ?? "#ad7b52";
  if (object.kind === "set") return object.color ?? "#8c8b85";
  if (object.kind === "vehicle") return object.color ?? "#426b8a";
  if (object.kind === "light") return object.color ?? "#ffd58a";
  return object.color ?? palette.selection;
}

function PrimitiveMesh({ object, palette }: {
  object: Extract<DirectorStageObject, { kind: "primitive" }>;
  palette: DirectorRenderPalette;
}) {
  const material = <meshStandardMaterial color={materialColor(object, palette)} roughness={0.72} />;
  switch (object.primitive.shape) {
    case "sphere":
      return <mesh castShadow receiveShadow><sphereGeometry args={[0.75, 32, 24]} />{material}</mesh>;
    case "cylinder":
      return <mesh castShadow receiveShadow position={[0, 0.75, 0]}><cylinderGeometry args={[0.6, 0.6, 1.5, 32]} />{material}</mesh>;
    case "cone":
      return <mesh castShadow receiveShadow position={[0, 0.75, 0]}><coneGeometry args={[0.75, 1.5, 32]} />{material}</mesh>;
    case "plane":
      return <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[2, 2]} />{material}</mesh>;
    case "capsule":
      return <mesh castShadow receiveShadow position={[0, 0.8, 0]}><capsuleGeometry args={[0.42, 0.8, 8, 18]} />{material}</mesh>;
    case "torus":
      return <mesh castShadow receiveShadow position={[0, 0.85, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.65, 0.18, 16, 40]} />{material}</mesh>;
    case "stair":
      return (
        <group>
          {[0, 1, 2, 3].map((step) => (
            <mesh key={step} castShadow receiveShadow position={[0, 0.15 + step * 0.3, -0.45 + step * 0.3]}>
              <boxGeometry args={[1.5, 0.3 + step * 0.6, 0.45]} />{material}
            </mesh>
          ))}
        </group>
      );
    case "arch":
      return (
        <group>
          <mesh castShadow receiveShadow position={[-0.65, 0.85, 0]}><boxGeometry args={[0.35, 1.7, 0.45]} />{material}</mesh>
          <mesh castShadow receiveShadow position={[0.65, 0.85, 0]}><boxGeometry args={[0.35, 1.7, 0.45]} />{material}</mesh>
          <mesh castShadow receiveShadow position={[0, 1.7, 0]}><torusGeometry args={[0.65, 0.18, 16, 32, Math.PI]} />{material}</mesh>
        </group>
      );
    case "box":
    default:
      return <mesh castShadow receiveShadow position={[0, 0.5, 0]}><boxGeometry args={[1, 1, 1]} />{material}</mesh>;
  }
}

function PropMesh({ object, palette }: {
  object: Extract<DirectorStageObject, { kind: "prop" }>;
  palette: DirectorRenderPalette;
}) {
  const color = materialColor(object, palette);
  const material = (roughness = 0.76) => (
    <meshStandardMaterial color={color} roughness={roughness} />
  );
  switch (object.prop.type) {
    case "chair":
      return (
        <group>
          <mesh castShadow receiveShadow position={[0, 0.55, 0]}><boxGeometry args={[0.8, 0.14, 0.8]} />{material()}</mesh>
          <mesh castShadow receiveShadow position={[0, 1.05, -0.34]}><boxGeometry args={[0.8, 0.9, 0.12]} />{material()}</mesh>
          {[-0.3, 0.3].flatMap((x) => [-0.3, 0.3].map((z) => (
            <mesh key={`${x}:${z}`} castShadow position={[x, 0.27, z]}><boxGeometry args={[0.1, 0.54, 0.1]} />{material()}</mesh>
          )))}
        </group>
      );
    case "table":
      return (
        <group>
          <mesh castShadow receiveShadow position={[0, 0.9, 0]}><boxGeometry args={[1.8, 0.16, 1.05]} />{material(0.68)}</mesh>
          {[-0.72, 0.72].flatMap((x) => [-0.36, 0.36].map((z) => (
            <mesh key={`${x}:${z}`} castShadow position={[x, 0.44, z]}><boxGeometry args={[0.14, 0.88, 0.14]} />{material()}</mesh>
          )))}
        </group>
      );
    case "sofa":
      return (
        <group>
          <mesh castShadow receiveShadow position={[0, 0.45, 0]}><boxGeometry args={[2.2, 0.5, 0.9]} />{material(0.92)}</mesh>
          <mesh castShadow receiveShadow position={[0, 0.98, -0.36]}><boxGeometry args={[2.2, 0.8, 0.22]} />{material(0.92)}</mesh>
          {[-1.02, 1.02].map((x) => (
            <mesh key={x} castShadow receiveShadow position={[x, 0.68, 0]}><boxGeometry args={[0.2, 0.55, 0.95]} />{material(0.92)}</mesh>
          ))}
        </group>
      );
    case "barrel":
      return (
        <group position={[0, 0.62, 0]}>
          <mesh castShadow receiveShadow><cylinderGeometry args={[0.48, 0.48, 1.24, 24]} />{material(0.88)}</mesh>
          {[-0.42, 0.42].map((y) => (
            <mesh key={y} position={[0, y, 0]}><torusGeometry args={[0.49, 0.035, 8, 24]} /><meshStandardMaterial color="#3f4348" roughness={0.5} /></mesh>
          ))}
        </group>
      );
    case "floor-lamp":
      return (
        <group>
          <mesh castShadow position={[0, 0.06, 0]}><cylinderGeometry args={[0.34, 0.34, 0.12, 24]} />{material(0.55)}</mesh>
          <mesh castShadow position={[0, 0.9, 0]}><cylinderGeometry args={[0.035, 0.045, 1.7, 12]} />{material(0.45)}</mesh>
          <mesh castShadow position={[0, 1.82, 0]} rotation={[Math.PI, 0, 0]}><coneGeometry args={[0.46, 0.66, 24, 1, true]} /><meshStandardMaterial color={color} roughness={0.7} side={THREE.DoubleSide} /></mesh>
        </group>
      );
    case "crate":
    default:
      return (
        <group position={[0, 0.5, 0]}>
          <mesh castShadow receiveShadow><boxGeometry args={[1, 1, 1]} />{material(0.86)}</mesh>
          {[-0.43, 0.43].map((x) => (
            <mesh key={x} castShadow position={[x, 0, 0.51]}><boxGeometry args={[0.1, 0.9, 0.06]} />{material(0.72)}</mesh>
          ))}
        </group>
      );
  }
}

function SetPieceMesh({ object, palette }: {
  object: Extract<DirectorStageObject, { kind: "set" }>;
  palette: DirectorRenderPalette;
}) {
  const color = materialColor(object, palette);
  const material = <meshStandardMaterial color={color} roughness={0.9} />;
  switch (object.set.type) {
    case "doorway":
      return (
        <group>
          <mesh castShadow receiveShadow position={[-1.15, 1.5, 0]}><boxGeometry args={[0.35, 3, 0.28]} />{material}</mesh>
          <mesh castShadow receiveShadow position={[1.15, 1.5, 0]}><boxGeometry args={[0.35, 3, 0.28]} />{material}</mesh>
          <mesh castShadow receiveShadow position={[0, 2.85, 0]}><boxGeometry args={[2.65, 0.3, 0.28]} />{material}</mesh>
        </group>
      );
    case "window":
      return (
        <group position={[0, 1.5, 0]}>
          <mesh castShadow receiveShadow><boxGeometry args={[3.2, 3, 0.22]} />{material}</mesh>
          <mesh position={[0, 0, 0.13]}><planeGeometry args={[1.8, 1.45]} /><meshPhysicalMaterial color="#9fc8da" roughness={0.15} transmission={0.45} transparent opacity={0.62} /></mesh>
          <mesh position={[0, 0, 0.16]}><boxGeometry args={[0.1, 1.5, 0.08]} /><meshStandardMaterial color="#34373b" /></mesh>
        </group>
      );
    case "platform":
      return <mesh castShadow receiveShadow position={[0, 0.2, 0]}><boxGeometry args={[4, 0.4, 3]} />{material}</mesh>;
    case "cyclorama":
      return (
        <group>
          <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[7, 7]} />{material}</mesh>
          <mesh receiveShadow position={[0, 3, -3.5]}><planeGeometry args={[7, 6]} />{material}</mesh>
        </group>
      );
    case "tree":
      return (
        <group>
          <mesh castShadow receiveShadow position={[0, 1.1, 0]}><cylinderGeometry args={[0.24, 0.38, 2.2, 12]} /><meshStandardMaterial color="#6d4c32" roughness={1} /></mesh>
          <mesh castShadow receiveShadow position={[0, 2.55, 0]}><icosahedronGeometry args={[1.25, 1]} /><meshStandardMaterial color={color} roughness={1} /></mesh>
        </group>
      );
    case "rock":
      return <mesh castShadow receiveShadow position={[0, 0.5, 0]} scale={[1.15, 0.72, 0.9]}><dodecahedronGeometry args={[0.8, 0]} />{material}</mesh>;
    case "wall":
    default:
      return <mesh castShadow receiveShadow position={[0, 1.5, 0]}><boxGeometry args={[4, 3, 0.24]} />{material}</mesh>;
  }
}

function VehicleWheel({ position }: { position: DirectorStageVector3 }) {
  return (
    <mesh castShadow receiveShadow position={position} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.34, 0.34, 0.2, 20]} />
      <meshStandardMaterial color="#202328" roughness={0.8} />
    </mesh>
  );
}

function VehicleMesh({ object, palette }: {
  object: Extract<DirectorStageObject, { kind: "vehicle" }>;
  palette: DirectorRenderPalette;
}) {
  const color = materialColor(object, palette);
  const body = <meshStandardMaterial color={color} roughness={0.5} metalness={0.12} />;
  if (object.vehicle.type === "bicycle" || object.vehicle.type === "motorcycle") {
    const motorcycle = object.vehicle.type === "motorcycle";
    return (
      <group>
        {[-0.72, 0.72].map((z) => (
          <mesh key={z} castShadow position={[0, 0.45, z]} rotation={[0, Math.PI / 2, 0]}>
            <torusGeometry args={[0.42, 0.065, 12, 28]} /><meshStandardMaterial color="#202328" roughness={0.8} />
          </mesh>
        ))}
        <mesh castShadow position={[0, 0.62, 0]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[motorcycle ? 0.2 : 0.045, motorcycle ? 0.28 : 0.045, 1.15, 10]} />{body}</mesh>
        <mesh castShadow position={[0, 0.92, 0.22]}><boxGeometry args={[motorcycle ? 0.42 : 0.08, 0.12, 0.42]} />{body}</mesh>
      </group>
    );
  }
  if (object.vehicle.type === "boat") {
    return (
      <group>
        <mesh castShadow receiveShadow position={[0, 0.42, 0]} scale={[1.5, 0.45, 3]}><sphereGeometry args={[0.65, 24, 12]} />{body}</mesh>
        <mesh castShadow position={[0, 0.95, -0.15]}><boxGeometry args={[1.25, 0.7, 1.5]} />{body}</mesh>
      </group>
    );
  }
  const van = object.vehicle.type === "van";
  return (
    <group>
      <mesh castShadow receiveShadow position={[0, van ? 0.78 : 0.62, 0]}><boxGeometry args={[1.65, van ? 1.35 : 0.72, 3.1]} />{body}</mesh>
      {!van ? <mesh castShadow position={[0, 1.04, -0.18]}><boxGeometry args={[1.45, 0.6, 1.45]} />{body}</mesh> : null}
      {[-0.72, 0.72].flatMap((x) => [-1.02, 1.02].map((z) => (
        <VehicleWheel key={`${x}:${z}`} position={[x, 0.35, z]} />
      )))}
    </group>
  );
}

function LightObject({ object, showHelper }: {
  object: Extract<DirectorStageObject, { kind: "light" }>;
  showHelper: boolean;
}) {
  const color = object.color ?? "#ffd58a";
  const light = object.light;
  return (
    <group>
      {light.type === "point" ? (
        <pointLight color={color} intensity={light.intensity} distance={light.range} decay={2} castShadow />
      ) : light.type === "spot" ? (
        <spotLight color={color} intensity={light.intensity} distance={light.range} angle={light.angle} penumbra={0.35} decay={2} castShadow />
      ) : (
        <directionalLight color={color} intensity={light.intensity} castShadow />
      )}
      {showHelper ? (
        <group>
          <mesh>
            <sphereGeometry args={[0.16, 16, 10]} />
            <meshBasicMaterial color={color} wireframe />
          </mesh>
          {light.type !== "point" ? (
            <mesh position={[0, 0, -0.32]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[0.2, 0.45, 12, 1, true]} />
              <meshBasicMaterial color={color} wireframe />
            </mesh>
          ) : null}
        </group>
      ) : null}
    </group>
  );
}

function HorseLeg({
  position,
  swing,
  color,
}: {
  position: DirectorStageVector3;
  swing: number;
  color: string;
}) {
  return (
    <group position={position} rotation={[swing, 0, 0]}>
      <mesh castShadow position={[0, -0.34, 0]}>
        <cylinderGeometry args={[0.105, 0.13, 0.68, 10]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      <group position={[0, -0.67, 0]} rotation={[-Math.max(0, swing) * 0.42, 0, 0]}>
        <mesh castShadow position={[0, -0.29, 0]}>
          <cylinderGeometry args={[0.075, 0.095, 0.58, 10]} />
          <meshStandardMaterial color={color} roughness={0.9} />
        </mesh>
        <mesh castShadow position={[0, -0.6, 0.05]} scale={[1, 0.5, 1.45]}>
          <sphereGeometry args={[0.12, 12, 8]} />
          <meshStandardMaterial color="#2d2521" roughness={0.82} />
        </mesh>
      </group>
    </group>
  );
}

function HorseMesh({
  object,
  timeSeconds,
  speed,
}: {
  object: Extract<DirectorStageObject, { kind: "creature" }>;
  timeSeconds: number;
  speed: number;
}) {
  const pose = directorHorseGaitPose({
    gait: object.creature.gait,
    speed,
    timeSeconds,
  });
  const color = object.color ?? "#7a5137";
  const buildScale = object.creature.build === "draft"
    ? [1.12, 1.08, 1.18] as const
    : object.creature.build === "pony"
      ? [0.82, 0.76, 0.82] as const
      : [1, 1, 1] as const;
  return (
    <group scale={buildScale}>
      <group position={[0, pose.bodyBob, 0]} rotation={[pose.bodyPitch, 0, 0]}>
        <mesh castShadow receiveShadow position={[0, 1.24, 0]} scale={[0.72, 0.62, 1.2]}>
          <sphereGeometry args={[0.72, 28, 18]} />
          <meshStandardMaterial color={color} roughness={0.88} />
        </mesh>
        <mesh castShadow receiveShadow position={[0, 1.34, 0.86]} scale={[0.64, 0.72, 0.7]}>
          <sphereGeometry args={[0.62, 24, 16]} />
          <meshStandardMaterial color={color} roughness={0.88} />
        </mesh>
        <group position={[0, 1.55, 1.1]} rotation={[-0.44 + pose.neckPitch, 0, 0]}>
          <mesh castShadow position={[0, 0.38, 0]}>
            <capsuleGeometry args={[0.25, 0.62, 8, 16]} />
            <meshStandardMaterial color={color} roughness={0.88} />
          </mesh>
          <group position={[0, 0.78, 0.14]} rotation={[0.2, 0, 0]}>
            <mesh castShadow scale={[0.44, 0.42, 0.72]}>
              <sphereGeometry args={[0.46, 22, 14]} />
              <meshStandardMaterial color={color} roughness={0.88} />
            </mesh>
            <mesh castShadow position={[0, -0.07, 0.45]} scale={[0.38, 0.3, 0.5]}>
              <sphereGeometry args={[0.4, 18, 12]} />
              <meshStandardMaterial color="#5f3e2d" roughness={0.9} />
            </mesh>
            {[-0.22, 0.22].map((x) => (
              <mesh key={x} castShadow position={[x, 0.42, -0.04]} rotation={[0.18, 0, x < 0 ? 0.14 : -0.14]}>
                <coneGeometry args={[0.105, 0.34, 10]} />
                <meshStandardMaterial color={color} roughness={0.9} />
              </mesh>
            ))}
          </group>
        </group>
        <mesh castShadow position={[0, 1.42, -1.04]} rotation={[0.42, 0, 0]}>
          <coneGeometry args={[0.18, 1.08, 12]} />
          <meshStandardMaterial color="#3b2a23" roughness={0.96} />
        </mesh>
        <HorseLeg position={[-0.42, 1.05, 0.72]} swing={pose.frontLeft} color={color} />
        <HorseLeg position={[0.42, 1.05, 0.72]} swing={pose.frontRight} color={color} />
        <HorseLeg position={[-0.42, 1.05, -0.7]} swing={pose.rearLeft} color={color} />
        <HorseLeg position={[0.42, 1.05, -0.7]} swing={pose.rearRight} color={color} />
        <group name="DirectorSocket:saddle" userData={{ directorSocket: "saddle" }} position={[0, 1.62, -0.08]}>
          <mesh castShadow receiveShadow position={[0, 0.035, 0]} scale={[0.9, 0.22, 0.82]}>
            <sphereGeometry args={[0.58, 20, 12]} />
            <meshStandardMaterial color="#493127" roughness={0.78} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

function cloneRiggedCharacter(scene: THREE.Group): THREE.Group {
  const cloned = SkeletonUtils.clone(scene) as THREE.Group;
  cloned.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;
    child.receiveShadow = true;
    child.material = Array.isArray(child.material)
      ? child.material.map((material) => material.clone())
      : child.material.clone();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial) {
        material.map = null;
        material.normalMap = null;
        material.roughnessMap = null;
        material.metalnessMap = null;
        material.alphaMap = null;
        material.roughness = 0.82;
        material.metalness = 0;
        material.transparent = false;
        material.opacity = 1;
        material.needsUpdate = true;
      }
    }
  });
  bindDirectorMannequinRig(cloned);
  return cloned;
}

function applyMannequinBodyShape(character: THREE.Group, bodyShape: number) {
  const normalized = THREE.MathUtils.clamp(bodyShape, -1, 1);
  const thinInfluence = Math.max(0, -normalized);
  const fullInfluence = Math.max(0, normalized);
  character.traverse((child) => {
    if (!(child instanceof THREE.SkinnedMesh) || !child.morphTargetInfluences) return;
    const dictionary = child.morphTargetDictionary ?? {};
    child.morphTargetInfluences.fill(0);
    const thinIndex = dictionary.Thin;
    const fullIndex = dictionary.Full;
    if (thinIndex !== undefined) child.morphTargetInfluences[thinIndex] = thinInfluence;
    if (fullIndex !== undefined) child.morphTargetInfluences[fullIndex] = fullInfluence;
  });
}

function DirectorSkeletonOverlay({ character, color }: {
  character: THREE.Group;
  color: string;
}) {
  const scene = useThree((state) => state.scene);
  const markers = useRef<Record<string, THREE.Mesh | null>>({});
  const jointPositions = useMemo(
    () => Object.fromEntries(
      Object.keys(DIRECTOR_MANNEQUIN_SKELETON_BONES).map((joint) => [joint, new THREE.Vector3()]),
    ) as DirectorMannequinSkeleton,
    [],
  );
  const segmentPositions = useMemo(
    () => new Float32Array(DIRECTOR_MANNEQUIN_SKELETON_CONNECTIONS.length * 2 * 3),
    [],
  );
  const segmentGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(segmentPositions, 3));
    return geometry;
  }, [segmentPositions]);

  useEffect(() => () => segmentGeometry.dispose(), [segmentGeometry]);
  useFrame(() => {
    readDirectorMannequinSkeleton(character, jointPositions);
    for (const [joint, position] of Object.entries(jointPositions)) {
      markers.current[joint]?.position.copy(position);
    }
    DIRECTOR_MANNEQUIN_SKELETON_CONNECTIONS.forEach(([startJoint, endJoint], index) => {
      const start = jointPositions[startJoint];
      const end = jointPositions[endJoint];
      segmentPositions.set(start.toArray(), index * 6);
      segmentPositions.set(end.toArray(), index * 6 + 3);
    });
    const attribute = segmentGeometry.getAttribute("position") as THREE.BufferAttribute;
    attribute.needsUpdate = true;
  });

  return createPortal(
    <group name="DirectorSkeletonOverlay">
      <lineSegments geometry={segmentGeometry} frustumCulled={false} renderOrder={20}>
        <lineBasicMaterial color={color} transparent opacity={0.96} depthTest={false} depthWrite={false} toneMapped={false} />
      </lineSegments>
      {Object.keys(DIRECTOR_MANNEQUIN_SKELETON_BONES).map((joint) => (
        <mesh
          key={joint}
          ref={(node) => { markers.current[joint] = node; }}
          name={`DirectorSkeletonJoint:${joint}`}
          renderOrder={21}
          raycast={() => undefined}
        >
          <sphereGeometry args={[joint === "torso" || joint === "pelvis" || joint === "head" ? 0.052 : 0.038, 16, 12]} />
          <meshBasicMaterial color={color} transparent opacity={0.98} depthTest={false} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
    </group>,
    scene,
  );
}

function RiggedMannequinMesh({
  object,
  palette,
  showSkeleton,
  renderedPose,
  activeActions,
  timeSeconds,
  locomotionSpeed,
  locomotionDistance,
}: {
  object: Extract<DirectorStageObject, { kind: "mannequin" }>;
  palette: DirectorRenderPalette;
  showSkeleton: boolean;
  renderedPose: DirectorMannequinPose;
  activeActions: EvaluatedDirectorActionClip[];
  timeSeconds: number;
  locomotionSpeed: number;
  locomotionDistance: number;
}) {
  const bodyType = object.mannequin.bodyType;
  const { scene: baseScene } = useGLTF(ANNY_CHARACTER_ASSETS[bodyType]);
  const { scene: motionSourceScene, animations: motionSourceAnimations } = useGLTF(
    ANNY_MOTION_SOURCE_ASSET,
  );
  const {
    scene: supplementalMotionSourceScene,
    animations: supplementalMotionSourceAnimations,
  } = useGLTF(ANNY_SUPPLEMENTAL_MOTION_SOURCE_ASSET);
  const character = useMemo(() => {
    const rig = cloneRiggedCharacter(baseScene);
    rig.name = `DirectorAnnyMannequin_${bodyType}`;
    return rig;
  }, [baseScene, bodyType]);
  const motionSource = useMemo(
    () => SkeletonUtils.clone(motionSourceScene),
    [motionSourceScene],
  );
  const supplementalMotionSource = useMemo(
    () => SkeletonUtils.clone(supplementalMotionSourceScene),
    [supplementalMotionSourceScene],
  );
  const motionLibrary = useMemo(
    () => createDirectorAnnyMotionClipLibrary({
      target: character,
      source: motionSource,
      animations: motionSourceAnimations,
      supplementalSources: [{
        id: "quaternius-universal-animation-standard",
        source: supplementalMotionSource,
        animations: supplementalMotionSourceAnimations,
      }],
    }),
    [
      character,
      motionSource,
      motionSourceAnimations,
      supplementalMotionSource,
      supplementalMotionSourceAnimations,
    ],
  );
  const mixer = useMemo(() => new THREE.AnimationMixer(character), [character]);
  const playback = resolveDirectorAnnyMotionPlayback({
    posePreset: object.mannequin.pose.preset,
    activeActions,
    locomotionSpeed,
    locomotionDistance,
    locomotionSpeeds: motionLibrary.locomotionSpeeds,
    availableClipNames: motionLibrary.releaseReadyClipNames,
    timeSeconds,
  });

  useEffect(() => {
    const tint = new THREE.Color(materialColor(object, palette));
    character.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        material.color.copy(tint);
      }
    });
  }, [character, object, palette]);

  useEffect(() => {
    mixer.stopAllAction();
    if (!playback) {
      applyDirectorMannequinPose(character, renderedPose);
      return;
    }

    const play = (
      clip: THREE.AnimationClip | undefined,
      localTimeSeconds: number,
      weight: number,
    ) => {
      if (!clip) return;
      const action = mixer.clipAction(clip, character);
      action.reset();
      action.setEffectiveWeight(weight);
      action.play();
      action.paused = true;
      action.time = clip.duration > 0 ? localTimeSeconds % clip.duration : 0;
    };
    play(
      playback.upperBody
        ? motionLibrary.lowerBodyClips[playback.base.clipName]
        : motionLibrary.clips[playback.base.clipName],
      playback.base.localTimeSeconds,
      playback.base.weight,
    );
    if (playback.upperBody) {
      play(
        motionLibrary.upperBodyClips[playback.upperBody.clipName],
        playback.upperBody.localTimeSeconds,
        playback.upperBody.weight,
      );
    }
    mixer.update(0);
    character.updateMatrixWorld(true);
  }, [character, mixer, motionLibrary, playback, renderedPose]);

  useEffect(() => () => {
    mixer.stopAllAction();
    mixer.uncacheRoot(character);
  }, [character, mixer]);

  useEffect(() => {
    applyMannequinBodyShape(character, object.mannequin.bodyShape ?? 0);
  }, [character, object.mannequin.bodyShape]);

  return (
    <group>
      <primitive object={character} />
      {showSkeleton ? <DirectorSkeletonOverlay character={character} color={palette.skeleton} /> : null}
    </group>
  );
}

function MannequinMesh({
  object,
  palette,
  showSkeleton,
  renderedPose,
  activeActions,
  timeSeconds,
  locomotionSpeed,
  locomotionDistance,
}: {
  object: Extract<DirectorStageObject, { kind: "mannequin" }>;
  palette: DirectorRenderPalette;
  showSkeleton: boolean;
  renderedPose: DirectorMannequinPose;
  activeActions: EvaluatedDirectorActionClip[];
  timeSeconds: number;
  locomotionSpeed: number;
  locomotionDistance: number;
}) {
  return (
    <Suspense fallback={null}>
      <RiggedMannequinMesh
        object={object}
        palette={palette}
        showSkeleton={showSkeleton}
        renderedPose={renderedPose}
        activeActions={activeActions}
        timeSeconds={timeSeconds}
        locomotionSpeed={locomotionSpeed}
        locomotionDistance={locomotionDistance}
      />
    </Suspense>
  );
}

function CrowdMesh({ object, palette }: {
  object: Extract<DirectorStageObject, { kind: "crowd" }>;
  palette: DirectorRenderPalette;
}) {
  const positions = useMemo(() => {
    const values: DirectorStageVector3[] = [];
    const xOffset = (object.crowd.columns - 1) * object.crowd.spacing / 2;
    const zOffset = (object.crowd.rows - 1) * object.crowd.spacing / 2;
    for (let row = 0; row < object.crowd.rows; row += 1) {
      for (let column = 0; column < object.crowd.columns; column += 1) {
        values.push([
          column * object.crowd.spacing - xOffset,
          0,
          row * object.crowd.spacing - zOffset,
        ]);
      }
    }
    return values;
  }, [object.crowd.columns, object.crowd.rows, object.crowd.spacing]);
  const color = materialColor(object, palette);
  return (
    <group>
      <Instances limit={positions.length} castShadow>
        <capsuleGeometry args={[0.28, 0.7, 6, 12]} />
        <meshStandardMaterial color={color} roughness={0.84} />
        {positions.map((position, index) => (
          <Instance key={`body-${index}`} position={[position[0], 0.95, position[2]]} />
        ))}
      </Instances>
      <Instances limit={positions.length} castShadow>
        <sphereGeometry args={[0.2, 12, 8]} />
        <meshStandardMaterial color={color} roughness={0.84} />
        {positions.map((position, index) => (
          <Instance key={`head-${index}`} position={[position[0], 1.7, position[2]]} />
        ))}
      </Instances>
    </group>
  );
}

function RiggedModelMesh({
  src,
  rig,
  activeActions,
  timeSeconds,
  locomotionSpeed,
  locomotionDistance,
}: {
  src: string;
  rig: DirectorBuiltinModelRig;
  activeActions: EvaluatedDirectorActionClip[];
  timeSeconds: number;
  locomotionSpeed: number;
  locomotionDistance: number;
}) {
  const { scene: baseScene, animations } = useGLTF(src);
  const model = useMemo(() => SkeletonUtils.clone(baseScene), [baseScene]);
  const mixer = useMemo(() => new THREE.AnimationMixer(model), [model]);
  const authoredAction = [...activeActions]
    .reverse()
    .find((entry) => Boolean(rig.actionMap[entry.clip.action]));
  const playback = resolveDirectorEmbeddedModelAnimation({
    rig,
    requestedAction: authoredAction?.clip.action,
    actionLocalTimeSeconds: authoredAction?.localTimeSeconds,
    actionWeight: authoredAction?.weight,
    locomotionSpeed,
    locomotionDistance,
    timeSeconds,
  });

  useEffect(() => {
    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
    });
  }, [model]);

  useEffect(() => {
    mixer.stopAllAction();
    if (!playback) return;
    const clip = THREE.AnimationClip.findByName(animations, playback.clipName);
    if (!clip) return;
    const action = mixer.clipAction(clip, model);
    action.reset();
    action.setEffectiveWeight(playback.weight);
    action.play();
    action.paused = true;
    action.time = clip.duration > 0
      ? playback.localTimeSeconds % clip.duration
      : 0;
    mixer.update(0);
    model.updateMatrixWorld(true);
    return () => {
      action.stop();
    };
  }, [animations, mixer, model, playback?.clipName, playback?.localTimeSeconds, playback?.weight]);

  useEffect(() => () => {
    mixer.stopAllAction();
    mixer.uncacheRoot(model);
  }, [mixer, model]);

  return <primitive object={model} />;
}

function ObjectVisual({ object, palette, assetUrls, showSkeleton, showEditorHelpers, mannequinPose, activeActions, timeSeconds, locomotionSpeed, locomotionDistance }: {
  object: DirectorStageObject;
  palette: DirectorRenderPalette;
  assetUrls?: Record<string, string>;
  showSkeleton: boolean;
  showEditorHelpers: boolean;
  mannequinPose?: DirectorMannequinPose;
  activeActions: EvaluatedDirectorActionClip[];
  timeSeconds: number;
  locomotionSpeed: number;
  locomotionDistance: number;
}) {
  switch (object.kind) {
    case "code": return <DirectorCodeInstance componentId={object.code.componentId} parameters={object.code.parameters} timeSeconds={timeSeconds} />;
    case "mannequin": return (
      <MannequinMesh
        object={object}
        palette={palette}
        showSkeleton={showSkeleton}
        renderedPose={mannequinPose ?? object.mannequin.pose}
        activeActions={activeActions}
        timeSeconds={timeSeconds}
        locomotionSpeed={locomotionSpeed}
        locomotionDistance={locomotionDistance}
      />
    );
    case "primitive": return <PrimitiveMesh object={object} palette={palette} />;
    case "creature": return object.creature.species === "horse"
      ? <HorseMesh object={object} timeSeconds={timeSeconds} speed={locomotionSpeed} />
      : null;
    case "prop": return <PropMesh object={object} palette={palette} />;
    case "set": return <SetPieceMesh object={object} palette={palette} />;
    case "vehicle": return <VehicleMesh object={object} palette={palette} />;
    case "light": return <LightObject object={object} showHelper={showEditorHelpers} />;
    case "crowd": return <CrowdMesh object={object} palette={palette} />;
    case "model": {
      const projectionUrl = resolveDirectorModelProjectionUrl(
        object.model.assetId,
        assetUrls,
      );
      const rig = object.model.animation ?? DIRECTOR_BUILTIN_MODEL_ASSETS.find(
        (asset) => asset.id === object.model.assetId,
      )?.rig;
      return projectionUrl
        ? <Suspense fallback={null}>
            {rig ? (
              <RiggedModelMesh
                src={projectionUrl}
                rig={rig}
                activeActions={activeActions}
                timeSeconds={timeSeconds}
                locomotionSpeed={locomotionSpeed}
                locomotionDistance={locomotionDistance}
              />
            ) : (
              <Gltf src={projectionUrl} castShadow receiveShadow />
            )}
          </Suspense>
        : <mesh castShadow position={[0, 0.5, 0]}><boxGeometry /><meshStandardMaterial color={materialColor(object, palette)} wireframe /></mesh>;
    }
  }
}

function SceneObject({
  object,
  selected,
  mode,
  snap,
  palette,
  assetUrls,
  showSkeleton,
  showEditorHelpers,
  mannequinPose,
  activeActions,
  timeSeconds,
  locomotionSpeed,
  locomotionDistance,
  locomotionYaw,
  onSelect,
  onContextMenu,
  onCommit,
  children,
}: {
  object: DirectorStageObject;
  selected: boolean;
  mode: DirectorTransformMode;
  snap: boolean;
  palette: DirectorRenderPalette;
  assetUrls?: Record<string, string>;
  showSkeleton: boolean;
  showEditorHelpers: boolean;
  mannequinPose?: DirectorMannequinPose;
  activeActions: EvaluatedDirectorActionClip[];
  timeSeconds: number;
  locomotionSpeed: number;
  locomotionDistance: number;
  locomotionYaw?: number;
  onSelect: () => void;
  onContextMenu?: () => void;
  onCommit?: (transform: DirectorStageTransform) => void;
  children?: React.ReactNode;
}) {
  const group = useRef<THREE.Group>(null);
  const renderedRotation: DirectorStageVector3 = locomotionYaw === undefined
    ? object.transform.rotation
    : [object.transform.rotation[0], locomotionYaw, object.transform.rotation[2]];
  useEffect(() => {
    if (!group.current) return;
    group.current.position.set(...object.transform.position);
    group.current.rotation.set(...renderedRotation);
    group.current.scale.set(...object.transform.scale);
  }, [object.transform, renderedRotation]);
  const commit = () => {
    if (!group.current) return;
    onCommit?.({
      position: group.current.position.toArray() as DirectorStageVector3,
      rotation: [group.current.rotation.x, group.current.rotation.y, group.current.rotation.z],
      scale: group.current.scale.toArray() as DirectorStageVector3,
    });
  };
  if (!object.visible) return null;
  return (
    <>
      <group
        ref={group}
        name={object.id}
        position={object.transform.position}
        rotation={renderedRotation}
        scale={object.transform.scale}
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onContextMenu={(event) => {
          event.stopPropagation();
          onSelect();
          onContextMenu?.();
        }}
      >
        <ObjectVisual
          object={object}
          palette={palette}
          assetUrls={assetUrls}
          showSkeleton={showSkeleton}
          showEditorHelpers={showEditorHelpers}
          mannequinPose={mannequinPose}
          activeActions={activeActions}
          timeSeconds={timeSeconds}
          locomotionSpeed={locomotionSpeed}
          locomotionDistance={locomotionDistance}
        />
        {children}
      </group>
      {selected && (
        <TransformControls
          object={group as unknown as React.RefObject<THREE.Object3D>}
          mode={mode}
          translationSnap={snap ? 0.25 : null}
          rotationSnap={snap ? Math.PI / 12 : null}
          scaleSnap={snap ? 0.1 : null}
          onMouseUp={commit}
        />
      )}
    </>
  );
}

function DirectorNavigation({
  enabled,
  preset,
  workingVolume,
}: {
  enabled: boolean;
  preset?: DirectorViewPreset;
  workingVolume?: DirectorStageWorkingVolume;
}) {
  const { camera } = useThree();
  const controls = useRef<any>(null);
  const navigationMaxDistance = workingVolume
    ? Math.max(1, Math.min(workingVolume.size[0], workingVolume.size[2]) / 2 - 0.5)
    : 100;
  const clampNavigation = useCallback(() => {
    if (!workingVolume) return;
    const [width, height, depth] = workingVolume.size;
    const [originX, originY, originZ] = workingVolume.origin;
    const margin = 0.15;
    camera.position.set(
      THREE.MathUtils.clamp(camera.position.x, originX - width / 2 + margin, originX + width / 2 - margin),
      THREE.MathUtils.clamp(camera.position.y, originY + margin, originY + height - margin),
      THREE.MathUtils.clamp(camera.position.z, originZ - depth / 2 + margin, originZ + depth / 2 - margin),
    );
    if (!controls.current) return;
    controls.current.target.set(
      THREE.MathUtils.clamp(controls.current.target.x, originX - width / 2 + margin, originX + width / 2 - margin),
      THREE.MathUtils.clamp(controls.current.target.y, originY, originY + height - margin),
      THREE.MathUtils.clamp(controls.current.target.z, originZ - depth / 2 + margin, originZ + depth / 2 - margin),
    );
  }, [camera, workingVolume]);
  useFrame(() => {
    if (!enabled) return;
    clampNavigation();
  });
  useEffect(() => {
    if (!enabled || !preset) return;
    const [width, height, depth] = workingVolume?.size ?? [100, 100, 100];
    const [originX, originY, originZ] = workingVolume?.origin ?? [0, 0, 0];
    if (preset === "top") {
      camera.position.set(originX, originY + Math.min(12, height - 0.25), originZ + 0.001);
    } else if (preset === "front") {
      camera.position.set(originX, originY + Math.min(3, height - 0.25), originZ + Math.min(10, depth / 2 - 0.25));
    } else {
      camera.position.set(
        originX + Math.min(8, width / 2 - 0.25),
        originY + Math.min(6, height - 0.25),
        originZ + Math.min(10, depth / 2 - 0.25),
      );
    }
    controls.current?.target.set(originX, originY + Math.min(1, height / 2), originZ);
    clampNavigation();
    controls.current?.update();
  }, [camera, clampNavigation, enabled, preset, workingVolume]);
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={enabled}
      target={[0, 1, 0]}
      minDistance={1}
      maxDistance={navigationMaxDistance}
      screenSpacePanning
    />
  );
}

function ShotCamera({
  camera,
  objects,
  active,
}: {
  camera: DirectorStageState["cameras"][number];
  objects: readonly DirectorStageObject[];
  active: boolean;
}) {
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  useFrame(() => {
    const shotCamera = cameraRef.current;
    const focusPoint = directorCameraFocusPoint(camera, objects);
    if (!shotCamera || !focusPoint) return;
    const [x, y, z] = focusPoint;
    shotCamera.lookAt(x, y, z);
    shotCamera.updateMatrixWorld();
  });
  return (
    <PerspectiveCamera
      ref={cameraRef}
      makeDefault={active}
      position={camera.position}
      rotation={camera.rotation}
      fov={camera.fov}
      near={0.01}
      far={1000}
    />
  );
}

function CameraRig({
  state,
  viewMode,
  calibrationCamera,
}: {
  state: DirectorStageState;
  viewMode: "director" | "camera";
  calibrationCamera?: DirectorCameraPose;
}) {
  const activeCamera = state.cameras.find((camera) => camera.id === state.activeCameraId)
    ?? state.cameras[0];
  return (
    <>
      <PerspectiveCamera
        makeDefault={viewMode === "director"}
        position={calibrationCamera?.position ?? [8, 6, 10]}
        rotation={calibrationCamera?.rotation}
        fov={calibrationCamera?.fov ?? 45}
        near={0.01}
        far={1000}
      />
      {activeCamera && (
        <ShotCamera camera={activeCamera} objects={state.objects} active={viewMode === "camera"} />
      )}
    </>
  );
}

function CameraAccessor({
  onAccessor,
}: {
  onAccessor: (accessor: () => DirectorCameraPose) => void;
}) {
  const get = useThree((threeState) => threeState.get);
  useEffect(() => {
    onAccessor(() => {
      const camera = get().camera as THREE.PerspectiveCamera;
      return {
        position: camera.position.toArray() as DirectorStageVector3,
        rotation: [camera.rotation.x, camera.rotation.y, camera.rotation.z],
        fov: Number.isFinite(camera.fov) ? camera.fov : 45,
      };
    });
  }, [get, onAccessor]);
  return null;
}

function isVectorKeyframeValue(
  value: number | DirectorStageVector3,
): value is DirectorStageVector3 {
  return Array.isArray(value) && value.length === 3;
}

type DirectorStageAnimationTrack = NonNullable<DirectorStageState["animation"]>["tracks"][number];

function directorPositionTrackMotion(
  track: DirectorStageAnimationTrack | undefined,
  timeSeconds: number,
  durationSeconds: number,
): { speed: number; distance: number; yaw?: number } {
  if (!track || track.property !== "position" || track.keyframes.length < 2) {
    return { speed: 0, distance: 0 };
  }
  const windowSeconds = 1 / 30;
  const beforeTime = Math.max(0, timeSeconds - windowSeconds);
  const afterTime = durationSeconds > 0
    ? Math.min(durationSeconds, timeSeconds + windowSeconds)
    : timeSeconds + windowSeconds;
  if (afterTime <= beforeTime) return { speed: 0, distance: 0 };
  const before = samplePositionKeyframes(track.keyframes, beforeTime);
  const after = samplePositionKeyframes(track.keyframes, afterTime);
  if (!before || !after || !isVectorKeyframeValue(before) || !isVectorKeyframeValue(after)) {
    return { speed: 0, distance: 0 };
  }
  const dx = after[0] - before[0];
  const dy = after[1] - before[1];
  const dz = after[2] - before[2];
  const speed = Math.hypot(dx, dy, dz) / (afterTime - beforeTime);
  const distance = directorPositionPathDistance(track.keyframes, timeSeconds);
  const horizontalDistance = Math.hypot(dx, dz);
  return horizontalDistance > 1e-5
    ? { speed, distance, yaw: Math.atan2(dx, dz) }
    : { speed, distance };
}

export function resolveDirectorObjectLocomotion({
  object,
  animation,
  timeSeconds,
  hasRiggedModel = false,
}: {
  object: DirectorStageObject;
  animation: DirectorStageState["animation"];
  timeSeconds: number;
  hasRiggedModel?: boolean;
}): { speed: number; distance: number; yaw?: number } {
  const positionTrack = animation?.tracks.find(
    (track) => track.targetId === object.id && track.property === "position",
  );
  const motion = directorPositionTrackMotion(
    positionTrack,
    timeSeconds,
    animation?.durationSeconds ?? 0,
  );
  const supportsPathFacing = object.kind === "creature"
    || hasRiggedModel
    || (object.kind === "mannequin" && (
      object.mannequin.pose.preset === "standing"
      || object.mannequin.pose.preset === "walking"
    ));
  return supportsPathFacing
    ? motion
    : { speed: motion.speed, distance: motion.distance };
}

export function resolveDirectorMannequinRuntimePose({
  object,
  animation,
  timeSeconds,
  locomotionSpeed,
  locomotionDistance,
}: {
  object: Extract<DirectorStageObject, { kind: "mannequin" }>;
  animation: DirectorStageState["animation"];
  timeSeconds: number;
  locomotionSpeed: number;
  locomotionDistance?: number;
}): DirectorMannequinPose {
  return evaluateDirectorMannequinActionPose({
    basePose: object.attachment?.socket === "saddle"
      ? {
          preset: "riding",
          joints: { ...DIRECTOR_MANNEQUIN_POSE_PRESETS.riding.joints },
        }
      : object.mannequin.pose,
    timeSeconds,
    locomotionSpeed,
    locomotionDistance,
    activeActions: evaluateDirectorActionClips(animation, object.id, timeSeconds),
  });
}

function DirectorMotionPaths({
  state,
  selectedObjectId,
  selectedCameraId,
  palette,
}: {
  state: DirectorStageState;
  selectedObjectId?: string;
  selectedCameraId?: string;
  palette: DirectorRenderPalette;
}) {
  const cameraIds = useMemo(
    () => new Set(state.cameras.map((camera) => camera.id)),
    [state.cameras],
  );
  const positionTracks = (state.animation?.tracks ?? []).filter(
    (track) => track.property === "position",
  );

  return positionTracks.map((track) => {
    const keyframes = [...track.keyframes]
      .sort((left, right) => left.time - right.time)
      .filter((keyframe) => isVectorKeyframeValue(keyframe.value));
    if (!keyframes.length) return null;
    const isCamera = cameraIds.has(track.targetId);
    const active = isCamera
      ? selectedCameraId === track.targetId
      : selectedObjectId === track.targetId;
    const color = isCamera ? palette.camera : palette.selection;
    const points = keyframes.map(
      (keyframe) => new THREE.Vector3(...keyframe.value as DirectorStageVector3),
    );

    return (
      <group key={track.id} name={`motion-path:${track.targetId}`}>
        {points.length > 1 ? (
          <Line
            points={points}
            color={color}
            lineWidth={active ? 3 : 1.5}
            opacity={active ? 0.95 : 0.38}
            transparent
            dashed={!active}
            dashScale={1.5}
            dashSize={0.18}
            gapSize={0.12}
          />
        ) : null}
        {points.map((point, index) => (
          <mesh key={keyframes[index]?.id ?? index} position={point}>
            <sphereGeometry args={[active ? 0.085 : 0.055, 14, 10]} />
            <meshBasicMaterial color={color} transparent opacity={active ? 1 : 0.52} />
          </mesh>
        ))}
      </group>
    );
  });
}

const BOUNDED_PANORAMA_VERTEX_SHADER = `
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const BOUNDED_PANORAMA_FRAGMENT_SHADER = `
  uniform sampler2D panoramaTexture;
  uniform vec3 capturePosition;
  uniform mat3 panoramaRotation;
  varying vec3 vWorldPosition;

  #include <common>

  void main() {
    vec3 direction = normalize(vWorldPosition - capturePosition);
    vec2 sampleUV = equirectUv(panoramaRotation * direction);
    gl_FragColor = texture2D(panoramaTexture, sampleUV);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function BoundedPanoramaProjection({
  texture,
  rotation,
  capturePosition,
  workingVolume,
}: {
  texture: THREE.Texture;
  rotation: THREE.Euler;
  capturePosition: DirectorStageVector3;
  workingVolume: DirectorStageWorkingVolume;
}) {
  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      panoramaTexture: { value: texture },
      capturePosition: { value: new THREE.Vector3(...capturePosition) },
      panoramaRotation: {
        value: new THREE.Matrix3()
          .setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(rotation))
          .transpose(),
      },
    },
    vertexShader: BOUNDED_PANORAMA_VERTEX_SHADER,
    fragmentShader: BOUNDED_PANORAMA_FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: true,
  }), [capturePosition, rotation, texture]);
  useEffect(() => () => material.dispose(), [material]);
  const boxCenter: DirectorStageVector3 = [
    workingVolume.origin[0],
    workingVolume.origin[1] + workingVolume.size[1] / 2,
    workingVolume.origin[2],
  ];
  return (
    <mesh
      name="BoundedPanoramaProjection"
      position={boxCenter}
      renderOrder={-100}
      frustumCulled={false}
    >
      <boxGeometry args={workingVolume.size} />
      <primitive attach="material" object={material} />
    </mesh>
  );
}

function EquirectangularPanorama({
  url,
  background,
  rotationValue,
  capturePosition,
  workingVolume,
}: {
  url: string;
  background: boolean;
  rotationValue: DirectorStageVector3;
  capturePosition: DirectorStageVector3;
  workingVolume?: DirectorStageWorkingVolume;
}) {
  const texture = useTexture(url);
  const scene = useThree((state) => state.scene);
  const rotation = useMemo(
    () => new THREE.Euler(...rotationValue),
    [rotationValue],
  );
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  useEffect(() => {
    const previousBackground = scene.background;
    const previousEnvironment = scene.environment;
    const previousBackgroundRotation = scene.backgroundRotation.clone();
    const previousEnvironmentRotation = scene.environmentRotation.clone();
    if (!workingVolume) {
      if (background) scene.background = texture;
      if (background) scene.backgroundRotation.copy(rotation);
    }
    scene.environment = texture;
    scene.environmentRotation.copy(rotation);
    return () => {
      if (!workingVolume && background && scene.background === texture) {
        scene.background = previousBackground;
        scene.backgroundRotation.copy(previousBackgroundRotation);
      }
      if (scene.environment === texture) {
        scene.environment = previousEnvironment;
        scene.environmentRotation.copy(previousEnvironmentRotation);
      }
    };
  }, [background, rotation, scene, texture, workingVolume]);

  return background && workingVolume ? (
    <BoundedPanoramaProjection
      texture={texture}
      rotation={rotation}
      capturePosition={capturePosition}
      workingVolume={workingVolume}
    />
  ) : null;
}

function DirectorScene({
  state,
  selectedObjectId,
  selectedCameraId,
  transformMode,
  viewMode,
  viewPreset,
  calibrationCamera,
  gridSnap,
  environmentUrl,
  showEnvironmentBackground,
  showSelectedSkeleton,
  timeSeconds = 0,
  assetUrls,
  renderPalette,
  onSelectionChange,
  onObjectContextMenu,
  onTransformCommit,
  onCameraAccessor,
  onFrameRendered,
}: Omit<DirectorViewportProps, "className" | "fallback" | "onReady" | "renderPalette"> & {
  onCameraAccessor: (accessor: () => DirectorCameraPose) => void;
  renderPalette: DirectorRenderPalette;
}) {
  const workingVolume = state.scene.environmentCalibration
    ? directorPanoramaWorkingVolume(state.scene.environmentCalibration)
    : undefined;
  const finiteGridSize: [number, number] = workingVolume
    ? [workingVolume.size[0], workingVolume.size[2]]
    : [100, 100];
  const renderSceneObject = (object: DirectorStageObject): React.ReactNode => {
    const riggedModel = object.kind === "model"
      ? object.model.animation ?? DIRECTOR_BUILTIN_MODEL_ASSETS.find(
          (asset) => asset.id === object.model.assetId,
        )?.rig
      : undefined;
    const locomotion = resolveDirectorObjectLocomotion({
      object,
      animation: state.animation,
      timeSeconds,
      hasRiggedModel: Boolean(riggedModel),
    });
    const mannequinPose = object.kind === "mannequin"
      ? resolveDirectorMannequinRuntimePose({
          object,
          animation: state.animation,
          timeSeconds,
          locomotionSpeed: locomotion.speed,
          locomotionDistance: locomotion.distance,
        })
      : undefined;
    const activeActions = evaluateDirectorActionClips(
      state.animation,
      object.id,
      timeSeconds,
    );
    const children = state.objects.filter(
      (candidate) => candidate.attachment?.parentId === object.id,
    );
    return (
      <SceneObject
        key={object.id}
        object={object}
        selected={selectedObjectId === object.id}
        mode={transformMode}
        snap={Boolean(gridSnap)}
        palette={renderPalette}
        assetUrls={assetUrls}
        showSkeleton={Boolean(showSelectedSkeleton && selectedObjectId === object.id)}
        showEditorHelpers={viewMode === "director"}
        mannequinPose={mannequinPose}
        activeActions={activeActions}
        timeSeconds={timeSeconds}
        locomotionSpeed={locomotion.speed}
        locomotionDistance={locomotion.distance}
        locomotionYaw={locomotion.yaw}
        onSelect={() => onSelectionChange?.(object.id)}
        onContextMenu={() => onObjectContextMenu?.(object.id)}
        onCommit={(transform) => onTransformCommit?.(object.id, transform)}
      >
        {children.map((child) => {
          const attachment = child.attachment;
          if (!attachment) return null;
          return (
            <group
              key={`attachment:${child.id}`}
              name={`DirectorAttachment:${attachment.socket}:${child.id}`}
              position={attachment.offset.position}
              rotation={attachment.offset.rotation}
              scale={attachment.offset.scale}
            >
              {renderSceneObject(child)}
            </group>
          );
        })}
      </SceneObject>
    );
  };
  const rootObjects = state.objects.filter(
    (object) => !object.attachment || !state.objects.some(
      (candidate) => candidate.id === object.attachment?.parentId,
    ),
  );
  return (
    <>
      <color attach="background" args={[state.scene.backgroundColor]} />
      {environmentUrl && (
        <Suspense fallback={null}>
          <EquirectangularPanorama
            url={environmentUrl}
            background={Boolean(showEnvironmentBackground)}
            rotationValue={state.scene.environmentRotation ?? [0, 0, 0]}
            capturePosition={state.scene.environmentCalibration?.capturePosition ?? [0, 1.6, 0]}
            workingVolume={workingVolume}
          />
        </Suspense>
      )}
      {state.scene.defaultLighting !== false && <>
        <ambientLight intensity={0.65} />
        <directionalLight castShadow intensity={1.7} position={[5, 9, 6]} shadow-mapSize={[2048, 2048]} />
      </>}
      <CameraRig
        state={state}
        viewMode={viewMode}
        calibrationCamera={calibrationCamera}
      />
      <CameraAccessor onAccessor={onCameraAccessor} />
      <DirectorNavigation
        enabled={viewMode === "director" && !calibrationCamera}
        preset={viewPreset}
        workingVolume={workingVolume}
      />
      {viewMode === "director" && (
        <DirectorMotionPaths
          state={state}
          selectedObjectId={selectedObjectId}
          selectedCameraId={selectedCameraId}
          palette={renderPalette}
        />
      )}
      {viewMode === "director" && state.scene.grid.visible && (
        <Grid
          args={finiteGridSize}
          position={workingVolume
            ? [workingVolume.origin[0], workingVolume.origin[1] + 0.006, workingVolume.origin[2]]
            : [0, 0, 0]}
          cellSize={state.scene.grid.size}
          sectionSize={state.scene.grid.size * 5}
          cellColor={renderPalette.gridMinor}
          sectionColor={renderPalette.gridMajor}
          cellThickness={0.65}
          sectionThickness={1.2}
          fadeDistance={workingVolume ? Math.max(...finiteGridSize) / 2 : 80}
          infiniteGrid={!workingVolume}
        />
      )}
      <Suspense fallback={null}>
        <AnnyAssetsReady>
          {rootObjects.map(renderSceneObject)}
          {onFrameRendered ? (
            <DirectorFramePublisher
              timeSeconds={timeSeconds}
              publish={onFrameRendered}
            />
          ) : null}
        </AnnyAssetsReady>
      </Suspense>
      {viewMode === "director" && (
        <GizmoHelper alignment="bottom-right" margin={[76, 76]}>
          <GizmoViewport
            axisColors={[renderPalette.axisX, renderPalette.axisY, renderPalette.axisZ]}
            labelColor={renderPalette.axisLabel}
          />
        </GizmoHelper>
      )}
    </>
  );
}

function DirectorFramePublisher({
  timeSeconds,
  publish,
}: {
  timeSeconds: number;
  publish: (frame: DirectorRenderedFrame) => void;
}) {
  const { active } = useProgress();
  const publicationGate = useRef(createDirectorFramePublicationGate());
  useEffect(() => {
    publicationGate.current.reset();
  }, [timeSeconds]);
  useFrame(({ gl, scene, camera }) => {
    gl.render(scene, camera);
    if (!publicationGate.current.tick(active)) return;
    renderDirectorFrameNow({
      renderer: gl,
      scene,
      camera,
      timeSeconds,
      canvas: gl.domElement,
      publish,
    });
  }, 1);
  return null;
}

function drawCroppedCanvas(source: HTMLCanvasElement, output: HTMLCanvasElement): void {
  const context = output.getContext("2d");
  if (!context) throw new Error("2D capture canvas is unavailable");
  const sourceRatio = source.width / source.height;
  const targetRatio = output.width / output.height;
  let sx = 0;
  let sy = 0;
  let sw = source.width;
  let sh = source.height;
  if (sourceRatio > targetRatio) {
    sw = source.height * targetRatio;
    sx = (source.width - sw) / 2;
  } else {
    sh = source.width / targetRatio;
    sy = (source.height - sh) / 2;
  }
  context.drawImage(source, sx, sy, sw, sh, 0, 0, output.width, output.height);
}

async function captureCanvas(
  source: HTMLCanvasElement,
  aspectRatio: DirectorAspectRatio,
  longEdge = 1920,
  mimeType: "image/png" | "image/jpeg" = "image/png",
): Promise<Blob> {
  const { width, height } = aspectRatioDimensions(aspectRatio, longEdge);
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  drawCroppedCanvas(source, output);
  return await new Promise<Blob>((resolve, reject) => {
    output.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Director Stage screenshot encoding failed"));
    }, mimeType, mimeType === "image/jpeg" ? 0.94 : undefined);
  });
}

export function preferredDirectorVideoMimeType(
  isTypeSupported: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
): string {
  return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
    .find(isTypeSupported) ?? "video/webm";
}

export async function recordCanvasVideo(
  source: HTMLCanvasElement,
  options: {
    aspectRatio: DirectorAspectRatio;
    durationSeconds: number;
    startTimeSeconds?: number;
    fps?: number;
    longEdge?: number;
    videoBitsPerSecond?: number;
    onTimeUpdate?: (timeSeconds: number) => void;
  },
): Promise<Blob> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("Camera video recording is unavailable in this browser");
  }
  if (source.width < 2 || source.height < 2) {
    throw new Error("Director Stage renderer is not ready for video recording");
  }
  const durationSeconds = options.durationSeconds;
  const startTimeSeconds = options.startTimeSeconds ?? 0;
  const fps = options.fps ?? 30;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Camera video recording requires a positive duration");
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error("Camera video recording requires a positive fps");
  }

  const { width, height } = aspectRatioDimensions(options.aspectRatio, options.longEdge ?? 1920);
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  drawCroppedCanvas(source, output);
  const stream = output.captureStream(fps);
  const mimeType = preferredDirectorVideoMimeType();
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: options.videoBitsPerSecond ?? 8_000_000,
  });

  return await new Promise<Blob>((resolve, reject) => {
    const chunks: BlobPart[] = [];
    let frameRequest = 0;
    let settled = false;
    const stopTracks = () => stream.getTracks().forEach((track) => track.stop());
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frameRequest);
      stopTracks();
      reject(error);
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => fail(new Error("Director camera video recorder failed"));
    recorder.onstop = () => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frameRequest);
      stopTracks();
      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size === 0) {
        reject(new Error("Director camera video recorder returned an empty file"));
        return;
      }
      resolve(blob);
    };

    const startedAt = performance.now();
    recorder.start(250);
    const drawFrame = (now: number) => {
      const elapsed = Math.min(durationSeconds, (now - startedAt) / 1000);
      drawCroppedCanvas(source, output);
      options.onTimeUpdate?.(startTimeSeconds + elapsed);
      if (elapsed >= durationSeconds) {
        recorder.stop();
        return;
      }
      frameRequest = requestAnimationFrame(drawFrame);
    };
    frameRequest = requestAnimationFrame(drawFrame);
  });
}

export const DirectorViewport = forwardRef<DirectorViewportHandle, DirectorViewportProps>(
  function DirectorViewport({
    state,
    selectedObjectId,
    selectedCameraId,
    transformMode,
    viewMode,
    viewPreset,
    calibrationCamera,
    gridSnap = false,
    timeSeconds = 0,
    environmentUrl,
    showEnvironmentBackground = false,
    showSelectedSkeleton = true,
    assetUrls,
    codeSources,
    onError,
    renderPalette: renderPaletteOverride,
    onSelectionChange,
    onObjectContextMenu,
    onTransformCommit,
    onReady,
    onFrameRendered,
    fallback,
    className,
  }, ref) {
    const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
    const renderError = useRef<Error | null>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [resolvedPalette, setResolvedPalette] = useState<DirectorRenderPalette>(
      directorRenderPaletteFallback,
    );
    const cameraAccessorRef = useRef<(() => DirectorCameraPose) | null>(null);
    const setCameraAccessor = useCallback((accessor: () => DirectorCameraPose) => {
      cameraAccessorRef.current = accessor;
    }, []);
    const evaluated = useMemo(
      () => evaluateDirectorStage(state, timeSeconds),
      [state, timeSeconds],
    );
    const renderPalette = useMemo(
      () => ({ ...resolvedPalette, ...renderPaletteOverride }),
      [renderPaletteOverride, resolvedPalette],
    );
    useEffect(() => {
      if (renderPaletteOverride) return;
      const refresh = () => setResolvedPalette(resolveDirectorRenderPalette(wrapperRef.current));
      refresh();
      if (typeof MutationObserver === "undefined") return;
      const observer = new MutationObserver(refresh);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      return () => observer.disconnect();
    }, [renderPaletteOverride]);
    useImperativeHandle(ref, () => ({
      canvas: () => canvas,
      cameraPose: () => {
        if (!cameraAccessorRef.current) {
          throw new Error("Director Stage camera is not ready");
        }
        return cameraAccessorRef.current();
      },
      capture: async (options) => {
        if (renderError.current) throw renderError.current;
        if (!canvas) throw new Error("Director Stage renderer is not ready");
        return captureCanvas(
          canvas,
          options.aspectRatio,
          options.longEdge,
          options.mimeType,
        );
      },
      record: async (options) => {
        if (renderError.current) throw renderError.current;
        if (!canvas) throw new Error("Director Stage renderer is not ready");
        return recordCanvasVideo(canvas, options);
      },
    }), [canvas]);

    const unavailable = fallback ?? (
      <div data-director-webgl-fallback="" role="alert">
        3D renderer unavailable. Enable browser graphics acceleration and reopen Clash.
      </div>
    );
    return (
      <div
        ref={wrapperRef}
        data-director-viewport=""
        className={className}
        style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0, background: directorTokens.viewport }}
      >
        <DirectorCodeRenderBoundary revision={state} sources={codeSources} onError={(error) => {
          renderError.current = error;
          if (error) onError?.(error);
        }}>
        <Canvas
          shadows={{ type: THREE.PCFShadowMap }}
          dpr={[1, 2]}
          gl={DIRECTOR_RENDERER_OPTIONS}
          fallback={unavailable}
          onPointerMissed={() => onSelectionChange?.(undefined)}
          onCreated={({ gl }) => {
            setCanvas(gl.domElement);
            onReady?.(gl.domElement);
          }}
        >
          <DirectorCodeSourcesContext.Provider value={codeSources ?? {}}>
          <DirectorScene
            state={evaluated}
            selectedObjectId={selectedObjectId}
            selectedCameraId={selectedCameraId}
            transformMode={transformMode}
            viewMode={viewMode}
            viewPreset={viewPreset}
            calibrationCamera={calibrationCamera}
            gridSnap={gridSnap}
            timeSeconds={timeSeconds}
            environmentUrl={environmentUrl}
            showEnvironmentBackground={showEnvironmentBackground}
            showSelectedSkeleton={showSelectedSkeleton}
            assetUrls={assetUrls}
            renderPalette={renderPalette}
            onSelectionChange={onSelectionChange}
            onObjectContextMenu={onObjectContextMenu}
            onTransformCommit={onTransformCommit}
            onCameraAccessor={setCameraAccessor}
            onFrameRendered={onFrameRendered}
          />
          </DirectorCodeSourcesContext.Provider>
        </Canvas>
        </DirectorCodeRenderBoundary>
      </div>
    );
  },
);
