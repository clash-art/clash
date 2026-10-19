import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";

let DirectorReferenceAspectRatioSchema = lazySchema(() => (
z.enum([
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "1:1",
])
), (real) => { DirectorReferenceAspectRatioSchema = real; });
let DirectorReferenceVector3Schema = lazySchema(() => (
z.tuple([
  z.number(),
  z.number(),
  z.number(),
])
), (real) => { DirectorReferenceVector3Schema = real; });

export let DirectorReferenceCameraOpticsSchema = lazySchema(() => (
z.object({
  projection: z.enum(["perspective", "orthographic"]),
  focalLengthMm: z.number().positive(),
  sensorWidthMm: z.number().positive(),
  sensorHeightMm: z.number().positive(),
  focusDistanceM: z.number().positive(),
  fStop: z.number().positive(),
  shutterAngleDegrees: z.number().positive(),
  iso: z.number().positive(),
  nearClipM: z.number().positive(),
  farClipM: z.number().positive(),
})
), (real) => { DirectorReferenceCameraOpticsSchema = real; });

export let DirectorReferenceCameraSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: DirectorReferenceVector3Schema,
  rotation: DirectorReferenceVector3Schema,
  fov: z.number().positive(),
  targetObjectId: z.string().min(1).optional(),
  targetObjectIds: z.array(z.string().min(1)).optional(),
  targetOffset: DirectorReferenceVector3Schema.optional(),
  optics: DirectorReferenceCameraOpticsSchema.optional(),
})
), (real) => { DirectorReferenceCameraSchema = real; });

export let DirectorReferenceShotSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cameraId: z.string().min(1),
  startTime: z.number().nonnegative(),
  sequenceStartTime: z.number().nonnegative().optional(),
  durationSeconds: z.number().positive(),
  aspectRatio: DirectorReferenceAspectRatioSchema,
  transition: z.enum(["cut", "dissolve"]).default("cut"),
  storyBeatIds: z.array(z.string().min(1)).optional(),
  actionClipIds: z.array(z.string().min(1)).optional(),
  cameraMove: z.object({
    preset: z.string().min(1),
    easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]),
  }).optional(),
})
), (real) => { DirectorReferenceShotSchema = real; });

export let DirectorReferenceStillSchema = lazySchema(() => (
z.object({
  assetId: z.string().min(1),
  cameraId: z.string().min(1),
  shotId: z.string().min(1),
  aspectRatio: DirectorReferenceAspectRatioSchema,
  stageRevisionId: z.string().min(1),
  timeSeconds: z.number().nonnegative().optional(),
  sequenceTimeSeconds: z.number().nonnegative().optional(),
})
), (real) => { DirectorReferenceStillSchema = real; });

export let DirectorReferenceVideoSchema = lazySchema(() => (
z.object({
  assetId: z.string().min(1),
  mimeType: z.string().min(1),
})
), (real) => { DirectorReferenceVideoSchema = real; });

export let DirectorReferencePacketSchema = lazySchema(() => (
z.object({
  schemaVersion: z.literal(1),
  stageId: z.string().min(1),
  stageRevisionId: z.string().min(1),
  exportedAt: z.string().datetime(),
  aspectRatio: DirectorReferenceAspectRatioSchema,
  durationSeconds: z.number().positive(),
  fps: z.number().int().positive(),
  scope: z.object({
    kind: z.enum(["sequence", "shot", "shot-selection"]),
    selectedShotIds: z.array(z.string().min(1)).min(1),
  }).optional(),
  cameraIds: z.array(z.string().min(1)).min(1),
  cameraSpec: z.object({
    cameras: z.array(DirectorReferenceCameraSchema),
  }).optional(),
  referenceVideo: DirectorReferenceVideoSchema,
  referenceStills: z.array(DirectorReferenceStillSchema),
  shotSpec: z.object({
    shots: z.array(DirectorReferenceShotSchema),
  }),
})
), (real) => { DirectorReferencePacketSchema = real; });

export type DirectorReferenceShot = z.infer<typeof DirectorReferenceShotSchema>;
export type DirectorReferenceCamera = z.infer<typeof DirectorReferenceCameraSchema>;
export type DirectorReferenceCameraOptics = z.infer<typeof DirectorReferenceCameraOpticsSchema>;
export type DirectorReferenceStill = z.infer<typeof DirectorReferenceStillSchema>;
export type DirectorReferenceVideo = z.infer<typeof DirectorReferenceVideoSchema>;
export type DirectorReferencePacket = z.infer<typeof DirectorReferencePacketSchema>;

export interface CreateDirectorReferencePacketInput {
  stageId: string;
  stageRevisionId: string;
  exportedAt: string;
  aspectRatio?: DirectorReferencePacket["aspectRatio"];
  durationSeconds?: number;
  fps?: number;
  selectedShotIds?: string[];
  normalizeShotTimes?: boolean;
  referenceVideo: DirectorReferenceVideo;
  /** Capture receipt / Project Asset references consumed by this export. */
  referenceStills?: ReadonlyArray<DirectorReferenceStill>;
  state: {
    activeCameraId?: string;
    cameras: ReadonlyArray<{
      id: string;
      name?: string;
      position?: [number, number, number];
      rotation?: [number, number, number];
      fov?: number;
      targetObjectId?: string;
      targetObjectIds?: string[];
      targetOffset?: [number, number, number];
      optics?: DirectorReferenceCameraOptics;
    }>;
    shots: ReadonlyArray<{
      id: string;
      cameraId: string;
      sequenceShotId?: string;
      assetId: string;
      aspectRatio: DirectorReferencePacket["aspectRatio"];
      stageRevisionId: string;
      timeSeconds?: number;
    }>;
    shotSequence?: ReadonlyArray<DirectorReferenceShot>;
    animation?: {
      durationSeconds: number;
      fps: number;
      cameraCues?: ReadonlyArray<{
        cameraId: string;
        startTime: number;
        durationSeconds: number;
      }>;
    };
  };
}

function uniqueIds(ids: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id?.trim())))];
}

/**
 * Freeze the exact Stage revision and media lineage consumed downstream.
 *
 * The packet is a Canvas-generation artifact, not an editorial Timeline.
 */
export function createDirectorReferencePacket(
  input: CreateDirectorReferencePacketInput,
): DirectorReferencePacket {
  const orderedSequenceShots = [...(input.state.shotSequence ?? [])]
    .sort((left, right) => left.startTime - right.startTime || left.id.localeCompare(right.id));
  const selectedShotIds = uniqueIds(input.selectedShotIds ?? []);
  const selectedShotIdSet = new Set(selectedShotIds);
  const selectedSequenceShots = selectedShotIds.length > 0
    ? orderedSequenceShots.filter((shot) => selectedShotIdSet.has(shot.id))
    : orderedSequenceShots;
  const timeOrigin = input.normalizeShotTimes
    ? selectedSequenceShots[0]?.startTime ?? 0
    : 0;
  const sequenceShots = selectedSequenceShots.map((shot) => ({
    ...shot,
    ...(input.normalizeShotTimes
      ? {
          startTime: shot.startTime - timeOrigin,
          sequenceStartTime: shot.startTime,
        }
      : {}),
  }));
  const referencedStills = input.referenceStills ?? input.state.shots.map((shot) => ({
    assetId: shot.assetId,
    cameraId: shot.cameraId,
    shotId: shot.sequenceShotId ?? shot.id,
    aspectRatio: shot.aspectRatio,
    stageRevisionId: shot.stageRevisionId,
    ...(shot.timeSeconds !== undefined ? { timeSeconds: shot.timeSeconds } : {}),
  }));
  const referenceStills = selectedShotIds.length > 0
    ? referencedStills.filter((still) => selectedShotIdSet.has(still.shotId))
    : referencedStills;
  const durationSeconds = input.durationSeconds
    ?? input.state.animation?.durationSeconds
    ?? Math.max(
      0,
      ...sequenceShots.map((shot) => shot.startTime + shot.durationSeconds),
    );
  const aspectRatio = input.aspectRatio
    ?? sequenceShots[0]?.aspectRatio
    ?? referenceStills[0]?.aspectRatio
    ?? "16:9";
  const cameraIds = uniqueIds(selectedShotIds.length > 0 ? [
    ...sequenceShots.map((shot) => shot.cameraId),
    ...referenceStills.map((still) => still.cameraId),
  ] : [
    ...sequenceShots.map((shot) => shot.cameraId),
    ...(input.state.animation?.cameraCues ?? []).map((cue) => cue.cameraId),
    input.state.activeCameraId,
    ...referenceStills.map((still) => still.cameraId),
  ]);

  return DirectorReferencePacketSchema.parse({
    schemaVersion: 1,
    stageId: input.stageId,
    stageRevisionId: input.stageRevisionId,
    exportedAt: input.exportedAt,
    aspectRatio,
    durationSeconds,
    fps: input.fps ?? input.state.animation?.fps ?? 30,
    ...(selectedShotIds.length > 0 ? {
      scope: {
        kind: selectedShotIds.length === 1 ? "shot" : "shot-selection",
        selectedShotIds,
      },
    } : {}),
    cameraIds,
    cameraSpec: {
      cameras: input.state.cameras.flatMap((camera) => {
        if (
          !cameraIds.includes(camera.id)
          || !camera.name
          || !camera.position
          || !camera.rotation
          || camera.fov === undefined
        ) {
          return [];
        }
        return [DirectorReferenceCameraSchema.parse(camera)];
      }),
    },
    referenceVideo: input.referenceVideo,
    referenceStills: referenceStills.map((still) => ({
      ...still,
      ...(still.timeSeconds !== undefined
        ? input.normalizeShotTimes
          ? {
              timeSeconds: Math.max(0, still.timeSeconds - timeOrigin),
              sequenceTimeSeconds: still.timeSeconds,
            }
          : { timeSeconds: still.timeSeconds }
        : {}),
    })),
    shotSpec: { shots: sequenceShots },
  });
}

/**
 * Translate structured shot metadata into the text control surface supported
 * by current video-generation providers. The packet remains the source of
 * truth; this is only the model-facing adaptation.
 */
export function directorReferencePromptContext(
  packet: DirectorReferencePacket,
): string {
  if (packet.shotSpec.shots.length === 0) return "";
  const shotLines = [...packet.shotSpec.shots]
    .sort((left, right) => left.startTime - right.startTime || left.id.localeCompare(right.id))
    .map((shot, index) => {
      const endTime = shot.startTime + shot.durationSeconds;
      const transition = shot.transition === "dissolve" ? "Dissolve" : "Cut";
      const move = shot.cameraMove
        ? ` · ${shot.cameraMove.preset} / ${shot.cameraMove.easing}`
        : "";
      const camera = packet.cameraSpec?.cameras.find(
        (candidate) => candidate.id === shot.cameraId,
      );
      const cameraSummary = camera
        ? ` · ${camera.name}${camera.optics ? ` ${camera.optics.focalLengthMm.toFixed(0)}mm` : ""}`
        : "";
      return `${index + 1}. ${shot.name} · ${shot.startTime.toFixed(2)}–${endTime.toFixed(2)}s · ${transition}${move}${cameraSummary}`;
    });

  return [
    "Director shot plan",
    `Format: ${packet.aspectRatio} · ${packet.durationSeconds.toFixed(2)}s · ${packet.fps}fps`,
    `Stage revision: ${packet.stageRevisionId}`,
    ...shotLines,
    "Preserve this shot order, timing, transitions, blocking, and camera motion while following the reference media.",
  ].join("\n");
}
