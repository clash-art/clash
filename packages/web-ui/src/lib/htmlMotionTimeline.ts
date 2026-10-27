import type { CompositionItem, Track } from "@clash/remotion-core";

type TimelineStateLike = Record<string, unknown> & {
  tracks?: Track[];
};

export type HtmlMotionTimelineInput = {
  nodeId: string;
  documentId: string;
  label: string;
  durationInFrames: number;
};

type CanvasConnectionNode = {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
};

type ConnectionTimeline = {
  id: string;
  state?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : fallback;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-") || "html-motion";
}

function uniqueId(prefix: string, used: Set<string>): string {
  if (!used.has(prefix)) return prefix;
  let suffix = 2;
  while (used.has(`${prefix}-${suffix}`)) suffix += 1;
  return `${prefix}-${suffix}`;
}

/**
 * Adds a live HTML Motion Graphics reference to a Project Timeline.
 *
 * Timeline stores no HTML snapshot. `sourceNodeId` is the identity; preview
 * and export resolve the Canvas `html-motion` node's latest `data.content`
 * when they start. Uses `compositionKind: motion-graphics` + `runtime: html`
 * (the dual-runtime DSL contract from #436 / #440).
 *
 * No audio-master-clock dependency — Player/HTML producer clocks stay local.
 */
export function appendHtmlMotionToTimelineState(
  state: TimelineStateLike,
  document: HtmlMotionTimelineInput,
): TimelineStateLike & { tracks: Track[] } {
  const tracks = Array.isArray(state.tracks) ? state.tracks : [];
  const alreadyConnected = tracks.some((track) =>
    track.items.some(
      (item) =>
        item.type === "composition" &&
        item.runtime === "html" &&
        item.sourceNodeId === document.nodeId,
    ),
  );
  if (alreadyConnected) return state as TimelineStateLike & { tracks: Track[] };

  const usedTrackIds = new Set(tracks.map((track) => track.id));
  const usedItemIds = new Set(
    tracks.flatMap((track) => track.items.map((item) => item.id)),
  );
  const existingTrack = tracks.find(
    (track) => track.category === "visual" && track.role === "overlay",
  );
  const item: CompositionItem = {
    id: uniqueId(`html-motion-${safePathSegment(document.nodeId)}`, usedItemIds),
    type: "composition",
    compositionKind: "motion-graphics",
    runtime: "html",
    compositionId: document.documentId,
    sourceNodeId: document.nodeId,
    sourcePath: `html-motion/${safePathSegment(document.nodeId)}.html`,
    from: 0,
    durationInFrames: Math.max(1, Math.round(document.durationInFrames)),
  };

  if (existingTrack) {
    return {
      ...state,
      tracks: tracks.map((track) =>
        track.id === existingTrack.id
          ? { ...track, items: [...track.items, item] }
          : track,
      ),
    };
  }

  const track: Track = {
    id: uniqueId("html-motion", usedTrackIds),
    name: "HTML Motion",
    role: "overlay",
    category: "visual",
    items: [item],
  };
  return { ...state, tracks: [...tracks, track] };
}

/**
 * Canvas edge from an HTML Motion node to a Timeline Editor is the handoff.
 * Same live-reference pattern as Remotion; runtime is html.
 */
export function deriveHtmlMotionConnectionUpdate(input: {
  sourceId: string;
  targetId: string;
  nodes: readonly CanvasConnectionNode[];
  timelines: readonly ConnectionTimeline[];
}): {
  timelineId: string;
  state: TimelineStateLike & { tracks: Track[] };
} | null {
  const source = input.nodes.find((node) => node.id === input.sourceId);
  const target = input.nodes.find((node) => node.id === input.targetId);
  if (source?.type !== "html-motion" || target?.type !== "video-editor") {
    return null;
  }

  const timelineId = target.data?.timelineId;
  if (typeof timelineId !== "string" || !timelineId) return null;
  const timeline = input.timelines.find(
    (candidate) => candidate.id === timelineId,
  );
  if (!timeline) return null;

  const currentState = isRecord(timeline.state) ? timeline.state : {};
  const nextState = appendHtmlMotionToTimelineState(currentState, {
    nodeId: source.id,
    documentId:
      typeof source.data?.documentId === "string" && source.data.documentId.trim()
        ? source.data.documentId.trim()
        : source.id,
    label:
      typeof source.data?.label === "string" && source.data.label.trim()
        ? source.data.label.trim()
        : "HTML Motion",
    durationInFrames: positiveInteger(source.data?.durationInFrames, 120),
  });
  if (nextState === currentState) return null;
  return { timelineId, state: nextState };
}
