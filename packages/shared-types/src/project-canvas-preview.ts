import { lazySchema } from "./lazy-schema.js";
import type { LoroDoc } from "loro-crdt";
import {
  getAbsoluteRect,
  rectUnion,
  type LayoutNode,
} from "@clash/shared-layout";
import { z } from "zod";

import { Canvas } from "./canvas-ops.js";
import { DEFAULT_CANVAS_ID } from "./project-workspace.js";

export let ProjectCanvasPreviewNodeSchema = lazySchema(() => (
z
  .object({
    id: z.string().trim().min(1),
    type: z.string().trim().min(1),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    parentId: z.string().trim().min(1).optional(),
    assetId: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
  })
  .strict()
), (real) => { ProjectCanvasPreviewNodeSchema = real; });
export type ProjectCanvasPreviewNode = z.infer<
  typeof ProjectCanvasPreviewNodeSchema
>;

export let ProjectCanvasPreviewSchema = lazySchema(() => (
z
  .object({
    canvasId: z.string().trim().min(1),
    bounds: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().nonnegative(),
        height: z.number().finite().nonnegative(),
      })
      .strict()
      .nullable(),
    nodes: z.array(ProjectCanvasPreviewNodeSchema),
  })
  .strict()
), (real) => { ProjectCanvasPreviewSchema = real; });
export type ProjectCanvasPreview = z.infer<typeof ProjectCanvasPreviewSchema>;

export let ProjectCanvasThumbnailSchema = lazySchema(() => (
z
  .object({
    url: z.string().url(),
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
), (real) => { ProjectCanvasThumbnailSchema = real; });
export type ProjectCanvasThumbnail = z.infer<
  typeof ProjectCanvasThumbnailSchema
>;

function previewLabel(data: Record<string, unknown>): string | undefined {
  for (const candidate of [data.label, data.title, data.name, data.content]) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim().split(/\r?\n/u, 1)[0]?.trim();
    if (normalized) return normalized.slice(0, 120);
  }
  return undefined;
}

function toLayoutNode(
  node: ReturnType<Canvas["listNodes"]>[number],
): LayoutNode {
  const style = node.style ?? {};
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    ...(node.parent_id ? { parentId: node.parent_id } : {}),
    ...(typeof node.width === "number" ? { width: node.width } : {}),
    ...(typeof node.height === "number" ? { height: node.height } : {}),
    data: node.data,
    style: {
      ...(typeof style.width === "number" || typeof style.width === "string"
        ? { width: style.width }
        : {}),
      ...(typeof style.height === "number" || typeof style.height === "string"
        ? { height: style.height }
        : {}),
      ...(typeof style.zIndex === "number" || typeof style.zIndex === "string"
        ? { zIndex: style.zIndex }
        : {}),
    },
  };
}

/** Lightweight, read-only projection of the real Canvas geometry for project cards. */
export function projectCanvasPreviewFromDoc(
  doc: LoroDoc,
  canvasId = DEFAULT_CANVAS_ID,
): ProjectCanvasPreview {
  const canvasNodes = new Canvas(doc, () => {}, canvasId).listNodes();
  const layoutNodes = canvasNodes.map(toLayoutNode);
  const nodes = canvasNodes.map((node, index) => {
    const rect = getAbsoluteRect(layoutNodes[index]!, layoutNodes);
    const assetId =
      typeof node.data.assetId === "string" && node.data.assetId.trim()
        ? node.data.assetId.trim()
        : undefined;
    const label = previewLabel(node.data);
    return ProjectCanvasPreviewNodeSchema.parse({
      id: node.id,
      type: node.type,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      ...(node.parent_id ? { parentId: node.parent_id } : {}),
      ...(assetId ? { assetId } : {}),
      ...(label ? { label } : {}),
    });
  });
  const bounds = rectUnion(nodes);
  return ProjectCanvasPreviewSchema.parse({
    canvasId,
    bounds,
    nodes,
  });
}
