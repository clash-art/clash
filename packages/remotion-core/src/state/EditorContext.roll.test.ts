import { expect, it } from "vitest";
import {
  editorInitialState,
  editorReducer,
  createEditorHistoryState,
  editorHistoryReducer,
} from "./EditorContext";
import type { EditorState, VideoItem } from "../types";

const fixture = (): EditorState => ({
  ...editorInitialState,
  primaryTrackId: "main",
  tracks: [
    {
      id: "main",
      name: "Main",
      category: "primary",
      items: [
        {
          id: "left",
          type: "video",
          src: "left.mp4",
          assetId: "left-asset",
          from: 0,
          durationInFrames: 60,
          sourceStartInFrames: 20,
        },
        {
          id: "right",
          type: "video",
          src: "right.mp4",
          from: 60,
          durationInFrames: 60,
          sourceStartInFrames: 20,
        },
      ],
    },
  ],
});
const roll = (boundaryFrame: number) => ({
  type: "ROLL_EDIT" as const,
  payload: {
    trackId: "main",
    leftItemId: "left",
    rightItemId: "right",
    boundaryFrame,
  },
});

it.each([50, 70])(
  "moves a shared boundary atomically to %i without gaps or overlaps, preserving the pair span",
  (boundary) => {
    const state = fixture();
    const next = editorReducer(state, roll(boundary));
    const [left, right] = next.tracks[0].items as VideoItem[];
    expect(left.durationInFrames).toBe(boundary);
    expect(right.from).toBe(boundary);
    expect(right.from + right.durationInFrames).toBe(120);
    expect(right.sourceStartInFrames).toBe(20 + boundary - 60);
    expect(state.tracks[0].items[0].durationInFrames).toBe(60);
  },
);
it("clamps the boundary to both source handles and keeps each clip nonempty", () => {
  const state = fixture();
  state.assets = [
    {
      id: "left-asset",
      name: "left",
      type: "video",
      src: "left.mp4",
      duration: 3,
      createdAt: 0,
    },
  ];
  expect(
    editorReducer(state, roll(200)).tracks[0].items[0].durationInFrames,
  ).toBe(70);
  expect(editorReducer(state, roll(-100)).tracks[0].items[1].from).toBe(40);
});
it("records both clips as one undoable edit", () => {
  const history = createEditorHistoryState(fixture());
  const changed = editorHistoryReducer(history, roll(70));
  expect(changed.present.tracks[0].items[1].from).toBe(70);
  const undone = editorHistoryReducer(changed, { type: "UNDO" });
  expect(undone.present.tracks).toEqual(history.present.tracks);
  expect(editorHistoryReducer(undone, { type: "REDO" }).present.tracks).toEqual(
    changed.present.tracks,
  );
});

it("moves the attached transition with the cut and limits it to the remaining clip handles", () => {
  const state = fixture();
  state.tracks.push({
    id: "transitions",
    name: "Transitions",
    category: "effect",
    role: "transition",
    items: [
      {
        id: "fade",
        type: "transition",
        transitionType: "crossfade",
        from: 50,
        durationInFrames: 20,
        fromItemId: "left",
        toItemId: "right",
      },
    ],
  });
  const moved = editorReducer(state, roll(70));
  const fade = moved.tracks[1].items[0];
  expect(fade.from + fade.durationInFrames / 2).toBe(
    moved.tracks[0].items[1].from,
  );
  expect(fade.durationInFrames).toBe(state.tracks[1].items[0].durationInFrames);
  const nearEnd = editorReducer(state, roll(119));
  const shortened = nearEnd.tracks[1].items[0];
  expect(shortened.from + shortened.durationInFrames).toBe(120);
  expect(shortened.from + shortened.durationInFrames / 2).toBe(
    nearEnd.tracks[0].items[1].from,
  );
});

it("does not roll clips separated by a gap", () => {
  const state = fixture();
  state.tracks[0].items[1].from += 10;
  expect(editorReducer(state, roll(70))).toBe(state);
});
