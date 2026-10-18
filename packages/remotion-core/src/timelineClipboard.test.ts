import { describe, expect, it } from "vitest";
import { editorReducer, normalizeInitialState } from "./state/EditorContext";
import { copyTimelineItems, planTimelinePaste } from "./timelineClipboard";
import type { EditorState, Track, TrackCategory, VideoItem } from "./types";

const video = (id: string, from: number, durationInFrames: number): VideoItem => ({
  id,
  type: "video",
  src: `${id}.mp4`,
  from,
  durationInFrames,
});
const track = (id: string, category: TrackCategory, items: VideoItem[]): Track => ({
  id,
  name: id,
  category,
  items,
});

/** Index 0 is the top of the Timeline UI. */
function editor(tracks: Track[], selectedItemId: string, currentFrame: number): EditorState {
  return { ...normalizeInitialState({ tracks, fps: 30 }), selectedItemId, currentFrame };
}

function paste(state: EditorState, copiedIds: string[]) {
  const clipboard = copyTimelineItems(state.tracks, copiedIds)!;
  let n = 0;
  const plan = planTimelinePaste(state, clipboard, {
    playheadFrame: state.currentFrame,
    createId: (kind) => `${kind}-new-${(n += 1)}`,
  });
  const next = plan.actions.reduce(editorReducer, state);
  const located = plan.pastedItemIds.map((id) => {
    const index = next.tracks.findIndex((t) => t.items.some((item) => item.id === id));
    const item = next.tracks[index]?.items.find((candidate) => candidate.id === id);
    return { trackId: next.tracks[index]?.id, trackIndex: index, from: item?.from };
  });
  return { plan, next, located };
}

describe("Timeline paste", () => {
  it("no conflict: pastes at the playhead on the selected item's track", () => {
    const state = editor(
      [
        track("upper", "visual", []),
        track("main", "primary", [video("a", 0, 30)]),
      ],
      "a",
      100,
    );
    const { plan, next, located } = paste(state, ["a"]);
    expect(located).toEqual([{ trackId: "main", trackIndex: 1, from: 100 }]);
    expect(plan.createdTrackIds).toEqual([]);
    expect(next.tracks).toHaveLength(state.tracks.length);
  });

  it("uses the selected track when no item is selected", () => {
    const base = editor(
      [track("upper", "visual", [video("u", 0, 10)]), track("main", "primary", [video("a", 0, 30)])],
      "a",
      200,
    );
    const clipboard = copyTimelineItems(base.tracks, ["a"])!;
    const state = { ...base, selectedItemId: null, selectedTrackId: "upper" };
    const plan = planTimelinePaste(state, clipboard, { playheadFrame: 200, createId: (k) => `${k}-x` });
    expect(plan.actions).toEqual([
      expect.objectContaining({ type: "ADD_ITEM", payload: expect.objectContaining({ trackId: "upper" }) }),
    ]);
  });

  it("conflict with no free track above: creates a new track at the top", () => {
    const state = editor(
      [
        track("upper", "visual", [video("u", 40, 100)]),
        track("main", "primary", [video("a", 0, 30), video("b", 60, 60)]),
      ],
      "a",
      70,
    );
    const { plan, next, located } = paste(state, ["a"]);
    expect(plan.createdTrackIds).toEqual(["track-new-2"]);
    expect(next.tracks).toHaveLength(state.tracks.length + 1);
    expect(located).toEqual([{ trackId: "track-new-2", trackIndex: 0, from: 70 }]);
    // Existing lanes are untouched.
    expect(next.tracks.slice(1)).toEqual(state.tracks);
  });

  it("conflict on the current track, free slot two tracks up: pastes there without a new track", () => {
    const state = editor(
      [
        track("top", "visual", [video("t", 0, 20)]),
        track("middle", "visual", [video("m", 50, 100)]),
        track("main", "primary", [video("a", 0, 30), video("b", 60, 60)]),
      ],
      "a",
      70,
    );
    const { plan, next, located } = paste(state, ["a"]);
    expect(located).toEqual([{ trackId: "top", trackIndex: 0, from: 70 }]);
    expect(plan.createdTrackIds).toEqual([]);
    expect(next.tracks.map((t) => t.id)).toEqual(["top", "middle", "main"]);
  });

  it("playhead in the middle of an existing item: the whole pasted item moves up, never overlaps", () => {
    const state = editor(
      [
        track("upper", "visual", [video("u", 100, 50)]),
        track("main", "primary", [video("a", 0, 100)]),
      ],
      "a",
      50,
    );
    // "upper" is free at the playhead (frame 50) but not for the whole item
    // (50..150 hits "u" at 100), so a new top track is created.
    const { plan, next, located } = paste(state, ["a"]);
    expect(located).toEqual([{ trackId: "track-new-2", trackIndex: 0, from: 50 }]);
    expect(plan.createdTrackIds).toHaveLength(1);
    expect(next.tracks.find((t) => t.id === "main")!.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("multi-item paste keeps the copied items' relative offsets", () => {
    const state = editor(
      [track("main", "primary", [video("a", 10, 20), video("b", 50, 20)])],
      "a",
      300,
    );
    const { located } = paste(state, ["a", "b"]);
    expect(located).toEqual([
      { trackId: "main", trackIndex: 0, from: 300 },
      { trackId: "main", trackIndex: 0, from: 340 },
    ]);
  });

  it("pasted items get new ids and drop the relative-position expression", () => {
    const state = editor([track("main", "primary", [{ ...video("a", 0, 20), fromExpr: "start" }])], "a", 40);
    const { next, plan } = paste(state, ["a"]);
    const pasted = next.tracks[0].items.find((item) => item.id === plan.pastedItemIds[0])!;
    expect(pasted.id).not.toBe("a");
    expect(pasted).not.toHaveProperty("fromExpr");
  });
});
