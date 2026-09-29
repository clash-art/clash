/**
 * Tests for the DnD coordinate / routing logic. These functions are the
 * source of "looks fine, silently breaks" bugs the team has been bitten by
 * before — see packages/remotion-ui/TIMELINE_COORDINATES.md (坑 A / 坑 B).
 *
 * The routing math is pure: it operates on px in `.tracks-viewport` space +
 * frames in composition-absolute space + a tracks list. We feed it
 * synthesized inputs and check the outputs structurally — no DOM, no React.
 */
import { describe, it, expect } from 'vitest';
import type { Item, Track, VideoItem } from '@clash/remotion-core';
import {
  buildPreview,
  computeVerticalLandmarks,
  decideInsertIntent,
  finalizeDrop,
  preferItemEdgeSnap,
  resolveNonOverlapInTrack,
} from './itemDragLogic';

const TRACK_HEIGHT = 72;
const PIXELS_PER_FRAME = 2;

const makeVideo = (id: string, from: number, dur: number): VideoItem => ({
  id,
  type: 'video',
  src: `${id}.mp4`,
  from,
  durationInFrames: dur,
});

const makeTrack = (id: string, items: Item[] = []): Track => ({ id, name: id, items });

// ──────────────────────────────────────────────────────────────────
//  computeVerticalLandmarks
// ──────────────────────────────────────────────────────────────────
describe('computeVerticalLandmarks', () => {
  it('returns thirds and the nearest track boundary index', () => {
    const r = computeVerticalLandmarks(/* itemTopY */ 30, /* heightPx */ 60, TRACK_HEIGHT);
    expect(r.q1).toBeCloseTo(50);
    expect(r.q2).toBeCloseTo(70);
    expect(r.nearestBoundaryIndex).toBe(Math.round((30 + 30) / TRACK_HEIGHT));
    expect(r.nearestBoundary).toBe(r.nearestBoundaryIndex * TRACK_HEIGHT);
  });
});

// ──────────────────────────────────────────────────────────────────
//  resolveNonOverlapInTrack
// ──────────────────────────────────────────────────────────────────
describe('resolveNonOverlapInTrack', () => {
  it('returns the start frame untouched when the track is empty / undefined', () => {
    expect(resolveNonOverlapInTrack(undefined, 50, 30, 'me')).toBe(50);
    expect(resolveNonOverlapInTrack(makeTrack('t'), 50, 30, 'me')).toBe(50);
  });

  it('skips the dragged item itself when checking overlaps', () => {
    const track = makeTrack('t', [makeVideo('me', 100, 50)]);
    // I'm dropping "me" at 100 — it would overlap itself, but should be ignored.
    expect(resolveNonOverlapInTrack(track, 100, 50, 'me')).toBe(100);
  });

  it('uses the closest free position before an overlapping neighbor', () => {
    const track = makeTrack('t', [makeVideo('a', 100, 50)]);
    expect(resolveNonOverlapInTrack(track, 80, 50, 'me')).toBe(50);
  });

  it('does not push a small move past a chain when a closer free position exists', () => {
    const track = makeTrack('t', [makeVideo('a', 100, 50), makeVideo('b', 150, 50)]);
    expect(resolveNonOverlapInTrack(track, 80, 30, 'me')).toBe(70);
  });

  it('keeps the captured campaign small drag near its original cut instead of jumping to frame 1587', () => {
    // Captured installed fixture: track-window-final-state.json, titles-layer-3.
    const ranges = [[44, 100], [144, 303], [447, 222], [669, 175], [844, 121],
      [965, 81], [1046, 136], [1182, 199], [1381, 94], [1475, 112],
      [1697, 178], [2207, 131], [2460, 90]];
    const track = makeTrack('campaign', ranges.map(([from, duration], index) =>
      makeVideo(index === 0 ? 'me' : `neighbor-${index}`, from, duration)));
    expect(resolveNonOverlapInTrack(track, 84, 100, 'me')).toBe(44);
    expect(resolveNonOverlapInTrack(track, 14, 100, 'me')).toBe(14);
    expect(resolveNonOverlapInTrack(track, 84, 100, 'me'))
      .toBe(resolveNonOverlapInTrack({ ...track, items: [...track.items].reverse() }, 84, 100, 'me'));
  });

  it('uses the following gap when closer, and skips gaps too short for the clip', () => {
    const track = makeTrack('t', [makeVideo('a', 0, 100), makeVideo('b', 120, 30)]);
    expect(resolveNonOverlapInTrack(track, 110, 40, 'me')).toBe(150);
    expect(resolveNonOverlapInTrack(track, 110, 10, 'me')).toBe(110);
    expect(resolveNonOverlapInTrack(makeTrack('t', [makeVideo('a', 100, 50)]), 145, 30, 'me')).toBe(150);
  });

  it('clamps to >= 0 even if input is negative', () => {
    expect(resolveNonOverlapInTrack(makeTrack('t'), -5, 10, 'me')).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────
//  buildPreview — vertical band routing
// ──────────────────────────────────────────────────────────────────
describe('buildPreview — vertical routing (matches asset-panel mental model)', () => {
  // From TIMELINE_COORDINATES.md "Drop 路由" — single-step:
  //   itemCenterY = (top + bottom) / 2
  //   bandIdx = floor(itemCenterY / trackHeight)
  //   bandIdx < 0  → create at top
  //   bandIdx >= tracks.length → create at bottom
  //   else → tracks[bandIdx]

  const baseArgs = (over: Partial<Parameters<typeof buildPreview>[0]>) => ({
    leftWithinTracksPx: 0,
    itemTopY: 0,
    itemHeightPx: 60,
    pixelsPerFrame: PIXELS_PER_FRAME,
    tracks: [makeTrack('t1'), makeTrack('t2'), makeTrack('t3')],
    item: makeVideo('me', 0, 30),
    originalTrackId: 't1',
    currentFrame: 0,
    snapEnabled: false,
    trackHeight: TRACK_HEIGHT,
    insertThresholdPx: 8,
    ...over,
  });

  it('center inside band 0 → target track t1', () => {
    const r = buildPreview(baseArgs({ itemTopY: 6, itemHeightPx: 60 }));
    // center y = 36 → band 0
    expect(r.willCreateNewTrack).toBe(false);
    expect(r.previewTrackId).toBe('t1');
  });

  it('center inside band 1 → target track t2', () => {
    const r = buildPreview(baseArgs({ itemTopY: TRACK_HEIGHT + 6, itemHeightPx: 60 }));
    // center y = 72 + 36 = 108 → band 1
    expect(r.willCreateNewTrack).toBe(false);
    expect(r.previewTrackId).toBe('t2');
  });

  it('routes through semantic variable-height track bands', () => {
    const r = buildPreview(baseArgs({
      itemTopY: 38,
      itemHeightPx: 20,
      trackHeights: [36, 72, 48],
    }));

    // center y = 48, after the 36px effect lane and inside the primary lane
    expect(r.willCreateNewTrack).toBe(false);
    expect(r.previewTrackId).toBe('t2');
  });

  it('center past the bottom of all tracks → create new track at bottom', () => {
    const r = buildPreview(
      baseArgs({ itemTopY: TRACK_HEIGHT * 3 + 6, itemHeightPx: 60 }),
    );
    expect(r.willCreateNewTrack).toBe(true);
    expect(r.insertIndex).toBe(3); // tracks.length
  });

  it('center above 0 → create new track at top', () => {
    const r = buildPreview(baseArgs({ itemTopY: -100, itemHeightPx: 60 }));
    // center y = -70 → band -1 < 0
    expect(r.willCreateNewTrack).toBe(true);
    expect(r.insertIndex).toBe(0);
  });

  it('previewFrame respects pixelsPerFrame and rounds to the nearest frame', () => {
    // 250px at 2 px/frame → 125 frames
    const r = buildPreview(baseArgs({ leftWithinTracksPx: 250, itemTopY: 6 }));
    expect(r.rawPreviewFrame).toBe(125);
  });
});

// ──────────────────────────────────────────────────────────────────
//  buildPreview — overlap resolution only when not creating a new track
// ──────────────────────────────────────────────────────────────────
describe('buildPreview — overlap resolution', () => {
  it('when moving into a track with a neighbor, uses the closest free position', () => {
    const t1 = makeTrack('t1', [makeVideo('me', 0, 30)]);
    const t2 = makeTrack('t2', [makeVideo('blocker', 100, 50)]);
    const r = buildPreview({
      leftWithinTracksPx: 80 * PIXELS_PER_FRAME, // request frame 80
      itemTopY: TRACK_HEIGHT + 6, // band 1 → t2
      itemHeightPx: 60,
      pixelsPerFrame: PIXELS_PER_FRAME,
      tracks: [t1, t2],
      item: makeVideo('me', 0, 30),
      originalTrackId: 't1',
      currentFrame: 0,
      snapEnabled: false,
      trackHeight: TRACK_HEIGHT,
      insertThresholdPx: 8,
    });
    expect(r.previewTrackId).toBe('t2');
    expect(r.previewFrame).toBe(70); // right edge meets blocker start
    expect(r.snapGuideFrame).toBeNull(); // resolved position differs from the snap
  });

  it('overlap push is NOT applied when creating a new track', () => {
    const t1 = makeTrack('t1', [makeVideo('blocker', 0, 100)]);
    const r = buildPreview({
      leftWithinTracksPx: 50 * PIXELS_PER_FRAME, // request frame 50 (overlaps blocker)
      itemTopY: TRACK_HEIGHT * 5, // way below any track → create new
      itemHeightPx: 60,
      pixelsPerFrame: PIXELS_PER_FRAME,
      tracks: [t1],
      item: makeVideo('me', 0, 30),
      originalTrackId: 't1',
      currentFrame: 0,
      snapEnabled: false,
      trackHeight: TRACK_HEIGHT,
      insertThresholdPx: 8,
    });
    expect(r.willCreateNewTrack).toBe(true);
    // rawPreviewFrame is the un-pushed value
    expect(r.rawPreviewFrame).toBe(50);
  });
});

// ──────────────────────────────────────────────────────────────────
//  preferItemEdgeSnap
// ──────────────────────────────────────────────────────────────────
describe('preferItemEdgeSnap', () => {
  it('returns rawFrom unchanged when snapping is disabled', () => {
    const tracks = [makeTrack('t', [makeVideo('a', 100, 50)])];
    expect(preferItemEdgeSnap(110, 30, tracks, 'me', 0, false, 5).from).toBe(110);
  });

  it('snaps to a nearby item-end if within threshold (left edge)', () => {
    const tracks = [makeTrack('t', [makeVideo('a', 0, 50)])];
    // a ends at 50; rawFrom = 53, threshold = 5 → snap left edge to 50
    const r = preferItemEdgeSnap(53, 30, tracks, 'me', 0, true, 5);
    expect(r.from).toBe(50);
    expect(r.guideFrame).toBe(50);
  });

  it('snaps via right edge by adjusting `from = guide - duration`', () => {
    const tracks = [makeTrack('t', [makeVideo('a', 100, 50)])];
    // a starts at 100; if our right edge is near 100, snap right edge to 100,
    // so from = 100 - duration.
    const r = preferItemEdgeSnap(/* rawFrom */ 68, /* dur */ 30, tracks, 'me', 0, true, 5);
    expect(r.from).toBe(70); // 100 - 30
    expect(r.guideFrame).toBe(100);
  });

  it('returns rawFrom unchanged when no nearby snap targets exist', () => {
    // Item-edge snap won't fire (only own item in track), and playhead far away.
    const tracks = [makeTrack('t', [makeVideo('me', 0, 50)])];
    const r = preferItemEdgeSnap(/* far from any edge */ 500, 30, tracks, 'me', /* playhead */ 0, true, 5);
    expect(r.guideFrame).toBeNull();
    expect(r.from).toBeGreaterThanOrEqual(0);
  });
});

// ──────────────────────────────────────────────────────────────────
//  decideInsertIntent
// ──────────────────────────────────────────────────────────────────
describe('decideInsertIntent', () => {
  it('returns a top create-track when there are no tracks', () => {
    const r = decideInsertIntent([], 'src', 0, TRACK_HEIGHT, 8);
    expect(r.willCreateNewTrack).toBe(true);
    expect(r.insertIndex).toBe(0);
  });

  it('returns no insert when y is well inside a track band (not near a boundary)', () => {
    const tracks = [makeTrack('a'), makeTrack('b'), makeTrack('c')];
    const r = decideInsertIntent(tracks, 'a', TRACK_HEIGHT + TRACK_HEIGHT / 2, TRACK_HEIGHT, 8);
    expect(r.insertIndex).toBeNull();
  });

  it('boundary above the source track → move into the previous track (not create)', () => {
    const tracks = [makeTrack('a'), makeTrack('b'), makeTrack('c')];
    // src = b (index 1). Boundary at y just below TRACK_HEIGHT (top of b).
    const r = decideInsertIntent(tracks, 'b', TRACK_HEIGHT + 2, TRACK_HEIGHT, 8);
    expect(r.willCreateNewTrack).toBe(false);
    expect(r.targetTrackIdIfMove).toBe('a');
  });

  it('boundary below the source track → move into the next track', () => {
    const tracks = [makeTrack('a'), makeTrack('b'), makeTrack('c')];
    // Boundary just above 2*TRACK_HEIGHT
    const r = decideInsertIntent(tracks, 'b', 2 * TRACK_HEIGHT - 2, TRACK_HEIGHT, 8);
    expect(r.willCreateNewTrack).toBe(false);
    expect(r.targetTrackIdIfMove).toBe('c');
  });

  it('top boundary → create new track at index 0', () => {
    const tracks = [makeTrack('a'), makeTrack('b')];
    const r = decideInsertIntent(tracks, 'a', 2, TRACK_HEIGHT, 8);
    expect(r.willCreateNewTrack).toBe(true);
    expect(r.insertIndex).toBe(0);
  });

  it('bottom boundary → create new track at end', () => {
    const tracks = [makeTrack('a'), makeTrack('b')];
    const r = decideInsertIntent(tracks, 'a', 2 * TRACK_HEIGHT - 2, TRACK_HEIGHT, 8);
    expect(r.willCreateNewTrack).toBe(true);
    expect(r.insertIndex).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────
//  finalizeDrop
// ──────────────────────────────────────────────────────────────────
describe('finalizeDrop', () => {
  const tracks = [makeTrack('a'), makeTrack('b')];

  it('classifies as create-track when willCreateNewTrack', () => {
    const action = finalizeDrop(
      {
        previewTrackId: 'a',
        previewFrame: 30,
        rawPreviewFrame: 30,
        insertIndex: 0,
        willCreateNewTrack: true,
        snapGuideFrame: null,
      },
      tracks,
      'a',
    );
    expect(action.type).toBe('create-track');
    if (action.type !== 'create-track') return;
    expect(action.insertIndex).toBe(0);
    expect(action.frame).toBe(30);
  });

  it('classifies as move-within-track when target equals original', () => {
    const action = finalizeDrop(
      {
        previewTrackId: 'a',
        previewFrame: 30,
        rawPreviewFrame: 30,
        insertIndex: null,
        willCreateNewTrack: false,
        snapGuideFrame: null,
      },
      tracks,
      'a',
    );
    expect(action.type).toBe('move-within-track');
  });

  it('classifies as move-to-track when target differs from original', () => {
    const action = finalizeDrop(
      {
        previewTrackId: 'b',
        previewFrame: 30,
        rawPreviewFrame: 30,
        insertIndex: null,
        willCreateNewTrack: false,
        snapGuideFrame: null,
      },
      tracks,
      'a',
    );
    expect(action.type).toBe('move-to-track');
    if (action.type !== 'move-to-track') return;
    expect(action.targetTrackId).toBe('b');
  });
});
