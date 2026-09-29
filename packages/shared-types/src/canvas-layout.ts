import type { LoroDoc } from "loro-crdt";
import { z } from "zod";

/** Canvas presentation is independent of immutable node and Generator facts. */
export const CANVAS_NODE_LAYOUTS = "canvasNodeLayouts";
const dimension = z.union([z.number().finite().nonnegative(), z.string()]);
export const CanvasNodeLayoutSchema = z
  .object({
    position: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .strict()
      .optional(),
    width: z.number().finite().nonnegative().optional(),
    height: z.number().finite().nonnegative().optional(),
    style: z
      .object({
        width: dimension.optional(),
        height: dimension.optional(),
        zIndex: z.number().finite().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CanvasNodeLayout = z.infer<typeof CanvasNodeLayoutSchema>;

export function projectCanvasNodeLayout<T extends Record<string, any>>(
  doc: LoroDoc,
  nodeId: string,
  raw: T,
): T {
  const layout = doc.getMap(CANVAS_NODE_LAYOUTS).get(nodeId);
  if (layout === undefined) return raw;
  const parsed = CanvasNodeLayoutSchema.safeParse(layout);
  if (!parsed.success) return raw;
  return {
    ...raw,
    ...parsed.data,
    ...(parsed.data.style
      ? { style: { ...raw.style, ...parsed.data.style } }
      : {}),
  };
}

/** Peers may change display geometry, never smuggle node authoring through it. */
export function assertCanvasLayoutMutation(
  current: LoroDoc,
  candidate: LoroDoc,
): void {
  const before = current.getMap(CANVAS_NODE_LAYOUTS);
  const after = candidate.getMap(CANVAS_NODE_LAYOUTS);
  for (const [id, layout] of after.entries()) {
    if (JSON.stringify(before.get(id)) === JSON.stringify(layout)) continue;
    CanvasNodeLayoutSchema.parse(layout);
    if (!candidate.getMap("nodes").get(id))
      throw new Error(`Layout node not found: ${id}`);
  }
}
