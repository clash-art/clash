// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  EditorProvider,
  useEditorDispatch,
  useEditorHistory,
  type EditorState,
  type ImageItem,
} from "@clash/remotion-core";
import { PropertiesPanel } from "./PropertiesPanel";

afterEach(cleanup);

it("keeps an unfinished numeric edit out of the Timeline and restores it on blur", () => {
  let saved: EditorState;
  render(
    <EditorProvider
      initialState={{
        tracks: [{ id: "track", name: "Photos", items: [{
          id: "shot", type: "image", src: "photo.png", from: 120,
          durationInFrames: 90,
          properties: { x: 48, y: 24, width: 1, height: 1, opacity: 0.8, rotation: 15 },
        }] }],
        selectedItemId: "shot", currentFrame: 120,
      }}
      onStateChange={(state) => { saved = state; }}
    >
      <PlaybackAndHistory />
      <PropertiesPanel />
    </EditorProvider>,
  );
  for (const label of ["X position in pixels", "Rotation in degrees", "Opacity"]) {
    const input = screen.getByRole("spinbutton", { name: label }) as HTMLInputElement;
    const initialValue = input.value;
    const before = JSON.stringify(saved!.tracks);
    fireEvent.focus(input);
    // Native number inputs expose an empty value while a minus sign is incomplete.
    fireEvent.change(input, { target: { value: "" } });
    expect(JSON.stringify(saved!.tracks)).toBe(before);
    expect(input.value).toBe("");
    fireEvent.blur(input);
    expect(input.value).toBe(initialValue);
  }
  const position = screen.getByRole("spinbutton", { name: "X position in pixels" });
  fireEvent.change(position, { target: { value: "" } });
  fireEvent.change(position, { target: { value: "-120" } });
  expect(saved!.tracks[0].items[0].properties?.x).toBe(-120);
  fireEvent.change(position, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Seek 150" }));
  expect((screen.getByRole("spinbutton", { name: "X position in pixels" }) as HTMLInputElement).value).toBe("-120");

  fireEvent.click(screen.getByRole("button", { name: "Add Scale keyframe at current frame" }));
  const scale = screen.getByRole("spinbutton", { name: "X animated scale" }) as HTMLInputElement;
  const keysBefore = saved!.tracks[0].items[0].keyframes;
  fireEvent.change(scale, { target: { value: "" } });
  expect(saved!.tracks[0].items[0].keyframes).toEqual(keysBefore);
  expect(scale.value).toBe("");
  fireEvent.change(scale, { target: { value: "0.25" } });
  expect(saved!.tracks[0].items[0].keyframes?.scale?.[0].value).toEqual([0.25, 1]);
});

function PlaybackAndHistory() {
  const dispatch = useEditorDispatch();
  const history = useEditorHistory();
  return (
    <>
      <button
        onClick={() => dispatch({ type: "SET_CURRENT_FRAME", payload: 150 })}
      >
        Seek 150
      </button>
      <button onClick={history.undo} disabled={!history.canUndo}>
        Undo edit
      </button>
      <button onClick={history.redo} disabled={!history.canRedo}>
        Redo edit
      </button>
    </>
  );
}

it("edits and navigates clip-local keys, undoes deletion, and restores the persisted editor state", () => {
  const image: ImageItem = {
    id: "shot",
    type: "image",
    src: "photo.png",
    from: 120,
    durationInFrames: 90,
    properties: { x: 12, y: 24, width: 1, height: 1, opacity: 1, rotation: 0 },
  };
  let saved: EditorState;
  function mount(initialState: Partial<EditorState>) {
    return render(
      <EditorProvider
        initialState={initialState}
        onStateChange={(state) => {
          saved = state;
        }}
      >
        <PlaybackAndHistory />
        <PropertiesPanel />
      </EditorProvider>,
    );
  }
  const view = mount({
    tracks: [{ id: "track", name: "Photos", items: [image] }],
    selectedItemId: "shot",
    currentFrame: 120,
  });
  const readItem = () => saved.tracks[0].items[0] as ImageItem;
  fireEvent.click(
    screen.getByRole("button", {
      name: "Add Position keyframe at current frame",
    }),
  );
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "X position in pixels" }),
    { target: { value: "48" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Seek 150" }));
  fireEvent.click(
    screen.getByRole("button", {
      name: "Add Position keyframe at current frame",
    }),
  );
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "X position in pixels" }),
    { target: { value: "240" } },
  );
  expect(readItem().keyframes?.position).toEqual([
    { frame: 0, value: [48, 24], interpolation: "linear" },
    { frame: 30, value: [240, 24], interpolation: "linear" },
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: "Previous Position keyframe" }),
  );
  expect(
    (
      screen.getByRole("spinbutton", {
        name: "X position in pixels",
      }) as HTMLInputElement
    ).value,
  ).toBe("48");
  fireEvent.click(
    screen.getByRole("button", { name: "Next Position keyframe" }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Remove Position keyframe at current frame",
    }),
  );
  expect(readItem().keyframes?.position?.map((key) => key.frame)).toEqual([0]);
  fireEvent.click(screen.getByRole("button", { name: "Undo edit" }));
  expect(readItem().keyframes?.position?.map((key) => key.frame)).toEqual([
    0, 30,
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Redo edit" }));
  expect(readItem().keyframes?.position?.map((key) => key.frame)).toEqual([0]);
  fireEvent.click(screen.getByRole("button", { name: "Undo edit" }));
  // Exercise remount with actual serialized state, not a second handcrafted fixture.
  // Host persistence and export are separate installed-candidate acceptance checks.
  const snapshot = JSON.parse(JSON.stringify(saved!)) as EditorState;
  view.unmount();
  mount(snapshot);
  expect(readItem().keyframes?.position?.[1]).toEqual({
    frame: 30,
    value: [240, 24],
    interpolation: "linear",
  });
  expect(
    (
      screen.getByRole("spinbutton", {
        name: "X position in pixels",
      }) as HTMLInputElement
    ).value,
  ).toBe("240");
});
