import type { Item, Track } from '@clash/remotion-core';
import { timeline as timelineStyles } from '../../timeline/styles';
import { calculateSnapForItemRange, getAllSnapTargets } from '../utils/snapCalculator';

export type InsertDecision = {
  insertIndex: number | null;
  willCreateNewTrack: boolean;
  targetTrackIdIfMove: string | null;
};

export type PreviewResult = {
  previewTrackId: string;
  previewFrame: number; // adjusted for overlap when moving into a track
  rawPreviewFrame: number; // before overlap resolution (used when creating new track)
  insertIndex: number | null;
  willCreateNewTrack: boolean;
  snapGuideFrame: number | null; // vertical guide line (only for item-edge snaps)
};

export type DropAction =
  | { type: 'create-track'; insertIndex: number; frame: number }
  | { type: 'move-to-track'; targetTrackId: string; frame: number }
  | { type: 'move-within-track'; targetTrackId: string; frame: number };

// Debug/inspection utility: compute the two trisection lines of the item and the nearest track boundary
export function computeVerticalLandmarks(
  itemTopY: number,
  itemHeightPx: number,
  trackHeight: number
) {
  const q1 = itemTopY + itemHeightPx / 3;
  const q2 = itemTopY + (2 * itemHeightPx) / 3;
  const center = itemTopY + itemHeightPx / 2;
  const nearestBoundaryIndex = Math.round(center / trackHeight);
  const nearestBoundary = nearestBoundaryIndex * trackHeight;
  return { q1, q2, nearestBoundary, nearestBoundaryIndex };
}

export function decideInsertIntent(
  tracks: Track[],
  srcTrackId: string,
  yInViewport: number,
  trackHeight: number,
  thresholdPx: number
): InsertDecision {
  if (tracks.length === 0) {
    return { insertIndex: 0, willCreateNewTrack: true, targetTrackIdIfMove: null };
  }

  const srcIndex = tracks.findIndex((t) => t.id === srcTrackId);
  const rawIdx = Math.floor(yInViewport / trackHeight);
  const clampedIdx = Math.max(0, Math.min(tracks.length - 1, rawIdx));
  const relY = yInViewport % trackHeight;
  let insertIndex: number | null = null;
  if (relY < thresholdPx) insertIndex = clampedIdx;
  else if (relY > trackHeight - thresholdPx) insertIndex = clampedIdx + 1;

  if (insertIndex === null) {
    return { insertIndex: null, willCreateNewTrack: false, targetTrackIdIfMove: null };
  }

  const atTop = insertIndex === 0;
  const atBottom = insertIndex === tracks.length;
  const isBetweenPrevAndSelf = srcIndex > 0 && insertIndex === srcIndex;
  const isBetweenSelfAndNext = srcIndex >= 0 && srcIndex < tracks.length - 1 && insertIndex === srcIndex + 1;

  // Adjacent boundaries → move, not create
  if (isBetweenPrevAndSelf) {
    return {
      insertIndex,
      willCreateNewTrack: false,
      targetTrackIdIfMove: tracks[srcIndex - 1].id,
    };
  }
  if (isBetweenSelfAndNext) {
    return {
      insertIndex,
      willCreateNewTrack: false,
      targetTrackIdIfMove: tracks[srcIndex + 1].id,
    };
  }

  // Top/bottom or non-adjacent → create track
  if (atTop || atBottom || insertIndex < srcIndex || insertIndex > srcIndex + 1) {
    return { insertIndex, willCreateNewTrack: true, targetTrackIdIfMove: null };
  }

  return { insertIndex: null, willCreateNewTrack: false, targetTrackIdIfMove: null };
}

export function preferItemEdgeSnap(
  rawFrom: number,
  duration: number,
  tracks: Track[],
  currentItemId: string,
  currentFrame: number,
  snapEnabled: boolean,
  thresholdFrames: number
): { from: number; guideFrame: number | null } {
  const base = calculateSnapForItemRange(
    rawFrom,
    duration,
    tracks,
    currentItemId,
    currentFrame,
    !!snapEnabled,
    thresholdFrames
  );
  if (!snapEnabled) {
    return { from: Math.max(0, base.snappedFrame), guideFrame: null };
  }

  const itemEdges = getAllSnapTargets(tracks, currentItemId).filter(
    (t) => t.type === 'item-start' || t.type === 'item-end'
  );
  const nearest = (frame: number) => {
    let best: { frame: number; dist: number } | null = null;
    for (const t of itemEdges) {
      const dist = Math.abs(t.frame - frame);
      if (dist <= thresholdFrames && (!best || dist < best.dist)) {
        best = { frame: t.frame, dist };
      }
    }
    return best;
  };

  const leftEdge = nearest(rawFrom);
  const rightEdge = nearest(rawFrom + duration);
  if (leftEdge || rightEdge) {
    if (leftEdge && rightEdge) {
      if (leftEdge.dist <= rightEdge.dist) {
        return { from: leftEdge.frame, guideFrame: leftEdge.frame };
      }
      return { from: rightEdge.frame - duration, guideFrame: rightEdge.frame };
    }
    if (leftEdge) return { from: leftEdge.frame, guideFrame: leftEdge.frame };
    if (rightEdge) return { from: rightEdge.frame - duration, guideFrame: rightEdge.frame };
  }

  if (base.didSnap && base.target && (base.target.type === 'item-start' || base.target.type === 'item-end')) {
    const guide = base.edge === 'right' ? base.snappedFrame + duration : base.snappedFrame;
    return { from: base.snappedFrame, guideFrame: guide };
  }
  return { from: Math.max(0, base.snappedFrame), guideFrame: null };
}

export function resolveNonOverlapInTrack(
  track: Track | undefined,
  startFrame: number,
  duration: number,
  currentItemId: string
): number {
  if (!track) return Math.max(0, startFrame);
  const requested = Math.max(0, startFrame);
  const neighbors = track.items.filter(item => item.id !== currentItemId)
    .sort((a, b) => a.from - b.from);
  let gapStart = 0;
  let closest = requested;
  let distance = Infinity;
  const consider = (candidate: number) => {
    const nextDistance = Math.abs(candidate - requested);
    if (nextDistance < distance) {
      closest = candidate;
      distance = nextDistance;
    }
  };
  // Project the pointer's requested position into each legal free interval.
  // Forward-only pushing can jump a short drag past an entire contiguous lane.
  // Earlier gaps win exact ties; no neighbor timing is rewritten.
  for (const item of neighbors) {
    const lastStart = item.from - duration;
    if (lastStart >= gapStart) {
      consider(Math.max(gapStart, Math.min(requested, lastStart)));
    }
    gapStart = Math.max(gapStart, item.from + item.durationInFrames);
  }
  consider(Math.max(gapStart, requested));
  return closest;
}

export function buildPreview(
  args: {
    leftWithinTracksPx: number;
    itemTopY: number; // Already adjusted with scrollTop in caller
    itemHeightPx: number;
    prevItemTopY?: number;
    pixelsPerFrame: number;
    tracks: Track[];
    item: Item;
    originalTrackId: string;
    currentFrame: number;
    snapEnabled: boolean;
    trackHeight: number;
    trackHeights?: readonly number[];
    insertThresholdPx: number;
  }
): PreviewResult {
  const rawFrom = Math.max(0, Math.round(args.leftWithinTracksPx / args.pixelsPerFrame));
  const duration = args.item.durationInFrames;

  // Vertical routing is a single-step function of the dragged item's center:
  // the track whose band contains that y value is the target. Center beyond
  // either extreme means "create a new track at that end". This matches the
  // asset-panel drop path, which just targets "whichever track the mouse is
  // over" — a mental model the user already has. The previous multi-case
  // tree (A0/A/B/C/D/E, zone overlaps, source-item-count specials) kept
  // accreting bugs as each case's threshold interacted with the next.
  const itemTop = args.itemTopY;
  const itemBottom = args.itemTopY + args.itemHeightPx;
  const itemCenterY = (itemTop + itemBottom) / 2;
  let bandIdx: number;
  if (args.trackHeights?.length === args.tracks.length) {
    if (itemCenterY < 0) {
      bandIdx = -1;
    } else {
      let bandBottom = 0;
      bandIdx = args.tracks.length;
      for (let index = 0; index < args.trackHeights.length; index += 1) {
        bandBottom += args.trackHeights[index];
        if (itemCenterY < bandBottom) {
          bandIdx = index;
          break;
        }
      }
    }
  } else {
    bandIdx = Math.floor(itemCenterY / args.trackHeight);
  }

  let willCreateNewTrack = false;
  let insertIndex: number | null = null;
  let previewTrackId = args.originalTrackId;

  if (bandIdx < 0) {
    willCreateNewTrack = true;
    insertIndex = 0;
  } else if (bandIdx >= args.tracks.length) {
    willCreateNewTrack = true;
    insertIndex = args.tracks.length;
  } else {
    previewTrackId = args.tracks[bandIdx]?.id || previewTrackId;
  }

  const snapPref = preferItemEdgeSnap(
    rawFrom,
    duration,
    args.tracks,
    args.item.id,
    args.currentFrame,
    args.snapEnabled,
    timelineStyles.snapThreshold
  );

  // Resolve collisions only within existing lanes; a new lane has no blockers.
  const adjustedFrom = !willCreateNewTrack
    ? resolveNonOverlapInTrack(args.tracks.find((t) => t.id === previewTrackId), snapPref.from, duration, args.item.id)
    : snapPref.from;

  const resolved = adjustedFrom !== snapPref.from;
  const snapGuideFrame = resolved ? null : snapPref.guideFrame;

  return {
    previewTrackId,
    previewFrame: adjustedFrom,
    rawPreviewFrame: snapPref.from,
    insertIndex: willCreateNewTrack ? insertIndex : null,
    willCreateNewTrack,
    snapGuideFrame,
  };
}

export function finalizeDrop(preview: PreviewResult, tracks: Track[], originalTrackId: string): DropAction {
  if (preview.willCreateNewTrack && preview.insertIndex != null) {
    return { type: 'create-track', insertIndex: preview.insertIndex, frame: Math.max(0, preview.rawPreviewFrame) };
  }

  if (preview.previewTrackId === originalTrackId) {
    return { type: 'move-within-track', targetTrackId: originalTrackId, frame: Math.max(0, preview.previewFrame) };
  }

  return { type: 'move-to-track', targetTrackId: preview.previewTrackId, frame: Math.max(0, preview.previewFrame) };
}
