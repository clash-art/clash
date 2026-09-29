// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditorProvider, type Item, type Track } from "@clash/remotion-core";
import { TimelineItem } from "./TimelineItem";

type Gesture = {
  first: boolean;
  last: boolean;
  movement: [number, number];
  args: ["right", boolean];
  event: PointerEvent;
};
const gesture = vi.hoisted(() => ({
  handle: null as ((state: Gesture) => void) | null,
}));
vi.mock("../ui/gesture", () => ({
  useDragGesture: (handle: (state: Gesture) => void) => {
    gesture.handle = handle;
    return () => ({});
  },
}));
afterEach(cleanup);

it.each([false, true])(
  "keeps drag movement relative to the initial geometry across renders (roll=%s)",
  (roll) => {
    const item: Item = {
      id: "title",
      type: "text",
      color: "#fff",
      text: "Title",
      from: 0,
      durationInFrames: 60,
    };
    const track: Track = {
      id: "titles",
      name: "Titles",
      category: "text",
      items: [item],
    };
    let boundary = 60;
    const draw = () => {
      const initialBoundary = boundary;
      const resize = (_edge: "left" | "right", delta: number) => {
        boundary = initialBoundary + delta;
      };
      return (
        <EditorProvider initialState={{ tracks: [track] }}>
          <TimelineItem
            item={{ ...item, durationInFrames: boundary }}
            track={track}
            trackId={track.id}
            pixelsPerFrame={2}
            isSelected={false}
            assets={[]}
            onSelect={() => {}}
            onDelete={() => {}}
            onUpdate={() => {}}
            onResize={resize}
            onRollEdit={resize}
          />
        </EditorProvider>
      );
    };
    const view = render(draw());
    const move = (x: number, first = false, last = false) =>
      act(() => {
        gesture.handle!({
          first,
          last,
          movement: [x, 0],
          args: ["right", roll],
          event: new MouseEvent("pointermove") as PointerEvent,
        });
      });
    move(0, true);
    move(10);
    expect(boundary).toBe(65);
    view.rerender(draw());
    // use-gesture's movement is displacement since pointer-down, not event delta.
    move(20);
    expect(boundary).toBe(70);
    view.rerender(draw());
    move(0, false, true);
    expect(boundary).toBe(60);
    view.rerender(draw());
    move(0, true);
    move(-10, false, true);
    expect(boundary).toBe(55);
  },
);
