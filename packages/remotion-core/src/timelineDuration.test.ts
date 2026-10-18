import { describe, expect, it } from "vitest";
import {
  createEditorHistoryState,
  editorHistoryReducer,
  editorReducer,
  normalizeInitialState,
} from "./state/EditorContext";
import {
  deriveTimelineDurationInFrames,
  EMPTY_TIMELINE_DURATION_IN_FRAMES,
} from "./timelineDuration";
import type { Track, VideoItem } from "./types";

const video = (id: string, from: number, durationInFrames: number): VideoItem => ({
  id,
  type: "video",
  src: `${id}.mp4`,
  from,
  durationInFrames,
});

const FPS = 30;
// The reported state: a persisted 50 s duration while a clip on track 1 runs
// from 0:44 to 1:28.
const reportedTracks: Track[] = [
  { id: "t1", name: "Media", items: [video("clip-performance-4k", 44 * FPS, 44 * FPS)] },
  { id: "t2", name: "Media", items: [video("a-roll", 0, 44 * FPS)] },
];

describe("composition duration follows the content end", () => {
  it("derives from the max item end across tracks, with a default only when empty", () => {
    expect(deriveTimelineDurationInFrames(reportedTracks)).toBe(88 * FPS);
    expect(deriveTimelineDurationInFrames([])).toBe(EMPTY_TIMELINE_DURATION_IN_FRAMES);
    expect(deriveTimelineDurationInFrames([{ items: [] }])).toBe(EMPTY_TIMELINE_DURATION_IN_FRAMES);
  });

  it("ignores a stale persisted duration when the editor loads", () => {
    const state = normalizeInitialState({ tracks: reportedTracks, durationInFrames: 50 * FPS, fps: FPS });
    expect(state.durationInFrames).toBe(88 * FPS);
  });

  it("grows when an item is added past the end and shrinks when it is trimmed back", () => {
    let state = normalizeInitialState({ tracks: [reportedTracks[1]], fps: FPS });
    expect(state.durationInFrames).toBe(44 * FPS);

    state = editorReducer(state, {
      type: "ADD_TRACK",
      payload: { id: "t1", name: "Media", items: [video("late", 44 * FPS, 44 * FPS)] },
    });
    expect(state.durationInFrames).toBe(88 * FPS);

    state = editorReducer(state, {
      type: "UPDATE_ITEM",
      payload: { trackId: "t1", itemId: "late", updates: { durationInFrames: 10 * FPS } },
    });
    expect(state.durationInFrames).toBe(54 * FPS);

    state = editorReducer(state, { type: "REMOVE_ITEM", payload: { trackId: "t1", itemId: "late" } });
    expect(state.durationInFrames).toBe(44 * FPS);
  });

  it("keeps the playhead inside a shrinking composition", () => {
    let state = normalizeInitialState({ tracks: reportedTracks, fps: FPS, currentFrame: 80 * FPS });
    state = editorReducer(state, {
      type: "REMOVE_ITEM",
      payload: { trackId: "t1", itemId: "clip-performance-4k" },
    });
    expect(state.durationInFrames).toBe(44 * FPS);
    expect(state.currentFrame).toBe(44 * FPS);
  });

  it("undo and redo restore a duration that still matches the content", () => {
    let history = createEditorHistoryState({ tracks: [reportedTracks[1]], fps: FPS });
    history = editorHistoryReducer(history, {
      type: "ADD_TRACK",
      payload: { id: "t1", name: "Media", items: [video("late", 44 * FPS, 44 * FPS)] },
    });
    expect(history.present.durationInFrames).toBe(88 * FPS);
    history = editorHistoryReducer(history, { type: "UNDO" });
    expect(history.present.durationInFrames).toBe(44 * FPS);
    history = editorHistoryReducer(history, { type: "REDO" });
    expect(history.present.durationInFrames).toBe(88 * FPS);
  });

  it("does not let SET_DURATION diverge from the content", () => {
    const state = normalizeInitialState({ tracks: reportedTracks, fps: FPS });
    expect(editorReducer(state, { type: "SET_DURATION", payload: 50 * FPS }).durationInFrames).toBe(88 * FPS);
  });
});
