/**
 * Library apply contract for HTML Motion Graphics (#448).
 *
 * Catalog records may declare `runtime: "html"` with a Canvas `html-motion`
 * sourceNodeId. Apply inserts a live Timeline composition item — same
 * sourceNodeId identity as Agent `html_motion` / appendHtmlMotionToTimelineState.
 * Remotion MG library items keep using runtime remotion via existing paths.
 */

import type { CompositionItem, EditorAction, EditorState, Track } from "@clash/remotion-core";

export type HtmlMotionLibraryApplyInput = {
  nodeId: string;
  documentId: string;
  label: string;
  durationInFrames: number;
  targetTrackId?: string;
};

function uniqueId(prefix: string, used: Set<string>): string {
  if (!used.has(prefix)) return prefix;
  let suffix = 2;
  while (used.has(`${prefix}-${suffix}`)) suffix += 1;
  return `${prefix}-${suffix}`;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-") || "html-motion";
}

/**
 * Build editor actions that insert a live HTML MG composition item.
 * Does not create the Canvas node — Agent/UI must own the html-motion node.
 */
export function buildHtmlMotionLibraryApplyActions(
  state: Pick<EditorState, "tracks">,
  input: HtmlMotionLibraryApplyInput,
  createId: (prefix: string) => string = (p) => uniqueId(p, new Set()),
): { actions: EditorAction[]; disabledReason?: string } {
  const tracks = state.tracks ?? [];
  const already = tracks.some((track) =>
    track.items.some(
      (item) =>
        item.type === "composition" &&
        item.runtime === "html" &&
        item.sourceNodeId === input.nodeId,
    ),
  );
  if (already) {
    return {
      actions: [],
      disabledReason: "HTML Motion item already linked on the Timeline.",
    };
  }

  const usedItemIds = new Set(
    tracks.flatMap((track) => track.items.map((item) => item.id)),
  );
  const usedTrackIds = new Set(tracks.map((track) => track.id));

  const item: CompositionItem = {
    id: createId(`html-motion-${safePathSegment(input.nodeId)}`),
    type: "composition",
    compositionKind: "motion-graphics",
    runtime: "html",
    compositionId: input.documentId,
    sourceNodeId: input.nodeId,
    sourcePath: `html-motion/${safePathSegment(input.nodeId)}.html`,
    from: 0,
    durationInFrames: Math.max(1, Math.round(input.durationInFrames)),
  };
  // Ensure id uniqueness against used set
  if (usedItemIds.has(item.id)) {
    item.id = uniqueId(item.id, usedItemIds);
  }

  const target =
    (input.targetTrackId
      ? tracks.find((t) => t.id === input.targetTrackId)
      : undefined) ??
    tracks.find((t) => t.category === "visual" && t.role === "overlay");

  if (target) {
    return {
      actions: [
        {
          type: "ADD_ITEM",
          payload: { trackId: target.id, item },
        },
      ],
    };
  }

  const trackId = uniqueId("html-motion", usedTrackIds);
  const track: Track = {
    id: trackId,
    name: input.label || "HTML Motion",
    role: "overlay",
    category: "visual",
    items: [item],
  };
  return {
    actions: [
      {
        type: "ADD_TRACK",
        payload: track,
      },
    ],
  };
}

/** Catalog discriminator for dual-runtime MG library records. */
export type MotionGraphicsLibraryRuntime = "html" | "remotion";

export function isHtmlMotionLibraryRuntime(
  runtime: unknown,
): runtime is "html" {
  return runtime === "html";
}
