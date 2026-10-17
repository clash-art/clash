import { z } from "zod";
import { AssetKindSchema, type AssetKind } from "../assets.js";
import {
  ACTION_INVOCATION_MODE,
  ActionInvocationModeSchema,
  ActionSpecSchema,
  ActionSurfaceSchema,
  invocationModeForSurface,
  type ActionSpec,
  type ActionSurface,
} from "./spec.js";

export { ACTION_INVOCATION_MODE } from "./spec.js";

export const ASSET_ACTION_ID = {
  ImageEditor: "image-editor",
  VideoClipper: "video-clipper",
} as const;
export type AssetActionId =
  (typeof ASSET_ACTION_ID)[keyof typeof ASSET_ACTION_ID];

/** Backward-compatible name for persisted canvas node types and transports. */
export const EDIT_KIND = ASSET_ACTION_ID;
export type EditKind = AssetActionId;

export const CropRectSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type CropRect = z.infer<typeof CropRectSchema>;

export const ImageEditParamsSchema = z.object({
  crop: CropRectSchema.optional(),
  rotation: z
    .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
    .optional(),
});
export type ImageEditParams = z.infer<typeof ImageEditParamsSchema>;

export const VideoClipParamsSchema = z
  .discriminatedUnion("mode", [
    z.object({
      mode: z.literal("screenshot"),
      frameTimeSec: z.number().nonnegative(),
    }),
    z.object({
      mode: z.literal("crop"),
      startSec: z.number().nonnegative(),
      endSec: z.number().positive(),
    }),
  ])
  .superRefine((value, context) => {
    if (value.mode === "crop" && value.endSec <= value.startSec) {
      context.addIssue({
        code: "custom",
        message: "endSec must be greater than startSec",
        path: ["endSec"],
      });
    }
  });
export type VideoClipParams = z.infer<typeof VideoClipParamsSchema>;

export const BUILT_IN_ASSET_ACTION_SPECS = {
  [ASSET_ACTION_ID.ImageEditor]: ActionSpecSchema.parse({
    id: ASSET_ACTION_ID.ImageEditor,
    version: "1",
    name: "Image Editor",
    family: "edit",
    inputKinds: ["image"],
    operations: [{ id: "transform", outputKind: "image" }],
  }),
  [ASSET_ACTION_ID.VideoClipper]: ActionSpecSchema.parse({
    id: ASSET_ACTION_ID.VideoClipper,
    version: "1",
    name: "Video Clipper",
    family: "edit",
    inputKinds: ["video"],
    operations: [
      { id: "screenshot", outputKind: "image" },
      { id: "crop", outputKind: "video" },
    ],
  }),
} as const satisfies Record<AssetActionId, ActionSpec>;

const InvocationBaseSchema = z.object({
  projectId: z.string().min(1),
  mode: ActionInvocationModeSchema,
  surface: ActionSurfaceSchema,
});

const ImageEditActionInvocationSchema = InvocationBaseSchema.extend({
  actionId: z.literal(ASSET_ACTION_ID.ImageEditor),
  source: z.object({ assetId: z.string().min(1), kind: z.literal("image") }),
  params: ImageEditParamsSchema,
});

const VideoEditActionInvocationSchema = InvocationBaseSchema.extend({
  actionId: z.literal(ASSET_ACTION_ID.VideoClipper),
  source: z.object({ assetId: z.string().min(1), kind: z.literal("video") }),
  params: VideoClipParamsSchema,
});

export const AssetEditActionInvocationSchema = z
  .discriminatedUnion("actionId", [
    ImageEditActionInvocationSchema,
    VideoEditActionInvocationSchema,
  ])
  .refine((value) => value.mode === invocationModeForSurface(value.surface), {
    message: "Invocation mode must match its surface",
    path: ["mode"],
  });
export type AssetEditActionInvocation = z.infer<
  typeof AssetEditActionInvocationSchema
>;

export type CreateAssetActionInvocationInput =
  | Omit<z.input<typeof ImageEditActionInvocationSchema>, "mode">
  | Omit<z.input<typeof VideoEditActionInvocationSchema>, "mode">;

export function createAssetActionInvocation(
  input: CreateAssetActionInvocationInput,
): AssetEditActionInvocation {
  return AssetEditActionInvocationSchema.parse({
    ...input,
    mode: invocationModeForSurface(input.surface),
  });
}

export function resolveAssetActionOutputKind(
  actionId: AssetActionId,
  params: ImageEditParams | VideoClipParams,
): AssetKind {
  if (actionId === ASSET_ACTION_ID.ImageEditor) return "image";
  const operationId = "mode" in params ? params.mode : "crop";
  const operation = BUILT_IN_ASSET_ACTION_SPECS[actionId].operations.find(
    (candidate) => candidate.id === operationId,
  );
  if (!operation)
    throw new Error(`Unsupported ${actionId} operation: ${operationId}`);
  return AssetKindSchema.parse(operation.outputKind);
}

export function legacyEditOriginForSurface(
  surface: ActionSurface,
): "canvas-node" | "asset-preview" {
  return surface === "canvas" ? "canvas-node" : "asset-preview";
}

export function actionSourceModel(
  invocation: AssetEditActionInvocation,
): string {
  return invocation.mode === ACTION_INVOCATION_MODE.Implicit
    ? `implicit:${invocation.actionId}`
    : invocation.actionId;
}
